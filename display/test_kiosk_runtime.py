"""Opt-in integration test: real Chromium, temporary profile, simulated local services.

Run on Linux with HOME_CONSOLE_BROWSER_TEST=1. Never uses the physical kiosk profile
or changes the real HA/PeaNUT services. Fixture readiness is illustrative, not HA acceptance.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from kiosk_supervisor import Browser, BrowserSettings, reachable
from kiosk_policy import RecoveryPolicy


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        role = self.server.role
        mode = self.server.state[role]
        if self.path == "/state":
            content = json.dumps({"mode": mode}).encode()
            status = 200
            kind = "application/json"
        elif mode == "offline":
            content = b"Simulated service unavailable"
            status = 503
            kind = "text/plain"
        elif role == "local":
            content = b"<html><body>Simulated local UPS fixture</body></html>"
            status = 200
            kind = "text/html"
        else:
            content = b"""<!doctype html><html><body>Simulated Home Console fixture
              <home-assistant></home-assistant>
              <input id="entry" value="preserve this edit">
              <script>
              const app = document.querySelector('home-assistant');
              app.hass = {user:{name:'pi-kiosk',is_admin:false},connection:{connected:false}};
              function render() {
                if (!document.hidden && !document.querySelector('hui-view')) document.body.append(document.createElement('hui-view'));
              }
              document.addEventListener('visibilitychange', render); render();
              async function update() {
                const {mode} = await (await fetch('/state')).json();
                app.hass.connection.connected = mode === 'ready';
                if (mode === 'login') history.replaceState(null,'','/auth/authorize');
                else if (location.pathname.startsWith('/auth/')) history.replaceState(null,'','/home-console/ups?kiosk');
              }
              update(); setInterval(update,100);
              </script></body></html>"""
            status = 200
            kind = "text/html"
            self.server.page_loads += 1
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)


@unittest.skipUnless(sys.platform == "linux" and os.environ.get("HOME_CONSOLE_BROWSER_TEST") == "1",
                     "Opt-in real-browser check requires Linux and HOME_CONSOLE_BROWSER_TEST=1")
class BrowserRecoveryIntegration(unittest.TestCase):
    def test_owned_browser_recovery_without_touching_real_services(self):
        self.assertIsNotNone(shutil.which("chromium"))
        state = {"ha": "ready", "local": "ready"}
        servers = []
        browser = None
        with tempfile.TemporaryDirectory(prefix="home-console-browser-test-") as temporary:
            try:
                for role in ("ha", "local"):
                    server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
                    server.role, server.state, server.page_loads = role, state, 0
                    threading.Thread(target=server.serve_forever, daemon=True).start()
                    servers.append(server)
                ha, local = [f"http://127.0.0.1:{server.server_port}" for server in servers]
                profile = Path(temporary) / "profile"
                profile.mkdir(mode=0o700)
                offline = Path(temporary) / "offline.html"
                offline.write_text("<html><body>Simulated offline fixture</body></html>")
                with socket.socket() as available:
                    available.bind(("127.0.0.1", 0))
                    port = available.getsockname()[1]
                self.assertNotEqual(port, 9222)
                settings = BrowserSettings(ha_url=ha + "/home-console/ups?kiosk", local_url=local + "/device/ups",
                                           offline_url=offline.as_uri(), profile=str(profile), debug_port=port, headless=True)
                browser = Browser(settings)
                browser.start()

                def wait_for(predicate, label):
                    deadline = time.monotonic() + 15
                    last_error = None
                    while time.monotonic() < deadline:
                        try:
                            value = predicate()
                            if value:
                                return value
                        except (OSError, RuntimeError, ValueError, KeyError) as error:
                            last_error = type(error).__name__
                        time.sleep(0.1)
                    self.fail(f"Timed out: {label}; {last_error}")

                wait_for(lambda: (browser.initialize() or browser.ha_id), "browser initialization")
                wait_for(lambda: browser.ha_state(0, True) == "ready", "authenticated fixture view")
                policy = RecoveryPolicy()
                self.assertEqual(policy.update(0, "ready", True), "local")
                self.assertEqual(policy.update(5, "ready", True), "ha")
                self.assertTrue(browser.show("ha"))
                self.assertEqual(browser.front_id, browser.ha_id)
                initial_loads = servers[0].page_loads
                for now in (10, 15, 20):
                    browser.initialize()
                    self.assertEqual(browser.ha_state(now, True), "ready")
                    browser.show(policy.update(now, "ready", True))
                self.assertEqual(servers[0].page_loads, initial_loads, "Healthy page was reloaded")
                self.assertEqual(browser.evaluate(browser.ha_id, "document.getElementById('entry').value"), "preserve this edit")

                state["ha"] = "disconnected"
                wait_for(lambda: browser.ha_state(25, True) == "disconnected", "WebSocket disconnection")
                self.assertEqual(policy.update(25, "disconnected", True), "ha")
                self.assertEqual(policy.update(45, "disconnected", True), "local")
                browser.show("local")
                wait_for(lambda: browser.page(browser.fallback_id)["url"] == settings.local_url, "local fallback")
                state["local"] = "offline"
                self.assertFalse(reachable(local + "/api/ping"))
                self.assertEqual(policy.update(50, "disconnected", False), "offline")
                browser.show("offline")
                wait_for(lambda: browser.page(browser.fallback_id)["url"] == settings.offline_url, "visible offline screen")

                state["ha"] = "login"
                wait_for(lambda: browser.ha_state(55, True) == "login", "expired login")
                for now in (55, 60, 65):
                    self.assertEqual(policy.update(now, "login", False), "offline")
                state["ha"] = "ready"
                wait_for(lambda: browser.ha_state(70, True) == "ready", "recovered authenticated fixture")
                self.assertEqual(policy.update(70, "ready", False), "offline")
                self.assertEqual(policy.update(75, "ready", False), "ha")
                self.assertTrue(browser.show("ha"))
                self.assertEqual(browser.front_id, browser.ha_id)
                process = browser.process
                browser.stop()
                self.assertIsNotNone(process.returncode, "Owned Chromium was not reaped")
            finally:
                if browser:
                    browser.stop()
                for server in servers:
                    server.shutdown()
                    server.server_close()


if __name__ == "__main__":
    unittest.main()
