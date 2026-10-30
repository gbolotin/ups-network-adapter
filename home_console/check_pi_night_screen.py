"""Toggle the real drawer using the existing kiosk session; restore its setting."""
import base64
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, '/usr/local/lib/ups-network-adapter')
from kiosk_cdp import Cdp, debugger_json
from screen_settings import read_night_blanking

DRAWER = "document.querySelector('home-console-control-drawer')"


def main():
    page = next(p for p in debugger_json('/json/list') if p.get('type') == 'page'
                and p.get('url', '').startswith('http://192.168.50.117/'))
    original_setting = read_night_blanking()
    light = Path('/sys/class/backlight/10-0045/brightness')
    record = {'initial_enabled': original_setting, 'brightness_before': int(light.read_text()),
              'physical_touch_tested': False}
    with Cdp(page['webSocketDebuggerUrl']) as client:
        original_url = client.evaluate('location.href')

        def wait(expression):
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if client.evaluate(expression):
                    return
                time.sleep(.2)
            raise RuntimeError('Night screen UI condition failed')

        def click(selector):
            rect = client.evaluate(f"(() => {{const r={DRAWER}.shadowRoot.querySelector({json.dumps(selector)}).getBoundingClientRect();return {{x:r.x+r.width/2,y:r.y+r.height/2}}}})()")
            for kind, buttons in [('mousePressed', 1), ('mouseReleased', 0)]:
                client.call('Input.dispatchMouseEvent', {'type': kind, **rect, 'button': 'left', 'buttons': buttons, 'clickCount': 1})

        def open_drawer():
            wait(f"!!{DRAWER}?.shadowRoot?.querySelector('#night-blanking')")
            click('.handle')
            wait(f"{DRAWER}.hasAttribute('open') && !{DRAWER}.nightToggle.disabled")

        try:
            client.call('Page.navigate', {'url': 'http://192.168.50.117/home-console/home?kiosk'})
            open_drawer()
            assert client.evaluate(f"{DRAWER}.nightToggle.checked") == original_setting
            # Ensure the visible UI actually writes both states using ordinary kiosk access.
            for enabled in [False, True, False]:
                if client.evaluate(f"{DRAWER}.nightToggle.checked") != enabled:
                    click('#night-blanking')
                wait(f"!{DRAWER}.nightToggle.disabled && {DRAWER}.nightConfirmed === {json.dumps(enabled)}")
                assert read_night_blanking() == enabled
            time.sleep(.5)
            record['brightness_when_disabled'] = int(light.read_text())
            assert record['brightness_when_disabled'] > 0
            client.call('Page.reload')
            open_drawer()
            assert client.evaluate(f"{DRAWER}.nightToggle.checked") is False
            record['persisted_after_browser_reload'] = True
            if original_setting:
                click('#night-blanking')
                wait(f"!{DRAWER}.nightToggle.disabled && {DRAWER}.nightConfirmed === true")
            record['restored_enabled'] = read_night_blanking()
            assert record['restored_enabled'] == original_setting
            image = client.call('Page.captureScreenshot', {'format': 'png'})
            Path('/tmp/home-console-night-screen.png').write_bytes(base64.b64decode(image['data']))
            record['passed'] = True
            print(json.dumps(record))
        finally:
            if read_night_blanking() != original_setting:
                client.evaluate(f"{DRAWER}.nightToggle.checked={json.dumps(original_setting)};void {DRAWER}.changeNightBlanking()")
                wait(f"!{DRAWER}.nightToggle.disabled && {DRAWER}.nightConfirmed === {json.dumps(original_setting)}")
            client.call('Page.navigate', {'url': original_url})


if __name__ == '__main__':
    main()
