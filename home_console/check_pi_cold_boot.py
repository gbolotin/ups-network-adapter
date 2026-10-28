"""Observe the one-use blocked-HA boot, remove its fixture, verify normal return."""
import base64
import datetime
import json
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path('/var/backups/home-console/20261027T210523Z')
sys.path.insert(0, '/usr/local/lib/ups-network-adapter')
sys.path.insert(0, str(ROOT / 'operator-stage'))
from kiosk_cdp import Cdp, debugger_json
from kiosk_supervisor import READINESS
from check_pi_boot_block import remove


def run(*args):
    return subprocess.run(args, capture_output=True, text=True, timeout=20)


def main():
    record = {'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'status': 'running', 'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
    record_path = ROOT / 'cold-boot-acceptance.json'
    if record_path.exists():
        raise RuntimeError('Inspect existing cold-boot evidence before repeating')
    record_path.write_text(json.dumps(record, indent=2))
    run('systemctl', 'disable', '--now', 'ups-kiosk-observe.service')
    try:
        if run('systemctl', 'is-active', 'ups-kiosk-acceptance-block.service').stdout.strip() != 'active':
            raise RuntimeError('Cold-boot fixture did not start')
        began = time.monotonic()
        local_ready_at = None
        while time.monotonic()-began < 100:
            if run('curl', '--fail', '--silent', '--max-time', '2', 'http://127.0.0.1:8080/api/ping').returncode == 0:
                local_ready_at = local_ready_at or time.monotonic()
            try:
                for page in debugger_json('/json/list'):
                    if page.get('type') == 'page' and page.get('url', '').startswith('http://127.0.0.1:8080/device/ups'):
                        with Cdp(page['webSocketDebuggerUrl']) as client:
                            if client.evaluate("!document.hidden && document.body.innerText.includes('Online') && document.body.innerText.includes('UPS Data')"):
                                service_at = int(run('systemctl', 'show', 'ups-kiosk.service', '-p', 'ActiveEnterTimestampMonotonic', '--value').stdout) / 1000000
                                record['local_screen_seconds_from_kiosk_active'] = round(time.monotonic()-service_at, 2)
                                record['local_screen_seconds_from_first_peanut_ping'] = round(time.monotonic()-(local_ready_at or time.monotonic()), 2)
                                record['fallback_authenticated'] = True
                                record_path.write_text(json.dumps(record, indent=2))
                                (ROOT / 'cold-boot-local-ups.png').write_bytes(base64.b64decode(client.call('Page.captureScreenshot', {'format': 'png'})['data']))
                                break
                else:
                    time.sleep(.5)
                    continue
                break
            except (OSError, RuntimeError, KeyError, ValueError):
                time.sleep(.5)
        else:
            raise RuntimeError('Blocked-HA boot did not show usable local UPS')
    finally:
        remove()
        run('systemctl', 'disable', '--now', 'ups-kiosk-acceptance-block.service')
        run('systemctl', 'stop', 'ups-kiosk-acceptance-unblock.timer')
        unit = Path('/etc/systemd/system/ups-kiosk-acceptance-block.service')
        reference = ROOT / 'operator-stage/ups-kiosk-acceptance-block.service'
        if unit.exists() and reference.exists() and unit.read_bytes() == reference.read_bytes():
            unit.unlink()
        run('systemctl', 'daemon-reload')
        record['fixture_removed'] = True
        record_path.write_text(json.dumps(record, indent=2))
    began = time.monotonic()
    while time.monotonic()-began < 120:
        for page in debugger_json('/json/list'):
            if page.get('type') != 'page' or not page.get('url', '').startswith('http://192.168.50.117/'):
                continue
            with Cdp(page['webSocketDebuggerUrl']) as client:
                if client.evaluate(READINESS) != 'ready' or client.evaluate('document.hidden'):
                    continue
                selected = client.evaluate("document.querySelector('home-assistant').hass.states['input_select.pi_console_player'].state")
                if selected != 'media_player.bedroom_3':
                    raise RuntimeError('Non-default room did not survive the Pi reboot')
                record['non_default_room_survived_reboot'] = selected
                response = client.call('Runtime.evaluate', {'expression': "document.querySelector('home-assistant').hass.callService('input_select','select_option',{entity_id:'input_select.pi_console_player',option:'media_player.denon_avc_x4700h_3'}).then(()=>true)", 'awaitPromise': True, 'returnByValue': True})
                if response.get('exceptionDetails'):
                    raise RuntimeError('Selected room restoration failed')
                record['ha_return_seconds'] = round(time.monotonic()-began, 2)
                record['ups_status'] = run('upsc', 'ups@localhost', 'ups.status').stdout.strip()
                record['status'] = 'passed'
                record_path.write_text(json.dumps(record, indent=2))
                print(json.dumps(record))
                return
        time.sleep(.5)
    raise RuntimeError('HA did not return after cold-boot fixture removal')


if __name__ == '__main__':
    main()
