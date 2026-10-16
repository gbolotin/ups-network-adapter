"""Install the optional PeaNUT dashboard without changing NUT or SNMP."""

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
import time

IMAGE = 'brandawg93/peanut:6.0.0'
CONTAINER = 'ups-peanut'
LABEL = 'ups-network-adapter.peanut'
CONFIG = Path('/var/lib/ups-peanut')
ENVIRONMENT = Path('/etc/ups-peanut.env')


def validate_peanut_password(password: str) -> None:
    if not password:
        raise ValueError('Password cannot be empty.')
    if len(password) < 8:
        raise ValueError('Password must be at least 8 characters long.')
    if '\n' in password or '\r' in password:
        raise ValueError('Password cannot contain newlines.')


def prompt_password(prompt_label: str) -> str:
    while True:
        p1 = getpass.getpass(f'Enter {prompt_label} password: ')
        if not p1:
            print('Password cannot be empty.')
            continue
        if len(p1) < 8:
            print('Password must be at least 8 characters long.')
            continue
        p2 = getpass.getpass('Confirm password: ')
        if p1 != p2:
            print('Passwords do not match. Please try again.')
            continue
        return p1


def install(password: str | None = None) -> None:
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
    settings_file = CONFIG / 'settings.yml'
    if not settings_file.exists():
        settings_file.write_text(
            "NUT_SERVERS:\n"
            "  - HOST: 127.0.0.1\n"
            "    PORT: 3493\n"
            "    DISABLED: false\n",
            encoding='utf-8'
        )
        settings_file.chmod(0o600)
        os.chown(settings_file, 1000, 1000)
    if password is None:
        if ENVIRONMENT.exists():
            if sys.stdin.isatty():
                ans = input('Existing PeaNUT credentials found in /etc/ups-peanut.env. Change admin password? [Y/n]: ').strip().lower()
                if ans in ('', 'y', 'yes'):
                    password = prompt_password('PeaNUT dashboard (port 8080, admin)')
        else:
            if sys.stdin.isatty():
                password = prompt_password('PeaNUT dashboard (port 8080, admin)')
            else:
                password = secrets.token_urlsafe(32)

    if password is not None:
        validate_peanut_password(password)
        auth_secret = secrets.token_urlsafe(32)
        if ENVIRONMENT.exists():
            for line in ENVIRONMENT.read_text(encoding='utf-8').splitlines():
                if line.startswith('AUTH_SECRET='):
                    auth_secret = line.split('=', 1)[1]
                    break
        descriptor, name = tempfile.mkstemp(dir=ENVIRONMENT.parent)
        try:
            with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as stream:
                stream.write(f'WEB_USERNAME=admin\nWEB_PASSWORD={password}\n')
                stream.write(f'AUTH_SECRET={auth_secret}\n')
            os.chmod(name, 0o600)
            os.replace(name, ENVIRONMENT)
        finally:
            if os.path.exists(name):
                os.unlink(name)
    ENVIRONMENT.chmod(0o600)
    os.chown(ENVIRONMENT, 0, 0)
    if existing.returncode == 0:
        if password is not None:
            subprocess.run(['docker', 'rm', '-f', CONTAINER], check=True)
            auth_file = CONFIG / 'auth.yaml'
            if auth_file.exists():
                auth_file.unlink()
            existing_reused = False
        else:
            existing_reused = True
    else:
        existing_reused = False

    if existing_reused:
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
            if Path('/etc/systemd/system/ups-kiosk-login.service').is_file():
                subprocess.run(['systemctl', 'restart', 'ups-kiosk-login.service'], check=False)
            print('PeaNUT is ready on HTTP port 8080; local NUT server: 127.0.0.1:3493.', flush=True)
            print("Initial login: sudo grep '^WEB_' /etc/ups-peanut.env", flush=True)
            return
        time.sleep(2)
    raise RuntimeError('PeaNUT did not become healthy; inspect the ups-peanut container before retrying')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Install the optional PeaNUT dashboard.')
    parser.add_argument('--password', help='Admin password for PeaNUT dashboard')
    parser.add_argument('--password-stdin', action='store_true', help='Read admin password from stdin')
    args = parser.parse_args()

    cli_password = None
    if args.password_stdin:
        cli_password = sys.stdin.read().rstrip('\r\n')
    elif args.password:
        cli_password = args.password
    elif 'PEANUT_PASSWORD' in os.environ:
        cli_password = os.environ['PEANUT_PASSWORD']

    try:
        install(password=cli_password)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        raise SystemExit(f'PeaNUT installation failed: {error}') from error
