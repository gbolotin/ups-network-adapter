"""Runnable setup checks with simulated files, services and SNMP; no Pi required."""

from contextlib import ExitStack
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

from setup_pi import NUT_SERVER_CONFIG, PROJECT, SNMP_CONFIG, main, nut_ready, prepare_nut_listener, prepare_snmp, snmp_probe
from ups_autodetect import MARKER


def check() -> None:
    legacy_nut = '# LISTEN ::1 3493\nMAXAGE 6\nALLOW_NO_DEVICE true\nLISTEN 127.0.0.1 3493\n  LISTEN 192.168.50.200 3493 # old address\n'
    wildcard_nut = prepare_nut_listener(legacy_nut)
    assert wildcard_nut == '# LISTEN ::1 3493\nMAXAGE 6\nALLOW_NO_DEVICE true\nLISTEN 0.0.0.0 3493\n'
    assert prepare_nut_listener(wildcard_nut) == wildcard_nut
    assert prepare_nut_listener(legacy_nut.replace('192.168.50.200', '192.0.2.42')) == wildcard_nut
    assert prepare_nut_listener('') == '\nLISTEN 0.0.0.0 3493\n'
    template = (PROJECT / 'config/ups.conf').read_text()
    assert not any(line.strip().startswith('rwcommunity') for line in template.splitlines())
    assert 'view upsView included .1.3.6.1.2.1.1' in template
    assert 'view upsView included .1.3.6.1.2.1.33' in template
    first, secret, port = prepare_snmp('', [], template, None)
    assert secret == 'public' and port == 161, (secret, port)
    assert 'agentaddress udp:0.0.0.0:161' in first
    assert 'rocommunity public default -V upsView' in first
    assert prepare_snmp(first, [], template, None)[0] == first
    lan, same_secret, _ = prepare_snmp(first, [], template, '192.0.2.20')
    assert same_secret == secret and 'agentaddress udp:0.0.0.0:161' in lan
    assert 'rocommunity public 192.0.2.20/32 -V upsView' in lan
    assert 'rocommunity public default -V upsView' not in lan, lan
    assert 'rocommunity public 127.0.0.1/32 -V upsView' in lan
    assert prepare_snmp(lan, [], template, '192.0.2.20')[0] == lan
    assert prepare_snmp(lan, [], template, None)[0] == lan
    changed_manager = prepare_snmp(lan, [], template, '192.0.2.21')[0]
    assert 'rocommunity public 192.0.2.20/32' not in changed_manager
    assert 'rocommunity public 192.0.2.21/32 -V upsView' in changed_manager
    old_template = template.replace('udp:0.0.0.0:161', 'udp:127.0.0.1:1161').replace('rocommunity public default -V upsView', '# no active community')
    legacy = old_template.replace('--ups ups', '--ups apc') + '\nrocommunity keep_this 192.0.2.20/32 -V upsView\n'
    migrated, existing, migrated_port = prepare_snmp(old_template, [legacy], template, None)
    assert migrated_port == 161 and 'agentaddress udp:0.0.0.0:161' in migrated, migrated
    assert existing == 'keep_this' and '--ups ups' in migrated and '--ups apc' not in migrated
    assert 'rocommunity keep_this 192.0.2.20/32' in migrated
    assert 'rocommunity keep_this 127.0.0.1/32' in migrated
    assert prepare_snmp(migrated, [legacy], template, None)[0] == migrated
    assert prepare_snmp('', [legacy], template, None)[1] == 'keep_this', 'Fresh single endpoint must import legacy credentials'
    empty_migration, fallback, _ = prepare_snmp(old_template, [], template, None)
    assert fallback == 'public' and 'rocommunity public default -V upsView' in empty_migration
    assert prepare_snmp(empty_migration, [], template, None)[0] == empty_migration
    custom = migrated.replace('udp:0.0.0.0:161', 'udp:0.0.0.0:2161')
    assert prepare_snmp(custom, [], template, None) == (custom, 'keep_this', 2161)
    unsafe = old_template + '\nrocommunity YOUR_GENERATED_SECRET default -V upsView\n'
    replaced = prepare_snmp(unsafe, [], template, '192.0.2.20')[0]
    assert '\nrocommunity YOUR_GENERATED_SECRET' not in replaced
    wildcard = first.replace('udp:0.0.0.0:161', 'udp:161')
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
        assert snmp_probe('test_secret', 161) == 3

    # Healthy repair and --check paths must not install, rewrite or restart anything.
    files = {str(SNMP_CONFIG): first, str(NUT_SERVER_CONFIG): wildcard_nut}
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
    conflicting_snmpd = set()
    def state(action, unit):
        if unit == 'snmpd.service':
            return ('enabled' if action == 'is-enabled' else 'active') if conflicting_snmpd else ('disabled' if action == 'is-enabled' else 'inactive')
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
            # A distro daemon conflict alone must fail --check without mutations,
            # or be repaired without rewriting/restarting a healthy adapter.
            conflicting_snmpd.add('snmpd.service')
            if '--check' in arguments:
                assert main() == 1 and not write.called and not run.called
            else:
                def stop_distro(command, **kwargs):
                    assert command == ['/usr/bin/systemctl', 'disable', '--now', 'snmpd.service']
                    conflicting_snmpd.clear()
                    return subprocess.CompletedProcess(command, 0)
                run.side_effect = stop_distro
                assert main() == 0 and run.call_count == 1 and not write.called
                run.reset_mock()
            conflicting_snmpd.clear()
            files[str(SNMP_CONFIG)] = old_template
            conflicting_snmpd.add('snmpd.service')
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
                    if command == ['/usr/bin/systemctl', 'disable', '--now', 'snmpd.service']:
                        conflicting_snmpd.clear()
                    else:
                        assert command[:2] == ['/usr/bin/systemctl', 'restart']
                        assert not conflicting_snmpd, 'Distro snmpd must stop before adapter services restart'
                        inactive.discard(command[2])
                    return subprocess.CompletedProcess(command, 0)
                write.side_effect = write_config
                run.side_effect = control
                with tempfile.TemporaryDirectory() as backup:
                    stack.enter_context(patch('setup_pi.tempfile.mkdtemp', return_value=backup))
                    copy = stack.enter_context(patch('setup_pi.shutil.copy2'))
                    assert main() == 0
                    assert write.call_count == 1
                    copy.assert_called_once_with(SNMP_CONFIG, Path(backup) / 'ups.conf')
                    assert [call.args[0] for call in run.call_args_list] == [
                        ['/usr/bin/systemctl', 'disable', '--now', 'snmpd.service'],
                        ['/usr/bin/systemctl', 'restart', 'ups-autodetect.service'],
                        ['/usr/bin/systemctl', 'restart', 'ups-snmp.service'],
                    ]
                    assert files[str(SNMP_CONFIG)] == empty_migration
                    write.reset_mock()
                    run.reset_mock()
                    assert main() == 0
                    assert not write.called and not run.called
            files[str(SNMP_CONFIG)] = first
            conflicting_snmpd.clear()
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
            # Existing listeners migrate without reinstalling or restarting USB/SNMP.
            files[str(NUT_SERVER_CONFIG)] = legacy_nut
            run.reset_mock()
            write.reset_mock()
            if '--check' in arguments:
                assert main() == 1 and not run.called and not write.called
            else:
                def write_listener(path, content, **kwargs):
                    assert path == NUT_SERVER_CONFIG and kwargs == {'group': 'nut'}
                    files[str(path)] = content
                def restart_nut(command, **kwargs):
                    assert command == ['/usr/bin/systemctl', 'restart', 'nut-server.service']
                    return subprocess.CompletedProcess(command, 0)
                write.side_effect = write_listener
                run.side_effect = restart_nut
                with tempfile.TemporaryDirectory() as backup:
                    stack.enter_context(patch('setup_pi.tempfile.mkdtemp', return_value=backup))
                    copy = stack.enter_context(patch('setup_pi.shutil.copy2'))
                    assert main() == 0
                    copy.assert_called_once_with(NUT_SERVER_CONFIG, Path(backup) / 'upsd.conf')
                    assert write.call_count == 1 and run.call_count == 1
                    assert files[str(NUT_SERVER_CONFIG)] == wildcard_nut
                    assert files[str(SNMP_CONFIG)] == first
                    write.reset_mock()
                    run.reset_mock()
                    assert main() == 0 and not write.called and not run.called
            files[str(NUT_SERVER_CONFIG)] = wildcard_nut
    installer = (PROJECT / 'install.sh').read_text()
    release = 'systemctl disable --now snmpd.service'
    assert release in installer, 'Installer must disable distro snmpd before starting adapter services'
    assert installer.index(release) < installer.index('systemctl enable --now ups-autodetect.service')
    print('PASS: setup defaults UDP161/public, SNMP migration backup, snmpd stop-before-start, idempotence, NUT listener migration, credential/ACL preservation, manager restriction, private query and read-only checks')


if __name__ == '__main__':
    check()
