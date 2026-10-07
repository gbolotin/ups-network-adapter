"""MCP wire and read-only monitoring checks; run with python3 test_ups_mcp.py."""

from io import BytesIO
import json
from pathlib import Path
import shutil
import subprocess
import sys
from unittest.mock import patch

from ups_mcp import MAX_MESSAGE, SERVICES, VERSIONS, get_adapter_status, get_pi_health, get_ups_status, serve


def request(method, identifier=1, **params):
    return {'jsonrpc': '2.0', 'id': identifier, 'method': method, 'params': params}


def handshake(version=VERSIONS[-1]):
    return [request('initialize', protocolVersion=version, capabilities={}, clientInfo={'name': 'test', 'version': '1'}),
            {'jsonrpc': '2.0', 'method': 'notifications/initialized'}]


def exchange(messages):
    source = BytesIO(b''.join(message if isinstance(message, bytes) else (json.dumps(message) + '\n').encode() for message in messages))
    target = BytesIO()
    serve(source, target)
    return [json.loads(line) for line in target.getvalue().splitlines()]


def check():
    values = {'ups.status': 'OL CHRG', 'device.model': 'Synthetic UPS', 'device.mfr': 'APC',
              'battery.charge': '100', 'battery.runtime': '3284', 'input.voltage': '232', 'ups.load': '10'}
    with patch('ups_mcp.read_ups', return_value=values) as read:
        data = get_ups_status()
        read.assert_called_once_with('ups')
        assert data['model'] == 'Synthetic UPS' and data['status'] == ['OL', 'CHRG']
        assert data['battery_runtime_seconds'] == 3284 and data['battery_voltage_volts'] is None
        assert data['input_voltage_volts'] == 232 and data['load_percent'] == 10
        for invalid in ('NaN', 'Infinity', '-1', 'bad'):
            values['battery.charge'] = invalid
            assert get_ups_status()['battery_charge_percent'] is None

    with patch('ups_mcp.Path.exists', return_value=True), patch('ups_mcp.Path.read_text', side_effect=['43300\n', '1234.5 0.0\n']), \
            patch('ups_mcp.shutil.disk_usage', return_value=shutil._ntuple_diskusage(100, 60, 40)):
        data = get_pi_health()
        assert data['cpu_temperature_celsius'] == 43.3 and data['uptime_seconds'] == 1234.5
        assert data['root_disk_free_bytes'] == 40

    service_output = '\n\n'.join(f'Id={name}\nLoadState=loaded\nActiveState=active\nSubState=running' for name in SERVICES)
    with patch('ups_mcp.subprocess.run', return_value=subprocess.CompletedProcess([], 0, service_output)) as run:
        assert all(fields['ActiveState'] == 'active' for fields in get_adapter_status()['services'].values())
        command = run.call_args.args[0]
        assert command[:2] == ['/usr/bin/systemctl', 'show'] and command[-4:] == list(SERVICES)
        assert run.call_args.kwargs['timeout'] == 3 and 'shell' not in run.call_args.kwargs
        run.return_value.stdout = 'Id=unrelated.service\n'
        try:
            get_adapter_status()
        except ValueError:
            pass
        else:
            raise AssertionError('Incomplete service report accepted')

    with patch('ups_mcp.read_ups', return_value=values) as read:
        for version in VERSIONS:
            replies = exchange(handshake(version) + [request('tools/list', 2), request('tools/call', 3, name='get_ups_status'), request('ping', 'ping')])
            assert replies[0]['result']['protocolVersion'] == version
            tools = replies[1]['result']['tools']
            assert {tool['name'] for tool in tools} == {'get_ups_status', 'get_pi_health', 'get_adapter_status'}
            assert all(tool['annotations']['readOnlyHint'] and not tool['inputSchema']['additionalProperties'] for tool in tools)
            result = replies[2]['result']
            assert result['isError'] is False and json.loads(result['content'][0]['text'])['model'] == 'Synthetic UPS'
            assert ('structuredContent' in result) == (version in VERSIONS[2:])
            assert replies[3]['id'] == 'ping' and replies[3]['result'] == {}
        assert exchange(handshake('future-version'))[0]['result']['protocolVersion'] == VERSIONS[-1]
        read.reset_mock()
        replies = exchange([request('tools/call', name='get_ups_status')] + handshake() + [
            request('tools/call', name='shutdown'),
            request('tools/call', name='get_ups_status', arguments={'host': '; reboot'}),
            request('tools/call', name='get_ups_status', arguments=[]),
            {'jsonrpc': '2.0', 'method': 'tools/call', 'params': {'name': 'get_ups_status'}},
            request('resources/list'), request('tools/list', cursor='bad'), request('initialize'),
        ])
        assert [item['error']['code'] for item in replies if 'error' in item] == [-32000, -32602, -32602, -32602, -32601, -32602, -32602]
        assert not read.called

    # Unavailable telemetry is an MCP tool error, never a retained healthy snapshot.
    with patch('ups_mcp.read_ups', side_effect=[values, subprocess.TimeoutExpired('upsc', 1), values]):
        replies = exchange(handshake() + [request('tools/call', n, name='get_ups_status') for n in (2, 3, 4)])
        assert [item['result']['isError'] for item in replies[1:]] == [False, True, False]
        assert 'structuredContent' not in replies[2]['result'] and 'Synthetic UPS' not in str(replies[2])

    replies = exchange([b'{bad\n', b'\xff\n', b'[]\n', b'{"jsonrpc":"2.0","id":null,"method":"ping"}\n',
                        b'{"jsonrpc":"2.0","id":NaN,"method":"ping"}\n', b'x' * (MAX_MESSAGE * 2) + b'\n', request('ping', 0)])
    assert [item['error']['code'] for item in replies[:-1]] == [-32700, -32700, -32600, -32600, -32700, -32600]
    assert replies[-1]['id'] == 0 and replies[-1]['result'] == {}
    assert exchange([request('ping', params_not_used=True) | {'params': []}])[0]['error']['code'] == -32602

    # Real subprocess framing, clean stdout, initialization and EOF shutdown.
    process = subprocess.run([sys.executable, str(Path(__file__).with_name('ups_mcp.py'))],
                             input=''.join(json.dumps(item) + '\n' for item in handshake() + [request('tools/list', 2)]),
                             capture_output=True, text=True, timeout=5, check=True)
    assert process.stderr == '' and len(process.stdout.splitlines()) == 2
    assert len(json.loads(process.stdout.splitlines()[1])['result']['tools']) == 3
    print('PASS: MCP lifecycle, versions, tools, read-only boundaries, sensor units, errors/recovery, framing limits and CLI')


if __name__ == '__main__':
    check()
