# APC USB recurrence: 14 October 2026

## Outcome

The original stability test failed. NUT stopped providing readings on 14 October at 15:19:52 Asia/Jerusalem, despite `pollonly` and `pollinterval = 10` still being configured. A remote USB device reset restored communication. No Pi reboot, cable reconnection, UPS output command, or automatic recovery loop was used.

PeaNUT was refreshed through Windows UI Automation and visibly showed **Online**, **100% charge**, and **5% load** at 22:21:46. NUT and local SNMP also returned current readings.

The initiating USB fault is still unproven. The previous polling mitigation did not prevent recurrence. Firmware, cable/link, and host-controller faults remain possible. Continuous scanner activity was removed as an unnecessary source of USB traffic, not identified as the proven trigger.

## Timeline and evidence

Times below use Asia/Jerusalem (UTC+03:00).

| Time | Verified observation |
| --- | --- |
| 10 October 17:01 | Original observation started. |
| 10 October 21:21–21:22 | Kernel reported USB disconnect/re-enumeration, address 59 to 60. NUT recovered; the next sample was `OL`. |
| 11 October 12:51 sample | USB address changed to 61; adapter processes restarted and readings were available. |
| 12 October 06:40 sample | USB address changed to 62; adapter processes restarted and readings were available. |
| 14 October 15:19:39 | Detector reported an unreadable serial on unchanged hardware. |
| 14 October 15:19:52 | NUT server marked data stale. First failed minute sample was 15:20:18. |
| 14 October 22:14 onward | All services remained active, but `upsc` returned `Data stale`. Root USB descriptor inspection timed out with competing scanner/driver stopped. USB monitoring showed repeated unanswered HID report descriptor requests. |
| 14 October evening recovery | A bounded `usbreset` command returned timeout status while kernel handling continued; readings recovered afterward. |
| 14 October 22:20:53 | Corrected observation started after adapter processes settled. It ends 21 October at 22:20:53. |

The user confirmed that the UPS and USB cable were left untouched during the three earlier reconnections. Their cause is not established by that confirmation. The Pi remained up throughout, USB autosuspend was disabled, and `vcgencmd get_throttled` returned `0x0` during inspection.

## Why the trace missed today's trigger

The collector froze on any anomaly, including a changed service PID. It froze at 21:22 on 10 October following a recovered USB reconnect while NUT readings were healthy. The first incident and preceding trace were retained correctly, but this policy prevented capture of today's later lockup. Minute-by-minute health records continued and established the failure time.

The existing trace contained cancelled control transfers and one pipe-stall completion before the earlier reconnect. These do not establish a specific initiating request or distinguish driver requests from scanner requests conclusively. The journal was near its 128 MiB cap; older kernel entries were no longer retained. A separate SNMP address-family error flooded service logs.

Original evidence was preserved before recovery: `/root/ups-recurrence-20261014-2214/stability-before-recovery.tar.gz`, `services-before-recovery.log`, `kernel-before-recovery.log`, `root-descriptors-current-fault.log`, and `usbmon-current-fault.log`. The complete original observation directory is preserved as `stability-observation-original` there. These are private, root-only directory contents.

## Changes deployed

1. **Capture continues after healthy reconnections.** Service PID changes are recorded as events. Only a failed NUT reading or missing UPS status freezes the first communication-failure trace. SNMP-only errors do not freeze a healthy NUT trace.
2. **Autodetection avoids redundant active scans.** Cached sysfs topology is checked every ten seconds. Scanner queries run at startup, after any USB topology change, after unsuccessful selection, or when sysfs cannot be read. New devices, changed bus/device addresses, disconnects and ambiguous scans still trigger normal selection. The existing single-UPS endpoint and model-specific polling settings are unchanged.
3. **SNMP can read its required netlink interface.** `AF_NETLINK` was added to the service's address-family allowlist. Repeated `could not open netlink socket` errors stopped after deployment. This repairs diagnostic noise; it is not a USB fix.

The runtime and Pi project source copies were both updated, with backups retained. No new production dependency was added. Deployment briefly restarted adapter processes. An observation armed during that expected startup interruption was archived separately as `stability-deployment-warmup`; it was not silently discarded or counted as a hardware recurrence. The corrected run was armed only after healthy readings and stable process IDs were verified.

## Validation

- Five local checks passed: detector, stability collector, setup, MIB bridge, and MCP. The updated detector and collector checks also passed on the Pi. Service verification and `git diff --check` passed.
- Regression cases cover unchanged topology without further scanner calls, added devices/ambiguity, re-enumeration, failed-selection retries, sysfs failure, healthy PID changes, SNMP-only errors, and genuine NUT communication failure.
- Live NUT/SNMP readings were available after deployment. The new trace continued growing without an incident file, and sampled kernel counters reported `text_lost 0`.
- A 35-second process trace of the detector recorded no child-process creation while topology remained unchanged; repeated scanner launches had stopped. Normal NUT control and string reads remain part of driver operation.
- No netlink socket error appeared in the inspected SNMP journal interval after the corrected service started.
- PeaNUT's visible Online/100%/5% state was verified after refreshing the existing browser tab.
- Follow-up at 07:20 on 15 October: all 540 minute samples from the corrected run were healthy, with no PID-change events. Current readings were `OL`, 100% charge, 4% load, and 232 V input. The trace had rotated at its 4 MiB file limit, continued recording, and reported `text_lost 0`. This covers approximately nine hours, not the full seven-day acceptance period.

Permanent USB stability, hardware cause, outage transitions, and Eaton behavior remain unverified. No automatic alert was added. A future recurrence requires analysis of the corrected capture before changing another factor.

Follow-up source investigation on 15 October found applicable missing NUT error-propagation and recovery fixes. A stable process PID does not exclude internal driver reconnects: the new trace contains matching reopen read sequences after intermittent failed reads. See [the source investigation and isolated reproduction](nut-source-investigation-2026-10-15.md). Successful NUT query samples describe client-visible availability, not a guarantee that every USB transfer succeeded.

References: [NUT 2.8.1 scanner documentation](https://networkupstools.org/historic/v2.8.1/docs/man/nut-scanner.html), [NUT 2.8.1 HID driver options](https://networkupstools.org/historic/v2.8.1/docs/man/usbhid-ups.html).
