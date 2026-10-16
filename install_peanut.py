"""Install the optional PeaNUT dashboard without changing NUT or SNMP."""

import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import time

IMAGE = 'brandawg93/peanut:6.0.0'
CONTAINER = 'ups-peanut'
LABEL = 'ups-network-adapter.peanut'
CONFIG = Path('/var/lib/ups-peanut')
ENVIRONMENT = Path('/etc/ups-peanut.env')


def install() -> None:
    if os.getuid() != 0:
        raise ValueError('Run with sudo python3 install_peanut.py')
    architecture = subprocess.run(['dpkg', '--print-architecture'], capture_output=True, text=True, check=True).stdout.strip()
    if architecture not in ('arm64', 'amd64'):
        raise ValueError('PeaNUT requires a 64-bit arm64 or amd64 OS')
    if CONFIG.is_symlink() or ENVIRONMENT.is_symlink():
        raise ValueError('Refusing to modify symlinked PeaNUT configuration')
    if not shutil.which('docker'):
        subprocess.run(['apt-get', 'update'], check=True)
        subprocess.run(['apt-get', 'install', '-y', 'docker.io'], check=True)
    subprocess.run(['systemctl', 'enable', '--now', 'docker.service'], check=True)
    existing = subprocess.run(
        ['docker', 'container', 'inspect', '--format', '{{json .Config}}', CONTAINER],
        capture_output=True, text=True, check=False,
    )
    if existing.returncode == 0:
        config = json.loads(existing.stdout)
        if (config.get('Labels') or {}).get(LABEL) != 'true' or config.get('Image') != IMAGE:
            raise ValueError('Existing ups-peanut container is unmanaged or uses another version; it was preserved')
    CONFIG.mkdir(mode=0o700, parents=True, exist_ok=True)
    CONFIG.chmod(0o700)
    os.chown(CONFIG, 1000, 1000)
    if not ENVIRONMENT.exists():
        # Create credentials before opening the web port, so first setup cannot be claimed by another client.
        descriptor = os.open(ENVIRONMENT, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as stream:
            stream.write(f'WEB_USERNAME=admin\nWEB_PASSWORD={secrets.token_urlsafe(32)}\n')
            stream.write(f'AUTH_SECRET={secrets.token_urlsafe(32)}\n')
    ENVIRONMENT.chmod(0o600)
    os.chown(ENVIRONMENT, 0, 0)
    if existing.returncode == 0:
        subprocess.run(['docker', 'start', CONTAINER], check=True)
    else:
        subprocess.run(['docker', 'pull', IMAGE], check=True)
        subprocess.run([
            'docker', 'run', '--detach', '--name', CONTAINER, '--label', f'{LABEL}=true',
            '--restart', 'unless-stopped', '--network', 'host', '--user', '1000:1000',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
            '--mount', f'type=bind,src={CONFIG},dst=/config', '--env-file', str(ENVIRONMENT),
            '--env', 'WEB_HOST=0.0.0.0', '--env', 'WEB_PORT=8080',
            '--env', 'AUTH_FILE_PATH=/config/auth.yaml',
            '--env', 'NUT_SERVERS=[{"HOST":"127.0.0.1","PORT":3493}]', IMAGE,
        ], check=True)
    for _ in range(60):
        health = subprocess.run(
            ['docker', 'exec', CONTAINER, 'node', 'healthcheck.mjs'],
            capture_output=True, timeout=10, check=False,
        )
        if health.returncode == 0:
            print('PeaNUT is ready on HTTP port 8080; local NUT server: 127.0.0.1:3493.', flush=True)
            print("Initial login: sudo grep '^WEB_' /etc/ups-peanut.env", flush=True)
            return
        time.sleep(2)
    raise RuntimeError('PeaNUT did not become healthy; inspect the ups-peanut container before retrying')


if __name__ == '__main__':
    try:
        install()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        raise SystemExit(f'PeaNUT installation failed: {error}') from error
