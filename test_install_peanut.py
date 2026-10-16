"""PeaNUT installation checks with simulated packages and Docker; no root or Pi required."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
from unittest.mock import patch

import install_peanut as peanut


def check() -> None:
    calls = []
    existing = None
    healthy = True
    architecture = 'arm64'

    def run(arguments, **kwargs):
        calls.append(arguments)
        if arguments[0] == 'dpkg':
            return subprocess.CompletedProcess(arguments, 0, architecture)
        if arguments[:3] == ['docker', 'container', 'inspect']:
            return subprocess.CompletedProcess(arguments, 0 if existing else 1, json.dumps(existing))
        if arguments[:2] == ['docker', 'exec']:
            return subprocess.CompletedProcess(arguments, 0 if healthy else 1)
        return subprocess.CompletedProcess(arguments, 0)

    with tempfile.TemporaryDirectory() as directory:
        config = Path(directory) / 'config'
        environment = Path(directory) / 'peanut.env'
        with (
            patch.object(peanut, 'CONFIG', config), patch.object(peanut, 'ENVIRONMENT', environment),
            patch.object(peanut.os, 'getuid', return_value=0, create=True),
            patch.object(peanut.os, 'chown', create=True) as chown,
            patch.object(peanut.shutil, 'which', return_value=None) as docker_path,
            patch.object(peanut.subprocess, 'run', side_effect=run), patch.object(peanut.time, 'sleep'),
            patch('builtins.print'),
        ):
            peanut.install()
            assert ['apt-get', 'install', '-y', 'docker.io'] in calls
            assert chown.call_args_list[0].args == (config, 1000, 1000)
            assert chown.call_args_list[1].args == (config / 'settings.yml', 1000, 1000)
            assert chown.call_args_list[2].args == (environment, 0, 0)
            container = next(call for call in calls if call[:2] == ['docker', 'run'])
            assert container[-1] == peanut.IMAGE
            assert container[container.index('--network') + 1] == 'host'
            assert 'AUTH_FILE_PATH=/config/auth.yaml' in container
            assert 'NUT_SERVERS=[{"HOST":"127.0.0.1","PORT":3493}]' in container
            assert not any('AUTH_DISABLED' in argument for argument in container)
            assert not any('WEB_PASSWORD' in argument for argument in container)
            credentials = environment.read_bytes()
            if os.name != 'nt':
                assert environment.stat().st_mode & 0o777 == 0o600
                assert config.stat().st_mode & 0o777 == 0o700
            assert b'WEB_USERNAME=admin\n' in credentials
            assert len(credentials.split(b'WEB_PASSWORD=')[1].splitlines()[0]) >= 32
            settings = config / 'settings.yml'
            settings.write_text('Existing dashboard settings')
            existing = {'Labels': {peanut.LABEL: 'true'}, 'Image': peanut.IMAGE}
            docker_path.return_value = '/usr/bin/docker'
            calls.clear()
            peanut.install()
            assert environment.read_bytes() == credentials
            assert settings.read_text() == 'Existing dashboard settings'
            assert ['docker', 'start', peanut.CONTAINER] in calls
            assert not any(call[:2] in (['docker', 'run'], ['docker', 'pull']) for call in calls)
            assert not any(call[0] == 'apt-get' for call in calls)
            assert not any(argument.startswith(('nut-', 'ups-snmp', 'ups-autodetect')) for call in calls for argument in call)
            existing = {'Labels': {}, 'Image': 'another-image'}
            try:
                peanut.install()
                raise AssertionError('Unmanaged container accepted')
            except ValueError:
                pass
            existing = None
            architecture = 'armhf'
            calls.clear()
            try:
                peanut.install()
                raise AssertionError('32-bit architecture accepted')
            except ValueError:
                pass
            assert len(calls) == 1
            architecture = 'arm64'
            healthy = True
            for invalid_pwd in ('short', 'has\nnewline123', ''):
                try:
                    peanut.install(password=invalid_pwd)
                except ValueError:
                    pass
                else:
                    raise AssertionError(f'Invalid password accepted: {invalid_pwd}')
            peanut.install(password='my-peanut-pass-123')
            assert b'WEB_PASSWORD=my-peanut-pass-123\n' in environment.read_bytes()
            healthy = False
            try:
                peanut.install()
                raise AssertionError('Failed health check accepted')
            except RuntimeError:
                pass
    print('PeaNUT checks passed: install, custom and private login, local NUT, repeat preservation, ownership, architecture and failed health.')


if __name__ == '__main__':
    check()
