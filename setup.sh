#!/bin/bash
# One entry point for package checks, configuration repair, and verification.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

check_only=false
arguments=("$@")
while [[ $# -gt 0 ]]; do
    case "$1" in
        --check) check_only=true; shift ;;
        --manager)
            [[ $# -ge 2 ]] || { echo '--manager requires an IPv4 address' >&2; exit 1; }
            shift 2 ;;
        --help)
            echo 'Usage: sudo bash setup.sh [--check] [--manager IPv4_ADDRESS]'
            exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done
[[ $EUID -eq 0 ]] || { echo 'Run with sudo bash setup.sh' >&2; exit 1; }
[[ -d /run/systemd/system ]] || { echo 'This script requires Raspberry Pi OS with systemd.' >&2; exit 1; }

missing=()
for package in python3 nut-server nut-client snmpd snmp usbutils; do
    if [[ $(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true) != 'install ok installed' ]]; then
        missing+=("$package")
    fi
done
if [[ ${#missing[@]} -gt 0 ]]; then
    echo "Missing packages: ${missing[*]}"
    if $check_only; then
        exit 1
    fi
    apt-get update
    apt-get install -y "${missing[@]}"
else
    echo 'Required packages are installed.'
fi
exec /usr/bin/python3 setup_pi.py "${arguments[@]}"
