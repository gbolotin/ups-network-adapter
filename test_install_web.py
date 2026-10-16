"""Simulated settings installation: no root, packages, services, or network required."""

import contextlib
import json
from pathlib import Path
import subprocess
import tempfile
from unittest.mock import patch

import install_web as installer


def main():
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        library = root / 'lib'
        library.mkdir()
        (library / 'ups_autodetect.py').write_text('installed')
        config = root / 'ups.conf'
        config.write_text(Path('config/ups.conf').read_text())
        state = root / 'state'
        credentials = root / 'credentials.json'
        unit = root / 'ups-web.service'
        commands = []

        def run(arguments, **kwargs):
            commands.append(arguments)
            assert kwargs.get('check') and kwargs.get('timeout')
            if arguments[0] == 'openssl':
                Path(arguments[arguments.index('-keyout') + 1]).write_text('private-key')
                Path(arguments[arguments.index('-out') + 1]).write_text('certificate')
            return subprocess.CompletedProcess(arguments, 0)

        class Response:
            status = 200

            def read(self):
                return b'UPS adapter settings'

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

        class Opener:
            def open(self, request, timeout):
                assert request.full_url == f'http://127.0.0.1:{installer.PORT}/'
                assert request.get_header('Authorization').startswith('Basic ')
                return Response()

        with contextlib.ExitStack() as stack:
            for name, value in [('LIBRARY', library), ('CONFIG', config), ('STATE', state), ('CREDENTIALS', credentials), ('UNIT', unit)]:
                stack.enter_context(patch.object(installer, name, value))
            stack.enter_context(patch.object(installer.os, 'getuid', return_value=0, create=True))
            stack.enter_context(patch.object(installer.os, 'chown', create=True))
            stack.enter_context(patch.object(installer.shutil, 'which', return_value='/usr/bin/openssl'))
            stack.enter_context(patch.object(installer.subprocess, 'run', side_effect=run))
            stack.enter_context(patch.object(installer.ssl, 'create_default_context'))
            stack.enter_context(patch.object(installer.urllib.request, 'build_opener', return_value=Opener()))
            original = config.read_bytes()
            installer.install()
            secret = credentials.read_bytes()
            assert len(json.loads(secret)['password']) >= 32
            assert (library / 'ups_web.html').is_file() and (library / 'ups_account.html').is_file() and (library / 'ups_maintenance.html').is_file() and unit.is_file()
            assert config.read_bytes() == original
            assert any(command[1:3] == ['restart', 'ups-web.service'] for command in commands)
            commands.clear()
            installer.install()
            assert credentials.read_bytes() == secret
            assert not any(command[0] == 'openssl' or command[1] == 'restart' for command in commands)
            assert any(command[1:3] == ['start', 'ups-web.service'] for command in commands)
            assert not any('ups-snmp.service' in command or 'nut-server.service' in command for command in commands)
            if __import__('os').name != 'nt':
                assert credentials.stat().st_mode & 0o777 == 0o600
                assert state.stat().st_mode & 0o777 == 0o700
            with patch.object(installer.os, 'getuid', return_value=1000):
                try:
                    installer.install()
                except ValueError:
                    pass
                else:
                    raise AssertionError('Non-root installation accepted')
            with patch.object(installer.shutil, 'which', return_value=None):
                try:
                    installer.install()
                except ValueError:
                    pass
                else:
                    raise AssertionError('Missing OpenSSL ignored')
            with patch.object(installer.Path, 'is_symlink', return_value=True):
                try:
                    installer.install()
                except ValueError:
                    pass
                else:
                    raise AssertionError('Symlinked installation accepted')
            with patch.object(Opener, 'open', side_effect=OSError('offline')), patch('time.sleep'):
                try:
                    installer.install()
                except RuntimeError as error:
                    assert 'health check failed' in str(error)
                else:
                    raise AssertionError('Failed HTTPS health check ignored')
            for invalid_pwd in ('short', 'has:colon123', 'has\nnewline123', ''):
                try:
                    installer.install(password=invalid_pwd)
                except ValueError:
                    pass
                else:
                    raise AssertionError(f'Invalid password accepted: {invalid_pwd}')
            installer.install(password='my-custom-pass-123')
            assert json.loads(credentials.read_text())['password'] == 'my-custom-pass-123'
            assert config.read_bytes() == original
    print('PASS: web installation, custom and private credentials, HTTPS generation, fixed service operations, repeat installation and prerequisite checks')


if __name__ == '__main__':
    main()
