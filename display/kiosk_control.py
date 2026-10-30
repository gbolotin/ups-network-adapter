"""Narrow authenticated HA-to-Pi power endpoint. Python standard library only."""
import argparse
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import threading
import time
from screen_settings import SETTINGS_PATH, read_night_blanking, write_night_blanking
from ups_power import UpsPower


COMMANDS = {'restart': ['/usr/bin/systemctl', 'reboot'],
            'shutdown': ['/usr/bin/systemctl', 'poweroff']}


class ControlServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, token, allowed_peer, executor=None, settings_path=SETTINGS_PATH, ups_power=None):
        if len(token) < 32:
            raise ValueError('A dedicated random token is required')
        self.token = token
        self.allowed_peer = allowed_peer
        self.executor = executor or self.execute
        self.last_action = -60
        self.action_lock = threading.Lock()
        self.settings_path = settings_path
        self.settings_lock = threading.Lock()
        self.ups_power = ups_power or UpsPower()
        super().__init__(address, Handler)

    @staticmethod
    def execute(action):
        subprocess.run(COMMANDS[action], check=True, timeout=15, capture_output=True)

    def schedule(self, action):
        with self.action_lock:
            if time.monotonic() - self.last_action < 60:
                return False
            self.last_action = time.monotonic()
        timer = threading.Timer(2, self.executor, args=(action,))
        timer.daemon = True
        timer.start()
        return True


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Never log credentials or request bodies.

    def respond(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(payload)

    def authorized(self):
        supplied = self.headers.get('Authorization', '')
        return self.client_address[0] == self.server.allowed_peer and hmac.compare_digest(
            supplied.encode(), ('Bearer ' + self.server.token).encode())

    def do_GET(self):
        if not self.authorized():
            self.respond(403, {'error': 'Forbidden'})
        elif self.path == '/health':
            self.respond(200, {'target': 'home-console-pi', 'ready': True})
        elif self.path == '/screen':
            try:
                self.respond(200, {'enabled': read_night_blanking(self.server.settings_path)})
            except (OSError, ValueError):
                self.respond(500, {'error': 'Cannot read screen settings'})
        elif self.path == '/ups':
            try:
                self.respond(200, self.server.ups_power.status())
            except (OSError, ValueError):
                self.respond(503, {'error': 'UPS unavailable'})
        else:
            self.respond(404, {'error': 'Not found'})

    def do_POST(self):
        if not self.authorized():
            self.respond(403, {'error': 'Forbidden'})
            return
        if self.path not in ('/power', '/screen', '/ups/off'):
            self.respond(404, {'error': 'Not found'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 256 or self.headers.get('Transfer-Encoding'):
                raise ValueError()
            if self.headers.get('Content-Type') != 'application/json':
                raise ValueError()
            body = json.loads(self.rfile.read(length))
            if self.path == '/ups/off':
                if not isinstance(body, dict) or set(body) != {'expected_identity', 'confirmed'} or body['confirmed'] is not True:
                    raise ValueError()
                try:
                    result = self.server.ups_power.power_off(body['expected_identity'])
                except (OSError, ValueError):
                    self.respond(409, {'error': 'UPS changed, unavailable or command rejected'})
                    return
                self.respond(200, result)
                return
            if self.path == '/screen':
                if not isinstance(body, dict) or set(body) != {'enabled'} or type(body['enabled']) is not bool:
                    raise ValueError()
                try:
                    with self.server.settings_lock:
                        write_night_blanking(body['enabled'], self.server.settings_path)
                    self.respond(200, {'enabled': body['enabled']})
                except OSError:
                    self.respond(500, {'error': 'Cannot save screen settings'})
                return
            if not isinstance(body, dict) or set(body) != {'action', 'confirmed'}:
                raise ValueError()
            action = body['action']
            if action not in COMMANDS or body['confirmed'] is not True:
                raise ValueError()
        except (ValueError, TypeError):
            self.respond(400, {'error': 'Invalid confirmed power action'})
            return
        if not self.server.schedule(action):
            self.respond(429, {'error': 'Power action already pending'})
            return
        self.respond(200, {'target': 'home-console-pi', 'accepted': action})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--token-file', default='/etc/ups-network-adapter/kiosk-control.token')
    parser.add_argument('--ha-address', default='192.168.50.117')
    parser.add_argument('--port', type=int, default=8766)
    args = parser.parse_args()
    token = Path(args.token_file).read_text().strip()
    with ControlServer(('0.0.0.0', args.port), token, args.ha_address) as server:
        server.serve_forever()


if __name__ == '__main__':
    main()
