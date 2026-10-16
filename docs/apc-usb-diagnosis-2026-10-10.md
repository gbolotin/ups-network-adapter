# APC BX750MI USB failure: 2026-10-10

## Result and limits

The Pi's APC USB device stopped answering control requests. NUT therefore could not obtain current readings, and PeaNUT displayed Device Unreachable. A USB device reset restored readings remotely. No Pi reboot, cable reconnection, UPS output command, or USB hub power cycle was used.

The failure is confirmed below NUT's permissions and configuration matching. The initiating cause remains unconfirmed. APC firmware/driver interaction is plausible; a USB cable, electrical link, or host-controller fault has not been excluded. A persistent BX750MI-specific polling mitigation is deployed and passed the short checks below. It must not be described as a proven permanent fix.

## Environment

- Pi: `192.168.50.200`, Raspberry Pi 4, Debian 13.7 arm64.
- Kernel: `6.18.50+rpt-rpi-v8`.
- NUT: `2.8.1-5`; libusb: `1.0.28`.
- USB device: APC Back-UPS BX750MI, `051d:0002`, USB path `1-1.3`, bus/device `001/059`.
- USB controller firmware: VL805 `000138c0`, reported up to date.

Times below use Asia/Jerusalem (UTC+03:00).

## Observed evidence

1. PeaNUT's `/api/ping` responded with HTTP 200 and `"pong"`. A direct LAN NUT query returned `ERR DATA-STALE`. A local `upsc` query also failed.
2. The driver ran as `nut`; its USB node was `root:nut`, mode `0664`. USB autosuspend was disabled (`power/control=on`, runtime status `active`). No kernel driver was bound to the UPS interface. Pi throttling flags were `0x0`.
3. With autodetection and the normal driver stopped, root `lsusb -v` exceeded a fifteen-second timeout. Both isolated `nut` and root driver attempts failed to read manufacturer/product/serial strings.
4. A root driver attempt overriding only its diagnostic serial matcher reached the HID descriptor stage. It logged `Unable to get HID descriptor (Operation timed out)` and `Unable to get Report descriptor: Resource temporarily unavailable`.
5. USB monitoring captured standard descriptor requests to UPS endpoint zero with no returned payload before cancellation. Requests to the hub and root controller succeeded. The kernel subsequently logged `device descriptor read/64, error -110` during USB reset retries.
6. `usbreset 051d:0002` exceeded its userspace timeout while the kernel continued reset handling. The UPS recovered afterward. By 15:47:38, local readings showed `OL CHRG`, 100% charge, 3920 seconds runtime, 4% load, and 232 V input.

The generic `insufficient permissions on everything` message was misleading here: root also failed, and the APC could be opened before descriptor reads failed. A serial mismatch was a consequence of the missing string, not the underlying USB failure.

The retained journal began after the original loss of communication. It cannot establish the request or event that first triggered the fault.

## Scanner comparison

After recovery, a foreground diagnostic driver ran with normal polling and:

- No scanner: six successful queries across about one minute.
- Normal scanning: six scans and successful queries at ten-second intervals.
- Accelerated scanning: twenty scans and successful queries at approximately one-second intervals.

The failure did not recur in these short runs. They do not prove that scanning is harmless over days, and they do not support claiming that scanning caused this incident.

## Persistent mitigation

The detector generates `pollonly` and `pollinterval = 10` only when the scanner reports `usbhid-ups`, vendor `051d`, product ID `0002`, and product string `Back-UPS BX750MI`. The setting therefore survives regeneration of `ups.conf`. Other models retain their original behavior.

`pollonly` disables interrupt transfers. The ten-second interval reduces control-poll traffic; it also increases status polling latency from two to ten seconds. Full sensor polling retains its thirty-second default. This addresses plausible compatibility paths without suppressing errors or adding periodic resets. Long-duration recurrence testing and an outage transition test are still required.

Upstream references:

- [NUT usbhid-ups documentation](https://networkupstools.org/docs/man/usbhid-ups.html): polling options and repeated USB control timeout guidance.
- [NUT PR 2671](https://github.com/networkupstools/nut/pull/2671): related APC BX lockup/reconnection handling. The contributor explicitly distinguishes recovery from the unresolved underlying cause.
- [NUT issue 2347](https://github.com/networkupstools/nut/issues/2347): related APC BX firmware/interrupt behavior; it is not proof that this incident has the same cause.

## Evidence and validation

Private raw logs are retained on the Pi at `/root/ups-diagnosis-20261010-154358/`: service/kernel journals, isolated driver logs, USB monitoring, ioctl trace, and scanner comparison logs. Configuration and installed detector backups are retained there before deployment.

Validation completed on 2026-10-10:

- Local Python checks passed: `test_ups_autodetect.py`, `test_setup_pi.py`, `test_ups_mib.py`, and `test_ups_mcp.py`. `git diff --check` passed.
- The updated detector check passed on the Pi. Its installed runtime and project source copies match SHA-256 `6a6033d7687c5d08c06514a5610f9ad6655915986b95c00039f5855d0c137ca1`. Backups retain both previous copies.
- Generated configuration includes `pollonly` and `pollinterval = 10`. Live `upsc` confirms `driver.flag.pollonly: enabled`, `driver.parameter.pollinterval: 10`, and the default `driver.parameter.pollfreq: 30`.
- From 15:55:16 through 15:56:36, nine ten-second samples returned `OL`, 100% charge, 3920 seconds runtime, and 232 V input. The driver PID remained unchanged. An eighty-second USB capture contained 118 UPS control submissions and no UPS interrupt transfers. The temporary `usbmon` module was unloaded afterward.
- Autodetection, the NUT driver, NUT server, and SNMP services were active after deployment. A direct Windows-to-Pi NUT query returned current model, status, charge, load, and voltage without `DATA-STALE`.
- A local SNMP v2c GET on UDP 161 returned model `Back-UPS BX750MI`, battery charge 100%, and output source 3 (normal mains).
- Refreshing the existing PeaNUT browser tab at 15:57:55 showed `Online`, 100% charge, and 4% load.

Long-duration stability, outage transitions, and Eaton hardware behavior were not tested. The original initiating event was not captured. No automatic reset loop or scheduled monitor was added. This change is a compatibility mitigation, not evidence that the recurring fault is permanently eliminated.
