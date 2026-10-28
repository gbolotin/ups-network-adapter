"""Controlled Pi cutover after the music gate. Run as root with staged, hashed assets."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import time

TARGETS = {
    'kiosk_cdp.py': ('/usr/local/lib/ups-network-adapter/kiosk_cdp.py', 0o644),
    'kiosk_policy.py': ('/usr/local/lib/ups-network-adapter/kiosk_policy.py', 0o644),
    'kiosk_supervisor.py': ('/usr/local/lib/ups-network-adapter/kiosk_supervisor.py', 0o644),
    'kiosk_screen.py': ('/usr/local/lib/ups-network-adapter/kiosk_screen.py', 0o644),
    'offline.html': ('/usr/local/share/ups-kiosk/offline.html', 0o644),
    'ups-kiosk-browser': ('/usr/local/bin/ups-kiosk-browser', 0o755),
    'ups-kiosk.service': ('/etc/systemd/system/ups-kiosk.service', 0o644),
    'ups-kiosk-screen.service': ('/etc/systemd/system/ups-kiosk-screen.service', 0o644),
}


def run(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=45)
    if result.returncode:
        raise RuntimeError('Deployment command failed: ' + args[0])
    return result.stdout.strip()


def digest(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def install(data, path, mode):
    target = Path(path)
    if target.is_symlink():
        raise RuntimeError('Refusing a symlink installation target')
    temporary = target.with_name(target.name + '.home-console-new')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
        os.fchmod(stream.fileno(), mode)
    os.replace(temporary, target)


def wait_for_profile_release(timeout=5):
    deadline = time.monotonic() + timeout
    while True:
        owned = False
        for process in Path('/proc').glob('[0-9]*'):
            try:
                if b'--user-data-dir=/var/lib/ups-kiosk/chromium' in (process / 'cmdline').read_bytes():
                    owned = True
                    break
            except FileNotFoundError:
                continue
        if not owned:
            return
        if time.monotonic() >= deadline:
            raise RuntimeError('Browser still owns the profile after the shutdown grace period')
        time.sleep(.1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', required=True)
    parser.add_argument('--backup', required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit('Run this deployment as root')
    os.umask(0o077)
    stage = Path(args.stage).resolve(strict=True)
    backup = Path(args.backup).resolve(strict=True)
    if stage.parent != Path('/tmp') or not stage.name.startswith('home-console-recovery-check.'):
        raise RuntimeError('Unexpected staging directory')
    if backup.parent != Path('/var/backups/home-console') or backup.stat().st_uid != 0 or backup.stat().st_mode & 0o077:
        raise RuntimeError('Expected a root-only Home Console backup')
    manifest = json.loads((backup / 'manifest.json').read_text())
    if digest(backup / 'kiosk.tar') != manifest['archive']['sha256']:
        raise RuntimeError('Original kiosk archive hash differs')
    assets = json.loads((stage / 'deployment.json').read_text())
    if set(assets) != set(TARGETS):
        raise RuntimeError('Unexpected deployment asset list')
    for name, expected in assets.items():
        if digest(stage / name) != expected:
            raise RuntimeError('Staged asset hash differs')
    for path, expected in manifest['nut_config_sha256'].items():
        if digest(path) != expected:
            raise RuntimeError('NUT configuration changed since the snapshot')
    if run('upsc', 'ups@localhost', 'ups.status') != 'OL':
        raise RuntimeError('Inspect UPS monitoring before cutover')
    journal = {'created_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'backup': str(backup), 'stage': str(stage), 'status': 'stopping_kiosk'}
    journal_path = backup / 'cutover.json'
    with journal_path.open('x') as stream:
        json.dump(journal, stream)
    mutated = False
    try:
        run('systemctl', 'stop', 'ups-kiosk-login.timer', 'ups-kiosk-login.service', 'ups-kiosk.service')
        if run('systemctl', 'show', 'ups-kiosk.service', '-p', 'MainPID', '--value') != '0':
            raise RuntimeError('Kiosk did not stop')
        wait_for_profile_release()
        profile = Path('/var/lib/ups-kiosk/chromium')
        if profile.is_symlink() or not profile.is_dir():
            raise RuntimeError('Unexpected kiosk profile')
        archive = backup / 'chromium-stopped.tar'
        with tarfile.open(archive, 'x') as saved:
            saved.add(profile, arcname='var/lib/ups-kiosk/chromium', recursive=True)
        with tarfile.open(archive, 'r') as saved:
            members = saved.getmembers()
            if not members or any(not (m.name == 'var/lib/ups-kiosk/chromium' or m.name.startswith('var/lib/ups-kiosk/chromium/')) for m in members):
                raise RuntimeError('Profile archive verification failed')
        journal.update(status='profile_backed_up', profile_sha256=digest(archive), profile_entries=len(members), profile_bytes=archive.stat().st_size)
        journal_path.write_text(json.dumps(journal, indent=2))
        print(json.dumps({'profile_backup_verified': str(archive), 'sha256': journal['profile_sha256'], 'entries': len(members)}), flush=True)
        for name, (target, mode) in TARGETS.items():
            install((stage / name).read_bytes(), target, mode)
            mutated = True
            if digest(target) != assets[name]:
                raise RuntimeError('Installed asset hash differs')
        run('systemd-analyze', 'verify', '/etc/systemd/system/ups-kiosk.service', '/etc/systemd/system/ups-kiosk-screen.service')
        run('systemctl', 'daemon-reload')
        run('systemctl', 'start', 'ups-kiosk.service')
        run('systemctl', 'start', 'ups-kiosk-login.timer')
        for path, expected in manifest['nut_config_sha256'].items():
            if digest(path) != expected:
                raise RuntimeError('NUT configuration changed during cutover')
        if run('upsc', 'ups@localhost', 'ups.status') != 'OL':
            raise RuntimeError('UPS monitoring needs attention after cutover')
        journal['status'] = 'started_awaiting_login_and_acceptance'
        journal_path.write_text(json.dumps(journal, indent=2))
        print(json.dumps({'kiosk_started': True, 'profile_backup': str(archive), 'nut_status': 'OL', 'night_service_enabled': False}), flush=True)
    except Exception:
        if mutated:
            run('systemctl', 'stop', 'ups-kiosk.service')
            with tarfile.open(backup / 'kiosk.tar') as original:
                for path in ('/usr/local/bin/ups-kiosk-browser', '/etc/systemd/system/ups-kiosk.service'):
                    member = original.getmember(path.lstrip('/'))
                    install(original.extractfile(member).read(), path, member.mode)
            run('systemctl', 'daemon-reload')
        run('systemctl', 'start', 'ups-kiosk.service')
        run('systemctl', 'start', 'ups-kiosk-login.timer')
        journal['status'] = 'original_launcher_restored_after_failure'
        journal_path.write_text(json.dumps(journal, indent=2))
        raise


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        raise SystemExit(str(error))
