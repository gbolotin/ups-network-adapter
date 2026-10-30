"""Test fresh passwordless login in a disposable browser context on the actual Pi."""
import json
import sys
import time

sys.path.insert(0, '/usr/local/lib/ups-network-adapter')
from kiosk_cdp import Cdp, debugger_json


def main():
    expected_user = sys.argv[1]
    browser_url = debugger_json('/json/version')['webSocketDebuggerUrl']
    with Cdp(browser_url) as browser:
        context = browser.call('Target.createBrowserContext')['browserContextId']
        try:
            target = browser.call('Target.createTarget', {
                'url': 'http://192.168.50.117/home-console/ups?kiosk',
                'browserContextId': context, 'background': True})['targetId']
            page = next(p for p in debugger_json('/json/list') if p['id'] == target)
            with Cdp(page['webSocketDebuggerUrl']) as client:
                deadline = time.monotonic() + 45
                identity = None
                while time.monotonic() < deadline:
                    identity = client.evaluate("(() => {const h=document.querySelector('home-assistant')?.hass;return h?.user?{id:h.user.id,name:h.user.name,admin:h.user.is_admin,path:location.pathname}:null})()")
                    if identity:
                        break
                    time.sleep(.4)
                assert identity and identity['id'] == expected_user and identity['admin'] is False, 'Fresh kiosk login did not complete as the restricted user'
                assert identity['path'].startswith('/home-console/'), 'Fresh session did not open the console'
                # Revoke only this disposable session, without logging any token.
                cleanup = client.call('Runtime.evaluate', {
                    'expression': "(async()=>{const token=document.querySelector('home-assistant').hass.auth.data.refresh_token;if(!token)return false;const r=await fetch('/auth/token',{method:'POST',body:new URLSearchParams({action:'revoke',token})});return r.ok})()",
                    'awaitPromise': True, 'returnByValue': True})
                revoked = cleanup.get('result', {}).get('value') is True
                assert revoked, 'Disposable login token was not revoked'
                print(json.dumps({'fresh_context': True, 'password_entered': False,
                                  'user': identity['name'], 'admin': False,
                                  'console_opened': True, 'test_session_revoked': revoked}))
        finally:
            browser.call('Target.disposeBrowserContext', {'browserContextId': context})


if __name__ == '__main__':
    main()
