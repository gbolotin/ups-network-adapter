"""Synthetic diagnostic checks; run with python3 test_ups_stability.py."""

import json
from itertools import chain, repeat
from pathlib import Path
import subprocess
import tempfile
from unittest.mock import patch

from diagnostics.ups_stability import command, is_ups_record, rotating_log, run, sample, save_incident, usb_devices


def check():
    devices = [{'bus': 1, 'device': 59}]
    assert is_ups_record('abc 123 S Ci:1:059:0 s 80 06 0100 0000 0040 64 <', devices)
    assert is_ups_record('abc 123 C Ci:1:059:0 -110 0', devices)
    assert not is_ups_record('abc 123 S Ci:1:001:0 s a3 00 0000 0003 0004 4 <', devices)
    assert not is_ups_record('abc 123 C Ci:2:059:0 0 4 = 01050000', devices)
    assert not is_ups_record('bad record', devices)
    assert not is_ups_record('abc 123 C Ci:bad:059:0 0 4', devices)
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        device = directory / '1-1.3'
        device.mkdir()
        for name, content in {'idVendor': '051d', 'idProduct': '0002', 'busnum': '1', 'devnum': '59'}.items():
            device.joinpath(name).write_text(content)
        assert usb_devices(directory) == [{'path': '1-1.3', 'bus': 1, 'device': 59}]
        device.joinpath('idVendor').write_text('1234')
        assert not usb_devices(directory)

        logger = rotating_log(directory / 'bounded.log', 100, 2)
        for index in range(50):
            logger.info('record %s %s', index, 'x' * 20)
        for handler in logger.handlers:
            handler.close()
        files = list(directory.glob('bounded.log*'))
        assert len(files) == 3 and all(path.stat().st_size <= 100 for path in files)
        with patch('diagnostics.ups_stability.command', return_value={'stdout': 'é' * (1024 * 1024), 'stderr': ''}) as query:
            save_incident(directory, {'errors': ['first failure']})
            save_incident(directory, {'errors': ['later failure']})
            assert query.call_count == 2
            assert json.loads(directory.joinpath('incident.json').read_text())['errors'] == ['first failure']
            assert directory.joinpath('kernel-at-fault.log').stat().st_size == 1024 * 1024
            assert directory.joinpath('services-at-fault.log').stat().st_size == 1024 * 1024
        directory.joinpath('test.json').write_text('{"deadline":0}')
        with patch('diagnostics.ups_stability.sample') as query:
            run(directory, 1)
            query.assert_not_called()

        directory.joinpath('incident.json').unlink()
        directory.joinpath('test.json').write_text('{"deadline":101}')
        directory.joinpath('health.jsonl').write_text('{"service_pids":{"nut-driver@ups":"20"}}\n')
        record = {'service_pids': {'nut-driver@ups': '21'}, 'errors': ['SNMP readings unavailable'],
                  'nut_returncode': 0, 'readings': {'ups.status': 'OL'}}
        with patch('diagnostics.ups_stability.time.time', side_effect=chain([100, 100], repeat(102))), \
                patch('diagnostics.ups_stability.threading.Thread'), \
                patch('diagnostics.ups_stability.threading.Event'), \
                patch('diagnostics.ups_stability.sample', return_value=record), \
                patch('diagnostics.ups_stability.command', return_value={'stdout': '', 'stderr': ''}):
            run(directory, 1)
        assert not directory.joinpath('incident.json').exists()
        last = json.loads(directory.joinpath('health.jsonl').read_text().splitlines()[-1])
        assert last['events'] == ['Adapter service PID changed'] and last['errors'] == ['SNMP readings unavailable']
        # Actual NUT communication loss freezes the trace, independent of service PIDs.
        record = {'service_pids': {'nut-driver@ups': '21'}, 'errors': ['NUT readings unavailable'],
                  'nut_returncode': 1, 'readings': {'ups.status': None}}
        with patch('diagnostics.ups_stability.time.time', side_effect=chain([100, 100], repeat(102))), \
                patch('diagnostics.ups_stability.threading.Thread'), \
                patch('diagnostics.ups_stability.threading.Event'), \
                patch('diagnostics.ups_stability.sample', return_value=record), \
                patch('diagnostics.ups_stability.command', return_value={'stdout': '', 'stderr': ''}):
            run(directory, 1)
        incident = json.loads(directory.joinpath('incident.json').read_text())
        assert incident['errors'] == ['NUT readings unavailable']

    replies = [
        {'returncode': 0, 'stdout': 'ups.status: OB\nbattery.charge: 95\n', 'stderr': ''},
        {'returncode': 0, 'stdout': '10\n\n20\n\n30\n\n40\n', 'stderr': ''},
        {'returncode': 0, 'stdout': 'INTEGER: 95\nINTEGER: 5', 'stderr': ''},
    ]
    with patch('diagnostics.ups_stability.command', side_effect=replies), \
            patch('diagnostics.ups_stability.usb_devices', return_value=devices):
        record = sample(True)
        assert not record['errors'] and record['readings']['ups.status'] == 'OB'
        assert record['service_pids']['nut-driver@ups'] == '20'
    with patch('diagnostics.ups_stability.command', return_value={'returncode': 1, 'stdout': '', 'stderr': 'Data stale'}), \
            patch('diagnostics.ups_stability.usb_devices', return_value=[]):
        record = sample(True)
        assert len(record['errors']) == 4 and record['nut_error'] == 'Data stale'
    with patch('diagnostics.ups_stability.subprocess.run', side_effect=subprocess.TimeoutExpired(['upsc'], 5)):
        assert command(['upsc'])['returncode'] == -1
    print('PASS: UPS-only trace filtering, USB identity, bounded rotation, first-fault preservation, deadline, health and timeout handling')


if __name__ == '__main__':
    check()
