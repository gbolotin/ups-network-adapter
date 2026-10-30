"""Verify both native HA theme modes from the Pi drawer and restore preferences."""
import base64
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, '/usr/local/lib/ups-network-adapter')
from kiosk_cdp import Cdp, debugger_json

DRAWER = "document.querySelector('home-console-control-drawer')"
ROOT = "document.querySelector('home-assistant')"


def main():
    page = next(p for p in debugger_json('/json/list') if p.get('type') == 'page'
                and p.get('url', '').startswith('http://192.168.50.117/'))
    with Cdp(page['webSocketDebuggerUrl']) as client:
        original_url = client.evaluate('location.href')
        original_theme = client.evaluate(f'{ROOT}.hass.selectedTheme') or {}
        record = {'physical_touch_tested': False, 'modes': []}

        def wait(expression):
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if client.evaluate(expression):
                    return
                time.sleep(.2)
            raise RuntimeError('Theme UI condition failed')

        def click(selector):
            box = client.evaluate(f"(() => {{const r={DRAWER}.shadowRoot.querySelector({json.dumps(selector)}).getBoundingClientRect();return {{x:r.x+r.width/2,y:r.y+r.height/2}}}})()")
            for kind, buttons in [('mousePressed', 1), ('mouseReleased', 0)]:
                client.call('Input.dispatchMouseEvent', {'type': kind, **box, 'button': 'left', 'buttons': buttons, 'clickCount': 1})

        def open_drawer():
            wait(f"!!{DRAWER}?.shadowRoot?.querySelector('#theme-mode')")
            click('.handle')
            wait(f"{DRAWER}.hasAttribute('open') && !{DRAWER}.themeSelect.disabled")

        try:
            client.call('Page.navigate', {'url': 'http://192.168.50.117/home-console/home?kiosk'})
            open_drawer()
            for mode, key in [('light', 'Home'), ('dark', 'End')]:
                click('#theme-mode')
                for name in [key, 'Enter']:
                    for kind in ['keyDown', 'keyUp']:
                        client.call('Input.dispatchKeyEvent', {'type': kind, 'key': name, 'code': name,
                                    'windowsVirtualKeyCode': {'Home': 36, 'End': 35, 'Enter': 13}[name]})
                wait(f"!{DRAWER}.themeSelect.disabled && {ROOT}.hass.themes.darkMode === {json.dumps(mode == 'dark')}")
                time.sleep(.5)
                color = client.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--primary-background-color').trim()")
                record['modes'].append({'mode': mode, 'background': color})
                picture = client.call('Page.captureScreenshot', {'format': 'png'})
                Path(f'/tmp/home-console-drawer-{mode}.png').write_bytes(base64.b64decode(picture['data']))
            client.call('Page.reload')
            wait(f"{ROOT}?.hass?.themes?.darkMode === true")
            open_drawer()
            assert client.evaluate(f'{DRAWER}.themeSelect.value') == 'dark'
            record['dark_persisted_after_reload'] = True
            assert record['modes'][0]['background'] != record['modes'][1]['background']
            record['passed'] = True
        finally:
            detail = '{theme:undefined,dark:undefined,...' + json.dumps(original_theme) + '}'
            client.evaluate(f"{ROOT}.dispatchEvent(new CustomEvent('settheme',{{detail:{detail},bubbles:true,composed:true}}))")
            time.sleep(1)
            client.call('Page.navigate', {'url': original_url})
        print(json.dumps(record))


if __name__ == '__main__':
    main()
