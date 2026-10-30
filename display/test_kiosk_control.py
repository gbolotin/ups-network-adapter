import http.client
import json
from pathlib import Path
import sys
import threading
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parent))
from kiosk_control import ControlServer


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.settings_path = Path(self.directory.name) / 'screen.json'
        self.server = ControlServer(('127.0.0.1', 0), 'x' * 48, '127.0.0.1', executor=lambda _: self.fail('No real power operation'), settings_path=self.settings_path)
        self.actions = []
        self.server.schedule = lambda action: self.actions.append(action) is None
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()

    def request(self, body, token='x' * 48, path='/power'):
        client = http.client.HTTPConnection(*self.server.server_address)
        client.request('POST', path, json.dumps(body), {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        response = client.getresponse()
        status = response.status
        response.read()
        client.close()
        return status

    def test_only_confirmed_allowlisted_commands_are_accepted(self):
        self.assertEqual(self.request({'action': 'restart', 'confirmed': True}), 200)
        self.assertEqual(self.request({'action': 'shutdown', 'confirmed': True}), 200)
        for action in ('host-reboot', 'restart; rm -rf /', 'reboot'):
            self.assertEqual(self.request({'action': action, 'confirmed': True}), 400)
        self.assertEqual(self.actions, ['restart', 'shutdown'])

    def test_confirmation_token_and_source_address_are_required(self):
        self.assertEqual(self.request({'action': 'restart', 'confirmed': False}), 400)
        self.assertEqual(self.request({'action': 'restart', 'confirmed': True}, 'wrong'), 403)
        self.server.allowed_peer = '192.0.2.1'
        self.assertEqual(self.request({'action': 'restart', 'confirmed': True}), 403)
        self.assertEqual(self.actions, [])

    def test_screen_toggle_is_authenticated_persistent_and_never_schedules_power(self):
        from screen_settings import read_night_blanking
        self.assertTrue(read_night_blanking(self.settings_path))
        self.assertEqual(self.request({'enabled': False}, token='wrong', path='/screen'), 403)
        for invalid in ['false', 0, None]:
            self.assertEqual(self.request({'enabled': invalid}, path='/screen'), 400)
        for enabled in [False, True]:
            self.assertEqual(self.request({'enabled': enabled}, path='/screen'), 200)
            self.assertEqual(read_night_blanking(self.settings_path), enabled)
        self.assertEqual(self.actions, [])

    def test_ups_off_requires_confirmation_and_uses_separate_control(self):
        calls = []
        class FakePower:
            def power_off(self, expected):
                if expected != 'a' * 24:
                    raise ValueError('Changed UPS')
                calls.append(expected)
                return {'accepted': 'load.off'}
        self.server.ups_power = FakePower()
        body = {'expected_identity': 'a' * 24, 'confirmed': True}
        self.assertEqual(self.request(body, token='wrong', path='/ups/off'), 403)
        self.assertEqual(self.request({**body, 'confirmed': False}, path='/ups/off'), 400)
        self.assertEqual(self.request({**body, 'expected_identity': 'b' * 24}, path='/ups/off'), 409)
        self.assertEqual(calls, [])
        self.assertEqual(self.request(body, path='/ups/off'), 200)
        self.assertEqual(calls, ['a' * 24])
        self.assertEqual(self.actions, [])


if __name__ == '__main__':
    unittest.main()
