import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parent))
from ups_power import NutConnection, UpsPower


class FakeNut:
    def __init__(self):
        self.commands = []
        self.snapshots = [{'id': 'a' * 24, 'manufacturer': 'Eaton', 'model': 'Test UPS',
                           'serial_number': 'test', 'commands': ['load.off']}]

    def __enter__(self): return self
    def __exit__(self, *_): pass
    def snapshot(self):
        return self.snapshots.pop(0) if len(self.snapshots) > 1 else self.snapshots[0]
    def command(self, value): self.commands.append(value)


class UpsPowerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / 'credentials.json'
        self.path.write_text(json.dumps({'username': 'home_console_power', 'password': 'b' * 64}))
        self.nut = FakeNut()
        self.power = UpsPower(self.path, lambda: self.nut)

    def tearDown(self): self.directory.cleanup()

    def test_capabilities_never_authenticate_or_send_commands(self):
        self.assertTrue(self.power.status()['can_power_off'])
        self.assertEqual(self.nut.commands, [])
        self.path.unlink()
        self.assertFalse(self.power.status()['can_power_off'])

    def test_only_fixed_off_command_is_sent_and_repeats_are_blocked(self):
        self.assertEqual(self.power.power_off('a' * 24)['accepted'], 'load.off')
        self.assertEqual(self.nut.commands, ['USERNAME home_console_power', 'PASSWORD ' + 'b' * 64, 'INSTCMD ups load.off'])
        with self.assertRaises(ValueError): self.power.power_off('a' * 24)
        self.assertEqual(len(self.nut.commands), 3)

    def test_wrong_ups_unsupported_command_and_invalid_identity_fail_closed(self):
        for identity in ['c' * 24, '', 'a' * 24 + '\nINSTCMD ups load.off', None]:
            with self.assertRaises(ValueError): self.power.power_off(identity)
        self.nut.snapshots[0]['commands'] = ['shutdown.return']
        with self.assertRaises(ValueError): self.power.power_off('a' * 24)
        self.assertEqual(self.nut.commands, [])

    def test_device_change_after_authentication_does_not_send_off(self):
        self.nut.snapshots.append({**self.nut.snapshots[0], 'id': 'c' * 24})
        with self.assertRaises(ValueError): self.power.power_off('a' * 24)
        self.assertFalse(any(command.startswith('INSTCMD') for command in self.nut.commands))


if __name__ == '__main__': unittest.main()
