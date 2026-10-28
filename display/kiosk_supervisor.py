"""Own Chromium and recover the Home Console independently of Docker/NUT."""
import json
from dataclasses import dataclass
import logging
from logging.handlers import SysLogHandler
import os
from pathlib import Path
import signal
import socket
import subprocess
import time
from urllib.request import ProxyHandler, build_opener
from urllib.parse import urlsplit

from kiosk_cdp import BrowserError, Cdp, debugger_json
from kiosk_policy import RecoveryPolicy, RestartPolicy

HA = "http://192.168.50.117/home-console/ups?kiosk"
LOCAL = "http://127.0.0.1:8080/device/ups"
OFFLINE = "file:///usr/local/share/ups-kiosk/offline.html"
PROFILE = "/var/lib/ups-kiosk/chromium"
stopping = False

READINESS = r"""(() => {
  if (location.origin !== 'http://192.168.50.117') return 'foreign';
  if (location.pathname.startsWith('/auth/')) return 'login';
  const app = document.querySelector('home-assistant');
  if (!app?.hass?.user) return 'loading';
  if (app.hass.user.name !== 'pi-kiosk' || app.hass.user.is_admin) return 'login';
  if (!app.hass.connection?.connected) return 'disconnected';
  function view(root) {
    if (root.querySelector('hui-view, hui-panel-view, hui-masonry-view, hui-sections-view')) return true;
    for (const node of root.querySelectorAll('*')) if (node.shadowRoot && view(node.shadowRoot)) return true;
    return false;
  }
  return location.pathname.startsWith('/home-console/') && view(document) ? 'ready' : 'loading';
})()"""


@dataclass(frozen=True)
class BrowserSettings:
    ha_url: str = HA
    local_url: str = LOCAL
    offline_url: str = OFFLINE
    profile: str = PROFILE
    debug_port: int = 9222
    headless: bool = False

    @property
    def ha_origin(self):
        url = urlsplit(self.ha_url)
        return f"{url.scheme}://{url.netloc}"

    @property
    def readiness(self):
        return READINESS.replace("'http://192.168.50.117'", json.dumps(self.ha_origin))


def reachable(url):
    try:
        with build_opener(ProxyHandler({})).open(url, timeout=2) as response:
            return response.status == 200
    except OSError:
        return False


def stop(*_):
    global stopping
    stopping = True


class Browser:
    def __init__(self, settings: BrowserSettings = BrowserSettings()):
        self.settings = settings
        self.process = None
        self.ha_id = None
        self.fallback_id = None
        self.front_id = None
        self.next_probe = 0
        self.login_grace_until = 0
        self.failed_since = None

    def browser_call(self, method, params):
        info = debugger_json("/json/version", self.settings.debug_port)
        with Cdp(info["webSocketDebuggerUrl"], port=self.settings.debug_port) as connection:
            return connection.call(method, params)

    def page(self, identifier):
        return next((p for p in debugger_json("/json/list", self.settings.debug_port)
                     if p.get("type") == "page" and p.get("id") == identifier), None)

    def page_call(self, identifier, method, params):
        page = self.page(identifier)
        if not page:
            raise BrowserError("Owned browser page is missing")
        with Cdp(page["webSocketDebuggerUrl"], port=self.settings.debug_port) as connection:
            return connection.call(method, params)

    def evaluate(self, identifier, expression):
        page = self.page(identifier)
        if not page:
            raise BrowserError("Owned browser page is missing")
        with Cdp(page["webSocketDebuggerUrl"], port=self.settings.debug_port) as connection:
            return connection.evaluate(expression)

    def start(self):
        # Never attach to an unrelated process that already owns the debug port.
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", self.settings.debug_port))
        if not Path(self.settings.profile).is_dir() or Path(self.settings.profile).is_symlink():
            raise BrowserError("Expected the existing private kiosk profile")
        self.process = subprocess.Popen([
            "/usr/bin/chromium", "--headless=new" if self.settings.headless else "--ozone-platform=wayland", "--kiosk", "--no-first-run",
            "--no-default-browser-check", "--disable-session-crashed-bubble",
            "--overscroll-history-navigation=0", "--disable-features=AutofillServerCommunication,PasswordManager",
            "--disable-save-password-bubble", "--password-store=basic",
            "--user-data-dir=" + self.settings.profile,
            "--load-extension=/usr/local/share/ups-kiosk/readability",
            "--remote-debugging-address=127.0.0.1", f"--remote-debugging-port={self.settings.debug_port}", self.settings.offline_url,
        ], start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.ha_id = self.fallback_id = self.front_id = None
        self.next_probe = 0
        self.login_grace_until = 0
        self.failed_since = None

    def stop(self):
        if not self.process:
            return
        try:
            os.killpg(self.process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.process.wait(timeout=3)
        self.process = None

    def initialize(self):
        if self.ha_id:
            return
        pages = debugger_json("/json/list", self.settings.debug_port)
        page = next((p for p in pages if p.get("type") == "page" and p.get("url") == self.settings.offline_url), None)
        if not page:
            raise BrowserError("Waiting for the owned startup page")
        self.fallback_id = self.front_id = page["id"]
        # This process owns the private kiosk profile; discard restored tabs, not auth data.
        for restored in pages:
            if restored.get("type") == "page" and restored.get("id") != self.fallback_id:
                self.browser_call("Target.closeTarget", {"targetId": restored["id"]})
        self.ha_id = self.browser_call("Target.createTarget", {"url": self.settings.ha_url, "background": True})["targetId"]

    def ha_state(self, now, http_ready):
        # The fallback's explicit Sign in link is a normal navigation, never token injection.
        if self.fallback_id and self.front_id == self.fallback_id:
            page = self.page(self.fallback_id)
            if page and page.get("url", "").startswith(self.settings.ha_origin + "/"):
                old_probe = self.ha_id
                self.ha_id = self.fallback_id
                self.fallback_id = None
                self.login_grace_until = now + 180
                if old_probe and old_probe != self.ha_id:
                    self.browser_call("Target.closeTarget", {"targetId": old_probe})
        state = self.evaluate(self.ha_id, self.settings.readiness)
        if state == "loading":
            # HA lazily renders its view only when Chromium considers the page active.
            # Hold a supported, bounded active-page probe without switching the display.
            page = self.page(self.ha_id)
            with Cdp(page["webSocketDebuggerUrl"], port=self.settings.debug_port) as probe:
                probe.call("Emulation.setFocusEmulationEnabled", {"enabled": True})
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    state = probe.evaluate(self.settings.readiness)
                    if state != "loading":
                        break
                    time.sleep(0.1)
        if state == "ready":
            self.failed_since = None
        elif self.failed_since is None:
            self.failed_since = now
        elif state != "login" and http_ready and now - self.failed_since >= 20 and now >= self.next_probe:
            self.page_call(self.ha_id, "Page.navigate", {"url": self.settings.ha_url})
            self.next_probe = now + 60
            self.failed_since = now
        return state

    def show(self, destination, login_required=False):
        if destination == "ha":
            if self.front_id != self.ha_id:
                page = self.page(self.ha_id)
                if not page:
                    raise BrowserError("Owned browser page is missing")
                if page.get("url") != self.settings.ha_url:
                    self.page_call(self.ha_id, "Page.navigate", {"url": self.settings.ha_url})
                    return False
                self.browser_call("Target.activateTarget", {"targetId": self.ha_id})
                self.front_id = self.ha_id
                if self.fallback_id:
                    self.browser_call("Target.closeTarget", {"targetId": self.fallback_id})
                    self.fallback_id = None
            return True
        url = self.settings.local_url if destination == "local" else self.settings.offline_url
        if not self.fallback_id:
            self.fallback_id = self.browser_call("Target.createTarget", {"url": url, "background": True})["targetId"]
        else:
            page = self.page(self.fallback_id)
            if page and not page.get("url", "").startswith(url.split("/device/")[0] if destination == "local" else url):
                self.page_call(self.fallback_id, "Page.navigate", {"url": url})
        if self.front_id != self.fallback_id:
            self.browser_call("Target.activateTarget", {"targetId": self.fallback_id})
            self.front_id = self.fallback_id
        if destination == 'offline':
            message = 'Home Assistant sign-in required · Local UPS unavailable' if login_required else 'Home Assistant and local UPS display unavailable'
        else:
            message = "Home Assistant sign-in required" if login_required else "Home Assistant offline · Local UPS fallback"
        # Isolated banner: no modification of PeaNUT data, controls, or authentication.
        self.evaluate(self.fallback_id, """(() => {
          if (location.origin !== """ + json.dumps(self.settings.local_url.split('/device/')[0]) + """ && location.protocol !== 'file:') return;
          let bar = document.getElementById('home-console-status');
          if (!bar) { bar = document.createElement('div'); bar.id = 'home-console-status';
            bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:8px;background:#292929;color:white;font:16px sans-serif;text-align:center';
            document.body.append(bar); }
          bar.replaceChildren(document.createTextNode(""" + json.dumps(message) + """));
          const link = document.createElement('a'); link.href = """ + json.dumps(self.settings.ha_url) + """;
          link.textContent = ' · Open Home Assistant'; link.style.color = '#8ddcff'; bar.append(link);
        })()""")


def main():
    logger = logging.getLogger('ups-kiosk-supervisor')
    logger.setLevel(logging.INFO)
    handler = SysLogHandler(address='/dev/log')
    handler.setFormatter(logging.Formatter('ups-kiosk-supervisor: %(message)s'))
    logger.addHandler(handler)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    browser = Browser()
    recovery = RecoveryPolicy()
    restart = RestartPolicy()
    next_start = 0
    last_status = None
    browser_errors = 0
    started_at = 0
    try:
        while not stopping:
            now = time.monotonic()
            if not browser.process or browser.process.poll() is not None:
                if browser.process:
                    browser.stop()
                    next_start = restart.failed(now)
                if now >= next_start:
                    try:
                        browser.start()
                        restart.started_at = started_at = now
                        recovery = RecoveryPolicy()
                        browser_errors = 0
                    except (OSError, BrowserError):
                        next_start = restart.failed(now)
                time.sleep(1)
                continue
            try:
                browser.initialize()
                ha_state = browser.ha_state(now, reachable(HA))
                local_ready = reachable("http://127.0.0.1:8080/api/ping")
                destination = recovery.update(now, ha_state, local_ready)
                if not (browser.front_id == browser.ha_id and now < browser.login_grace_until and ha_state != "ready"):
                    if browser.show(destination, ha_state == "login") is False:
                        # Returning from another view needs a fresh ready UPS page first.
                        recovery.front = destination = "local" if local_ready else "offline"
                        recovery.ready_samples = 0
                status = (destination, ha_state == "login")
                if status != last_status:
                    logger.info("Kiosk: " + destination + ("; sign-in required" if ha_state == "login" else ""))
                    last_status = status
                browser_errors = 0
            except (OSError, BrowserError, ValueError, KeyError):
                browser_errors += 1
                if now - started_at > 20 and browser_errors >= 2:
                    logger.info("Kiosk: browser unavailable; bounded restart")
                    browser.stop()
                    next_start = restart.failed(time.monotonic())
            for _ in range(5):
                if stopping:
                    break
                time.sleep(1)
    finally:
        browser.stop()


if __name__ == "__main__":
    main()
