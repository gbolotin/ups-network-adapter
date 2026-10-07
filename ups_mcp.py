#!/usr/bin/env python3
"""Read-only MCP tools over stdio; launch as an ordinary SSH user, without a PTY."""

from datetime import datetime, timezone
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
from typing import BinaryIO

from ups_mib import read_ups

VERSIONS = ('2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25')
MAX_MESSAGE = 65536
SERVICES = ('ups-autodetect.service', 'nut-driver.target', 'nut-server.service', 'ups-snmp.service')


def numeric(value: str | None) -> float | None:
    try:
        result = float(value)
        return result if math.isfinite(result) and result >= 0 else None
    except (TypeError, ValueError, OverflowError):
        return None


def get_ups_status() -> dict:
    values = read_ups('ups')  # Fixed local, read-only NUT query with a one-second timeout.
    return {
        'ups': 'ups',
        'manufacturer': values.get('ups.mfr') or values.get('device.mfr'),
        'model': values.get('ups.model') or values.get('device.model'),
        'driver': values.get('driver.name'),
        'status': values['ups.status'].split(),
        'battery_charge_percent': numeric(values.get('battery.charge')),
        'battery_runtime_seconds': numeric(values.get('battery.runtime')),
        'battery_voltage_volts': numeric(values.get('battery.voltage')),
        'input_voltage_volts': numeric(values.get('input.voltage')),
        'load_percent': numeric(values.get('ups.load')),
    }


def get_pi_health() -> dict:
    temperature = Path('/sys/class/thermal/thermal_zone0/temp')
    raw_temperature = numeric(temperature.read_text().strip()) if temperature.exists() else None
    uptime = numeric(Path('/proc/uptime').read_text().split()[0])
    disk = shutil.disk_usage('/')
    return {
        'cpu_temperature_celsius': raw_temperature / 1000 if raw_temperature is not None else None,
        'uptime_seconds': uptime,
        'root_disk_total_bytes': disk.total,
        'root_disk_used_bytes': disk.used,
        'root_disk_free_bytes': disk.free,
    }


def get_adapter_status() -> dict:
    result = subprocess.run(
        ['/usr/bin/systemctl', 'show', '--no-pager',
         '--property=Id,LoadState,ActiveState,SubState', *SERVICES],
        capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=3, check=True,
    )
    states = {}
    for block in result.stdout.strip().split('\n\n'):
        fields = dict(line.split('=', 1) for line in block.splitlines() if '=' in line)
        if fields.get('Id') in SERVICES:
            states[fields['Id']] = {key: fields.get(key) for key in ('LoadState', 'ActiveState', 'SubState')}
    if set(states) != set(SERVICES):
        raise ValueError('Incomplete service status')
    return {'services': states}


TOOLS = {
    'get_ups_status': (get_ups_status, 'Read current local UPS model, status and measurements. Missing sensors are null; runtime is in seconds.'),
    'get_pi_health': (get_pi_health, 'Read Pi CPU temperature, uptime and root filesystem space.'),
    'get_adapter_status': (get_adapter_status, 'Read USB detector, NUT driver target, NUT server and SNMP service states. Active services alone do not prove UPS communication.'),
}


def reject_constant(value: str) -> None:
    raise ValueError('Non-JSON numeric constant')


def serve(stdin: BinaryIO, stdout: BinaryIO) -> None:
    """Bounded, newline-delimited JSON-RPC; only the advertised tools are callable."""
    version = None
    initialized = False

    def reply(identifier, *, result=None, code=None, message=None):
        body = {'jsonrpc': '2.0', 'id': identifier}
        body.update({'error': {'code': code, 'message': message}} if code else {'result': result})
        stdout.write((json.dumps(body, ensure_ascii=True, allow_nan=False, separators=(',', ':')) + '\n').encode('utf-8'))
        stdout.flush()

    while raw := stdin.readline(MAX_MESSAGE + 1):
        if len(raw) > MAX_MESSAGE:
            # Drain this message in bounded chunks, then resume at the next line.
            while raw and not raw.endswith(b'\n'):
                raw = stdin.readline(MAX_MESSAGE + 1)
            reply(None, code=-32600, message='Message exceeds 64 KiB')
            continue
        try:
            request = json.loads(raw.decode('utf-8'), parse_constant=reject_constant)
        except (UnicodeError, ValueError, RecursionError):
            reply(None, code=-32700, message='Invalid JSON')
            continue
        if (not isinstance(request, dict) or request.get('jsonrpc') != '2.0'
                or not isinstance(request.get('method'), str)
                or ('id' in request and (type(request['id']) not in (int, str)))):
            reply(None, code=-32600, message='Invalid JSON-RPC request')
            continue
        method = request['method']
        params = request.get('params', {})
        if 'id' not in request:
            if method == 'notifications/initialized' and version and isinstance(params, dict):
                initialized = True
            # Never execute tools from notifications or respond to notifications.
            continue
        identifier = request['id']
        if not isinstance(params, dict):
            reply(identifier, code=-32602, message='Parameters must be an object')
        elif method == 'initialize':
            client = params.get('clientInfo')
            if (version or not isinstance(params.get('protocolVersion'), str)
                    or not isinstance(params.get('capabilities'), dict)
                    or not isinstance(client, dict)
                    or not all(isinstance(client.get(key), str) for key in ('name', 'version'))):
                reply(identifier, code=-32602, message='Invalid or repeated initialization')
                continue
            version = params['protocolVersion'] if params['protocolVersion'] in VERSIONS else VERSIONS[-1]
            reply(identifier, result={
                'protocolVersion': version, 'capabilities': {'tools': {'listChanged': False}},
                'serverInfo': {'name': 'ups-network-adapter', 'version': '0.2.0'},
                'instructions': 'Read-only live measurements. Missing readings are unavailable, not zero. No control or shutdown tools.',
            })
        elif method == 'ping':
            reply(identifier, result={})
        elif not initialized:
            reply(identifier, code=-32000, message='Initialize the MCP session first')
        elif method == 'tools/list':
            if params.get('cursor') is not None:
                reply(identifier, code=-32602, message='No pagination cursor is supported')
                continue
            reply(identifier, result={'tools': [{
                'name': name, 'description': description,
                'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': False},
                'annotations': {'readOnlyHint': True, 'destructiveHint': False, 'idempotentHint': True, 'openWorldHint': False},
            } for name, (_, description) in TOOLS.items()]})
        elif method == 'tools/call':
            name = params.get('name')
            arguments = params.get('arguments', {})
            if not isinstance(name, str) or name not in TOOLS or not isinstance(arguments, dict) or arguments:
                reply(identifier, code=-32602, message='Choose a listed tool with an empty arguments object')
                continue
            try:
                data = TOOLS[name][0]()
                data['observed_at'] = datetime.now(timezone.utc).isoformat()
                result = {'content': [{'type': 'text', 'text': json.dumps(data, allow_nan=False)}], 'isError': False}
                if version in VERSIONS[2:]:
                    result['structuredContent'] = data
            except (OSError, subprocess.SubprocessError, ValueError, IndexError):
                # Do not expose subprocess output, private configurations, or stale readings.
                result = {'content': [{'type': 'text', 'text': f'{name}: live readings unavailable; check the UPS connection and adapter services.'}], 'isError': True}
            reply(identifier, result=result)
        else:
            reply(identifier, code=-32601, message='Method not found')


if __name__ == '__main__':
    try:
        serve(sys.stdin.buffer, sys.stdout.buffer)
    except (BrokenPipeError, KeyboardInterrupt):
        pass
