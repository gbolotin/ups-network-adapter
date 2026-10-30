"""Read-only Pi acceptance sample. Never exports page contents or credentials."""
import datetime
import json
import os
from pathlib import Path
import pwd
import subprocess
import sys

sys.path.insert(0, '/usr/local/lib/ups-network-adapter')
from kiosk_cdp import Cdp, debugger_json
from kiosk_supervisor import READINESS

UNITS = ('ups-kiosk.service', 'ups-kiosk-screen.service', 'nut-driver@ups.service',
         'nut-server.service', 'ups-autodetect.service', 'ups-snmp.service',
         'ups-kiosk-login.timer', 'docker.service', 'ups-web.service')


def command(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=8)
    return result.stdout.strip() if result.returncode == 0 else 'unavailable'


def sample():
    result = {'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
              'services': {unit: command('systemctl', 'is-active', unit) for unit in UNITS},
              'ups_status': command('upsc', 'ups@localhost', 'ups.status'),
              'temperature_c': int(Path('/sys/class/thermal/thermal_zone0/temp').read_text()) / 1000,
              'ha': {'state': 'unavailable'}, 'kiosk_pss_kib': 0, 'kiosk_processes': 0}
    memory = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
    result['mem_available_kib'] = int(memory['MemAvailable'].split()[0])
    uid = pwd.getpwnam('upsdisplay').pw_uid
    for process in Path('/proc').glob('[0-9]*'):
        try:
            if process.stat().st_uid != uid:
                continue
            result['kiosk_processes'] += 1
            for line in (process / 'smaps_rollup').read_text().splitlines():
                if line.startswith('Pss:'):
                    result['kiosk_pss_kib'] += int(line.split()[1])
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    for device in Path('/sys/class/backlight').glob('*'):
        result['brightness'] = int((device / 'brightness').read_text())
        break
    try:
        for page in debugger_json('/json/list'):
            if page.get('type') != 'page' or not page.get('url', '').startswith('http://192.168.50.117/'):
                continue
            with Cdp(page['webSocketDebuggerUrl']) as client:
                result['ha'] = {'state': client.evaluate(READINESS),
                                'visible': not client.evaluate('document.hidden'),
                                'viewport': client.evaluate('({width:innerWidth,height:innerHeight,scale:devicePixelRatio})'),
                                'ups': client.evaluate("document.querySelector('home-assistant')?.hass?.states?.['sensor.connected_ups_status']?.state ?? document.querySelector('home-assistant')?.hass?.states?.['sensor.ups_apc_status_data']?.state ?? null")}
                break
    except (OSError, RuntimeError, KeyError, ValueError):
        pass
    result['healthy'] = (all(result['services'][unit] == 'active' for unit in UNITS)
                         and result['ups_status'] == 'OL' and result['ha']['state'] == 'ready'
                         and result['ha'].get('ups') == result['ups_status']
                         and result['ha'].get('visible') is True)
    return result


if __name__ == '__main__':
    print(json.dumps(sample()))
