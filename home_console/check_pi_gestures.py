"""Quiet actual-browser slider/queue gesture checks, restoring the fresh baseline."""
import datetime
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, '/usr/local/lib/ups-network-adapter')
from kiosk_cdp import Cdp, debugger_json

ROOT = Path('/var/backups/home-console/20261027T210523Z')
PLAYER = 'media_player.bedroom_3'
HELPER = 'input_select.pi_console_player'
FIND = "function find(r,s){let a=[...r.querySelectorAll(s)];for(const n of r.querySelectorAll('*'))if(n.shadowRoot)a.push(...find(n.shadowRoot,s));return a;}"


def main():
    page = next(p for p in debugger_json('/json/list') if p.get('type') == 'page' and p.get('url', '').startswith('http://192.168.50.117/home-console/'))
    record = {'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'status': 'running'}
    path = ROOT / 'pi-gesture-acceptance.json'
    if path.exists():
        raise RuntimeError('Inspect the existing gesture journal before repeating')
    with Cdp(page['webSocketDebuggerUrl']) as client:
        def state(entity, attribute=None):
            suffix = '.state' if attribute is None else '.attributes[' + json.dumps(attribute) + ']'
            return client.evaluate("document.querySelector('home-assistant').hass.states[" + json.dumps(entity) + ']' + suffix)

        def service(domain, action, data):
            response = client.call('Runtime.evaluate', {'expression': "document.querySelector('home-assistant').hass.callService(" + ','.join(map(json.dumps, (domain, action, data))) + ').then(()=>true)', 'awaitPromise': True, 'returnByValue': True})
            if response.get('exceptionDetails') or response.get('result', {}).get('value') is not True:
                raise RuntimeError('Acceptance service failed')

        def wait(predicate):
            for _ in range(100):
                if predicate():
                    return
                time.sleep(.1)
            raise RuntimeError('Gesture acceptance readback timed out')

        def drag(start, end, y):
            client.call('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': start, 'y': y}]})
            for step in range(1, 13):
                client.call('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': start+(end-start)*step/12, 'y': y}]})
                time.sleep(.04)
            client.call('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
            time.sleep(1)

        original = state(HELPER)
        volume = state(PLAYER, 'volume_level')
        if state(PLAYER) != 'idle' or not isinstance(volume, (float, int)) or volume < .4:
            raise RuntimeError('This quiet test requires the inspected idle Bedroom baseline at 40% or higher')
        record.update({'helper_before': original, 'bedroom_volume_before': volume})
        path.write_text(json.dumps(record, indent=2))
        owned_volume = None
        try:
            service('input_select', 'select_option', {'entity_id': HELPER, 'option': PLAYER})
            wait(lambda: state(HELPER) == PLAYER)
            client.call('Page.navigate', {'url': 'http://192.168.50.117/home-console/now-playing?kiosk'})
            time.sleep(4)
            slider = client.evaluate('(() => {' + FIND + "const n=find(document,'ha-control-slider').find(n=>n.getBoundingClientRect().width>0);if(!n)return null;const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()")
            if not slider or state(PLAYER) != 'idle' or state(PLAYER, 'volume_level') != volume:
                raise RuntimeError('Player or slider changed before the test')
            owned_volume = .08
            drag(slider['x']+slider['width']*volume, slider['x']+slider['width']*.08, slider['y']+slider['height']/2)
            wait(lambda: state(PLAYER, 'volume_level') < .15)
            owned_volume = state(PLAYER, 'volume_level')
            if client.evaluate('location.pathname') != '/home-console/now-playing':
                raise RuntimeError('Volume drag navigated away from Now Playing')
            record['slider'] = {'volume_after_drag': owned_volume, 'view_unchanged': True}
            service('media_player', 'volume_set', {'entity_id': PLAYER, 'volume_level': volume})
            wait(lambda: abs(state(PLAYER, 'volume_level')-volume) < .005)
            owned_volume = None
            client.call('Page.navigate', {'url': 'http://192.168.50.117/home-console/music-library?kiosk'})
            time.sleep(4)
            client.evaluate('(() => {' + FIND + "find(document,'home-console-queue')[0].scrollIntoView({block:'center'})})()")
            time.sleep(.5)
            rectangle = client.evaluate('(() => {' + FIND + "const r=find(document,'home-console-queue')[0].getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()")
            drag(rectangle['x']+rectangle['width']*.8, rectangle['x']+rectangle['width']*.2, max(12, min(580, rectangle['y']+rectangle['height']/2)))
            if client.evaluate('location.pathname') != '/home-console/music-library':
                raise RuntimeError('Queue gesture navigated away from the library')
            record['queue'] = {'view_unchanged': True}
            record['status'] = 'passed'
        finally:
            if owned_volume is not None and state(PLAYER) == 'idle' and abs(state(PLAYER, 'volume_level')-owned_volume) < .005:
                service('media_player', 'volume_set', {'entity_id': PLAYER, 'volume_level': volume})
                wait(lambda: abs(state(PLAYER, 'volume_level')-volume) < .005)
            if state(HELPER) == PLAYER:
                service('input_select', 'select_option', {'entity_id': HELPER, 'option': original})
                wait(lambda: state(HELPER) == original)
            record['helper_after'] = state(HELPER)
            record['bedroom_volume_after'] = state(PLAYER, 'volume_level')
            client.call('Page.navigate', {'url': 'http://192.168.50.117/home-console/ups?kiosk'})
            path.write_text(json.dumps(record, indent=2))
    print(json.dumps(record))


if __name__ == '__main__':
    main()
