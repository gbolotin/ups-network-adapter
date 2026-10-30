"""Simulate lock notifications in the Pi UI; never change HA or the physical lock."""
import base64
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, '/usr/local/lib/ups-network-adapter')
from kiosk_cdp import Cdp, debugger_json

SAVER = "document.querySelector('home-console-screensaver')"


def main():
    page = next(p for p in debugger_json('/json/list') if p.get('type') == 'page'
                and p.get('url', '').startswith('http://192.168.50.117/'))
    with Cdp(page['webSocketDebuggerUrl']) as client:
        client.call('Page.reload')
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if client.evaluate(f'!!{SAVER}?.lockNotice'):
                break
            time.sleep(.3)
        else:
            raise RuntimeError('Lock notification module not loaded')
        try:
            client.evaluate(f"(() => {{const s={SAVER};s.lastActivity=Date.now()-121000;void s.tick();}})()")
            time.sleep(1)
            client.evaluate(f"(() => {{const s={SAVER};clearInterval(s.timer);s.lastLockState=undefined;s.updateLockState('locked',true);}})()")
            assert client.evaluate(f'{SAVER}.lockNotice.hidden'), 'Initial state generated an event'
            checks = []
            for state, icon, label in [('unlocked', 'mdi:lock-open-variant', 'Замок открыт'),
                                       ('locked', 'mdi:lock', 'Замок закрыт')]:
                client.evaluate(f"{SAVER}.updateLockState({json.dumps(state)},true)")
                time.sleep(.3)
                result = client.evaluate(f"""(() => {{const s={SAVER};return {{
                  hidden:s.lockNotice.hidden,icon:s.lockIcon.icon,label:s.lockLabel.textContent,
                  width:s.lockIcon.getBoundingClientRect().width,
                  svg:!!s.lockIcon.shadowRoot?.querySelector('ha-svg-icon')?.shadowRoot?.querySelector('svg')
                }};}})()""")
                assert not result['hidden'] and result['icon'] == icon and result['label'] == label, result
                assert result['width'] == 192 and result['svg'], result
                checks.append(result)
                picture = client.call('Page.captureScreenshot', {'format': 'png'})
                Path(f'/tmp/screensaver-lock-{state}.png').write_bytes(base64.b64decode(picture['data']))
            time.sleep(5)
            client.evaluate(f"{SAVER}.updateLockState('locked',true)")
            assert client.evaluate(f'{SAVER}.lockNotice.hidden'), 'Notice did not expire'
            client.evaluate(f"(() => {{const s={SAVER};s.lastLockState=undefined;s.updateLockState('unlocked',true);}})()")
            time.sleep(.3)
            indicator = client.evaluate(f"""(() => {{const s={SAVER},i=s.openLockIndicator,r=i.getBoundingClientRect();return {{
              hidden:i.hidden,width:r.width,left:r.left,top:r.top,noticeHidden:s.lockNotice.hidden,
              svg:!!i.shadowRoot?.querySelector('ha-svg-icon')?.shadowRoot?.querySelector('svg')
            }};}})()""")
            assert not indicator['hidden'] and indicator['noticeHidden'] and indicator['svg'], indicator
            assert indicator['width'] == 128 and indicator['top'] == 32 and indicator['left'] == 860, indicator
            picture = client.call('Page.captureScreenshot', {'format': 'png'})
            Path('/tmp/screensaver-open-lock-indicator.png').write_bytes(base64.b64decode(picture['data']))
            client.evaluate(f"{SAVER}.updateLockState('locked',true)")
            assert client.evaluate(f'{SAVER}.openLockIndicator.hidden'), 'Closed lock indicator still visible'
            print(json.dumps({'simulated_events': True, 'physical_lock_operated': False,
                              'expired': True, 'checks': checks, 'persistent_indicator': indicator}))
        finally:
            client.evaluate(f"""(() => {{const s={SAVER};if(!s)return;
              s.lastLockState=document.querySelector('home-assistant')?.hass?.states['lock.lock_ultra_17']?.state;
              s.updateLockState(s.lastLockState,false);
              s.lastActivity=Date.now();s.hide();clearInterval(s.timer);
              s.timer=setInterval(()=>void s.tick(),1000);
            }})()""")


if __name__ == '__main__':
    main()
