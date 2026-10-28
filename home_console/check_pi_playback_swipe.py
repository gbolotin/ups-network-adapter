"""Inject actual Pi browser swipes while the zero-volume Bedroom queue is playing.

Never starts playback or changes volume. User-driven physical swipe proof is separate.
"""
import base64
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, '/usr/local/lib/ups-network-adapter')
from kiosk_cdp import Cdp, debugger_json
from kiosk_supervisor import READINESS


def main():
    page = next(p for p in debugger_json('/json/list') if p.get('type') == 'page' and p.get('url', '').startswith('http://192.168.50.117/home-console/'))
    paths = []
    with Cdp(page['webSocketDebuggerUrl']) as client:
        original = client.evaluate('location.href')

        def wait(expression):
            for _ in range(100):
                if client.evaluate(expression):
                    return
                time.sleep(.1)
            raise RuntimeError('Playback swipe condition timed out')

        def playing():
            return client.evaluate("(() => {const h=document.querySelector('home-assistant').hass;const p=h.states['media_player.bedroom_3'];return h.states['input_select.pi_console_player'].state==='media_player.bedroom_3' && p.state==='playing' && p.attributes.volume_level===0})()")

        try:
            client.call('Page.navigate', {'url': 'http://192.168.50.117/home-console/music-library?kiosk'})
            wait('(' + READINESS + ") === 'ready'")
            time.sleep(2)
            wait("(() => {const h=document.querySelector('home-assistant').hass;const p=h.states['media_player.bedroom_3'];return h.states['input_select.pi_console_player'].state==='media_player.bedroom_3' && p.state==='playing' && p.attributes.volume_level===0})()")
            for path in ('players', 'radio', 'ups'):
                client.call('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': 900, 'y': 200}]})
                for step in range(1, 9):
                    client.call('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': 900-100*step, 'y': 200}]})
                    time.sleep(.04)
                client.call('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
                wait('location.pathname===' + json.dumps('/home-console/' + path) + " && location.search==='?kiosk'")
                time.sleep(1)
                if not playing():
                    raise RuntimeError('Playback or selected room changed during navigation')
                paths.append(path)
            image = client.call('Page.captureScreenshot', {'format': 'png'})['data']
            Path('/var/backups/home-console/20261027T210523Z/pi-playback-swipe.png').write_bytes(base64.b64decode(image))
        finally:
            client.call('Page.navigate', {'url': original})
    print(json.dumps({'paths': paths, 'input': 'actual Pi browser, injected touch', 'playing_at_zero_volume_throughout': True}))


if __name__ == '__main__':
    main()
