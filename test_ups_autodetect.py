"""Synthetic detection and service sequencing checks; no Linux services or USB required."""

import configparser
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

from ups_autodetect import MARKER, apply_selection, main, parse_scan, scan_usb, write_config

APC = '''Scanning USB bus.
[nutdev1]
    driver = "usbhid-ups"
    port = "auto"
    vendorid = "051D"
    productid = "0002"
    product = "Back-UPS BX750MI"
    serial = "SYNTHETIC_APC_001"
    bus = "001"
    device = "025"
    ###NOTMATCHED-YET###bcdDevice = "0001"
'''
# Synthetic IDs: the user's Eaton revision still needs its own hardware scan.
EATON = '''[nutdev1]
    driver = "nutdrv_qx"
    port = "auto"
    vendorid = "0665"
    productid = "5161"
    bus = "001"
    device = "026"
'''


def check() -> None:
    apc, identity, message = parse_scan(APC)
    assert apc.startswith(MARKER + '[ups]\n')
    assert 'driver = usbhid-ups' in apc and 'vendorid = 051d' in apc
    assert 'serial = "SYNTHETIC_APC_001"' in apc and 'sdorder = -1' in apc
    assert 'bus =' not in apc and 'device =' not in apc
    eaton = parse_scan(EATON)
    assert 'driver = nutdrv_qx' in eaton[0] and 'serial =' not in eaton[0]
    assert identity != eaton[1] and 'Selected' in message
    assert parse_scan(APC.replace('"025"', '"027"'))[1] != identity
    assert parse_scan('Scanning USB bus.\n')[0] == MARKER
    assert parse_scan(APC + EATON.replace('[nutdev1]', '[nutdev2]'))[0] == MARKER
    assert parse_scan(APC.replace('usbhid-ups', 'other-driver'))[0] == MARKER
    escaped = parse_scan(APC.replace('SYNTHETIC_APC_001', 'test.*'))[0]
    assert 'serial = "test\\\\.\\\\*"' in escaped  # Literal POSIX match, quoted for NUT.
    for invalid in (APC.replace('051D', '051D.*'), APC.replace('SYNTHETIC_APC_001', 'bad\x01serial'), APC + '\n[DEFAULT]\nport = /dev/null\n'):
        try:
            selected = parse_scan(invalid)
        except (ValueError, configparser.Error):
            pass
        else:
            assert selected[0] == MARKER

    with patch('ups_autodetect.subprocess.run', return_value=subprocess.CompletedProcess([], 0, APC, 'XML search disabled.')) as run:
        assert scan_usb()[0] == apc
        assert run.call_args.args[0] == ['/usr/bin/nut-scanner', '-U', '-N']
        assert run.call_args.kwargs['timeout'] == 20
    for error in (FileNotFoundError('scanner'), subprocess.TimeoutExpired('scanner', 20)):
        with patch('ups_autodetect.subprocess.run', side_effect=error):
            assert scan_usb()[0] == MARKER
    for stderr in ('USB search disabled.', 'Failed to open device bus 001'):
        with patch('ups_autodetect.subprocess.run', return_value=subprocess.CompletedProcess([], 0, APC, stderr)):
            assert scan_usb()[0] == MARKER

    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / 'ups.conf'
        path.write_text('[existing]\ndriver = usbhid-ups\n')
        with patch('ups_autodetect.systemctl') as control, patch('ups_autodetect.write_config') as write:
            try:
                apply_selection(apc, path)
            except ValueError:
                pass
            else:
                raise AssertionError('Unmanaged configuration was overwritten')
            assert not control.called and not write.called
        path.write_text(MARKER)
        events = []
        def control(*args):
            events.append(args)
        def write(target, content):
            events.append(('write', content))
            target.write_text(content)
        with patch('ups_autodetect.systemctl', side_effect=control), patch('ups_autodetect.write_config', side_effect=write):
            for selected in (apc, eaton[0], MARKER, apc):
                events.clear()
                apply_selection(selected, path)
                assert events == [
                    ('stop', 'nut-driver.target', 'nut-server.service'), ('write', selected),
                    ('restart', 'nut-driver-enumerator.service'), ('start', 'nut-driver.target', 'nut-server.service'),
                    ('try-restart', 'ups-snmp.service'),
                ]
                assert path.read_text() == selected

        # Failed ownership setup leaves the old file intact and removes the temporary file.
        group = SimpleNamespace(getgrnam=lambda name: SimpleNamespace(gr_gid=123))
        with patch.dict(sys.modules, grp=group), patch('ups_autodetect.os.chown', create=True) as ownership:
            write_config(path, eaton[0])
            assert path.read_text() == eaton[0]
            assert ownership.call_args.args[1:] == (0, 123)
            ownership.side_effect = PermissionError('ownership')
            try:
                write_config(path, apc)
            except PermissionError:
                pass
            else:
                raise AssertionError('Ownership failure was ignored')
            assert path.read_text() == eaton[0] and list(Path(folder).iterdir()) == [path]

    # Unchanged polls do not interrupt telemetry; disconnect/swap does reset it.
    scans = [parse_scan(APC), parse_scan(APC), eaton, parse_scan(''), parse_scan(APC)]
    with patch('ups_autodetect.scan_usb', side_effect=scans), patch('ups_autodetect.apply_selection') as apply, patch('ups_autodetect.time.sleep', side_effect=[None, None, None, None, InterruptedError('end check')]), patch('builtins.print'):
        try:
            main()
        except InterruptedError:
            pass
        assert [call.args[0] for call in apply.call_args_list] == [apc, eaton[0], MARKER, apc]
    print('PASS: single UPS detection, model switching, ambiguity/errors, matching validation and service sequencing')


if __name__ == '__main__':
    check()
