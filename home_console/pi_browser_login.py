"""One-time supported HA form login over the plan's loopback CDP connection.

Read the existing pi-kiosk credentials from protected SSH stdin. Never log or
persist credentials, protocol payloads, or tokens. This is not an autologin service.
"""
import json
import sys
import time
from urllib.parse import urlsplit

sys.path.insert(0, '/usr/local/lib/ups-network-adapter')
from kiosk_cdp import Cdp, debugger_json
from kiosk_supervisor import READINESS

DOM = """const nodes=[];
function walk(root) { for(const node of root.querySelectorAll('*')) {
  nodes.push(node); if(node.shadowRoot) walk(node.shadowRoot);
  if(node.tagName==='IFRAME' && node.contentDocument) walk(node.contentDocument);
}} walk(document);"""
SCOPE = "if(location.origin!=='http://192.168.50.117'||location.pathname!=='/auth/authorize')return false;"


def main():
    credentials = json.load(sys.stdin)
    if credentials.get('username') != 'pi-kiosk' or not credentials.get('password'):
        raise RuntimeError('Expected the existing protected pi-kiosk credentials')
    pages = [p for p in debugger_json('/json/list') if p.get('type') == 'page'
             and urlsplit(p.get('url', '')).netloc == '192.168.50.117']
    if len(pages) != 1:
        raise RuntimeError('Expected exactly one owned HA page')
    page = pages[0]
    with Cdp(page['webSocketDebuggerUrl']) as client:
        if client.evaluate(READINESS) == 'ready':
            print(json.dumps({'already_signed_in': True, 'user': 'pi-kiosk'}))
            return
        with Cdp(debugger_json('/json/version')['webSocketDebuggerUrl']) as browser:
            browser.call('Target.activateTarget', {'targetId': page['id']})
        # Dismiss an unrelated popup left by an interrupted operator attempt.
        for kind, buttons in (('mousePressed', 1), ('mouseReleased', 0)):
            client.call('Input.dispatchMouseEvent', {'type': kind, 'x': 800, 'y': 100, 'button': 'left', 'buttons': buttons, 'clickCount': 1})
        for name, kind in (('username', 'text'), ('password', 'password')):
            box = client.evaluate('(() => {' + SCOPE + DOM + """
              const inputs=nodes.filter(n=>n.tagName==='INPUT' && n.name===""" + json.dumps(name) + """ && n.type===""" + json.dumps(kind) + """);
              if(inputs.length!==1)return false;const r=inputs[0].getBoundingClientRect();
              if(!r.width||!r.height)return false;return{x:r.x+r.width/2,y:r.y+r.height/2};
            })()""")
            if not box:
                raise RuntimeError('HA sign-in fields changed; supported interactive sign-in is required')
            for event, buttons in (('mousePressed', 1), ('mouseReleased', 0)):
                client.call('Input.dispatchMouseEvent', {'type': event, **box, 'button': 'left', 'buttons': buttons, 'clickCount': 1})
            focused = client.evaluate('(() => {' + SCOPE + """
              let active=document.activeElement;
              while(active?.shadowRoot?.activeElement)active=active.shadowRoot.activeElement;
              return active?.tagName==='INPUT' && active.name===""" + json.dumps(name) + """ && active.type===""" + json.dumps(kind) + ";})()")
            if not focused:
                raise RuntimeError('Browser focus is outside the expected sign-in field; no text was sent')
            for event in ('rawKeyDown', 'keyUp'):
                client.call('Input.dispatchKeyEvent', {'type': event, 'key': 'a', 'code': 'KeyA', 'modifiers': 2, 'windowsVirtualKeyCode': 65})
            # Trusted browser input updates the form-associated HA fields and validity.
            client.call('Input.insertText', {'text': credentials[name]})
        deadline = time.monotonic() + 10
        submitted = False
        while time.monotonic() < deadline:
            button = client.evaluate('(() => {' + SCOPE + DOM + """
              const buttons=nodes.filter(n=>n.tagName==='BUTTON' && !n.disabled &&
                (n.textContent.trim()==='Log in'||n.getRootNode().host?.textContent.trim()==='Log in'));
              if(buttons.length!==1)return false;
              const r=buttons[0].getBoundingClientRect(); if(!r.width||!r.height)return false;
              return {x:r.x+r.width/2,y:r.y+r.height/2};
            })()""")
            if button:
                for kind, buttons in (('mousePressed', 1), ('mouseReleased', 0)):
                    client.call('Input.dispatchMouseEvent', {'type': kind, **button, 'button': 'left', 'buttons': buttons, 'clickCount': 1})
                submitted = True
                break
            time.sleep(0.2)
        if not submitted:
            raise RuntimeError('HA did not enable the normal sign-in action')
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if client.evaluate(READINESS) == 'ready':
                print(json.dumps({'normal_form_login_completed': True, 'user': 'pi-kiosk', 'admin': False}))
                return
            time.sleep(0.5)
        raise RuntimeError('HA sign-in did not reach the authenticated dashboard; no credential retry was attempted')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        raise SystemExit(str(error))
