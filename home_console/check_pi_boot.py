"""Operator-side two-reboot acceptance with bounded SSH and private evidence."""
import argparse
import json
from pathlib import Path
import subprocess
import time

SSH = ['ssh', '-i', str(Path.home() / '.ssh/ups_adapter_admin'), '-o', 'IdentitiesOnly=yes',
       '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', 'upsadmin@192.168.50.200']
REMOTE = '/var/backups/home-console/20261027T210523Z/operator-stage/kiosk_health.py'


def health():
    run = subprocess.run(SSH + ['sudo', '-n', 'python3', REMOTE], capture_output=True, text=True, timeout=20)
    if run.returncode:
        raise RuntimeError('Pi health connection unavailable')
    return json.loads(run.stdout)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    repository = Path(__file__).resolve().parent.parent
    if output.is_relative_to(repository):
        raise RuntimeError('Keep operational evidence outside the checkout')
    record = {'status': 'running', 'reboots': [], 'before': health()}
    with output.open('x') as stream:
        json.dump(record, stream, indent=2)
    if not record['before']['healthy']:
        raise RuntimeError('Inspect current Pi health before reboot')
    previous = record['before']['boot_id']
    for index in range(2):
        began = time.monotonic()
        reboot = subprocess.run(SSH + ['sudo', '-n', 'systemctl', 'reboot'], capture_output=True, timeout=15)
        if reboot.returncode:
            raise RuntimeError('Reboot request failed; inspect Pi before retrying')
        stable = 0
        while time.monotonic() - began < 180:
            time.sleep(3)
            try:
                state = health()
                stable = stable + 1 if state['boot_id'] != previous and state['healthy'] else 0
                if stable >= 3:
                    break
            except (RuntimeError, subprocess.TimeoutExpired, json.JSONDecodeError):
                stable = 0
        else:
            record['status'] = 'failed'
            output.write_text(json.dumps(record, indent=2))
            raise RuntimeError('Reboot did not return to stable authenticated HA within three minutes')
        previous = state['boot_id']
        record['reboots'].append({'number': index + 1, 'ready_seconds': round(time.monotonic() - began, 2), 'health': state})
        output.write_text(json.dumps(record, indent=2))
        print(json.dumps({'reboot': index + 1, 'ready_seconds': record['reboots'][-1]['ready_seconds'], 'authenticated_ha': True, 'ups': state['ups_status']}), flush=True)
    record['status'] = 'passed'
    output.write_text(json.dumps(record, indent=2))


if __name__ == '__main__':
    main()
