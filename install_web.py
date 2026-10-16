"""Install the separate HTTPS settings site using Python and existing OpenSSL."""

import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import urllib.request
import ssl

from ups_web import CONFIG, STATE, CREDENTIALS, settings

PROJECT = Path(__file__).resolve().parent
LIBRARY = Path('/usr/local/lib/ups-network-adapter')
UNIT = Path('/etc/systemd/system/ups-web.service')


def install() -> None:
    if os.getuid() != 0:
        raise ValueError('Run with sudo python3 install_web.py')
    if not shutil.which('openssl'):
        raise ValueError('OpenSSL is required for the HTTPS certificate. Install it before retrying.')
    targets = [CONFIG, CONFIG.parent, STATE, CREDENTIALS, LIBRARY, UNIT]
    targets += [STATE / name for name in ('certificate.pem', 'key.pem')]
    targets += [LIBRARY / name for name in ('ups_web.py', 'ups_web.html')]
    if any(path.is_symlink() for path in targets):
        raise ValueError('Refusing to modify symlinked web configuration or installation files')
    settings(CONFIG.read_text(encoding='utf-8'))
    if not (LIBRARY / 'ups_autodetect.py').is_file():
        raise ValueError('Run sudo bash setup.sh first')
    STATE.mkdir(mode=0o700, exist_ok=True)
    STATE.chmod(0o700)
    os.chown(STATE, 0, 0)
    changed = not CREDENTIALS.exists()
    if changed:
        descriptor = os.open(CREDENTIALS, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump({'username': 'admin', 'password': secrets.token_urlsafe(32)}, stream)
    CREDENTIALS.chmod(0o600)
    os.chown(CREDENTIALS, 0, 0)
    credentials = json.loads(CREDENTIALS.read_text(encoding='utf-8'))
    if credentials.get('username') != 'admin' or not credentials.get('password') or ':' in credentials['password']:
        raise ValueError('Invalid web credentials file; it was preserved')
    if not all((STATE / name).is_file() for name in ('certificate.pem', 'key.pem')):
        changed = True
        with tempfile.TemporaryDirectory(dir=STATE) as directory:
            temporary = Path(directory)
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
                            '-subj', '/CN=UPS adapter settings', '-keyout', str(temporary / 'key.pem'),
                            '-out', str(temporary / 'certificate.pem')], check=True, capture_output=True, timeout=30)
            for name in ('key.pem', 'certificate.pem'):
                (temporary / name).chmod(0o600)
                (temporary / name).replace(STATE / name)
    for name in ('key.pem', 'certificate.pem'):
        (STATE / name).chmod(0o600)
        os.chown(STATE / name, 0, 0)
    for source, target in [(PROJECT / name, LIBRARY / name) for name in ('ups_web.py', 'ups_web.html')] + [(PROJECT / 'config/ups-web.service', UNIT)]:
        if not target.exists() or source.read_bytes() != target.read_bytes():
            # Atomic replacement keeps a running site from reading a partially copied page.
            descriptor, name = tempfile.mkstemp(dir=target.parent)
            try:
                with os.fdopen(descriptor, 'wb') as stream:
                    stream.write(source.read_bytes())
                os.chown(name, 0, 0)
                os.chmod(name, 0o644)
                os.replace(name, target)
            finally:
                if os.path.exists(name):
                    os.unlink(name)
            changed = True
    subprocess.run(['/usr/bin/systemctl', 'daemon-reload'], check=True, timeout=30)
    subprocess.run(['/usr/bin/systemctl', 'enable', 'ups-web.service'], check=True, timeout=30)
    subprocess.run(['/usr/bin/systemctl', 'restart' if changed else 'start', 'ups-web.service'], check=True, timeout=30)
    # The generated certificate is self-signed; verify the local TLS endpoint using its pinned certificate.
    context = ssl.create_default_context(cafile=str(STATE / 'certificate.pem'))
    context.check_hostname = False
    import base64
    import time
    header = base64.b64encode((credentials['username'] + ':' + credentials['password']).encode()).decode()
    for attempt in range(10):
        try:
            request = urllib.request.Request('https://127.0.0.1:8081/', headers={'Authorization': 'Basic ' + header})
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))
            with opener.open(request, timeout=5) as response:
                if response.status == 200 and b'UPS adapter settings' in response.read():
                    print('Settings ready on HTTPS port 8081. Login: sudo cat /etc/ups-web-credentials.json')
                    return
        except OSError:
            pass
        time.sleep(1)
    raise RuntimeError('Settings site health check failed; inspect ups-web.service')


if __name__ == '__main__':
    try:
        install()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        raise SystemExit(f'Web installation failed: {error}') from error
