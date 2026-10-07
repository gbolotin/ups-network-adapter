#!/bin/bash
# Install files; --configure-nut also prepares this dedicated Pi for autodetection.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

if [[ $EUID -ne 0 ]]; then
    echo 'Run with sudo bash install.sh [--configure-nut]' >&2
    exit 1
fi
if [[ $# -gt 1 || ( $# -eq 1 && $1 != --configure-nut ) ]]; then
    echo 'Usage: sudo bash install.sh [--configure-nut]' >&2
    exit 1
fi
for executable in /usr/bin/python3 /usr/bin/upsc /usr/bin/nut-scanner /usr/sbin/snmpd /usr/bin/systemctl; do
    if [[ ! -x "$executable" ]]; then
        echo "Missing $executable. Install python3 nut-server nut-client snmpd snmp first." >&2
        exit 1
    fi
done
getent passwd Debian-snmp >/dev/null
getent group Debian-snmp >/dev/null

install -d -o root -g root -m 0755 /usr/local/lib/ups-network-adapter
install -o root -g root -m 0644 ups_mib.py /usr/local/lib/ups-network-adapter/ups_mib.py
install -o root -g root -m 0644 ups_mcp.py /usr/local/lib/ups-network-adapter/ups_mcp.py
install -o root -g root -m 0644 ups_autodetect.py /usr/local/lib/ups-network-adapter/ups_autodetect.py
install -o root -g root -m 0644 config/ups-snmp.service /etc/systemd/system/ups-snmp.service
install -o root -g root -m 0644 config/ups-autodetect.service /etc/systemd/system/ups-autodetect.service
install -d -o root -g Debian-snmp -m 0750 /etc/ups-network-adapter
# Preserve the single endpoint's credentials and local settings on updates.
if [[ ! -e /etc/ups-network-adapter/ups.conf ]]; then
    install -o root -g Debian-snmp -m 0640 config/ups.conf /etc/ups-network-adapter/ups.conf
fi
systemctl daemon-reload

if [[ ${1:-} == --configure-nut ]]; then
    backup=$(mktemp -d /root/ups-adapter-backup-XXXXXXXX)
    cp -a /etc/nut "$backup/nut"
    cp -a /etc/ups-network-adapter "$backup/snmp"
    systemctl is-enabled nut-monitor.service nut-driver-enumerator.path ups-autodetect.service ups-snmp.service > "$backup/service-enablement.txt" || true
    systemctl disable --now ups-autodetect.service
    systemctl stop ups-snmp.service
    if [[ -e /etc/systemd/system/ups-snmp@.service ]]; then
        systemctl disable --now ups-snmp@apc.service ups-snmp@eaton.service
    fi
    systemctl mask --now nut-monitor.service
    # The detector invokes NUT's enumerator after writing a complete configuration.
    # Disable its file watcher to prevent concurrent reconfiguration during a swap.
    systemctl disable --now nut-driver-enumerator.path
    systemctl stop nut-driver.target nut-server.service nut-driver-enumerator.service
    /usr/bin/python3 - <<'PY'
from pathlib import Path
import re

path = Path('/etc/nut/nut.conf')
content = path.read_text()
content, count = re.subn(r'^\s*MODE\s*=.*$', 'MODE=netserver', content, flags=re.MULTILINE)
path.write_text(content if count else content + '\nMODE=netserver\n')
path = Path('/etc/nut/upsd.conf')
content = path.read_text()
for key, value in (('ALLOW_NO_DEVICE', 'true'), ('MAXAGE', '6')):
    content, count = re.subn(r'^\s*' + key + r'\s+.*$', key + ' ' + value, content, flags=re.MULTILINE)
    if not count:
        content += '\n' + key + ' ' + value + '\n'
if not re.search(r'^\s*LISTEN\s+(127\.0\.0\.1|0\.0\.0\.0|\*)(\s+3493)?\s*(#.*)?$', content, flags=re.MULTILINE):
    content += '\nLISTEN 127.0.0.1 3493\n'
path.write_text(content)
Path('/etc/nut/ups.conf').write_text('# Managed by ups-network-adapter autodetection.\n')
PY
    chown root:nut /etc/nut/nut.conf /etc/nut/ups.conf /etc/nut/upsd.conf
    chmod 0640 /etc/nut/nut.conf /etc/nut/ups.conf /etc/nut/upsd.conf
    systemctl enable nut.target nut-server.service nut-driver.target nut-driver-enumerator.service
    systemctl enable --now ups-autodetect.service
    echo "Autodetection enabled. Previous configuration backed up to $backup"
fi
echo 'Files installed. Follow README.md to configure the single SNMP endpoint.'
