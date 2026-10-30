"""Actual Pi browser vertical gestures, with URL/room retention and no device calls."""
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, '/usr/local/lib/ups-network-adapter')
from kiosk_cdp import Cdp, debugger_json
from kiosk_supervisor import READINESS

SCROLL = """(() => {
  const found=[];
  function walk(root){for(const n of root.querySelectorAll('*')){
    const r=n.getBoundingClientRect();
    if(n.clientHeight>80 && n.scrollHeight>n.clientHeight+20 && r.width>200 && r.bottom>80 && r.top<550 && (n===document.scrollingElement || ['auto','scroll'].includes(getComputedStyle(n).overflowY)))
      found.push({tag:n.localName,id:n.id,top:n.scrollTop,height:n.scrollHeight,client:n.clientHeight,x:Math.max(20,Math.min(1000,r.x+r.width/2)),y:Math.max(100,Math.min(450,r.y+r.height/2))});
    if(n.shadowRoot)walk(n.shadowRoot);
  }}walk(document);return found;
})()"""


def main():
    page = next(p for p in debugger_json('/json/list') if p.get('type') == 'page' and p.get('url', '').startswith('http://192.168.50.117/home-console/'))
    record = {'input': 'Chromium touch-event injection on actual Pi', 'cases': []}
    with Cdp(page['webSocketDebuggerUrl']) as client:
        original = client.evaluate('location.href')
        try:
            for path in ('home', 'music-library'):
                client.call('Page.navigate', {'url': 'http://192.168.50.117/home-console/' + path + '?kiosk'})
                for _ in range(100):
                    if client.evaluate(READINESS) == 'ready':
                        break
                    time.sleep(.1)
                time.sleep(2)
                before = client.evaluate(SCROLL)
                if not before:
                    raise RuntimeError('No visible vertical scroll region: ' + path)
                target = before[-1]
                helper = client.evaluate("document.querySelector('home-assistant').hass.states['input_select.pi_console_player'].state")
                x = 900 if path == 'home' else target['x']
                y = 450 if path == 'home' else min(450, target['y'] + 100)
                client.call('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y}]})
                for step in range(1, 10):
                    client.call('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x, 'y': y-(y-80)*step/9}]})
                    time.sleep(.05)
                client.call('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
                time.sleep(1)
                after = client.evaluate(SCROLL)
                moved = any(a['tag'] == b['tag'] and a['id'] == b['id'] and a['height'] == b['height'] and abs(a['top']-b['top']) > 20 for a in after for b in before)
                if not moved or client.evaluate('location.pathname') != '/home-console/' + path or client.evaluate('location.search') != '?kiosk':
                    raise RuntimeError('Vertical gesture failed or navigated: ' + path)
                if client.evaluate("document.querySelector('home-assistant').hass.states['input_select.pi_console_player'].state") != helper:
                    raise RuntimeError('Scroll changed the selected room')
                record['cases'].append({'view': path, 'scrolled': True, 'url_and_room_retained': True})
        finally:
            client.call('Page.navigate', {'url': original})
    record['status'] = 'passed'
    Path('/var/backups/home-console/20261027T210523Z/pi-scroll-acceptance.json').write_text(json.dumps(record, indent=2))
    print(json.dumps(record))


if __name__ == '__main__':
    main()
