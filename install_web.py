"""Install the separate HTTPS settings site using Python and existing OpenSSL."""

import argparse
import getpass
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import ssl

from ups_web import CONFIG, STATE, CREDENTIALS, settings, validate_web_password

PROJECT = Path(__file__).resolve().parent
LIBRARY = Path('/usr/local/lib/ups-network-adapter')
UNIT = Path('/etc/systemd/system/ups-web.service')
PORT = int(os.environ.get('UPS_WEB_PORT', '80'))


def prompt_password(prompt_label: str) -> str:
    while True:
        p1 = getpass.getpass(f'Enter {prompt_label} password: ')
        if not p1:
            print('Password cannot be empty.')
            continue
        if len(p1) < 8:
            print('Password must be at least 8 characters long.')
            continue
        if ':' in p1:
            print('Password cannot contain colons (:) due to HTTP Basic Authentication.')
            continue
        p2 = getpass.getpass('Confirm password: ')
        if p1 != p2:
            print('Passwords do not match. Please try again.')
            continue
        return p1


def install(password: str | None = None) -> None:
    if os.getuid() != 0:
        raise ValueError('Run with sudo python3 install_web.py')
    if not shutil.which('openssl'):
        raise ValueError('OpenSSL is required for the HTTPS certificate. Install it before retrying.')
    targets = [CONFIG, CONFIG.parent, STATE, CREDENTIALS, LIBRARY, UNIT]
    targets += [STATE / name for name in ('certificate.pem', 'key.pem')]
    targets += [LIBRARY / name for name in ('ups_web.py', 'ups_web.html', 'ups_account.html')]
    if any(path.is_symlink() for path in targets):
        raise ValueError('Refusing to modify symlinked web configuration or installation files')
    settings(CONFIG.read_text(encoding='utf-8'))
    if not (LIBRARY / 'ups_autodetect.py').is_file():
        raise ValueError('Run sudo bash setup.sh first')
    STATE.mkdir(mode=0o700, exist_ok=True)
    STATE.chmod(0o700)
    os.chown(STATE, 0, 0)
    changed = False
    if password is None:
        if CREDENTIALS.exists():
            if sys.stdin.isatty():
                ans = input('Existing settings credentials found in /etc/ups-web-credentials.json. Change admin password? [Y/n]: ').strip().lower()
                if ans in ('', 'y', 'yes'):
                    password = prompt_password(f'Configuration web (port {PORT}, admin)')
        else:
            if sys.stdin.isatty():
                password = prompt_password(f'Configuration web (port {PORT}, admin)')
            else:
                password = secrets.token_urlsafe(32)

    if password is not None:
        validate_web_password(password)
        descriptor, name = tempfile.mkstemp(dir=CREDENTIALS.parent)
        try:
            with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
                json.dump({'username': 'admin', 'password': password}, stream)
            os.chmod(name, 0o600)
            os.chown(name, 0, 0)
            os.replace(name, CREDENTIALS)
        finally:
            if os.path.exists(name):
                os.unlink(name)
        changed = True
    CREDENTIALS.chmod(0o600)
    os.chown(CREDENTIALS, 0, 0)
    credentials = json.loads(CREDENTIALS.read_text(encoding='utf-8'))
    if credentials.get('username') != 'admin' or not credentials.get('password') or ':' in credentials['password']:
        raise ValueError('Invalid web credentials file; it was preserved')
    if shutil.which('openssl') and not all((STATE / name).is_file() for name in ('certificate.pem', 'key.pem')):
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
        if (STATE / name).is_file():
            (STATE / name).chmod(0o600)
            os.chown(STATE / name, 0, 0)
    for source, target in [(PROJECT / name, LIBRARY / name) for name in ('ups_web.py', 'ups_web.html', 'ups_account.html')] + [(PROJECT / 'config/ups-web.service', UNIT)]:
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
    import base64
    import time
    header = base64.b64encode((credentials['username'] + ':' + credentials['password']).encode()).decode()
    for attempt in range(10):
        try:
            request = urllib.request.Request(f'http://127.0.0.1:{PORT}/', headers={'Authorization': 'Basic ' + header})
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(request, timeout=5) as response:
                if response.status == 200 and (b'UPS adapter' in response.read() or b'settings' in response.read()):
                    print(f'Configuration web ready on HTTP port {PORT}. Login: sudo cat /etc/ups-web-credentials.json')
                    return
        except OSError:
            pass
        time.sleep(1)
    raise RuntimeError('Configuration web health check failed; inspect ups-web.service')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Install the HTTPS settings site.')
    parser.add_argument('--password', help='Admin password for settings site')
    parser.add_argument('--password-stdin', action='store_true', help='Read admin password from stdin')
    args = parser.parse_args()

    cli_password = None
    if args.password_stdin:
        cli_password = sys.stdin.read().rstrip('\r\n')
    elif args.password:
        cli_password = args.password
    elif 'UPS_WEB_PASSWORD' in os.environ:
        cli_password = os.environ['UPS_WEB_PASSWORD']

    try:
        install(password=cli_password)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        raise SystemExit(f'Web installation failed: {error}') from error
