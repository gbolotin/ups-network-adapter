"""Runnable setup checks with simulated files, services and SNMP; no Pi required."""

from contextlib import ExitStack
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

from setup_pi import PROJECT, SNMP_CONFIG, main, nut_ready, prepare_snmp, snmp_probe
from ups_autodetect import MARKER


def check() -> None:
    template = (PROJECT / 'config/ups.conf').read_text()
    with patch('setup_pi.secrets.token_hex', return_value='test_secret'):
        first, secret, port = prepare_snmp('', [], template, None)
        assert secret == 'test_secret' and port == 1161
        assert 'rocommunity test_secret 127.0.0.1/32 -V upsView' in first
        assert prepare_snmp(first, [], template, None)[0] == first
        lan, same_secret, _ = prepare_snmp(first, [], template, '192.0.2.20')
        assert same_secret == secret and 'agentaddress udp:0.0.0.0:1161' in lan
        assert 'rocommunity test_secret 192.0.2.20/32 -V upsView' in lan
        assert prepare_snmp(lan, [], template, '192.0.2.20')[0] == lan
        assert prepare_snmp(lan, [], template, None)[0] == lan
        legacy = template.replace('--ups ups', '--ups apc') + '\nrocommunity keep_this 192.0.2.20/32 -V upsView\n'
        migrated, existing, _ = prepare_snmp(template, [legacy], template, None)
        assert existing == 'keep_this' and '--ups ups' in migrated and '--ups apc' not in migrated
        assert 'rocommunity keep_this 192.0.2.20/32' in migrated
        assert 'rocommunity keep_this 127.0.0.1/32' in migrated
        assert prepare_snmp(migrated, [legacy], template, None)[0] == migrated
        unsafe = template + '\nrocommunity YOUR_GENERATED_SECRET default -V upsView\n'
        replaced = prepare_snmp(unsafe, [], template, '192.0.2.20')[0]
        assert '\nrocommunity YOUR_GENERATED_SECRET' not in replaced
        wildcard = first.replace('udp:127.0.0.1:1161', 'udp:1161')
        assert prepare_snmp(wildcard, [], template, None)[0] == wildcard
    for invalid in ('192.0.2.999', '192.0.2.20\nrocommunity bad default', '::1'):
        try:
            prepare_snmp(first, [], template, invalid)
        except ValueError:
            pass
        else:
            raise AssertionError('Invalid manager accepted')

    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory)
        (path / 'ups.conf').write_text(MARKER)
        (path / 'nut.conf').write_text('MODE = netserver # comment\n')
        (path / 'upsd.conf').write_text('LISTEN 127.0.0.1\nMAXAGE 6 # comment\nALLOW_NO_DEVICE true\n')
        assert nut_ready(path)
        with (path / 'upsd.conf').open('a') as stream:
            stream.write('MAXAGE 15\n')
        assert not nut_ready(path)
        (path / 'ups.conf').write_text('[apc]\n')
        assert not nut_ready(path)

    def probe(arguments, **kwargs):
        assert 'test_secret' not in arguments and '-c' not in arguments
        config = Path(kwargs['env']['SNMPCONFPATH']) / 'snmp.conf'
        assert config.read_text() == 'defCommunity test_secret\n'
        return subprocess.CompletedProcess(arguments, 0, '3\n', '')
    with patch('setup_pi.run', side_effect=probe):
        assert snmp_probe('test_secret', 1161) == 3

    # Healthy repair and --check paths must not install, rewrite or restart anything.
    files = {str(SNMP_CONFIG): first}
    for source, target in (
        (PROJECT / 'ups_autodetect.py', '/usr/local/lib/ups-network-adapter/ups_autodetect.py'),
        (PROJECT / 'ups_mib.py', '/usr/local/lib/ups-network-adapter/ups_mib.py'),
        (PROJECT / 'ups_mcp.py', '/usr/local/lib/ups-network-adapter/ups_mcp.py'),
        (PROJECT / 'config/ups-autodetect.service', '/etc/systemd/system/ups-autodetect.service'),
        (PROJECT / 'config/ups-snmp.service', '/etc/systemd/system/ups-snmp.service'),
        (PROJECT / 'config/ups.conf', None),
    ):
        content = source.read_text()
        files[str(source)] = content
        if target:
            files[str(Path(target))] = content
    inactive = set()
    def state(action, unit):
        if unit == 'nut-monitor.service':
            return 'masked' if action == 'is-enabled' else 'inactive'
        if unit == 'nut-driver-enumerator.path' or unit.startswith('ups-snmp@'):
            return 'disabled' if action == 'is-enabled' else 'inactive'
        return 'enabled' if action == 'is-enabled' else 'inactive' if unit in inactive else 'active'
    for arguments in (['setup_pi.py', '--check'], ['setup_pi.py']):
        with ExitStack() as stack:
            stack.enter_context(patch.object(sys, 'argv', arguments))
            stack.enter_context(patch('setup_pi.read', side_effect=lambda path: files.get(str(path), '')))
            stack.enter_context(patch('setup_pi.nut_ready', return_value=True))
            stack.enter_context(patch('setup_pi.private_config', return_value=True))
            stack.enter_context(patch('setup_pi.Path.exists', return_value=True))
            stack.enter_context(patch('setup_pi.state', side_effect=state))
            stack.enter_context(patch('setup_pi.shutil.which', return_value=None))
            stack.enter_context(patch('setup_pi.scan_usb', return_value=(MARKER + '[ups]\n', (), 'selected')))
            stack.enter_context(patch('setup_pi.read_ups', return_value={'ups.status': 'OL', 'ups.model': 'Test UPS'}))
            stack.enter_context(patch('setup_pi.snmp_probe', return_value=3))
            write = stack.enter_context(patch('setup_pi.write_config'))
            run = stack.enter_context(patch('setup_pi.run'))
            stack.enter_context(patch('builtins.print'))
            assert main() == 0
            assert not write.called and not run.called
            files[str(SNMP_CONFIG)] = template
            if '--check' in arguments:
                assert main() == 1
                assert not write.called and not run.called
            else:
                # Configure missing SNMP access and start an inactive detector, then rerun.
                inactive.add('ups-autodetect.service')
                def write_config(path, content, **kwargs):
                    assert kwargs == {'group': 'Debian-snmp'}
                    files[str(path)] = content
                def control(command, **kwargs):
                    assert command[:2] == ['/usr/bin/systemctl', 'restart']
                    inactive.discard(command[2])
                    return subprocess.CompletedProcess(command, 0)
                write.side_effect = write_config
                run.side_effect = control
                with tempfile.TemporaryDirectory() as backup:
                    stack.enter_context(patch('setup_pi.tempfile.mkdtemp', return_value=backup))
                    stack.enter_context(patch('setup_pi.shutil.copy2'))
                    stack.enter_context(patch('setup_pi.secrets.token_hex', return_value='test_secret'))
                    assert main() == 0
                    assert write.call_count == 1
                    assert [call.args[0][2] for call in run.call_args_list] == ['ups-autodetect.service', 'ups-snmp.service']
                    write.reset_mock()
                    run.reset_mock()
                    assert main() == 0
                    assert not write.called and not run.called
            files[str(SNMP_CONFIG)] = first
            # Installing only the new MCP file must not restart detector or SNMP.
            target = str(Path('/usr/local/lib/ups-network-adapter/ups_mcp.py'))
            files[target] = ''
            run.reset_mock()
            write.reset_mock()
            if '--check' in arguments:
                assert main() == 1 and not run.called and not write.called
            else:
                def install_mcp(command, **kwargs):
                    assert command == ['/bin/bash', str(PROJECT / 'install.sh')]
                    files[target] = files[str(PROJECT / 'ups_mcp.py')]
                    return subprocess.CompletedProcess(command, 0)
                run.side_effect = install_mcp
                assert main() == 0 and run.call_count == 1 and not write.called
            files[target] = files[str(PROJECT / 'ups_mcp.py')]
    print('PASS: setup idempotence, credential preservation/migration, manager validation, private SNMP query and read-only checks')


if __name__ == '__main__':
    check()
