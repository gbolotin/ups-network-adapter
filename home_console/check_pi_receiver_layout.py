"""Check Receiver geometry in the actual Pi browser without device commands."""
import base64
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, '/usr/local/lib/ups-network-adapter')
from kiosk_cdp import Cdp, debugger_json

INSPECT = """(() => {
 function find(root, selector) {
   const own = [...root.querySelectorAll(selector)];
   for (const node of root.querySelectorAll('*')) {
     if (node.shadowRoot) own.push(...find(node.shadowRoot, selector));
   }
   return own;
 }
 const wrapper = find(document, 'home-console-receiver-layout')[0];
 if (!wrapper?.media || !wrapper.controls) return null;
 const nativeCard = wrapper.media.shadowRoot?.querySelector('ha-card');
 if (!nativeCard || !wrapper.volume || !wrapper.radio) return null;
 const box = node => node.getBoundingClientRect().toJSON();
 return { viewport: { width: innerWidth, height: innerHeight },
   layout: box(wrapper), media: box(wrapper.media), controls: box(wrapper.controls),
   radio: find(wrapper.shadowRoot, 'home-console-radio-favorites').map(box),
   stations: [...(wrapper.radio?.shadowRoot?.querySelectorAll('button') || [])].map(box),
   sources: wrapper.sources?.map(box),
   slider: find(wrapper.volume, 'ha-control-slider').map(box),
   mute: find(wrapper.volume, '.mute').map(box),
   nativeCard: box(nativeCard) };
})()"""


def main():
    page = next(p for p in debugger_json('/json/list') if p.get('type') == 'page'
                and p.get('url', '').startswith('http://192.168.50.117/'))
    with Cdp(page['webSocketDebuggerUrl']) as client:
        client.call('Page.navigate', {'url': 'http://192.168.50.117/home-console/receiver?kiosk'})
        deadline = time.monotonic() + 35
        while time.monotonic() < deadline:
            result = client.evaluate(INSPECT)
            if result and len(result.get('stations', [])) >= 2:
                break
            time.sleep(.3)
        else:
            raise RuntimeError('Receiver did not become ready')
        time.sleep(2)
        result = client.evaluate(INSPECT)
        assert abs(result['layout']['bottom'] - result['viewport']['height']) <= 1, result
        assert abs(result['controls']['bottom'] - result['viewport']['height']) <= 1, result
        assert result['media']['height'] > result['controls']['height'], result
        assert abs(result['nativeCard']['height'] - result['media']['height']) <= 1, result
        assert result['radio'][0]['right'] < result['media']['left'], result
        assert result['stations'][0]['left'] == result['stations'][1]['left'], result
        assert result['stations'][0]['bottom'] < result['stations'][1]['top'], result
        assert len(result['sources']) == 1, result
        assert abs(result['sources'][0]['right'] - result['layout']['right']) <= 1, result
        assert result['sources'][0]['width'] == 80, result
        if result['slider'] and result['mute']:
            assert result['slider'][0]['right'] <= result['mute'][0]['left'], result
            assert result['mute'][0]['right'] <= result['sources'][0]['left'], result
        picture = client.call('Page.captureScreenshot', {'format': 'png'})
        Path('/tmp/receiver-full-height.png').write_bytes(base64.b64decode(picture['data']))
        print(json.dumps(result))


if __name__ == '__main__':
    main()
