# Seven-day UPS stability observation

This opt-in diagnostic collector is separate from normal adapter setup. It uses Python's standard library, installed NUT/SNMP clients, systemd, and the kernel USB monitor. It does not change UPS output, polling settings, or recovery behavior.

Install from a project copy on the Pi with `sudo bash diagnostics/install.sh`. The installer enables one service, not a Codex automation. Current results and measurements are in [the dated report](../docs/ups-stability-logging-2026-10-10.md).

## What is retained

Files under `/var/log/ups-stability/` are root-only:

| File | Purpose and bound |
| --- | --- |
| `test.json` | Start time and seven-day deadline, retained across service restarts and reboots. |
| `health.jsonl*` | One sample per minute: NUT query outcome and readings, service PIDs, USB address, and USB monitor counters. SNMP is queried every fifth sample. Eight files of at most 2 MiB each. |
| `usb.log*` | UTC timestamps plus USB monitor records for APC `051d:0002` addresses. Eight files of at most 4 MiB each. |
| `incident.json` | First failed NUT query or missing UPS status. Later communication failures do not replace it. |
| `services-at-fault.log`, `kernel-at-fault.log` | Up to 2,000 journal entries from the preceding 30 minutes, bounded to 1 MiB per file. |

On the first NUT communication failure, the collector freezes the rotating USB trace and continues health sampling. Healthy service PID changes are recorded in `events`; SNMP and USB/service availability anomalies remain in `errors` without freezing a healthy NUT trace. This prevents an earlier recovered reconnect from hiding a later lockup. It never resets USB or restarts adapter services. A service restart continues the same observation window and retains a genuinely frozen trace. After seven days, sampling stops automatically; enabled service startup cannot reset the deadline. No automatic notification is configured.

The journald drop-in changes volatile logging to persistent logging, with `SystemMaxUse=128M`, `SystemMaxFileSize=16M`, `SystemKeepFree=1G`, and an eight-day age limit. These are global journal settings. Size limits can remove old entries before eight days during a log flood. Journal allocation can exceed the nominal cap by an active file; the total configured diagnostic storage allowance is approximately 200 MiB.

## Inspect or stop

Run these on the Pi, or through an existing authorized SSH session:

```sh
systemctl status ups-stability --no-pager
cat /var/log/ups-stability/test.json
tail -n 3 /var/log/ups-stability/health.jsonl
test ! -f /var/log/ups-stability/incident.json || cat /var/log/ups-stability/incident.json
journalctl -u ups-stability --no-pager
```

To stop collection, run `sudo systemctl disable --now ups-stability`. Evidence remains. The persistent journal setting remains until `/etc/systemd/journald.conf.d/zz-ups-stability.conf` is removed and journald is restarted. The USB monitor module is intentionally left loaded; unloading it could interrupt another diagnostic reader.

Starting a new observation requires preserving the existing directory, then creating a fresh one before restarting the service. Do not clear or overwrite the first incident before analysis.

## Scope and limits

This trace targets the current APC USB ID; Eaton capture is not implemented. Only matching device traffic is saved, although the kernel monitor watches all buses. Early enumeration before a matching sysfs identity appears can be missed. The text API limits captured payload size and can drop events; `usbmon_stats` records the kernel's counters. An external USB analyzer would be needed to verify electrical transactions independently of the host controller.

A one-minute sample cannot identify the exact second of an interruption or rule out a brief interruption between samples. An unchanged sensor value is not itself proof of stale data. The collector checks NUT's query result rather than requiring sensor values to change. A valid battery status is accepted. Outage and reboot acceptance tests remain separate.

Synthetic checks run with `python3 test_ups_stability.py`; they require no Pi or USB device.

References: [Linux USB monitor documentation](https://cdn.kernel.org/doc/html/latest/usb/usbmon.html), [systemd journal configuration](https://www.freedesktop.org/software/systemd/man/latest/journald.conf.html).
