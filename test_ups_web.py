"""Settings validation, rollback, and real HTTP boundary checks. No Pi or root required."""

import base64
import http.client
import json
from pathlib import Path
import re
import shutil
import ssl
import subprocess
import tempfile
import threading
from unittest.mock import patch
from urllib.parse import urlencode

import ups_web as web
from setup_pi import prepare_snmp


def rejected(action):
    try:
        action()
    except ValueError:
        return
    raise AssertionError('Invalid input accepted')


def main():
    template = Path('config/ups.conf').read_text()
    form = dict(name='Office UPS', location='Rack 1', contact='IT', read_community='new_secret',
                read_sources='192.0.2.20', write_enabled='yes', write_community='write_secret', write_sources='192.0.2.21')
    desired = web.updated_config(template, form)
    assert 'rocommunity new_secret 127.0.0.1/32 -V upsView' in desired
    assert 'rocommunity new_secret 192.0.2.20/32 -V upsView' in desired
    assert 'rwcommunity write_secret 192.0.2.21/32 -V upsWebWrite' in desired
    assert 'view upsWebWrite included .1.3.6.1.2.1.1\n' in desired
    assert 'pass_persist ' in desired and 'view upsView included .1.3.6.1.2.1.33' in desired
    assert web.settings(desired)['name'] == 'Office UPS'
    assert 'sysName Office UPS\n' in desired and 'sysName "' not in desired
    apostrophe = web.updated_config(template, dict(form, contact="O'Neil", location=''))
    assert web.settings(apostrophe)['contact'] == "O'Neil"
    assert not any(line.startswith('sysLocation') for line in apostrophe.splitlines())
    assert web.updated_config(apostrophe, dict(form, contact="O'Neil", location='')) == apostrophe
    assert prepare_snmp(apostrophe, [], template, None)[0] == apostrophe
    unicode_config = web.updated_config(template, dict(form, location='חדר שרתים'))
    assert web.settings(unicode_config)['location'] == 'חדר שרתים'
    assert prepare_snmp(desired, [], template, None)[0] == desired
    keep = dict(form, read_community='', write_community='')
    assert web.updated_config(desired, keep) == desired
    disabled = web.updated_config(desired, dict(keep, write_enabled=''))
    assert 'rwcommunity ' not in disabled and 'view upsWebWrite ' not in disabled
    for field, value in [('name', 'bad\nrocommunity injected default'), ('location', '# comment'),
                         ('contact', '\\escape'), ('name', ''), ('name', 'x' * 129),
                         ('read_community', 'bad secret'), ('read_sources', 'host.example'),
                         ('read_sources', ''), ('write_sources', '::1'), ('write_sources', ''),
                         ('write_community', 'new_secret')]:
        rejected(lambda: web.updated_config(template, dict(form, **{field: value})))
    rejected(lambda: web.updated_config(template, dict(form, write_community='')))
    for custom in ['rwcommunity old default', 'rocommunity other default -V upsView',
                   'view upsWebWrite included .1', 'com2sec local default other', 'includeFile /etc/other.conf']:
        rejected(lambda: web.updated_config(template + '\n' + custom, form))

    with tempfile.TemporaryDirectory() as directory:
        config = Path(directory) / 'ups.conf'
        config.write_text(template)
        writes = []

        def write(path, content, group):
            assert group == 'Debian-snmp'
            writes.append(content)
            path.write_text(content)

        with patch.object(web, 'CONFIG', config), patch.object(web, 'STATE', Path(directory)), patch.object(web, 'write_config', side_effect=write):
            submitted = dict(form, revision=web.revision(template))
            with patch.object(web, 'restart_snmp') as restart:
                assert web.save(submitted)
                restart.assert_called_once()
            assert config.read_text() == desired and list(Path(directory).glob('backup-*/ups.conf'))
            rejected(lambda: web.save(submitted))
            config.write_text(template)
            with patch.object(web, 'restart_snmp', side_effect=[subprocess.CalledProcessError(1, 'systemctl'), None]):
                try:
                    web.save(submitted)
                except RuntimeError as error:
                    assert 'Previous configuration restored and SNMP restarted' in str(error)
                else:
                    raise AssertionError('Restart failure not reported')
            assert config.read_text() == template
            with patch.object(web, 'restart_snmp', side_effect=OSError('offline')):
                try:
                    web.save(submitted)
                except RuntimeError as error:
                    assert 'SNMP did not restart' in str(error)
                else:
                    raise AssertionError('Rollback restart failure not reported')
            assert config.read_text() == template

            credentials = {'username': 'admin', 'password': 'test-password'}
            server = web.SettingsServer(('127.0.0.1', 0), credentials)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            auth = 'Basic ' + base64.b64encode(b'admin:test-password').decode()

            def request(method='GET', path='/', body=None, authorized=True, extra=None):
                connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
                headers = {'Authorization': auth} if authorized else {}
                if body is not None:
                    headers['Content-Type'] = 'application/x-www-form-urlencoded'
                headers.update(extra or {})
                connection.request(method, path, body, headers)
                response = connection.getresponse()
                result = response.status, response.read().decode(), dict(response.getheaders())
                connection.close()
                return result

            try:
                assert request(authorized=False)[0] == 401
                assert request('POST', body='name=oops', authorized=False)[0] == 401
                assert request(path='/missing')[0] == 404
                status, page, headers = request()
                assert status == 200 and 'public' not in page and 'new_secret' not in page
                assert headers['Cache-Control'] == 'no-store' and 'frame-ancestors' in headers['Content-Security-Policy']
                token = re.search(r'name="csrf" value="([^"]+)"', page)[1]
                posted = dict(submitted, csrf=token)
                assert request('POST', body=urlencode(dict(posted, csrf='wrong')))[0] == 403
                assert request('POST', body=urlencode(posted) + '&name=duplicate')[0] == 400
                assert request('POST', body='', extra={'Content-Length': '8193'})[0] == 400
                assert request('POST', body='x=1', extra={'Content-Type': 'application/json'})[0] == 400
                assert request('POST', body=urlencode(dict(posted, revision='é')))[0] == 400
                with patch.object(web, 'restart_snmp'):
                    assert request('POST', body=urlencode(posted))[0] == 200
                assert config.read_text() == desired
                assert request('POST', body=urlencode(posted))[0] == 400
                with patch.object(web, 'restart_snmp') as restart:
                    assert not web.save(dict(keep, revision=web.revision(desired)))
                    restart.assert_not_called()
                config.write_text(desired.replace('Office UPS', '<script>alert(1)</script>'))
                assert '&lt;script&gt;' in request()[1] and '<script>' not in request()[1]

                # Test /account page
                status, account_page, _ = request(path='/account')
                assert status == 200 and 'User &amp; Password' in account_page
                account_token = re.search(r'name="csrf" value="([^"]+)"', account_page)[1]
                
                # Wrong current password
                bad_curr = {'csrf': account_token, 'current_password': 'wrong', 'new_username': 'admin',
                            'new_password': 'new-password-123', 'confirm_password': 'new-password-123'}
                assert request('POST', path='/account', body=urlencode(bad_curr))[0] == 400

                # Mismatched new password
                mismatch = {'csrf': account_token, 'current_password': 'test-password', 'new_username': 'admin',
                            'new_password': 'new-password-123', 'confirm_password': 'different-pass'}
                assert request('POST', path='/account', body=urlencode(mismatch))[0] == 400

                # Short password
                short_pwd = {'csrf': account_token, 'current_password': 'test-password', 'new_username': 'admin',
                             'new_password': 'short', 'confirm_password': 'short'}
                assert request('POST', path='/account', body=urlencode(short_pwd))[0] == 400

                # Valid credentials update
                creds_file = Path(directory) / 'credentials.json'
                with patch.object(web, 'CREDENTIALS', creds_file):
                    valid_update = {'csrf': account_token, 'current_password': 'test-password', 'new_username': 'newadmin',
                                    'new_password': 'new-password-123', 'confirm_password': 'new-password-123'}
                    res_status, res_body, _ = request('POST', path='/account', body=urlencode(valid_update))
                    assert res_status == 200 and 'Credentials updated successfully' in res_body
                    assert json.loads(creds_file.read_text()) == {'username': 'newadmin', 'password': 'new-password-123'}
                    
                    # Old auth should now fail
                    assert request(authorized=True)[0] == 401
                    # New auth should succeed
                    new_auth = 'Basic ' + base64.b64encode(b'newadmin:new-password-123').decode()
                    assert request(extra={'Authorization': new_auth})[0] == 200

                # Test /maintenance page
                status, maint_page, _ = request(path='/maintenance', extra={'Authorization': new_auth})
                assert status == 200 and 'System Maintenance' in maint_page
                assert 'Restart System' in maint_page and 'Shutdown System' in maint_page
                maint_token = re.search(r'name="csrf" value="([^"]+)"', maint_page)[1]

                # Bad CSRF on /maintenance
                bad_csrf = {'csrf': 'wrong-token', 'action': 'restart'}
                assert request('POST', path='/maintenance', body=urlencode(bad_csrf), extra={'Authorization': new_auth})[0] == 403

                # Unknown action
                bad_act = {'csrf': maint_token, 'action': 'unknown'}
                assert request('POST', path='/maintenance', body=urlencode(bad_act), extra={'Authorization': new_auth})[0] == 400

                # Restart action
                with patch.object(web, 'schedule_system_action') as mock_action:
                    restart_req = {'csrf': maint_token, 'action': 'restart'}
                    r_status, r_body, _ = request('POST', path='/maintenance', body=urlencode(restart_req), extra={'Authorization': new_auth})
                    assert r_status == 200 and 'Restarting System' in r_body
                    mock_action.assert_called_once_with('restart')

                # Shutdown action
                with patch.object(web, 'schedule_system_action') as mock_action:
                    shutdown_req = {'csrf': maint_token, 'action': 'shutdown'}
                    s_status, s_body, _ = request('POST', path='/maintenance', body=urlencode(shutdown_req), extra={'Authorization': new_auth})
                    assert s_status == 200 and 'System Shutting Down' in s_body
                    mock_action.assert_called_once_with('shutdown')

                # Direct execute_system_action test
                with patch.object(subprocess, 'run') as mock_run:
                    web.execute_system_action('restart')
                    assert any('reboot' in arg for arg in mock_run.call_args[0][0])
                    web.execute_system_action('shutdown')
                    assert any('poweroff' in arg for arg in mock_run.call_args[0][0])
                rejected(lambda: web.execute_system_action('invalid_action'))
                rejected(lambda: web.schedule_system_action('invalid_action'))

                # Test /kiosk unauthenticated access
                k_status, k_page, _ = request(path='/kiosk', authorized=False)
                assert k_status == 200 and 'UPS Adapter Kiosk' in k_page
                assert 'PeaNUT Dashboard' in k_page and 'statusBadge' in k_page

                # Test /api/kiosk-data
                kd_status, kd_body, kd_headers = request(path='/api/kiosk-data', authorized=False)
                assert kd_status == 200 and 'application/json' in kd_headers.get('Content-Type', '')
                kdata = json.loads(kd_body)
                assert 'ups' in kdata and 'system' in kdata and 'network' in kdata
                k_csrf = kdata['csrf']

                # Test /kiosk/action bad csrf
                bad_k_csrf = {'csrf': 'bad', 'action': 'restart'}
                res_code, res_json, _ = request('POST', path='/kiosk/action', body=urlencode(bad_k_csrf), authorized=False)
                assert res_code == 403 and 'Invalid form token' in res_json

                # Test /kiosk/action bad action
                bad_k_act = {'csrf': k_csrf, 'action': 'invalid'}
                res_code, res_json, _ = request('POST', path='/kiosk/action', body=urlencode(bad_k_act), authorized=False)
                assert res_code == 400 and 'error' in res_json

                # Test /kiosk/action restart
                with patch.object(web, 'schedule_system_action') as mock_k_action:
                    good_k_restart = {'csrf': k_csrf, 'action': 'restart'}
                    res_code, res_json, _ = request('POST', path='/kiosk/action', body=urlencode(good_k_restart), authorized=False)
                    assert res_code == 200 and json.loads(res_json).get('success') is True
                    mock_k_action.assert_called_once_with('restart')

                # Test /kiosk/action shutdown
                with patch.object(web, 'schedule_system_action') as mock_k_action:
                    good_k_shutdown = {'csrf': k_csrf, 'action': 'shutdown'}
                    res_code, res_json, _ = request('POST', path='/kiosk/action', body=urlencode(good_k_shutdown), authorized=False)
                    assert res_code == 200 and json.loads(res_json).get('success') is True
                    mock_k_action.assert_called_once_with('shutdown')

                assert '1h 1m' in web.format_uptime(3661)
                assert '1h 1m 1s' in web.format_runtime(3661)
            finally:
                server.shutdown()
                server.server_close()
                worker.join(timeout=5)
            if shutil.which('openssl'):
                key = Path(directory) / 'key.pem'
                certificate = Path(directory) / 'certificate.pem'
                subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                                '-subj', '/CN=localhost', '-keyout', str(key), '-out', str(certificate)],
                               check=True, capture_output=True, timeout=30)
                context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                context.minimum_version = ssl.TLSVersion.TLSv1_2
                context.load_cert_chain(certificate, key)
                with web.SettingsServer(('127.0.0.1', 0), credentials, context) as secure:
                    worker = threading.Thread(target=secure.serve_forever, daemon=True)
                    worker.start()
                    try:
                        client_context = ssl.create_default_context(cafile=str(certificate))
                        client_context.check_hostname = False
                        connection = http.client.HTTPSConnection('127.0.0.1', secure.server_port, context=client_context, timeout=5)
                        connection.request('GET', '/', headers={'Authorization': auth})
                        response = connection.getresponse()
                        assert response.status == 200 and b'UPS adapter settings' in response.read()
                        connection.close()
                    finally:
                        secure.shutdown()
                        worker.join(timeout=5)
                print('PASS: real TLS endpoint with certificate verification')
            else:
                print('SKIP: real TLS check requires openssl on PATH')
    print('PASS: web validation, access limits, identity preservation, private backups, rollback, auth, CSRF, escaping, stale forms and real HTTP requests')


if __name__ == '__main__':
    main()
