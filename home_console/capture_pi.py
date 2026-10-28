"""Create a private rollback snapshot without stopping or changing services.

Run on the Pi as root with Python 3. Profile backup belongs to the later,
stopped-browser cutover step and is deliberately not part of this snapshot.
"""

import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import tarfile


KIOSK_PATHS = (
    '/usr/local/bin/ups-kiosk-browser',
    '/etc/systemd/system/ups-kiosk.service',
    '/etc/systemd/system/ups-kiosk.service.d',
    '/etc/systemd/system/ups-kiosk-login.service',
    '/etc/systemd/system/ups-kiosk-login.timer',
    '/usr/local/lib/ups-network-adapter/ups-kiosk-login.mjs',
    '/usr/local/share/ups-kiosk/readability',
    '/usr/local/share/ups-kiosk/icons',
    '/etc/ups-peanut.env',
)
UNITS = (
    'docker.service', 'ups-kiosk.service', 'ups-kiosk-login.service',
    'ups-kiosk-login.timer', 'nut-driver@ups.service', 'nut-server.service',
    'ups-autodetect.service', 'ups-snmp.service', 'snmpd.service', 'ups-web.service',
)


def run(arguments):
    result = subprocess.run(arguments, capture_output=True, text=True, timeout=20)
    return {'returncode': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def archive_paths(paths, destination):
    """Store Unix ownership/modes and hash the actual saved bytes for verification."""
    missing = []
    with tarfile.open(destination, 'x', dereference=False) as archive:
        for source in map(Path, paths):
            if not source.exists() and not source.is_symlink():
                missing.append(str(source))
                continue
            archive.add(source, arcname=source.as_posix().lstrip('/'), recursive=True)
    members = []
    with tarfile.open(destination, 'r') as archive:
        for member in archive:
            item = {'path': member.name, 'mode': oct(member.mode), 'uid': member.uid, 'gid': member.gid}
            if member.isfile():
                with archive.extractfile(member) as stream:
                    item['sha256'] = hashlib.file_digest(stream, 'sha256').hexdigest()
            if member.issym() or member.islnk():
                item['linkname'] = member.linkname
            members.append(item)
    return {'sha256': digest(destination), 'members': members, 'missing_optional_paths': missing}


def nut_config_hashes():
    paths = set()
    for root in ('/etc/nut', '/etc/snmp', '/etc/ups-network-adapter', '/etc/systemd/system/nut-driver@ups.service.d'):
        directory = Path(root)
        if directory.exists():
            paths.update(path for path in directory.rglob('*') if path.is_file())
    for pattern in ('ups_mib.py', 'ups_autodetect.py'):
        paths.update(Path('/usr/local').rglob(pattern))
    return {str(path): digest(path) for path in sorted(paths) if not path.is_symlink()}


def nut_executable_hashes():
    executables = {}
    for process in Path('/proc').glob('[0-9]*'):
        try:
            if (process / 'comm').read_text().strip() not in {'usbhid-ups', 'upsd', 'snmpd'}:
                continue
            executable = process / 'exe'
            executables[process.name] = {'path': str(executable.readlink()), 'sha256': digest(executable)}
        except FileNotFoundError:
            # A process may finish between enumerating /proc and reading its identity.
            continue
    return executables


def main():
    if os.geteuid() != 0:
        raise SystemExit('Run this snapshot as root; no service changes are performed.')
    os.umask(0o077)
    parent = Path('/var/backups/home-console')
    if parent.is_symlink():
        raise SystemExit('Refusing a symlink backup directory')
    parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if parent.stat().st_uid != 0 or parent.stat().st_mode & 0o077:
        raise SystemExit('Backup parent must be root-owned with mode 0700')
    timestamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    destination = parent / timestamp
    destination.mkdir(mode=0o700)
    manifest = {'created_utc': timestamp, 'profile_included': False, 'archive': archive_paths(KIOSK_PATHS, destination / 'kiosk.tar')}
    required = set(KIOSK_PATHS) - {'/etc/systemd/system/ups-kiosk.service.d'}
    missing_required = required.intersection(manifest['archive']['missing_optional_paths'])
    manifest['missing_required_paths'] = sorted(missing_required)
    manifest['units'] = {}
    for unit in UNITS:
        manifest['units'][unit] = run(['systemctl', 'show', unit, '-p', 'ActiveState', '-p', 'SubState', '-p', 'UnitFileState', '-p', 'MainPID', '-p', 'InvocationID', '-p', 'NRestarts', '-p', 'FragmentPath', '-p', 'DropInPaths'])
    manifest['unit_definitions'] = run(['systemctl', 'cat', *UNITS])
    manifest['nut_config_sha256'] = nut_config_hashes()
    manifest['nut_executables'] = nut_executable_hashes()
    manifest['nut_processes'] = run(['ps', '-C', 'usbhid-ups,upsd,snmpd', '-o', 'pid,lstart,args'])
    manifest['upsc'] = run(['upsc', 'ups@127.0.0.1'])
    manifest['hardware'] = {
        'hostname': platform.node(), 'kernel': platform.release(), 'architecture': platform.machine(),
        'os_release': Path('/etc/os-release').read_text(), 'memory': Path('/proc/meminfo').read_text(),
        'display': {str(path): path.read_text() for pattern in ('card*-DSI-*/status', 'card*-DSI-*/modes') for path in Path('/sys/class/drm').glob(pattern)},
        'timezone': run(['timedatectl', 'show', '-p', 'Timezone', '--value']),
    }
    manifest['peanut_private_inspect'] = run(['docker', 'inspect', 'ups-peanut'])
    manifest['peanut_ping'] = run(['curl', '--fail', '--silent', '--show-error', '--max-time', '3', 'http://127.0.0.1:8080/api/ping'])
    (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    # Read back both artifacts before advertising a usable backup.
    saved = json.loads((destination / 'manifest.json').read_text())
    if digest(destination / 'kiosk.tar') != saved['archive']['sha256']:
        raise SystemExit('Archive verification failed')
    if missing_required:
        raise SystemExit(f'Incomplete snapshot at {destination}; missing: {sorted(missing_required)}')
    print(json.dumps({'snapshot': str(destination), 'archive_sha256': saved['archive']['sha256'], 'saved_entries': len(saved['archive']['members']), 'profile_included': False, 'hostname': platform.node(), 'kernel': platform.release(), 'architecture': platform.machine(), 'peanut_healthy': manifest['peanut_ping']['returncode'] == 0}))


if __name__ == '__main__':
    main()
