"""Run with python3 test_ups_mib.py. Synthetic data; no UPS, SNMP daemon or pip needed."""

from io import StringIO
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

from ups_mib import Bridge, ROOT, build_mib, number, oid, read_ups, serve


def check() -> None:
    values = {
        "ups.mfr": "APC", "ups.model": "Synthetic BX750MI", "ups.status": "OL",
        "battery.charge": "96.5", "battery.runtime": "601", "battery.runtime.low": "180",
        "battery.voltage": "13.7", "battery.current": "-1.2", "battery.temperature": "27",
        "input.voltage": "231.8", "input.frequency": "49.9", "output.voltage": "230.1",
        "output.frequency": "50.0", "output.current": "0.6", "ups.load": "32.5",
        "ups.realpower": "133", "ups.power.nominal": "750", "ups.realpower.nominal": "410",
    }
    mib = build_mib(values, "apc", 0)
    for suffix, expected in {
        "2.1.0": 2, "2.2.0": 0, "2.3.0": 11, "2.4.0": 96, "2.5.0": 137,
        "2.6.0": -12, "2.7.0": 27, "3.3.1.2.1": 499, "3.3.1.3.1": 231,
        "4.1.0": 3, "4.2.0": 500, "4.4.1.2.1": 230, "4.4.1.3.1": 6,
        "4.4.1.4.1": 133, "4.4.1.5.1": 32, "9.5.0": 750, "9.6.0": 410, "9.7.0": 3,
    }.items():
        assert mib[oid(suffix)] == ("integer", expected), suffix
    assert mib[oid("6.1.0")] == ("gauge", 0)
    assert oid("2.8.0") not in mib  # No invented, non-RFC "battery condition" scalar.
    assert oid("3.3.1.1.1") not in mib  # Table index is not-accessible in RFC 1628.
    assert oid("1.7.0") not in mib  # RFC 1628 has no serial-number scalar here.

    for status, source, battery in (
        ("OB", 5, 2), ("OB LB", 5, 3), ("OL BOOST", 6, 2), ("OL TRIM", 7, 2),
        ("OL BYPASS", 4, 2), ("OFF", 2, 1), ("OB LB FSD", 5, 3), ("WAIT", 1, 1),
    ):
        sample = build_mib({**values, "ups.status": status}, "apc", 12)
        assert sample[oid("4.1.0")][1] == source, status
        assert sample[oid("2.1.0")][1] == battery, status
    alarm_mib = build_mib({**values, "ups.status": "OB LB RB OVER FSD"}, "apc", 12)
    assert alarm_mib[oid("6.1.0")][1] == 5
    assert alarm_mib[oid("6.2.1.2.3")] == ("objectid", ".1.3.6.1.2.1.33.1.6.3.3")
    assert oid("6.2.1.2.4") not in alarm_mib  # LB/FSD does not prove depletion.

    missing = build_mib({"ups.status": "OL", "device.mfr": "Eaton"}, "eaton", 0)
    assert missing[oid("1.1.0")] == ("string", "Eaton")
    assert oid("2.3.0") not in missing
    assert oid("4.4.1.4.1") not in missing
    for invalid in (None, "unknown", "NaN", "sNaN", "Infinity", "-1", "1e999999999"):
        assert number(invalid) is None, invalid
    assert number("101", maximum=100) is None
    assert number("1e999999", "10") is None
    assert number("0") == 0
    assert number("2.3", "10") == 23
    assert build_mib({**values, "battery.runtime": "30"}, "apc", 0)[oid("2.3.0")][1] == 1
    assert oid("2.3.0") not in build_mib({**values, "battery.runtime": "0"}, "apc", 0)
    assert build_mib({**values, "ups.model": "UPS\ninteger\x00é"}, "apc", 0)[oid("1.2.0")][1] == "UPS?integer??"

    # Cache, battery timer, failed reads, and recovery use a deterministic injected clock.
    now = [100.0]
    readings = iter([values, {**values, "ups.status": "OB LB"}, OSError("disconnected"), values])
    calls = []

    def read():
        calls.append(now[0])
        reading = next(readings)
        if isinstance(reading, Exception):
            raise reading
        return reading

    bridge = Bridge("apc", read, lambda: now[0])
    assert bridge.snapshot()[oid("4.1.0")][1] == 3
    now[0] = 101
    bridge.snapshot()
    assert len(calls) == 1
    now[0] = 102
    assert bridge.snapshot()[oid("4.1.0")][1] == 5
    now[0] = 103
    assert bridge.snapshot()[oid("2.2.0")][1] == 1
    now[0] = 104
    failed = bridge.snapshot()
    assert failed[oid("2.1.0")][1] == 1
    assert failed[oid("4.1.0")][1] == 1
    assert failed[oid("6.2.1.2.20")] == ("objectid", ".1.3.6.1.2.1.33.1.6.3.20")
    for suffix in ("2.2.0", "2.4.0", "2.5.0", "4.4.1.2.1", "3.2.0"):
        assert oid(suffix) not in failed
    now[0] = 106
    recovered = bridge.snapshot()
    assert recovered[oid("4.1.0")][1] == 3
    assert recovered[oid("2.2.0")][1] == 0
    assert recovered[oid("6.1.0")][1] == 0
    for failure in (subprocess.TimeoutExpired("upsc", 1), subprocess.CalledProcessError(1, "upsc")):
        with patch("ups_mib.subprocess.run", side_effect=failure):
            assert Bridge("apc", lambda: read_ups("apc")).snapshot()[oid("6.1.0")][1] == 1

    # Exercise the upsc boundary, including a colon within a value and missing status.
    result = subprocess.CompletedProcess([], 0, "ups.status: OL\nups.model: UPS: example\n", "")
    with patch("ups_mib.subprocess.run", return_value=result) as run:
        assert read_ups("apc")["ups.model"] == "UPS: example"
        assert run.call_args.args[0] == ["/usr/bin/upsc", "apc@127.0.0.1"]
        assert run.call_args.kwargs["timeout"] == 1
        assert run.call_args.kwargs["check"] is True
    with patch("ups_mib.subprocess.run", return_value=subprocess.CompletedProcess([], 0, "", "")):
        try:
            read_ups("apc")
        except ValueError:
            pass
        else:
            raise AssertionError("Empty NUT response was accepted")

    def exchange(request):
        output = StringIO()
        serve(lambda: mib, StringIO(request), output)
        return output.getvalue()

    assert exchange("PING\nPING\n\n") == "PONG\nPONG\n"
    assert exchange("get\n.1.3.6.1.2.1.33.1.2.5.0\n") == ".1.3.6.1.2.1.33.1.2.5.0\ninteger\n137\n"
    assert exchange("get\n1.3.6.1.2.1.33.1.2.5.0\n").endswith("\n137\n")
    assert exchange("get\n.1.3.6.1.2.1.33.99\ngetnext\n.9\n") == "NONE\nNONE\n"
    assert exchange("get\nbad.oid\nget\n" + "9" * 5000 + "\n") == "NONE\nNONE\n"
    assert exchange("set\n.1.3.6.1.2.1.33.1.8.2.0\ninteger 0\nPING\n") == "not-writable\nPONG\n"
    assert exchange("get\n") == ""
    assert exchange("set\n.1\n") == ""
    previous = ".1.3.6.1.2.1.33"
    walked = []
    while True:
        response = exchange(f"getnext\n{previous}\n")
        if response == "NONE\n":
            break
        current, kind, value = response.splitlines()
        key = tuple(map(int, current.lstrip(".").split(".")))
        assert key[:len(ROOT)] == ROOT
        assert not walked or key > walked[-1]
        assert (kind, value) == (mib[key][0], str(mib[key][1]))
        walked.append(key)
        previous = current
        assert len(walked) <= len(mib)
    assert walked == sorted(mib)
    assert exchange("getnext\n.1.3.6.1.2.1.33.1.9.2\n").startswith(".1.3.6.1.2.1.33.1.9.5.0\n")

    # Test the real entry point without starting a NUT or SNMP service.
    script = str(Path(__file__).with_name("ups_mib.py"))
    process = subprocess.run([sys.executable, script, "--ups", "apc"], input="PING\n\n", text=True, capture_output=True, timeout=5)
    assert process.returncode == 0 and process.stdout == "PONG\n", process.stderr
    # Net-SNMP combines stderr/stdout; a NUT failure must leave a clean protocol reply.
    with patch("ups_mib.subprocess.run", side_effect=FileNotFoundError("upsc")):
        disconnected = Bridge("apc", lambda: read_ups("apc"))
        output = StringIO()
        with patch("sys.stderr", output):
            serve(disconnected.snapshot, StringIO("PING\nget\n.1.3.6.1.2.1.33.1.6.2.1.2.20\nPING\n"), output)
        assert output.getvalue() == "PONG\n.1.3.6.1.2.1.33.1.6.2.1.2.20\nobjectid\n.1.3.6.1.2.1.33.1.6.3.20\nPONG\n"
    rejected = subprocess.run([sys.executable, script, "--ups", "apc; bad"], text=True, capture_output=True, timeout=5)
    assert rejected.returncode == 2
    print("PASS: UPS-MIB mapping, status/alarms, missing data, cache/failure recovery, upsc boundary, GET/GETNEXT/SET and CLI")


if __name__ == "__main__":
    check()
