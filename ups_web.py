"""Small HTTPS settings site. Only fixed SNMP configuration and service operations are exposed."""

import base64
import hashlib
import hmac
from html import escape
from http.server import BaseHTTPRequestHandler, HTTPServer
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import socket
import ssl
import struct
import subprocess
import tempfile
import threading
from urllib.parse import parse_qs

from ups_autodetect import write_config

CONFIG = Path('/etc/ups-network-adapter/ups.conf')
STATE = Path('/var/lib/ups-web')
CREDENTIALS = Path('/etc/ups-web-credentials.json')
PEANUT_ENV = Path('/etc/ups-peanut.env')
PEANUT_CONFIG = Path('/var/lib/ups-peanut')
WRITE_VIEW = 'upsWebWrite'
WRITE_TREE = '.1.3.6.1.2.1.1'


def validate_web_password(password: str) -> None:
    if not password:
        raise ValueError('Password cannot be empty.')
    if len(password) < 8:
        raise ValueError('Password must be at least 8 characters long.')
    if ':' in password:
        raise ValueError('Password cannot contain colons (:) due to HTTP Basic Authentication.')
    if '\n' in password or '\r' in password:
        raise ValueError('Password cannot contain newlines.')


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


def sync_peanut_password(username: str, password: str) -> None:
    if not PEANUT_ENV.exists():
        return
    env_content = PEANUT_ENV.read_text(encoding='utf-8')
    lines = []
    has_user = False
    has_pass = False
    for line in env_content.splitlines():
        if line.startswith('WEB_USERNAME='):
            lines.append(f'WEB_USERNAME={username}')
            has_user = True
        elif line.startswith('WEB_PASSWORD='):
            lines.append(f'WEB_PASSWORD={password}')
            has_pass = True
        else:
            lines.append(line)
    if not has_user:
        lines.append(f'WEB_USERNAME={username}')
    if not has_pass:
        lines.append(f'WEB_PASSWORD={password}')
    descriptor, name = tempfile.mkstemp(dir=PEANUT_ENV.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            stream.write('\n'.join(lines) + '\n')
        os.chmod(name, 0o600)
        os.chown(name, 0, 0)
        os.replace(name, PEANUT_ENV)
    finally:
        if os.path.exists(name):
            os.unlink(name)

    auth_file = PEANUT_CONFIG / 'auth.yaml'
    if auth_file.exists():
        try:
            import bcrypt
            hashed = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
            auth_content = f"users:\n  - username: {username}\n    password: '{hashed}'\n"
            descriptor, name = tempfile.mkstemp(dir=PEANUT_CONFIG)
            try:
                with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
                    stream.write(auth_content)
                os.chmod(name, 0o600)
                os.chown(name, 1000, 1000)
                os.replace(name, auth_file)
            finally:
                if os.path.exists(name):
                    os.unlink(name)
        except Exception:
            pass

    if Path('/etc/systemd/system/ups-kiosk-login.service').is_file():
        subprocess.run(['/usr/bin/systemctl', 'restart', 'ups-kiosk-login.service'], check=False, timeout=10)


def save_credentials(form: dict[str, str], current_credentials: dict[str, str]) -> dict[str, str]:
    current_password = form.get('current_password', '')
    if not hmac.compare_digest(current_password.encode('utf-8'), current_credentials['password'].encode('utf-8')):
        raise ValueError('Current password is incorrect.')
    new_username = form.get('new_username', '').strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', new_username):
        raise ValueError('Username accepts 1–64 letters, digits, underscores, or hyphens.')
    new_password = form.get('new_password', '')
    confirm_password = form.get('confirm_password', '')
    validate_web_password(new_password)
    if new_password != confirm_password:
        raise ValueError('New password and confirmation do not match.')
    updated = {'username': new_username, 'password': new_password}
    descriptor, name = tempfile.mkstemp(dir=CREDENTIALS.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(updated, stream)
        os.chmod(name, 0o600)
        if hasattr(os, 'getuid') and os.getuid() == 0:
            os.chown(name, 0, 0)
        os.replace(name, CREDENTIALS)
    finally:
        if os.path.exists(name):
            os.unlink(name)
    if form.get('update_peanut') == 'yes':
        sync_peanut_password(new_username, new_password)
    return updated


def execute_system_action(action: str) -> None:
    systemctl = shutil.which('systemctl') or '/usr/bin/systemctl'
    if action in ('restart', 'reboot'):
        command = [systemctl, 'reboot']
    elif action in ('shutdown', 'poweroff'):
        command = [systemctl, 'poweroff']
    else:
        raise ValueError('Unsupported maintenance action.')
    subprocess.run(command, check=False)


def schedule_system_action(action: str, delay: float = 1.0) -> None:
    if action not in ('restart', 'reboot', 'shutdown', 'poweroff'):
        raise ValueError('Unsupported maintenance action.')
    timer = threading.Timer(delay, execute_system_action, args=(action,))
    timer.daemon = True
    timer.start()


def format_uptime(seconds: int) -> str:
    hours = seconds // 3600
    minutes = (seconds % 3600) // 60
    if hours > 0:
        return f'{hours}h {minutes}m'
    return f'{minutes}m {seconds % 60}s'


def format_runtime(seconds: int) -> str:
    hours = seconds // 3600
    minutes = (seconds % 3600) // 60
    secs = seconds % 60
    if hours > 0:
        return f'{hours}h {minutes}m {secs}s'
    if minutes > 0:
        return f'{minutes}m {secs}s'
    return f'{secs}s'


def get_network_info() -> dict:
    result = {
        'hostname': socket.gethostname(),
        'ip': '127.0.0.1',
        'prefix': 24,
        'gateway': '127.0.0.1',
        'interface': 'eth0',
        'mac': 'N/A'
    }
    route_file = Path('/proc/net/route')
    if route_file.exists():
        try:
            for line in route_file.read_text().splitlines()[1:]:
                fields = line.strip().split()
                if len(fields) >= 8 and fields[1] == '00000000':
                    result['interface'] = fields[0]
                    result['gateway'] = socket.inet_ntoa(struct.pack('<L', int(fields[2], 16)))
                    mac_file = Path(f'/sys/class/net/{fields[0]}/address')
                    if mac_file.exists():
                        result['mac'] = mac_file.read_text().strip()
                    break
            for line in route_file.read_text().splitlines()[1:]:
                fields = line.strip().split()
                if len(fields) >= 8 and fields[0] == result['interface'] and fields[1] != '00000000':
                    result['prefix'] = bin(int(fields[7], 16)).count('1')
                    break
        except Exception:
            pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        target_gw = result['gateway'] if result['gateway'] != '127.0.0.1' else '8.8.8.8'
        s.connect((target_gw, 80))
        result['ip'] = s.getsockname()[0]
        s.close()
    except OSError:
        pass
    return result


def get_system_health() -> dict:
    temp = None
    thermal = Path('/sys/class/thermal/thermal_zone0/temp')
    if thermal.exists():
        try:
            temp = round(int(thermal.read_text().strip()) / 1000, 1)
        except (ValueError, OSError):
            pass

    uptime_sec = 0
    proc_uptime = Path('/proc/uptime')
    if proc_uptime.exists():
        try:
            uptime_sec = int(float(proc_uptime.read_text().split()[0]))
        except (ValueError, OSError):
            pass

    mem_total_mb = 0
    mem_used_mb = 0
    mem_pct = 0
    proc_mem = Path('/proc/meminfo')
    if proc_mem.exists():
        try:
            meminfo = {}
            for line in proc_mem.read_text().splitlines():
                parts = line.split(':')
                if len(parts) == 2:
                    meminfo[parts[0].strip()] = int(parts[1].strip().split()[0])
            total_kb = meminfo.get('MemTotal', 0)
            avail_kb = meminfo.get('MemAvailable', 0)
            used_kb = total_kb - avail_kb
            mem_total_mb = round(total_kb / 1024)
            mem_used_mb = round(used_kb / 1024)
            mem_pct = round(used_kb / total_kb * 100, 1) if total_kb else 0
        except Exception:
            pass

    disk_total_gb = 0
    disk_used_gb = 0
    disk_pct = 0
    try:
        disk = shutil.disk_usage('/')
        disk_total_gb = round(disk.total / (1024**3), 1)
        disk_used_gb = round(disk.used / (1024**3), 1)
        disk_pct = round(disk.used / disk.total * 100, 1) if disk.total else 0
    except OSError:
        pass

    return {
        'cpu_temp': temp,
        'uptime_seconds': uptime_sec,
        'uptime_formatted': format_uptime(uptime_sec),
        'memory_total_mb': mem_total_mb,
        'memory_used_mb': mem_used_mb,
        'memory_percent': mem_pct,
        'disk_total_gb': disk_total_gb,
        'disk_used_gb': disk_used_gb,
        'disk_percent': disk_pct
    }


def get_ups_metrics() -> dict:
    try:
        from ups_mib import read_ups
        raw = read_ups('ups')
        load_pct = float(raw.get('ups.load', 0))
        nominal_watts = float(raw.get('ups.realpower.nominal', 0) or raw.get('ups.power.nominal', 0))
        load_watts = round((load_pct / 100.0) * nominal_watts, 1) if nominal_watts else load_pct
        runtime_sec = int(float(raw.get('battery.runtime', 0)))
        return {
            'status': raw.get('ups.status', 'UNKNOWN').split()[0] if raw.get('ups.status') else 'UNKNOWN',
            'model': raw.get('ups.model') or raw.get('device.model', 'Unknown'),
            'mfr': raw.get('ups.mfr') or raw.get('device.mfr', ''),
            'battery_charge': int(float(raw.get('battery.charge', 100))),
            'battery_runtime_seconds': runtime_sec,
            'battery_runtime_formatted': format_runtime(runtime_sec),
            'battery_voltage': raw.get('battery.voltage', '--'),
            'input_voltage': raw.get('input.voltage', '--'),
            'load_percent': int(load_pct),
            'load_watts': load_watts,
            'serial': raw.get('ups.serial') or raw.get('device.serial', '')
        }
    except Exception:
        return {
            'status': 'UNKNOWN',
            'model': 'Back-UPS BX750MI',
            'mfr': 'American Power Conversion',
            'battery_charge': 100,
            'battery_runtime_seconds': 0,
            'battery_runtime_formatted': '--:--',
            'battery_voltage': '--',
            'input_voltage': '--',
            'load_percent': 0,
            'load_watts': 0,
            'serial': ''
        }


def get_kiosk_data() -> dict:
    return {
        'ups': get_ups_metrics(),
        'system': get_system_health(),
        'network': get_network_info()
    }


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
        self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Connection', 'close')
        if challenge:
            self.send_header('WWW-Authenticate', 'Basic realm="UPS adapter settings", charset="UTF-8"')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(payload)
        self.close_connection = True

    def respond_json(self, status: int, data: dict) -> None:
        payload = json.dumps(data).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Connection', 'close')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(payload)
        self.close_connection = True

    def do_HEAD(self) -> None:
        self.do_GET()

    def authorized(self) -> bool:
        if self.path in ('/kiosk', '/kiosk/', '/api/kiosk-data', '/kiosk/data') or self.path.startswith('/kiosk/'):
            return True
        header = self.headers.get('Authorization', '')
        if len(header) > 1024 or not hmac.compare_digest(header.encode(), self.server.authorization):
            self.respond(401, 'Authentication required.', True)
            return False
        return True

    def do_GET(self) -> None:
        if not self.authorized():
            return
        host = self.headers.get('Host', '127.0.0.1').split(':')[0]
        if self.path in ('/', '/settings'):
            try:
                content = CONFIG.read_text(encoding='utf-8')
                values = settings(content)
                values.update(
                    csrf=self.server.csrf, revision=revision(content),
                    write_checked='checked' if values['write_community'] else '',
                    host=host,
                    username=escape(self.server.credentials.get('username', 'admin')),
                    nav_snmp_active='active',
                    nav_account_active='',
                )
                values['read_community'] = values['write_community'] = ''
                page = Path(__file__).with_name('ups_web.html').read_text(encoding='utf-8')
                self.respond(200, re.sub(r'\{\{(\w+)\}\}', lambda match: escape(values.get(match[1], ''), quote=True), page))
            except (OSError, ValueError):
                self.respond(409, 'Configuration cannot be edited safely. Check custom access rules in /etc/ups-network-adapter/ups.conf.')
        elif self.path in ('/account', '/users', '/password'):
            values = {
                'csrf': self.server.csrf,
                'host': host,
                'username': escape(self.server.credentials.get('username', 'admin')),
                'nav_snmp_active': '',
                'nav_account_active': 'active',
                'peanut_checked': 'checked' if PEANUT_ENV.exists() else '',
                'peanut_display': 'block' if PEANUT_ENV.exists() else 'none',
            }
            page = Path(__file__).with_name('ups_account.html').read_text(encoding='utf-8')
            self.respond(200, re.sub(r'\{\{(\w+)\}\}', lambda match: escape(values.get(match[1], ''), quote=True), page))
        elif self.path in ('/maintenance', '/system'):
            values = {
                'csrf': self.server.csrf,
                'host': host,
                'username': escape(self.server.credentials.get('username', 'admin')),
            }
            page = Path(__file__).with_name('ups_maintenance.html').read_text(encoding='utf-8')
            self.respond(200, re.sub(r'\{\{(\w+)\}\}', lambda match: escape(values.get(match[1], ''), quote=True), page))
        elif self.path in ('/kiosk', '/kiosk/'):
            values = {
                'csrf': self.server.csrf,
                'host': host,
            }
            page = Path(__file__).with_name('ups_kiosk.html').read_text(encoding='utf-8')
            self.respond(200, re.sub(r'\{\{(\w+)\}\}', lambda match: escape(values.get(match[1], ''), quote=True), page))
        elif self.path in ('/api/kiosk-data', '/kiosk/data'):
            data = get_kiosk_data()
            data['csrf'] = self.server.csrf
            self.respond_json(200, data)
        else:
            self.respond(404, 'Page not found.')

    def do_POST(self) -> None:
        if not self.authorized():
            return
        if self.path not in ('/', '/settings', '/account', '/users', '/password', '/maintenance', '/system', '/kiosk/action', '/kiosk'):
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
                if self.path in ('/kiosk/action', '/kiosk'):
                    self.respond_json(403, {'error': 'Invalid form token.'})
                else:
                    self.respond(403, 'Invalid form token. Reload settings before saving.')
                return

            if self.path in ('/kiosk/action', '/kiosk'):
                action = form.get('action', '').strip().lower()
                if action in ('restart', 'reboot'):
                    schedule_system_action('restart')
                    self.respond_json(200, {'success': True, 'action': 'restart'})
                elif action in ('shutdown', 'poweroff'):
                    schedule_system_action('shutdown')
                    self.respond_json(200, {'success': True, 'action': 'shutdown'})
                else:
                    raise ValueError('Unknown kiosk action requested.')
            elif self.path in ('/maintenance', '/system'):
                action = form.get('action', '').strip().lower()
                if action in ('restart', 'reboot'):
                    schedule_system_action('restart')
                    body = (
                        '<!doctype html><html><head><meta charset="utf-8">'
                        '<meta name="viewport" content="width=device-width, initial-scale=1">'
                        '<title>Restarting - UPS Adapter</title>'
                        '<meta http-equiv="refresh" content="45; url=/">'
                        '<style>:root { color-scheme: light dark; font-family: system-ui, sans-serif; }'
                        'body { margin: 40px auto; max-width: 600px; padding: 20px; text-align: center; background: light-dark(#f3f5f8, #15181d); color: light-dark(#18202c, #eef2f8); }'
                        '.box { padding: 32px; border: 1px solid light-dark(#ccd4df, #455062); border-radius: 12px; background: light-dark(white, #20262f); }'
                        'h1 { color: #2359b8; margin-top: 0; } a { color: #2359b8; font-weight: 600; text-decoration: none; }</style></head>'
                        '<body><div class="box"><h1>Restarting System…</h1>'
                        '<p>The UPS network adapter is rebooting now. Services will be unavailable for approximately 30–60 seconds.</p>'
                        '<p>This page will automatically attempt to reconnect in 45 seconds.</p>'
                        '<p><a href="/">Return to Home</a></p></div></body></html>'
                    )
                    self.respond(200, body)
                elif action in ('shutdown', 'poweroff'):
                    schedule_system_action('shutdown')
                    body = (
                        '<!doctype html><html><head><meta charset="utf-8">'
                        '<meta name="viewport" content="width=device-width, initial-scale=1">'
                        '<title>Shutting Down - UPS Adapter</title>'
                        '<style>:root { color-scheme: light dark; font-family: system-ui, sans-serif; }'
                        'body { margin: 40px auto; max-width: 600px; padding: 20px; text-align: center; background: light-dark(#f3f5f8, #15181d); color: light-dark(#18202c, #eef2f8); }'
                        '.box { padding: 32px; border: 1px solid light-dark(#ccd4df, #455062); border-radius: 12px; background: light-dark(white, #20262f); }'
                        'h1 { color: #b82323; margin-top: 0; }'
                        '.alert { margin-top: 20px; padding: 14px; text-align: left; background: light-dark(#fff4e5, #2d2215); border-left: 4px solid #e07000; border-radius: 4px; font-size: 0.95rem; line-height: 1.5; }'
                        '</style></head>'
                        '<body><div class="box"><h1>System Shutting Down</h1>'
                        '<p>The UPS network adapter is safely halting and turning off system storage to protect the SD card.</p>'
                        '<div class="alert"><strong>Powering back on:</strong> Once the activity LED turns off or remains solid, it is safe to disconnect power. To restart the adapter, physically reconnect the power supply.</div>'
                        '</div></body></html>'
                    )
                    self.respond(200, body)
                else:
                    raise ValueError('Unknown maintenance action requested.')
            elif self.path in ('/account', '/users', '/password'):
                new_creds = save_credentials(form, self.server.credentials)
                self.server.update_auth(new_creds)
                self.respond(200, f'<p>Credentials updated successfully for user <strong>{escape(new_creds["username"])}</strong>.</p><p><a href="/account">Back to User &amp; Password</a> | <a href="/">Go to SNMP Settings</a></p>')
            else:
                changed = save(form)
                self.respond(200, '<p>' + ('Settings saved. SNMP restarted.' if changed else 'Settings already match.') + '</p><a href="/">Back to settings</a>')
        except (ValueError, UnicodeError) as error:
            if self.path in ('/kiosk/action', '/kiosk'):
                self.respond_json(400, {'error': str(error)})
                return
            elif self.path in ('/maintenance', '/system'):
                back_url = '/maintenance'
            elif self.path in ('/account', '/users', '/password'):
                back_url = '/account'
            else:
                back_url = '/'
            self.respond(400, f'<p>{escape(str(error))}</p><a href="{back_url}">Reload settings</a>')
        except RuntimeError as error:
            self.respond(503, escape(str(error)))
        except (OSError, subprocess.SubprocessError):
            self.respond(503, 'Settings could not be saved. Check ups-web.service on the Pi.')


class SettingsServer(HTTPServer):
    def __init__(self, address, credentials, context=None):
        self.credentials = credentials
        self.update_auth(credentials)
        self.csrf = secrets.token_urlsafe(32)
        self.context = context
        super().__init__(address, SettingsHandler)

    def update_auth(self, credentials: dict[str, str]) -> None:
        self.credentials = credentials
        self.authorization = b'Basic ' + base64.b64encode((credentials['username'] + ':' + credentials['password']).encode())

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
    port = int(os.environ.get('UPS_WEB_PORT', '80'))
    credentials = json.loads(CREDENTIALS.read_text(encoding='utf-8'))
    context = None
    if os.environ.get('UPS_WEB_HTTPS') == '1' and (STATE / 'certificate.pem').is_file() and (STATE / 'key.pem').is_file():
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(STATE / 'certificate.pem', STATE / 'key.pem')
    with SettingsServer(('0.0.0.0', port), credentials, context) as server:
        server.serve_forever()


if __name__ == '__main__':
    main()
