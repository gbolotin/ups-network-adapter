"""Confirmed, identity-bound UPS output-off operation over local NUT only."""
import json
from pathlib import Path
import re
import shlex
import socket
import threading
import time


class NutConnection:
    def __enter__(self):
        self.socket = socket.create_connection(('127.0.0.1', 3493), timeout=4)
        self.socket.settimeout(4)
        self.stream = self.socket.makefile('rwb')
        return self

    def __exit__(self, *_):
        self.stream.close()
        self.socket.close()

    def line(self):
        line = self.stream.readline(8193)
        if not line or len(line) > 8192 or not line.endswith(b'\n'):
            raise ValueError('Incomplete NUT reply')
        return line.decode('utf-8').strip()

    def send(self, command):
        self.stream.write((command + '\n').encode('ascii'))
        self.stream.flush()

    def command(self, command):
        self.send(command)
        if self.line() != 'OK':
            raise ValueError('NUT command was not accepted')

    def listing(self, kind):
        self.send(f'LIST {kind} ups')
        if self.line() != f'BEGIN LIST {kind} ups':
            raise ValueError('UPS is not available')
        result = []
        for _ in range(512):
            line = self.line()
            if line == f'END LIST {kind} ups':
                return result
            parts = shlex.split(line)
            if parts[:2] != [kind, 'ups'] or len(parts) != (4 if kind == 'VAR' else 3):
                raise ValueError('Invalid UPS reply')
            result.append(parts[2:])
        raise ValueError('UPS response exceeds limit')

    def snapshot(self):
        # Deployed from the same pure policy.py used by the HA adapter.
        from ups_identity import identity
        values = dict(self.listing('VAR'))
        if not values.get('ups.status'):
            raise ValueError('Missing UPS status')
        return {**identity(values), 'commands': [item[0] for item in self.listing('CMD')]}


class UpsPower:
    def __init__(self, credentials_path='/etc/ups-network-adapter/ups-power.json', connection_factory=NutConnection):
        self.credentials_path = Path(credentials_path)
        self.connection_factory = connection_factory
        self.lock = threading.Lock()
        self.last_off = -60

    def status(self):
        with self.connection_factory() as nut:
            info = nut.snapshot()
        return {key: info[key] for key in ('id', 'manufacturer', 'model', 'serial_number')} | {
            'can_power_off': 'load.off' in info['commands'] and self.credentials_path.is_file()}

    def power_off(self, expected_identity):
        if not isinstance(expected_identity, str) or not re.fullmatch(r'[a-f0-9]{24}', expected_identity):
            raise ValueError('Invalid UPS identity')
        with self.lock:
            if time.monotonic() - self.last_off < 60:
                raise ValueError('UPS command already requested')
            credentials = json.loads(self.credentials_path.read_text())
            if credentials.get('username') != 'home_console_power' or not re.fullmatch(r'[a-f0-9]{64}', credentials.get('password', '')):
                raise ValueError('Invalid UPS control configuration')
            with self.connection_factory() as nut:
                def check():
                    info = nut.snapshot()
                    if info['id'] != expected_identity or 'load.off' not in info['commands']:
                        raise ValueError('Connected UPS changed or does not support output off')
                check()
                nut.command('USERNAME home_console_power')
                nut.command('PASSWORD ' + credentials['password'])
                check()  # Recheck after authentication, immediately before the fixed command.
                self.last_off = time.monotonic()
                nut.command('INSTCMD ups load.off')
        return {'accepted': 'load.off', 'ups_identity': expected_identity}
