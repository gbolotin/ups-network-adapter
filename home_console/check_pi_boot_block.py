"""One-use, kiosk-UID-only cold-boot failure fixture with timed automatic cleanup."""
import argparse
import datetime
import json
import os
from pathlib import Path
import pwd
import subprocess

ROOT = Path('/var/backups/home-console/20261027T210523Z')
TABLE = 'home_console_boot_acceptance'
NFT = '/usr/sbin/nft'


def remove():
    if subprocess.run([NFT, 'list', 'table', 'inet', TABLE], capture_output=True).returncode == 0:
        subprocess.run([NFT, 'delete', 'table', 'inet', TABLE], capture_output=True, check=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--remove', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError('Root-only acceptance fixture')
    os.umask(0o077)
    if args.remove:
        remove()
        return
    # Refuse repeat application on later boots, even if cleanup was interrupted.
    with (ROOT / 'cold-boot-fixture-used.json').open('x') as output:
        json.dump({'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}, output)
    if subprocess.run([NFT, 'list', 'table', 'inet', TABLE], capture_output=True).returncode == 0:
        raise RuntimeError('Acceptance table already exists')
    uid = pwd.getpwnam('upsdisplay').pw_uid
    rules = f'table inet {TABLE} {{\n chain output {{\n type filter hook output priority 0; policy accept;\n meta skuid {uid} ip daddr 192.168.50.117 tcp dport 80 reject\n }}\n}}\n'
    try:
        subprocess.run([NFT, '-f', '-'], input=rules, text=True, capture_output=True, check=True)
        subprocess.run(['systemd-run', '--unit=ups-kiosk-acceptance-unblock', '--on-active=150s',
                        '/usr/bin/python3', str(ROOT / 'operator-stage/check_pi_boot_block.py'), '--remove'], capture_output=True, check=True)
        subprocess.run(['systemd-run', '--unit=ups-kiosk-cold-observer', '--on-active=2s',
                        '/usr/bin/python3', str(ROOT / 'operator-stage/check_pi_cold_boot.py')], capture_output=True, check=True)
    except BaseException:
        remove()
        raise


if __name__ == '__main__':
    main()
