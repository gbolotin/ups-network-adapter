"""Implementation of setup.sh; uses the existing installer and standard library."""

import argparse
import ipaddress
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile
import time

from ups_autodetect import MARKER, scan_usb, write_config
from ups_mib import build_mib, oid, read_ups

PROJECT = Path(__file__).resolve().parent
SNMP_CONFIG = Path('/etc/ups-network-adapter/ups.conf')
NUT_SERVER_CONFIG = Path('/etc/nut/upsd.conf')
PLACEHOLDERS = {'REPLACE_WITH_RANDOM_SECRET', 'YOUR_GENERATED_SECRET'}


def read(path: Path) -> str:
    return path.read_text(encoding='utf-8') if path.exists() else ''


def private_config(path: Path, group: str) -> bool:
    import grp
    if not path.exists():
        return False
    info = path.stat()
    return info.st_uid == 0 and info.st_gid == grp.getgrnam(group).gr_gid and info.st_mode & 0o777 == 0o640


def nut_ready(directory: Path) -> bool:
    mode = [line.partition('#')[0].strip() for line in read(directory / 'nut.conf').splitlines()]
    server = [line.partition('#')[0].strip() for line in read(directory / 'upsd.conf').splitlines()]
    modes = [re.sub(r'\s+', '', line) for line in mode if re.match(r'^MODE\s*=', line)]
    allow = [line.split()[1:] for line in server if re.match(r'^ALLOW_NO_DEVICE\s', line)]
    age = [line.split()[1:] for line in server if re.match(r'^MAXAGE\s', line)]
    return (
        read(directory / 'ups.conf').startswith(MARKER)
        and bool(modes) and all(value == 'MODE=netserver' for value in modes)
        and bool(allow) and all(value in [['true'], ['yes'], ['on'], ['1']] for value in allow)
        and bool(age) and all(value == ['6'] for value in age)
        and any(re.fullmatch(r'LISTEN\s+(127\.0\.0\.1|0\.0\.0\.0|\*)(\s+3493)?', line) for line in server)
    )


def communities(content: str) -> list[list[str]]:
    entries = []
    for line in content.splitlines():
        fields = shlex.split(line, comments=True)
        if fields and fields[0] == 'rocommunity':
            if len(fields) < 2:
                raise ValueError('Malformed rocommunity setting')
            if fields[1] in PLACEHOLDERS:
                continue
            if not re.fullmatch(r'[A-Za-z0-9_.-]{1,255}', fields[1]):
                raise ValueError('Existing community uses unsupported quoting; keep it and configure SNMP manually')
            entries.append(fields)
    return entries


def setting(content: str, pattern: str, value: str) -> str:
    matches = [line for line in content.splitlines() if re.match(pattern, line)]
    if matches == [value]:
        return content
    lines = [line for line in content.splitlines() if not re.match(pattern, line)]
    return '\n'.join(lines).rstrip() + '\n' + value + '\n'


def prepare_nut_listener(content: str) -> str:
    return setting(content, r'^\s*LISTEN(?:\s|$)', 'LISTEN 0.0.0.0 3493')


def snmp_port(content: str) -> int:
    match = re.search(r'^\s*agentaddress\s+udp:(?:(?:\d{1,3}\.){3}\d{1,3}:)?(\d+)(?:,|\s*$)', content, re.MULTILINE)
    if not match or not 1 <= int(match[1]) <= 65535:
        raise ValueError('Expected an IPv4 UDP agentaddress in SNMP configuration')
    return int(match[1])


def prepare_snmp(current: str, legacy: list[str], template: str, manager: str | None) -> tuple[str, str, int]:
    content = current or template
    if not communities(current):
        content = next((old for old in legacy if communities(old)), content)
    entries = communities(content)
    # Remove active example credentials before enabling any LAN binding.
    content = '\n'.join(line for line in content.splitlines() if not (
        re.match(r'^\s*rocommunity\s+', line) and shlex.split(line, comments=True)[1] in PLACEHOLDERS
    )) + '\n'
    if not entries:
        content += 'rocommunity public default -V upsView\n'
    secret = entries[0][1] if entries else 'public'
    if not any(len(entry) >= 3 and entry[2] in {'127.0.0.1', '127.0.0.1/32'} for entry in entries):
        content += f'rocommunity {secret} 127.0.0.1/32 -V upsView\n'
    else:
        secret = next(entry[1] for entry in entries if len(entry) >= 3 and entry[2] in {'127.0.0.1', '127.0.0.1/32'})
    content = setting(content, r'^\s*sysName\s+', 'sysName ups-adapter')
    content = setting(content, r'^\s*pass_persist\s+\.?1\.3\.6\.1\.2\.1\.33\s+',
                      'pass_persist .1.3.6.1.2.1.33 /usr/bin/python3 -u /usr/local/lib/ups-network-adapter/ups_mib.py --ups ups')
    for subtree in ('1', '33'):
        view = f'view upsView included .1.3.6.1.2.1.{subtree}'
        if view not in content.splitlines():
            content += view + '\n'
    port = snmp_port(content)
    if port == 1161:
        # Migrate the former project default; preserve deliberate custom ports.
        port = 161
        content = setting(content, r'^\s*agentaddress\s+', 'agentaddress udp:0.0.0.0:161')
    if manager:
        manager = str(ipaddress.IPv4Address(manager))
        content = setting(content, r'^\s*agentaddress\s+', f'agentaddress udp:0.0.0.0:{port}')
        # Explicit manager mode replaces broad/previous IPv4 ACLs, not just adds
        # a rule that a default source could bypass. Keep the local probe working.
        content = '\n'.join(line for line in content.splitlines()
                            if not re.match(r'^\s*rocommunity(?:\s|$)', line)) + '\n'
        content += f'rocommunity {secret} 127.0.0.1/32 -V upsView\n'
        if manager != '127.0.0.1':
            content += f'rocommunity {secret} {manager}/32 -V upsView\n'
    elif not re.search(r'udp:(?:(127\.0\.0\.1|0\.0\.0\.0):)?' + str(port) + r'(,|\s|$)', content):
        match = re.search(r'^\s*agentaddress\s+(.+)$', content, re.MULTILINE)
        content = setting(content, r'^\s*agentaddress\s+', match[0].strip() + f',udp:127.0.0.1:{port}')
    return content, secret, port


def run(arguments: list[str], *, check: bool = True, **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(arguments, check=check, timeout=180, **kwargs)


def state(action: str, unit: str) -> str:
    result = run(['/usr/bin/systemctl', action, unit], check=False, capture_output=True, text=True)
    return result.stdout.strip()


def ensure_running(unit: str, restart: bool = False) -> None:
    if state('is-enabled', unit) == 'masked':
        run(['/usr/bin/systemctl', 'unmask', unit])
    if state('is-enabled', unit) not in {'enabled', 'static', 'indirect'}:
        run(['/usr/bin/systemctl', 'enable', unit])
    if restart or state('is-active', unit) != 'active':
        run(['/usr/bin/systemctl', 'restart', unit])


def snmp_probe(secret: str, port: int) -> int:
    # Credentials go through a private client config, not command arguments or logs.
    with tempfile.TemporaryDirectory(prefix='ups-snmp-check-') as directory:
        config = Path(directory) / 'snmp.conf'
        config.write_text(f'defCommunity {secret}\n', encoding='utf-8')
        config.chmod(0o600)
        result = run(
            ['/usr/bin/snmpget', '-v2c', '-t', '3', '-r', '1', '-Oqve', f'udp:127.0.0.1:{port}', '.1.3.6.1.2.1.33.1.4.1.0'],
            capture_output=True, text=True, env={**os.environ, 'SNMPCONFPATH': directory},
        )
        return int(result.stdout.strip())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Report state without making changes')
    parser.add_argument('--manager', type=ipaddress.IPv4Address, help='Restrict IPv4 community access to loopback and this monitoring machine')
    args = parser.parse_args()
    print('Pi:', read(Path('/proc/device-tree/model')).strip('\x00\n') or 'model unavailable', flush=True)
    temperature = run(['vcgencmd', 'measure_temp'], check=False, capture_output=True, text=True) if shutil.which('vcgencmd') else None
    if temperature:
        print('Temperature:', temperature.stdout.strip(), flush=True)

    ready = nut_ready(Path('/etc/nut')) and all(private_config(Path('/etc/nut') / name, 'nut') for name in ('nut.conf', 'ups.conf', 'upsd.conf'))
    listener_changed = read(NUT_SERVER_CONFIG) != prepare_nut_listener(read(NUT_SERVER_CONFIG))
    desired, secret, port = prepare_snmp(
        read(SNMP_CONFIG), [read(SNMP_CONFIG.with_name(name + '.conf')) for name in ('apc', 'eaton')],
        read(PROJECT / 'config/ups.conf'), str(args.manager) if args.manager else None,
    )
    files = {
        PROJECT / 'ups_autodetect.py': Path('/usr/local/lib/ups-network-adapter/ups_autodetect.py'),
        PROJECT / 'ups_mib.py': Path('/usr/local/lib/ups-network-adapter/ups_mib.py'),
        PROJECT / 'ups_mcp.py': Path('/usr/local/lib/ups-network-adapter/ups_mcp.py'),
        PROJECT / 'config/ups-autodetect.service': Path('/etc/systemd/system/ups-autodetect.service'),
        PROJECT / 'config/ups-snmp.service': Path('/etc/systemd/system/ups-snmp.service'),
    }
    changed = {source.name for source, target in files.items() if read(source) != read(target)}
    snmp_changed = read(SNMP_CONFIG) != desired
    issues = []
    if not ready:
        issues.append('NUT configuration needs setup')
    if listener_changed:
        issues.append('NUT listener needs LISTEN 0.0.0.0 3493')
    if changed:
        issues.append('Installed project files need updating')
    if snmp_changed:
        issues.append('SNMP configuration needs setup')
    if not private_config(SNMP_CONFIG, 'Debian-snmp'):
        issues.append('SNMP file permissions need fixing')
    for unit in ('ups-autodetect.service', 'ups-snmp.service', 'nut-server.service', 'nut-driver.target'):
        if state('is-active', unit) != 'active' or state('is-enabled', unit) != 'enabled':
            issues.append(f'{unit} needs enabling or starting')
    if state('is-enabled', 'nut-monitor.service') != 'masked' or state('is-active', 'nut-monitor.service') == 'active':
        issues.append('Automatic shutdown monitor needs masking')
    if state('is-enabled', 'nut-driver-enumerator.path') == 'enabled' or state('is-active', 'nut-driver-enumerator.path') == 'active':
        issues.append('Driver file watcher needs disabling')
    for unit in ('ups-snmp@apc.service', 'ups-snmp@eaton.service'):
        if state('is-enabled', unit) == 'enabled' or state('is-active', unit) == 'active':
            issues.append(f'Legacy endpoint {unit} needs disabling')
    if port == 161 and (state('is-enabled', 'snmpd.service') == 'enabled' or state('is-active', 'snmpd.service') == 'active'):
        issues.append('Distro snmpd needs disabling to release UDP 161')

    for issue in issues:
        print('Needs attention:', issue, flush=True)
    if args.check:
        if issues:
            return 1
    else:
        if not ready or changed or not SNMP_CONFIG.exists():
            run(['/bin/bash', str(PROJECT / 'install.sh'), *([] if ready else ['--configure-nut'])])
        # Reread after installation so a fresh setup's other NUT settings survive.
        current_nut = read(NUT_SERVER_CONFIG)
        desired_nut = prepare_nut_listener(current_nut)
        listener_changed = current_nut != desired_nut
        if listener_changed:
            backup = Path(tempfile.mkdtemp(prefix='ups-adapter-backup-nut-', dir='/root'))
            shutil.copy2(NUT_SERVER_CONFIG, backup / 'upsd.conf')
            write_config(NUT_SERVER_CONFIG, desired_nut, group='nut')
            print('NUT listener configuration backup:', backup, flush=True)
        if snmp_changed:
            backup = Path(tempfile.mkdtemp(prefix='ups-adapter-backup-snmp-', dir='/root'))
            shutil.copy2(SNMP_CONFIG, backup / 'ups.conf')
            write_config(SNMP_CONFIG, desired, group='Debian-snmp')
            print('SNMP configuration backup:', backup, flush=True)
        if not private_config(SNMP_CONFIG, 'Debian-snmp'):
            import grp
            os.chown(SNMP_CONFIG, 0, grp.getgrnam('Debian-snmp').gr_gid)
            SNMP_CONFIG.chmod(0o640)
        for unit in ('ups-snmp@apc.service', 'ups-snmp@eaton.service'):
            if state('is-enabled', unit) == 'enabled' or state('is-active', unit) == 'active':
                run(['/usr/bin/systemctl', 'disable', '--now', unit])
        if state('is-enabled', 'nut-monitor.service') != 'masked' or state('is-active', 'nut-monitor.service') == 'active':
            run(['/usr/bin/systemctl', 'mask', '--now', 'nut-monitor.service'])
        if state('is-enabled', 'nut-driver-enumerator.path') == 'enabled' or state('is-active', 'nut-driver-enumerator.path') == 'active':
            run(['/usr/bin/systemctl', 'disable', '--now', 'nut-driver-enumerator.path'])
        if port == 161 and (state('is-enabled', 'snmpd.service') == 'enabled' or state('is-active', 'snmpd.service') == 'active'):
            run(['/usr/bin/systemctl', 'disable', '--now', 'snmpd.service'])
        native_repair = False
        for unit in ('nut-server.service', 'nut-driver.target'):
            if state('is-enabled', unit) == 'masked':
                run(['/usr/bin/systemctl', 'unmask', unit])
            if state('is-enabled', unit) not in {'enabled', 'static', 'indirect'}:
                run(['/usr/bin/systemctl', 'enable', unit])
            native_repair |= state('is-active', unit) != 'active'
        if listener_changed:
            ensure_running('nut-server.service', restart=True)
        ensure_running('ups-autodetect.service', ready and (native_repair or bool(changed & {'ups_autodetect.py', 'ups-autodetect.service'})))
        ensure_running('ups-snmp.service', snmp_changed or bool(changed & {'ups_mib.py', 'ups-snmp.service'}))

    values = {}
    detected = scan_usb()
    if detected[0] == MARKER and detected[2] != 'No supported USB UPS detected':
        raise ValueError(detected[2])
    deadline = time.monotonic() + (45 if not args.check and issues and detected[0] != MARKER else 0)
    while True:
        try:
            values = read_ups('ups')
            break
        except (OSError, subprocess.SubprocessError, ValueError):
            if time.monotonic() >= deadline:
                break
            print('Waiting for USB detection and driver startup...', flush=True)
            time.sleep(3)
    if values:
        print('UPS:', values.get('ups.model', values.get('device.model', '?')), flush=True)
        print('NUT status:', values['ups.status'], flush=True)
        print('Battery charge:', values.get('battery.charge', 'unavailable'), '%', flush=True)
    else:
        print('NUT: no live readings; connect one supported UPS or inspect journalctl -u ups-autodetect -u nut-server -b', flush=True)
        if detected[0] != MARKER:
            raise ValueError('USB UPS detected, but NUT is not returning live readings')
    source = snmp_probe(secret, port)
    expected = build_mib(values, 'ups', 0)[oid('4.1.0')][1]
    if source != expected:
        raise ValueError(f'SNMP source {source} differs from NUT source {expected}')
    print(f'SNMP local check passed on UDP {port}; output source = {source}', flush=True)
    print('NUT listens on all IPv4 interfaces at TCP 3493 (including loopback).', flush=True)
    print('Configuration: /etc/ups-network-adapter/ups.conf (community is kept private)', flush=True)
    if not args.manager:
        print('To restrict IPv4 community access: sudo bash setup.sh --manager MONITORING_PC_IP', flush=True)
    print('Setup checks passed.' if values else 'Software checks passed; USB readings still need verification.', flush=True)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        print(f'Setup failed: {error}', flush=True)
        raise SystemExit(1)
