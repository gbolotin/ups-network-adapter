#!/bin/bash
# Opt-in diagnostics only; the normal adapter installer does not enable tracing.
set -euo pipefail
[[ $(id -u) -eq 0 ]] || { echo 'Run this installer as root.' >&2; exit 1; }
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
install -d -m 0755 /usr/local/lib/ups-network-adapter /etc/systemd/journald.conf.d
install -o root -g root -m 0644 ups_stability.py /usr/local/lib/ups-network-adapter/ups_stability.py
install -o root -g root -m 0644 ups-stability.service /etc/systemd/system/ups-stability.service
systemd-analyze verify /etc/systemd/system/ups-stability.service
install -o root -g root -m 0644 zz-ups-stability.conf /etc/systemd/journald.conf.d/zz-ups-stability.conf
systemctl restart systemd-journald
journalctl --flush
systemctl daemon-reload
systemctl enable ups-stability.service
systemctl restart ups-stability.service
