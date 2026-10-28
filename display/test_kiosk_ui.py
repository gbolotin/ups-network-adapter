"""Opt-in real-browser tests for owned UI, with simulated states and failed MA access."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from kiosk_supervisor import Browser, BrowserSettings

HTML = b"""<!doctype html><html><body>
<ma-browser-card><input id="searchInp" type="text"></ma-browser-card>
<home-console-queue></home-console-queue>
<script type="module">
import '/ui/home-console-queue.js'; import '/ui/touch-keyboard.js';
const queue = document.querySelector('home-console-queue');
queue.setConfig({player_helper:'input_select.fixture',player_map:{'media_player.fixture':'fixture-room'},ma_token:'fixture-only-not-a-secret'});
window.setFixture = state => {
  const states = {'input_select.fixture':{state:'media_player.fixture'}};
  if (state !== null) states['media_player.fixture'] = {state,attributes:{friendly_name:'Simulated player'}};
  queue.hass = {states, callWS:async request => request.endpoint.endsWith('/info')
    ? {state:'started',ingress:true,ingress_entry:'/api/hassio_ingress/fixture'} : {session:'fixture_session'}};
};
setFixture(null);
document.getElementById('searchInp').addEventListener('keydown', event => {
  if (event.key === 'Enter') window.submitted = event.target.value;
});
window.fixtureReady = true;
</script></body></html>"""


class UiFixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path.startswith('/ui/'):
            name = self.path.removeprefix('/ui/')
            if name not in ('home-console-queue.js', 'queue-policy.mjs', 'touch-keyboard.js', 'keyboard-policy.mjs'):
                self.send_error(404)
                return
            content = (self.server.ui_root / name).read_bytes()
            kind = 'text/javascript'
        else:
            content, kind = HTML, 'text/html'
        self.send_response(200)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        self.server.requests.append(json.loads(body))
        self.send_response(self.server.failure_status)
        self.send_header('Content-Length', '0')
        self.end_headers()


@unittest.skipUnless(sys.platform == 'linux' and os.environ.get('HOME_CONSOLE_BROWSER_TEST') == '1',
                     'Opt-in Linux/Chromium fixture check')
class OwnedUiIntegration(unittest.TestCase):
    def test_failure_targets_keyboard_and_gesture_boundaries(self):
        root = Path(os.environ.get('HOME_CONSOLE_UI_ROOT', Path(__file__).resolve().parents[1] / 'home_console/ui'))
        server = ThreadingHTTPServer(('127.0.0.1', 0), UiFixture)
        server.ui_root, server.requests, server.failure_status = root, [], 403
        threading.Thread(target=server.serve_forever, daemon=True).start()
        browser = None
        with tempfile.TemporaryDirectory(prefix='home-console-ui-test-') as temporary:
            try:
                profile = Path(temporary) / 'profile'
                profile.mkdir(mode=0o700)
                offline = Path(temporary) / 'offline.html'
                offline.write_text('<html><body>Simulated fixture startup</body></html>')
                with socket.socket() as available:
                    available.bind(('127.0.0.1', 0))
                    port = available.getsockname()[1]
                browser = Browser(BrowserSettings(ha_url=f'http://127.0.0.1:{server.server_port}/home-console/music-library?kiosk',
                                                  profile=str(profile), debug_port=port, offline_url=offline.as_uri(), headless=True))
                browser.start()

                def wait_for(predicate, label):
                    deadline = time.monotonic() + 15
                    while time.monotonic() < deadline:
                        try:
                            if predicate():
                                return
                        except (OSError, RuntimeError, ValueError, KeyError):
                            pass
                        time.sleep(0.1)
                    self.fail('Timed out: ' + label)

                wait_for(lambda: (browser.initialize() or browser.ha_id), 'browser startup')
                evaluate = lambda expression: browser.evaluate(browser.ha_id, expression)
                wait_for(lambda: evaluate('window.fixtureReady === true'), 'owned UI module load')
                self.assertTrue(browser.show('ha'))
                evaluate("document.querySelector('home-console-queue').shadowRoot.querySelector('header button').click()")
                for state in (None, 'unknown', 'unavailable'):
                    evaluate('setFixture(' + json.dumps(state) + ')')
                    text = evaluate("document.querySelector('home-console-queue').shadowRoot.textContent")
                    self.assertIn('Choose an available control room.', text)
                    self.assertEqual(len(server.requests), 0, 'Unavailable selection sent a queue request')
                evaluate("setFixture('idle')")
                wait_for(lambda: 'Queue unavailable.' in evaluate("document.querySelector('home-console-queue').shadowRoot.textContent"), 'permission failure display')
                self.assertGreater(len(server.requests), 0)
                for request in server.requests:
                    self.assertEqual(request['args']['queue_id'], 'fixture-room')
                server.failure_status = 500
                evaluate("[...document.querySelector('home-console-queue').shadowRoot.querySelectorAll('button')].find(b=>b.textContent==='Refresh').click()")
                wait_for(lambda: len(server.requests) >= 2, 'failed connection retry')
                wait_for(lambda: 'Queue unavailable.' in evaluate("document.querySelector('home-console-queue').shadowRoot.textContent"), 'server failure display')

                self.assertTrue(evaluate("document.getElementById('searchInp').focus(); !document.querySelector('home-console-touch-keyboard').hidden"))
                script = """(() => {
                  const keyboard = document.querySelector('home-console-touch-keyboard');
                  const press = name => [...keyboard.shadowRoot.querySelectorAll('button')].find(b=>b.textContent===name).click();
                  press('Clear'); press('Shift'); for(const key of ['B','a','c','h']) press(key); press('Search');
                  return window.submitted;
                })()"""
                self.assertEqual(evaluate(script), 'Bach')
                evaluate("document.getElementById('searchInp').focus()")
                self.assertEqual(evaluate("""(() => {
                  const keyboard=document.querySelector('home-console-touch-keyboard');
                  const press=name=>[...keyboard.shadowRoot.querySelectorAll('button')].find(b=>b.textContent===name).click();
                  press('Clear'); press('EN → RU'); press('Shift'); for(const key of ['А','к','в','а','р','и','у','м']) press(key);
                  return document.getElementById('searchInp').value;
                })()"""), 'Аквариум')
                self.assertEqual(evaluate("""(() => {
                  let escaped=0; const count=()=>escaped++;
                  for(const name of ['touchstart','touchmove','touchend']) document.addEventListener(name,count);
                  const targets=[document.querySelector('home-console-queue').shadowRoot.querySelector('ha-card'),
                    document.querySelector('home-console-touch-keyboard').shadowRoot.querySelector('button'),document.getElementById('searchInp')];
                  for(const target of targets) for(const name of ['touchstart','touchmove','touchend']) target.dispatchEvent(new Event(name,{bubbles:true,composed:true}));
                  return escaped;
                })()"""), 0, 'Owned control gestures escaped to page navigation')
                self.assertTrue(evaluate("""history.pushState(null,'','/home-console/music-library');
                  dispatchEvent(new Event('location-changed'));
                  document.getElementById('searchInp').blur();document.getElementById('searchInp').focus();
                  document.querySelector('home-console-touch-keyboard').hidden"""))
            finally:
                if browser:
                    browser.stop()
                server.shutdown()
                server.server_close()


if __name__ == '__main__':
    unittest.main()
