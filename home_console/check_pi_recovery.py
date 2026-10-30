"""Live, bounded recovery acceptance. Uses only an owned temporary nft table.

Run as root on the Pi. Restricts upsdisplay -> HA:80/local:8080 only. NUT,
SSH, other accounts, and household HA access remain available. A detached
cleanup process removes this exact new table if the test is interrupted.
"""
import datetime
import json
import os
from pathlib import Path
import pwd
import secrets
import shutil
import signal
import subprocess
import sys
import time
from urllib.parse import urlsplit

sys.path.insert(0, '/usr/local/lib/ups-network-adapter')
from kiosk_cdp import Cdp, debugger_json
from kiosk_supervisor import READINESS


def main():
    if os.geteuid() != 0 or not shutil.which('nft'):
        raise SystemExit('Root and the existing nft tool are required; install nothing')
    root = Path('/var/backups/home-console/20261027T210523Z')
    record_path = root / 'live-recovery-test.json'
    with record_path.open('x') as stream:
        json.dump({'status': 'preparing', 'utc': datetime.datetime.now(datetime.timezone.utc).isoformat()}, stream)
    os.chmod(record_path, 0o600)
    uid = pwd.getpwnam('upsdisplay').pw_uid
    table = 'home_console_test_' + secrets.token_hex(4)
    nft = shutil.which('nft')
    if subprocess.run([nft, 'list', 'table', 'inet', table], capture_output=True).returncode == 0:
        raise SystemExit('Refusing an existing network-test table')
    cleanup_code = "import time,subprocess;time.sleep(180);subprocess.run(" + repr([nft, 'delete', 'table', 'inet', table]) + ",stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)"
    guardian = subprocess.Popen([sys.executable, '-c', cleanup_code], start_new_session=True,
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    created = False
    record = {'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'owned_table': table, 'phases': []}

    def save():
        record_path.write_text(json.dumps(record, indent=2))

    def command(text):
        result = subprocess.run([nft, '-f', '-'], input=text + '\n', text=True, capture_output=True)
        if result.returncode:
            record['setup_diagnostic'] = result.stderr[:1600]
            save()
            raise RuntimeError('Scoped network test command failed')

    def pages():
        return [p for p in debugger_json('/json/list') if p.get('type') == 'page']

    def matching(predicate):
        for page in pages():
            with Cdp(page['webSocketDebuggerUrl']) as client:
                if client.evaluate(predicate):
                    return page
        return None

    def wait_for(predicate, timeout, label):
        began = time.monotonic()
        while time.monotonic() - began < timeout:
            try:
                value = predicate()
                if value:
                    seconds = round(time.monotonic() - began, 2)
                    record['phases'].append({'check': label, 'seconds': seconds})
                    save()
                    print(json.dumps({'passed': label, 'seconds': seconds}), flush=True)
                    return value
            except (OSError, RuntimeError, KeyError, ValueError):
                pass
            time.sleep(.5)
        raise RuntimeError('Recovery deadline missed: ' + label)

    try:
        initial = wait_for(lambda: matching("location.origin==='http://192.168.50.117' && !document.hidden && (" + READINESS + ")==='ready'") , 15, 'initial HA visible')
        command(f'''table inet {table} {{
 chain output {{
  type filter hook output priority 0;
  policy accept;
  meta skuid {uid} ip daddr 192.168.50.117 tcp dport 80 reject;
 }}
}}''')
        created = True
        # Exercise an actual browser error during navigation, with other users' HA intact.
        with Cdp(initial['webSocketDebuggerUrl']) as client:
            client.call('Page.reload', {'ignoreCache': True})
        local = wait_for(lambda: matching("location.origin==='http://127.0.0.1:8080' && !document.hidden && !!document.getElementById('home-console-status')"), 60, 'HA failure -> visible local UPS')
        command(f'add rule inet {table} output meta skuid {uid} ip daddr 127.0.0.1 tcp dport 8080 reject')
        wait_for(lambda: matching("location.protocol==='file:' && !document.hidden && document.body.textContent.includes('No live UPS reading')"), 30, 'both displays unavailable -> visible offline screen')
    finally:
        if subprocess.run([nft, 'list', 'table', 'inet', table], capture_output=True).returncode == 0:
            subprocess.run([nft, 'delete', 'table', 'inet', table], check=True, capture_output=True)
        guardian.terminate()
        guardian.wait(timeout=5)
        record['network_rules_removed'] = True
        save()
    page = wait_for(lambda: matching("location.origin==='http://192.168.50.117' && !document.hidden && (" + READINESS + ")==='ready'"), 120, 'HA recovery -> authenticated console')
    with Cdp(page['webSocketDebuggerUrl']) as client:
        if client.evaluate(READINESS) != 'ready':
            raise RuntimeError('Returned HA page is not authenticated and ready')
    record['ups_status'] = subprocess.run(['upsc', 'ups@localhost', 'ups.status'], check=True, capture_output=True, text=True).stdout.strip()
    if record['ups_status'] != 'OL':
        raise RuntimeError('Inspect UPS state after the test')
    record['status'] = 'passed'
    save()
    print(json.dumps({'live_recovery_passed': True, 'owned_rules_removed': True, 'ups_status': 'OL'}), flush=True)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit('Test interrupted')))
    try:
        main()
    except Exception as error:
        raise SystemExit(str(error))
