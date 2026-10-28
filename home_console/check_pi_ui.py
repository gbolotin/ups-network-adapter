"""Exercise actual kiosk navigation/search with injected Chromium touch input.

This checks the running Pi browser, not the physical touch sensor or wake contact.
No player, queue, or household-device action is invoked.
"""
import base64
import datetime
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, '/usr/local/lib/ups-network-adapter')
from kiosk_cdp import Cdp, debugger_json
from kiosk_supervisor import READINESS

ROOT = Path('/var/backups/home-console/20261027T210523Z')
FIND = """function find(root, selector) {
  const own = [...root.querySelectorAll(selector)];
  for (const node of root.querySelectorAll('*')) if(node.shadowRoot) own.push(...find(node.shadowRoot,selector));
  return own;
} """


def main():
    page = next(p for p in debugger_json('/json/list') if p.get('type') == 'page' and p.get('url', '').startswith('http://192.168.50.117/home-console/'))
    record = {'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'input': 'Chromium-injected touch; physical sensor unverified', 'swipes': [], 'searches': []}
    with Cdp(page['webSocketDebuggerUrl']) as client:
        def wait(expression, timeout=30):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if client.evaluate(expression):
                    return
                time.sleep(.2)
            raise RuntimeError('Pi UI condition did not become ready')

        def tap(x, y):
            client.call('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y}]})
            client.call('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
            time.sleep(.12)

        def key(label):
            position = client.evaluate("(() => { const k=document.querySelector('home-console-touch-keyboard'); const b=[...k.shadowRoot.querySelectorAll('button')].find(b=>b.textContent === " + json.dumps(label) + "); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()")
            if not position:
                raise RuntimeError('Expected visible keyboard key')
            tap(position['x'], position['y'])

        def navigate(path):
            client.call('Page.navigate', {'url': 'http://192.168.50.117/home-console/' + path + '?kiosk'})
            wait('(' + READINESS + ") === 'ready'")

        navigate('ups')
        time.sleep(2)
        paths = ['ups', 'home', 'now-playing', 'music-library', 'players', 'radio']
        for direction in (1, -1):
            index = 0
            for _ in paths:
                start, end = (900, 100) if direction == 1 else (100, 900)
                client.call('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': start, 'y': 200}]})
                for step in range(1, 9):
                    client.call('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': start+(end-start)*step/8, 'y': 200}]})
                    time.sleep(.025)
                client.call('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
                index = (index + direction) % len(paths)
                wait('location.pathname === ' + json.dumps('/home-console/' + paths[index]) + " && location.search === '?kiosk'")
                record['swipes'].append(paths[index])
                (ROOT / 'pi-ui-progress.json').write_text(json.dumps(record, indent=2))
                time.sleep(1)
        navigate('music-library')
        search = "(() => {" + FIND + "return find(document,'input#searchInp').find(e=>e.getBoundingClientRect().width>0)})()"
        wait('!!(' + search + ')')
        position = client.evaluate('(() => {const r=(' + search + ').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()')
        tap(position['x'], position['y'])
        wait("!document.querySelector('home-console-touch-keyboard').hidden")
        original_language = client.evaluate("document.querySelector('home-console-touch-keyboard').language")
        for language, text in (('en', 'Bach'), ('ru', 'Аквариум')):
            if client.evaluate("document.querySelector('home-console-touch-keyboard').hidden"):
                position = client.evaluate('(() => {const r=(' + search + ').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()')
                tap(position['x'], position['y'])
            current_language = client.evaluate("document.querySelector('home-console-touch-keyboard').language")
            if current_language != language:
                key('EN → RU' if current_language == 'en' else 'RU → EN')
            key('Clear')
            for letter in text:
                if letter.isupper():
                    key('Shift')
                key(letter)
            if client.evaluate('(' + search + ').value') != text:
                raise RuntimeError('Touch keyboard text differs')
            key('Search')
            wait("document.querySelector('home-console-touch-keyboard').hidden")
            if client.evaluate('location.pathname') != '/home-console/music-library':
                raise RuntimeError('Keyboard input navigated away from the library')
            record['searches'].append({'language': language, 'text': text, 'submitted': True, 'remained_on_library': True})
            time.sleep(2)
        # Restore the language preference changed by this test.
        client.evaluate("document.querySelector('home-console-touch-keyboard').language=" + json.dumps(original_language) + ";localStorage.setItem('home-console-keyboard-language'," + json.dumps(original_language) + ")")
        navigate('ups')
        record['display'] = client.evaluate("({width:innerWidth,height:innerHeight,scale:devicePixelRatio,horizontalOverflow:document.documentElement.scrollWidth>innerWidth})")
        image = client.call('Page.captureScreenshot', {'format': 'png'})['data']
        (ROOT / 'pi-ups-after-reboots.png').write_bytes(base64.b64decode(image))
    record['status'] = 'passed'
    (ROOT / 'pi-ui-acceptance.json').write_text(json.dumps(record, indent=2))
    print(json.dumps(record))


if __name__ == '__main__':
    main()
