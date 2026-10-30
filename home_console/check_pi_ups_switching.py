"""Inspect the rendered UPS card on the actual Pi; never issue device commands."""
import base64
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, '/usr/local/lib/ups-network-adapter')
from kiosk_cdp import Cdp, debugger_json

INSPECT = """(() => {
 function find(root, selector) {
   const own=[...root.querySelectorAll(selector)];
   for(const n of root.querySelectorAll('*')) if(n.shadowRoot) own.push(...find(n.shadowRoot,selector));
   return own;
 }
 const wrapper=find(document,'home-console-ups')[0];
 if(!wrapper?.shadowRoot)return null;
 const nodes=find(wrapper.shadowRoot,'ha-markdown,ha-tile-info');
 return {path:location.pathname,viewport:{width:innerWidth,height:innerHeight},
   readings:nodes.map(n=>n.textContent.trim()),
   summary:find(wrapper.shadowRoot,'ha-markdown')[0]?.shadowRoot?.textContent,
   identity:document.querySelector('home-assistant')?.hass?.states['sensor.connected_ups_connected']?.state};
})()"""


def main():
    page = next(p for p in debugger_json('/json/list') if p.get('type') == 'page'
                and p.get('url', '').startswith('http://192.168.50.117/'))
    with Cdp(page['webSocketDebuggerUrl']) as client:
        original = client.evaluate('location.href')
        try:
            client.call('Page.navigate', {'url': 'http://192.168.50.117/home-console/ups?kiosk'})
            deadline = time.monotonic() + 35
            result = None
            while time.monotonic() < deadline:
                result = client.evaluate(INSPECT)
                offline = '--offline' in sys.argv
                ready = result and ('UPS not connected or data unavailable' in (result.get('summary') or '') if offline
                                    else result.get('identity') == 'Eaton 5E 2200 G2' and 'Eaton' in (result.get('summary') or ''))
                if ready:
                    break
                time.sleep(.3)
            else:
                raise RuntimeError('Rendered UPS card did not become ready')
            time.sleep(1)
            result = client.evaluate(INSPECT)
            screenshot = client.call('Page.captureScreenshot', {'format': 'png'})
            suffix = '-offline' if '--offline' in sys.argv else ''
            Path(f'/tmp/home-console-ups-switching{suffix}.png').write_bytes(base64.b64decode(screenshot['data']))
            print(json.dumps(result))
        finally:
            client.call('Page.navigate', {'url': original})


if __name__ == '__main__':
    main()
