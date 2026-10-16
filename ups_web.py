"""Small HTTPS settings site. Only fixed SNMP configuration and service operations are exposed."""

import base64
import hashlib
import hmac
from html import escape
from http.server import BaseHTTPRequestHandler, HTTPServer
import ipaddress
import json
from pathlib import Path
import re
import secrets
import shlex
import shutil
import ssl
import subprocess
import tempfile
from urllib.parse import parse_qs

from ups_autodetect import write_config

CONFIG = Path('/etc/ups-network-adapter/ups.conf')
STATE = Path('/var/lib/ups-web')
CREDENTIALS = Path('/etc/ups-web-credentials.json')
WRITE_VIEW = 'upsWebWrite'
WRITE_TREE = '.1.3.6.1.2.1.1'


def sources(value: str) -> list[str]:
    result = []
    for item in value.split(','):
        item = item.strip()
        if item == 'default':
            result.append(item)
        else:
            network = ipaddress.IPv4Network(item, strict=False)
            result.append(str(network))
    if len(result) > 16:
        raise ValueError('Use at most 16 client addresses or networks.')
    return list(dict.fromkeys(result))


def settings(content: str) -> dict[str, str]:
    result = {'name': '', 'location': '', 'contact': '', 'read_community': '',
              'write_community': '', 'read_sources': '', 'write_sources': '127.0.0.1/32'}
    clients = {'rocommunity': [], 'rwcommunity': []}
    for line in content.splitlines():
        identity = re.match(r'^\s*(sysName|sysLocation|sysContact)\s+(.+?)\s*$', line)
        if identity:
            name = {'sysName': 'name', 'sysLocation': 'location', 'sysContact': 'contact'}[identity[1]]
            result[name] = identity[2]
            continue
        fields = shlex.split(line, comments=True)
        if not fields:
            continue
        key = fields[0]
        if key in clients:
            view = 'upsView' if key == 'rocommunity' else WRITE_VIEW
            if len(fields) != 5 or fields[3:] != ['-V', view]:
                raise ValueError('Custom community rules are present. Configure these manually; the site will preserve them.')
            name = 'read_community' if key == 'rocommunity' else 'write_community'
            if result[name] and result[name] != fields[1]:
                raise ValueError('Multiple communities are present. Configure these manually; the site will preserve them.')
            result[name] = fields[1]
            clients[key].extend(sources(fields[2]))
        elif key == 'view' and len(fields) > 1 and fields[1] == WRITE_VIEW:
            if fields != ['view', WRITE_VIEW, 'included', WRITE_TREE]:
                raise ValueError('Custom write view is present. Configure it manually; the site will preserve it.')
        elif key in ('rocommunity6', 'rwcommunity6', 'com2sec', 'com2sec6', 'access', 'authcommunity', 'includeFile', 'includeDir', 'includeSearch'):
            raise ValueError('Custom access rules are present. Configure these manually; the site will preserve them.')
    result['read_sources'] = ', '.join(dict.fromkeys(clients['rocommunity']))
    if clients['rwcommunity']:
        result['write_sources'] = ', '.join(dict.fromkeys(clients['rwcommunity']))
    if not result['read_community']:
        raise ValueError('No supported read community is configured. Run adapter setup first.')
    return result


def updated_config(content: str, form: dict[str, str]) -> str:
    current = settings(content)
    lines = []
    for field, directive in (('name', 'sysName'), ('location', 'sysLocation'), ('contact', 'sysContact')):
        value = form.get(field, '').strip()
        if (field == 'name' and not value) or len(value) > 128 or len(value.encode('utf-8')) > 255 or any(not char.isprintable() for char in value):
            raise ValueError('Identity fields accept up to 128 printable characters (255 UTF-8 bytes); name is required.')
        if any(char in value for char in '#"\\'):
            raise ValueError('Identity fields cannot contain #, double quotes, or backslashes.')
        # Net-SNMP copies the remaining identity text literally, including quotation marks.
        if value:
            lines.append(f'{directive} {value}')
    read_secret = form.get('read_community', '') or current['read_community']
    write_secret = (form.get('write_community', '') or current['write_community']) if form.get('write_enabled') == 'yes' else ''
    for secret in (read_secret, write_secret):
        if secret and not re.fullmatch(r'[A-Za-z0-9_.-]{1,255}', secret):
            raise ValueError('Communities accept 1–255 letters, digits, underscores, dots, or hyphens.')
    if form.get('write_enabled') == 'yes' and not write_secret:
        raise ValueError('Enter a write community before enabling write access.')
    if write_secret and hmac.compare_digest(read_secret, write_secret):
        raise ValueError('Read and write communities must differ.')
    read_clients = sources(form.get('read_sources', ''))
    if '127.0.0.1/32' not in read_clients:
        read_clients.insert(0, '127.0.0.1/32')
    lines.extend(f'rocommunity {read_secret} {client} -V upsView' for client in read_clients)
    if write_secret:
        lines.append(f'view {WRITE_VIEW} included {WRITE_TREE}')
        lines.extend(f'rwcommunity {write_secret} {client} -V {WRITE_VIEW}' for client in sources(form.get('write_sources', '')))
    replaced = {'sysName', 'sysLocation', 'sysContact', 'rocommunity', 'rwcommunity'}
    preserved = []
    for line in content.splitlines():
        fields = line.split()
        if fields and (fields[0] in replaced or fields[:2] == ['view', WRITE_VIEW]):
            continue
        preserved.append(line)
    return '\n'.join(preserved).rstrip() + '\n' + '\n'.join(lines) + '\n'


def revision(content: str) -> str:
    return hashlib.sha256(content.encode()).hexdigest()


def restart_snmp() -> None:
    subprocess.run(['/usr/bin/systemctl', 'restart', 'ups-snmp.service'], check=True, timeout=30, capture_output=True)
    subprocess.run(['/usr/bin/systemctl', 'is-active', '--quiet', 'ups-snmp.service'], check=True, timeout=10, capture_output=True)


def save(form: dict[str, str]) -> bool:
    if CONFIG.is_symlink():
        raise ValueError('Refusing to modify a symlinked configuration.')
    previous = CONFIG.read_text(encoding='utf-8')
    if not hmac.compare_digest(form.get('revision', '').encode(), revision(previous).encode()):
        raise ValueError('Configuration changed since this page opened. Reload before saving.')
    desired = updated_config(previous, form)
    if desired == previous:
        return False
    backup = Path(tempfile.mkdtemp(prefix='backup-', dir=STATE))
    shutil.copy2(CONFIG, backup / 'ups.conf')
    (backup / 'ups.conf').chmod(0o600)
    write_config(CONFIG, desired, group='Debian-snmp')
    try:
        restart_snmp()
    except (OSError, subprocess.SubprocessError):
        write_config(CONFIG, previous, group='Debian-snmp')
        try:
            restart_snmp()
        except (OSError, subprocess.SubprocessError) as error:
            raise RuntimeError('Previous configuration restored, but SNMP did not restart. Check ups-snmp.service on the Pi.') from error
        raise RuntimeError('SNMP restart failed. Previous configuration restored and SNMP restarted.')
    return True


class SettingsHandler(BaseHTTPRequestHandler):
    timeout = 10

    def log_message(self, format, *args):
        # Request paths and headers can contain secrets; log only response codes.
        pass

    def respond(self, status: int, body: str, challenge: bool = False) -> None:
        payload = body.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Connection', 'close')
        if challenge:
            self.send_header('WWW-Authenticate', 'Basic realm="UPS adapter settings", charset="UTF-8"')
        self.end_headers()
        self.wfile.write(payload)
        self.close_connection = True

    def authorized(self) -> bool:
        header = self.headers.get('Authorization', '')
        if len(header) > 1024 or not hmac.compare_digest(header.encode(), self.server.authorization):
            self.respond(401, 'Authentication required.', True)
            return False
        return True

    def do_GET(self) -> None:
        if not self.authorized():
            return
        if self.path != '/':
            self.respond(404, 'Page not found.')
            return
        try:
            content = CONFIG.read_text(encoding='utf-8')
            values = settings(content)
            values.update(csrf=self.server.csrf, revision=revision(content),
                          write_checked='checked' if values['write_community'] else '')
            values['read_community'] = values['write_community'] = ''
            page = Path(__file__).with_name('ups_web.html').read_text(encoding='utf-8')
            self.respond(200, re.sub(r'\{\{(\w+)\}\}', lambda match: escape(values[match[1]], quote=True), page))
        except (OSError, ValueError):
            self.respond(409, 'Configuration cannot be edited safely. Check custom access rules in /etc/ups-network-adapter/ups.conf.')

    def do_POST(self) -> None:
        if not self.authorized():
            return
        if self.path != '/':
            self.respond(404, 'Page not found.')
            return
        if self.headers.get('Content-Type') != 'application/x-www-form-urlencoded' or self.headers.get('Transfer-Encoding'):
            self.respond(400, 'Unsupported request format.')
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 8192:
                raise ValueError('Invalid request size.')
            payload = self.rfile.read(length)
            if len(payload) != length:
                raise ValueError('Incomplete request.')
            fields = parse_qs(payload.decode('utf-8'), keep_blank_values=True, max_num_fields=16, errors='strict')
            if any(len(values) != 1 for values in fields.values()):
                raise ValueError('Duplicate form fields.')
            form = {key: values[0] for key, values in fields.items()}
            if not hmac.compare_digest(form.get('csrf', '').encode(), self.server.csrf.encode()):
                self.respond(403, 'Invalid form token. Reload settings before saving.')
                return
            changed = save(form)
            self.respond(200, '<p>' + ('Settings saved. SNMP restarted.' if changed else 'Settings already match.') + '</p><a href="/">Back to settings</a>')
        except (ValueError, UnicodeError) as error:
            self.respond(400, '<p>' + escape(str(error)) + '</p><a href="/">Reload settings</a>')
        except RuntimeError as error:
            self.respond(503, escape(str(error)))
        except (OSError, subprocess.SubprocessError):
            self.respond(503, 'Settings could not be saved. Check ups-web.service on the Pi.')


class SettingsServer(HTTPServer):
    def __init__(self, address, credentials, context=None):
        self.authorization = b'Basic ' + base64.b64encode((credentials['username'] + ':' + credentials['password']).encode())
        self.csrf = secrets.token_urlsafe(32)
        self.context = context
        super().__init__(address, SettingsHandler)

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(10)
        if self.context:
            try:
                connection = self.context.wrap_socket(connection, server_side=True)
            except OSError:
                connection.close()
                raise
        return connection, address


def main() -> None:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(STATE / 'certificate.pem', STATE / 'key.pem')
    credentials = json.loads(CREDENTIALS.read_text(encoding='utf-8'))
    with SettingsServer(('0.0.0.0', 8081), credentials, context) as server:
        server.serve_forever()


if __name__ == '__main__':
    main()
