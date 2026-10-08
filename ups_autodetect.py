#!/usr/bin/env python3
"""Keep one NUT UPS named 'ups' configured for the USB device currently attached."""

import configparser
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time

MARKER = "# Managed by ups-network-adapter autodetection.\n"
CONFIG = Path("/etc/nut/ups.conf")


def parse_scan(output: str) -> tuple[str, tuple[str, ...], str]:
    start = output.find("[")
    if start < 0:
        return MARKER, (), "No supported USB UPS detected"
    parser = configparser.ConfigParser(interpolation=None)
    parser.read_string(output[start:])
    if parser.defaults() or len(parser.sections()) != 1:
        return MARKER, (), "Connect exactly one USB UPS; refusing ambiguous scan"
    fields = {key: value.strip().strip('"') for key, value in parser[parser.sections()[0]].items()}
    driver = fields.get("driver", "")
    if driver not in {"usbhid-ups", "nutdrv_qx"} or fields.get("port") != "auto":
        return MARKER, (), "Detected UPS uses an unsupported driver"
    for key in ("vendorid", "productid"):
        if not re.fullmatch(r"[0-9A-Fa-f]{4}", fields.get(key, "")):
            raise ValueError(f"Invalid or missing USB {key}")
    config = MARKER + f"[ups]\n    driver = {driver}\n    port = auto\n"
    for key in ("vendorid", "productid"):
        config += f"    {key} = {fields[key].lower()}\n"
    serial = fields.get("serial", "")
    if serial:
        if len(serial) > 255 or any(ord(character) < 32 or ord(character) > 126 for character in serial):
            raise ValueError("Invalid USB serial number")
        # NUT serial matching uses POSIX regular expressions, then ups.conf quoting.
        serial = re.sub(r'([.\[\]\\*^$()+?{|}])', r'\\\1', serial)
        serial = serial.replace("\\", "\\\\").replace('"', '\\"')
        config += f'    serial = "{serial}"\n'
    config += "    sdorder = -1\n"
    identity = (driver, fields['vendorid'].lower(), fields['productid'].lower(),
                fields.get('serial', ''), fields.get('bus', ''), fields.get('device', ''))
    return config, identity, f"Selected {driver} for USB {fields['vendorid']}:{fields['productid']} as ups"


def same_usb_device(previous: tuple[str, ...], current: tuple[str, ...]) -> bool:
    if not previous or not current:
        return previous == current
    # Only ignore missing serial data when the driver, IDs and USB address agree.
    if not all(previous[4:]) or not all(current[4:]):
        return previous == current
    return (previous[:3] == current[:3] and previous[4:] == current[4:]
            and (not previous[3] or not current[3] or previous[3] == current[3]))


def scan_usb() -> tuple[str, tuple[str, ...], str]:
    try:
        result = subprocess.run(
            ["/usr/bin/nut-scanner", "-U", "-N"], capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=20, check=True,
        )
        if "USB search disabled" in result.stderr or "Failed to open device" in result.stderr:
            raise ValueError("USB scan unavailable or incomplete")
        return parse_scan(result.stdout)
    except (OSError, subprocess.SubprocessError, configparser.Error, ValueError) as error:
        # Fail closed instead of retaining a previous UPS selection on scan errors.
        return MARKER, (), f"USB detection failed: {error}"


def write_config(path: Path, content: str, group: str = "nut") -> None:
    import grp  # Linux-only file ownership; parsing checks also run on Windows.

    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n", dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chown(temporary, 0, grp.getgrnam(group).gr_gid)
        os.chmod(temporary, 0o640)
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def systemctl(*arguments: str) -> None:
    subprocess.run(["/usr/bin/systemctl", *arguments], timeout=120, check=True)


def apply_selection(content: str, path: Path = CONFIG) -> None:
    if not path.read_text(encoding="utf-8").startswith(MARKER):
        raise ValueError("ups.conf is not managed; run sudo bash install.sh --configure-nut first")
    # Stop the previous driver before rewriting its section or selecting another model.
    systemctl("stop", "nut-driver.target", "nut-server.service")
    write_config(path, content)
    systemctl("restart", "nut-driver-enumerator.service")
    systemctl("start", "nut-driver.target", "nut-server.service")
    # Clear bridge cache and battery elapsed time even when swapping two similar units.
    systemctl("try-restart", "ups-snmp.service")


def main() -> None:
    previous = None
    last_message = None
    while True:
        detected = scan_usb()
        identity = detected[1]
        changed = previous is None or not same_usb_device(previous, identity)
        message = detected[2]
        if changed:
            apply_selection(detected[0])
            previous = identity
        elif identity and identity[3]:
            # Learn a newly readable serial without rewriting/restarting NUT.
            previous = identity
        elif identity:
            message = 'USB serial unavailable for unchanged device; keeping current NUT selection'
        if changed or message != last_message:
            print(message, flush=True)
            if changed and identity:
                print(f'USB selection: bus {identity[4]}, device {identity[5]}, serial {identity[3] or "unavailable"}', flush=True)
            last_message = message
        # ponytail: periodic USB scan, up to 10 seconds before discovery; use udev events if instant switching is needed.
        time.sleep(10)


if __name__ == "__main__":
    main()
