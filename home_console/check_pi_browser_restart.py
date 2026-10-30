"""Live crash/hang acceptance for the one owned kiosk Chromium process group."""
import datetime
import json
import os
from pathlib import Path
import pwd
import re
import signal
import subprocess
import sys
import time
from urllib.parse import urlsplit

sys.path.insert(0, '/usr/local/lib/ups-network-adapter')
from kiosk_cdp import Cdp, debugger_json
from kiosk_supervisor import READINESS


def master():
    uid = pwd.getpwnam('upsdisplay').pw_uid
    matches = []
    for process in Path('/proc').glob('[0-9]*'):
        try:
            status = dict(line.split(':', 1) for line in (process / 'status').read_text().splitlines() if ':' in line)
            if int(status['Uid'].split()[0]) != uid:
                continue
            args = (process / 'cmdline').read_bytes()
            pid = int(process.name)
            profile = re.search(rb'(?:^|[\x00 ])--user-data-dir=/var/lib/ups-kiosk/chromium(?:[\x00 ]|$)', args)
            if profile and status.get('Name', '').strip() == 'chromium' and os.getpgid(pid) == pid:
                matches.append(pid)
        except (FileNotFoundError, ProcessLookupError):
            continue
    if len(matches) != 1:
        raise RuntimeError('Expected exactly one owned kiosk browser master')
    if os.getpgid(matches[0]) != matches[0]:
        raise RuntimeError('Expected the supervisor-owned browser process group')
    return matches[0]


def ready():
    for page in debugger_json('/json/list'):
        if page.get('type') != 'page' or urlsplit(page.get('url', '')).netloc != '192.168.50.117':
            continue
        with Cdp(page['webSocketDebuggerUrl']) as connection:
            if connection.evaluate(READINESS) == 'ready' and not connection.evaluate('document.hidden'):
                return True
    return False


def main():
    if os.geteuid() != 0:
        raise SystemExit('Run as root on the Pi')
    path = Path('/var/backups/home-console/20261027T210523Z/live-browser-restart-test.json')
    record = {'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'phases': []}
    with path.open('x') as output:
        json.dump(record, output)
    os.chmod(path, 0o600)
    if not ready():
        raise RuntimeError('Wait for the authenticated console before this test')
    for mode, event in [('crash', signal.SIGKILL), ('hang', signal.SIGSTOP)]:
        pid = master()
        start = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
        guardian = None
        if mode == 'hang':
            code = f"""import os,signal,time;from pathlib import Path
time.sleep(90)
p=Path('/proc/{pid}/stat')
if p.exists() and p.read_text().rsplit(')',1)[1].split()[19]=={start!r}:os.killpg({pid},signal.SIGCONT)
"""
            guardian = subprocess.Popen([sys.executable, '-c', code], start_new_session=True,
                                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        began = time.monotonic()
        try:
            os.killpg(pid, event)
            while time.monotonic() - began < 90:
                try:
                    current = master()
                    if current != pid and ready():
                        record['phases'].append({'case': mode, 'seconds': round(time.monotonic() - began, 2), 'old_pid': pid, 'new_pid': current})
                        path.write_text(json.dumps(record, indent=2))
                        print(json.dumps(record['phases'][-1]), flush=True)
                        break
                except (OSError, RuntimeError, KeyError, ValueError):
                    pass
                time.sleep(.5)
            else:
                raise RuntimeError('Browser recovery deadline missed: ' + mode)
        finally:
            if guardian:
                # Thaw only this still-existing owned group before disarming the guard.
                try:
                    identity = Path(f'/proc/{pid}/stat')
                    if identity.exists() and identity.read_text().rsplit(')', 1)[1].split()[19] == start:
                        os.killpg(pid, signal.SIGCONT)
                except ProcessLookupError:
                    pass
                guardian.terminate()
                guardian.wait(timeout=5)
    record['status'] = 'passed'
    path.write_text(json.dumps(record, indent=2))
    print(json.dumps({'browser_crash_and_hang_recovery': 'passed', 'ups_status': subprocess.run(['upsc', 'ups@localhost', 'ups.status'], capture_output=True, text=True).stdout.strip()}), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        raise SystemExit(str(error))
