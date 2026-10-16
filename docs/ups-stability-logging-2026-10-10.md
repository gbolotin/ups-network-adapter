# UPS stability logging: overhead and deployment, 2026-10-10

## Result

The overhead check passed after correcting a busy loop in the first candidate. Bounded diagnostic logging is enabled on `192.168.50.200`. Observation started on **2026-10-10 at 17:01:43 Asia/Jerusalem** and ends automatically on **2026-10-17 at 17:01:43**. This is the start of evidence collection, not a seven-day stability result.

No production dependency was added. NUT's polling mitigation and the running adapter processes were not changed or restarted by enabling logging.

## Measurements

A sixty-second baseline ran with USB monitoring disabled. The corrected collector then ran for approximately two minutes, using the same capture and health-sampling paths installed for observation. Its health checks included real NUT and SNMP queries. CPU measurements include the collector's child commands. First-fault snapshot byte bounds were tightened afterward and tested separately; that failure-only path was not included in the healthy overhead benchmark.

| Measurement | Result |
| --- | --- |
| Baseline whole-Pi CPU usage | 1.913% across all cores |
| Whole-Pi CPU during capture | 1.866% across all cores |
| Collector CPU, including completed children | 0.429% of one core |
| Peak sampled collector RSS | 15,004 KiB, approximately 14.7 MiB |
| Elapsed capture | 121.16 seconds, including shutdown |
| Collector-attributed disk writes | 61,440 bytes |
| USB trace | 35,073 bytes, 354 records |
| Health records | 1,244 bytes, two successful samples |
| Kernel USB monitor counters | `text_lost 0` in recorded samples and live spot checks |
| Disk free before installation | 53,892,907,008 bytes, approximately 50.2 GiB |

The two CPU windows have normal background workload variation; the lower whole-Pi result does not show that tracing improves performance. The collector itself was below the acceptance thresholds of 2% of one core and 32 MiB sampled RSS. Both health samples succeeded.

At this short sample's rate, collector-attributed disk writes project to about 42 MiB/day. Logical trace and health data project to about 25 MiB/day. These are estimates, not seven-day measurements; they exclude journald writes and filesystem metadata. Faults or changed USB traffic can raise the rate, while rotation bounds retained files.

The first candidate used nonblocking reads with `select()` on the text USB monitor. That interface remained ready without data, producing a busy loop: 99.203% of one core. It was rejected before installation. The corrected version blocks in `read()`, as the documented text capture workflow does. Both benchmark results are retained.

## Installed logging

`ups-stability.service` runs a standard-library Python collector:

```text
USB monitor --> UPS-address filter --> 32 MiB rotating trace --+
                                                            |
NUT every minute + SNMP every five minutes --> health records +--> first anomaly
                                                            |       |
Persistent driver/kernel journal ---------------------------+       +--> freeze trace
                                                                    +--> save journal snapshot
```

- `/var/log/ups-stability/` is root-only, mode `0700`; individual diagnostic files are owner-only.
- Eight USB trace files retain up to 32 MiB. Eight health files retain up to 16 MiB. First-fault journal snapshots are bounded to 1 MiB each.
- The first anomaly is preserved exclusively in `incident.json`; subsequent anomalies cannot overwrite it. Health sampling continues after the USB trace freezes. No automatic USB reset or adapter restart occurs.
- The persisted deadline survives collector restarts. Previous service PIDs are read from the health log, so a restart between collector runs remains detectable.
- Journald was explicitly configured as volatile. The new drop-in enables persistent storage with a 128 MiB nominal cap, 16 MiB journal files, 1 GiB free-space reserve, and eight-day age limit. The allowance including active journal allocation is approximately 200 MiB for all diagnostic retention.
- Enabling the collector restarts journald to apply its drop-in. All four adapter PIDs were identical before and afterward. Existing journal data was flushed to `/var/log/journal/`; persistent journal files were verified on disk.
- The seven-day collector is separate from normal adapter installation. Instructions and rollback details are in [diagnostics/README.md](../diagnostics/README.md).

## Validation and private evidence

Local checks passed: `test_ups_stability.py`, `test_ups_autodetect.py`, `test_setup_pi.py`, `test_ups_mib.py`, and `test_ups_mcp.py`. The diagnostic check also passed on the Pi. `bash -n` validated the diagnostic installer; `systemd-analyze verify` validated its service. `git diff --check` passed.

After activation, the collector and all four adapter services were active. Its first live record showed `OL`, 100% charge, 4% load, 230 V input, `pollonly` enabled, and a ten-second poll interval. SNMP returned 100% charge and source 3 (normal mains). Four live samples passed, the trace grew past 60 KiB, and no incident file existed. The current monitor reported `text_lost 0`.

A collector-only restart verified that the original deadline remained byte-for-byte unchanged, previous adapter PIDs remained detectable, and capture resumed without a false incident. Final adapter PIDs still matched the pre-installation snapshot. The installed collector and the Pi's project copy have SHA-256 `6ed7b0bdbc5048cf6f98939097aabdf0b531ae529b280c7a667800172dcee655`.

A separately marked synthetic incident exercised real journal snapshot commands without inducing a UPS fault. It saved 230,179 bytes of service entries and 930 bytes of kernel entries. Unicode snapshot tests separately verify the strict 1 MiB byte bound. The synthetic incident is isolated under the private diagnosis directory and is not part of the live observation.

Raw measurement and deployment evidence remains private on the Pi at `/root/ups-diagnosis-20261010-154358/`: `trace-overhead.json`, `trace-overhead-v1-busy-loop.json`, the two `trace-benchmark-*` directories, `check-trace-overhead.py`, journal configuration before installation, and before/after adapter PID records. Current diagnostic evidence is under `/var/log/ups-stability/`.

## Remaining limits

The overhead benchmark is short and does not cover sustained heavy USB traffic or a failure storm. Rotation tests cover size bounds; live files have not grown enough to exercise rotation on hardware. Trace counters must be reviewed for drops during the observation period.

The text USB API limits payload size, and sysfs filtering can miss early enumeration before the device identity appears. The host trace cannot prove electrical bus behavior independently of the controller. Trace filtering currently targets APC `051d:0002`; Eaton capture is outside this observation.

One-minute health sampling can miss a brief interruption. First-fault freezing can be triggered by an SNMP or service anomaly unrelated to a USB lockup; the evidence must be interpreted before changing the UPS configuration. No automatic notification or Codex review task was configured. Outage transitions and reboot recovery were not exercised.

References: [Linux USB monitor](https://cdn.kernel.org/doc/html/latest/usb/usbmon.html), [systemd journal configuration](https://www.freedesktop.org/software/systemd/man/latest/journald.conf.html).
