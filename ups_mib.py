#!/usr/bin/env python3
"""Read-only RFC 1628 monitoring bridge for Net-SNMP pass_persist and NUT."""

import argparse
from bisect import bisect_right
from collections.abc import Callable
from decimal import Decimal, DecimalException
import re
import subprocess
import sys
import time
from typing import TextIO

ROOT = (1, 3, 6, 1, 2, 1, 33, 1)
Oid = tuple[int, ...]
Value = tuple[str, str | int]


def oid(suffix: str) -> Oid:
    return ROOT + tuple(int(part) for part in suffix.split("."))


def number(value: str | None, scale: str = "1", minimum: int = 0, maximum: int = 2147483647) -> int | None:
    """Omit unavailable/out-of-range readings; never turn them into zero."""
    try:
        scaled = Decimal(value) * Decimal(scale)
        if scaled.is_finite() and minimum <= scaled <= maximum:
            return int(scaled)
    except (DecimalException, TypeError, ValueError):
        pass
    return None


def build_mib(values: dict[str, str], name: str, seconds_on_battery: int | None) -> dict[Oid, Value]:
    mib: dict[Oid, Value] = {}

    def put(suffix: str, value: str | int | None, kind: str = "integer") -> None:
        if value is not None:
            mib[oid(suffix)] = (kind, value)

    for suffix, value in (
        ("1.1.0", values.get("ups.mfr") or values.get("device.mfr")),
        ("1.2.0", values.get("ups.model") or values.get("device.model")),
        ("1.3.0", values.get("ups.firmware")),
        ("1.4.0", "ups-network-adapter/0.1"),
        ("1.5.0", name),
    ):
        if value:
            # DisplayString is ASCII and the pass_persist protocol is line-oriented.
            text = "".join(character if 32 <= ord(character) <= 126 else "?" for character in value)
            put(suffix, text[:255], "string")

    status = set(values.get("ups.status", "").split())
    connected = bool(status)
    battery_status = 3 if "LB" in status else 2 if status & {"OL", "OB"} else 1
    put("2.1.0", battery_status)
    put("2.2.0", seconds_on_battery)
    source = next((value for token, value in (
        ("OFF", 2), ("BYPASS", 4), ("OB", 5), ("BOOST", 6), ("TRIM", 7), ("OL", 3)
    ) if token in status), 1)
    put("4.1.0", source)

    # Only the two single-phase models are targeted. Do not invent missing sensors.
    if connected:
        put("3.2.0", 1)
        put("4.3.0", 1)
        for suffix, key, scale, minimum, maximum in (
            ("2.4.0", "battery.charge", "1", 0, 100),
            ("2.5.0", "battery.voltage", "10", 0, 2147483647),
            ("2.6.0", "battery.current", "10", -2147483648, 2147483647),
            ("2.7.0", "battery.temperature", "1", -2147483648, 2147483647),
            ("3.3.1.2.1", "input.frequency", "10", 0, 2147483647),
            ("3.3.1.3.1", "input.voltage", "1", 0, 2147483647),
            ("3.3.1.4.1", "input.current", "10", 0, 2147483647),
            ("3.3.1.5.1", "input.realpower", "1", 0, 2147483647),
            ("4.2.0", "output.frequency", "10", 0, 2147483647),
            ("4.4.1.2.1", "output.voltage", "1", 0, 2147483647),
            ("4.4.1.3.1", "output.current", "10", 0, 2147483647),
            ("4.4.1.4.1", "ups.realpower", "1", 0, 2147483647),
            ("4.4.1.5.1", "ups.load", "1", 0, 200),
            ("9.1.0", "input.voltage.nominal", "1", 0, 2147483647),
            ("9.2.0", "input.frequency.nominal", "10", 0, 2147483647),
            ("9.3.0", "output.voltage.nominal", "1", 0, 2147483647),
            ("9.4.0", "output.frequency.nominal", "10", 0, 2147483647),
            ("9.5.0", "ups.power.nominal", "1", 0, 2147483647),
            ("9.6.0", "ups.realpower.nominal", "1", 0, 2147483647),
            ("9.9.0", "input.transfer.low", "1", 0, 2147483647),
            ("9.10.0", "input.transfer.high", "1", 0, 2147483647),
        ):
            put(suffix, number(values.get(key), scale, minimum, maximum))
        runtime = number(values.get("battery.runtime"), minimum=1)
        if runtime is not None:
            # RFC 1628 requires a positive number of minutes; round a partial minute up.
            put("2.3.0", (runtime + 59) // 60)
        low_runtime = number(values.get("battery.runtime.low"))
        if low_runtime is not None:
            put("9.7.0", low_runtime // 60)

    alarms = {alarm for token, alarm in (
        ("RB", 1), ("OB", 2), ("LB", 3), ("OVER", 8), ("BYPASS", 9),
        ("OFF", 14), ("ALARM", 18), ("FSD", 22), ("CAL", 24),
    ) if token in status}
    if values.get("ups.alarm"):
        alarms.add(18)
    if not connected:
        alarms.add(20)
    put("6.1.0", len(alarms), "gauge")
    for alarm in alarms:
        put(f"6.2.1.2.{alarm}", "." + ".".join(map(str, oid(f"6.3.{alarm}"))), "objectid")
    # Alarm timestamps are omitted: pass_persist does not supply snmpd's sysUpTime.
    return mib


def read_ups(name: str) -> dict[str, str]:
    result = subprocess.run(
        ["/usr/bin/upsc", f"{name}@127.0.0.1"], capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=1, check=True,
    )
    values = {}
    for line in result.stdout.splitlines():
        key, separator, value = line.partition(": ")
        if separator:
            values[key] = value.strip()
    if not values.get("ups.status"):
        raise ValueError("NUT returned no UPS status")
    return values


class Bridge:
    def __init__(self, name: str, read: Callable[[], dict[str, str]], clock: Callable[[], float] = time.monotonic):
        self.name = name
        self.read = read
        self.clock = clock
        self.next_read = 0.0
        self.values: dict[str, str] = {}
        self.battery_since: float | None = None

    def snapshot(self) -> dict[Oid, Value]:
        now = self.clock()
        if now >= self.next_read:
            try:
                values = self.read()
                if not values.get("ups.status"):
                    raise ValueError("NUT returned no UPS status")
                self.values = values
            except (OSError, subprocess.SubprocessError, ValueError):
                # Never continue advertising stale "on line" telemetry after a failed read.
                self.values = {}
                # Net-SNMP merges stderr into this protocol pipe: do not log there.
            now = self.clock()
            # ponytail: two-second request-driven cache; use a background reader if polling latency matters.
            self.next_read = now + 2
            status = set(self.values.get("ups.status", "").split())
            if "OB" in status:
                if self.battery_since is None:
                    self.battery_since = now
            else:
                self.battery_since = None
        elapsed = None
        if self.values:
            elapsed = min(int(now - self.battery_since), 2147483647) if self.battery_since is not None else 0
        return build_mib(self.values, self.name, elapsed)


def serve(snapshot: Callable[[], dict[Oid, Value]], stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout) -> None:
    for line in stdin:
        command = line.strip()
        if not command:
            return
        if command == "PING":
            response = "PONG"
        elif command == "set":
            if not stdin.readline() or not stdin.readline():
                return
            response = "not-writable"
        elif command in {"get", "getnext"}:
            raw_oid = stdin.readline().strip()
            if not raw_oid:
                return
            response = "NONE"
            if len(raw_oid) <= 1024 and re.fullmatch(r"\.?\d+(?:\.\d+)*", raw_oid):
                requested = tuple(int(part) for part in raw_oid.lstrip(".").split("."))
                mib = snapshot()
                selected = requested
                if command == "getnext":
                    keys = sorted(mib)
                    index = bisect_right(keys, requested)
                    selected = keys[index] if index < len(keys) else ()
                if selected in mib:
                    kind, value = mib[selected]
                    response = "." + ".".join(map(str, selected)) + f"\n{kind}\n{value}"
        else:
            return
        stdout.write(response + "\n")
        stdout.flush()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ups", default="ups", help="Local NUT UPS section name (default: ups)")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", args.ups):
        parser.error("UPS name must contain 1-64 letters, digits, underscores or hyphens")
    serve(Bridge(args.ups, lambda: read_ups(args.ups)).snapshot)


if __name__ == "__main__":
    main()
