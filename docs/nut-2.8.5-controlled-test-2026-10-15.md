# NUT USB driver 2.8.5 controlled test

## Outcome and scope

Activated on the Pi at `192.168.50.200` on 15 October 2026 at 08:35 Asia/Jerusalem. The live `usbhid-ups` driver now reports **2.8.5**, APC HID **0.101**, and internal driver **0.71**. Client-visible readings and SNMP were healthy after activation.

This is a driver-only comparison. The packaged server, client, scanner, enumerator, and controller remain Debian `2.8.1-5`. The applicable recovery fixes identified in [the source investigation](nut-source-investigation-2026-10-15.md) are in the USB driver. Holding the other components constant limits the variables under test.

Settings remain `pollinterval = 2`, `pollfreq = 30`, and `pollonly`. No USB reset, cable reconnection, outage, or Pi reboot was performed. Automatic recovery was not added.

## Build and activation

- Source: [official NUT 2.8.5 release](https://github.com/networkupstools/nut/releases/tag/v2.8.5), `nut-2.8.5.tar.gz`.
- Archive SHA-256: `18bf32e59eb764b13da3c4fa70384926d7fa584cb31d2fe7f137a570633eeec1`, verified against the release asset digest.
- Native arm64 build uses the installed libusb **1.0.28**. Matching Debian development headers were downloaded and extracted into the private build directory. No system package or runtime dependency was installed or upgraded.
- Build/evidence directory: `/root/nut-2.8.5-test-20261015`. Configure and build logs, HID test output, source archive, and before/after evidence remain there.
- Test binary: `/opt/nut-2.8.5/usbhid-ups`, SHA-256 `d85e7ede4257c1eb807d6840b1eb98a0e60ee6a65abdccbd0118a730db493007`.
- The optional systemd drop-in `/etc/systemd/system/nut-driver@ups.service.d/zz-nut-285-test.conf` selects this binary inside the driver service's mount namespace:

```ini
[Service]
BindReadOnlyPaths=/opt/nut-2.8.5/usbhid-ups:/usr/lib/nut/usbhid-ups
```

The packaged binary on the host remains intact. Existing controller commands, daemon startup, shutdown, restart, and automatic selection remain in use. Other driver binaries are not replaced. This override persists across service restarts and boot until removed. Normal project deployment does not install this optional experiment.

## Validation

- Native driver build succeeded. Upstream `getvaluetest` and `getexponenttest-belkin-hid` both passed.
- A transient systemd namespace check reported 2.8.5 through the packaged path; the same path outside that namespace still reported 2.8.1.
- The running driver executable hash matched the isolated 2.8.5 binary. The host packaged binary and `/etc/nut/ups.conf` hashes remained unchanged.
- Autodetector, NUT server, and SNMP process IDs remained unchanged during activation. The driver restarted as planned and its PID was stable during the readiness check.
- NUT reported `OL`, 100% battery charge, 4% load, and 232 V input. The active driver exposed the expected two-second interval, thirty-second full sensor interval, and `pollonly` flag.
- SNMP returned charge 100 and output source 3 (normal). PeaNUT's HTTP endpoint returned its normal redirect; its visible browser state was not checked in this deployment.
- The new collector's first sample had no errors or events. USB trace capture was active, growing, and reported `text_lost 0`.

The upstream test selection covers HID parsing helpers, not the complete recovery path. No full NUT test suite, rollback execution, reboot, deliberate USB failure, or battery outage was tested.

## Observation and evidence

The pre-test collector was stopped before restarting the driver. Its complete directory and a compressed copy were preserved under `/root/nut-2.8.5-test-20261015/activation/`. Previous ten-second and restored two-second 2.8.1 phases remain identifiable in that evidence.

The new seven-day capture began at **15 October 08:35:34** and ends at **22 October 08:35:34 Asia/Jerusalem**. This replaces the previous active observation deadline; the earlier evidence was retained. Metadata is in `/var/log/ups-stability/test.json` and `/var/log/ups-stability/experiment.json`.

The same bounded health/USB capture and first-failure freeze policy remain active. No Codex automation or automatic notification was added. Successful minute samples do not exclude brief recovered USB errors between samples. Long-duration stability and recovery from the original lockup remain unverified.

## Rollback reference

Rollback is available because the packaged 2.8.1 binary was not overwritten. During rollback, pause the collector, preserve its current directory, stop `nut-driver@ups`, remove only `zz-nut-285-test.conf`, reload systemd, and start the driver again. Verify `driver.version: 2.8.1`, healthy readings, and stable process IDs before resuming capture with an explicitly labelled rollback phase. Keep the two versions' observations separate.

The readiness check during deployment included a fallback that would remove the test override and restore the packaged driver if 2.8.5 failed startup validation. That fallback was not exercised because validation passed. Retain `/opt/nut-2.8.5/usbhid-ups` while the override is installed.
