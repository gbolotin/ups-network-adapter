# NUT source investigation: 15 October 2026

## Conclusion

The Pi's NUT version contains confirmed software defects that affect USB error reporting and recovery, including a bug specifically documented for `pollonly` with libusb 1.x. These defects do not prove that NUT initiates the USB lockup, but they establish that the UPS alone cannot be assumed responsible for the observed recovery behavior.

An isolated C reproduction confirmed the missing error propagation and the incorrect permission-warning predicate. A controlled test with released NUT 2.8.5 is justified. No NUT upgrade, source patch, service restart, USB probe/reset, or change to the active stability observation was performed during this investigation.

## Sources and installed baseline

- Official clone: `C:\Users\gbolo\.cache\ups-diagnostics\nut-upstream`. Full history is available; its working tree remains clean.
- Investigated upstream HEAD: `44294b5899cfe5b8142cef6f8b174681b5992d1c`.
- NUT 2.8.1 tag: `4ba352d8f82e4c51032d4166d4cc3276b31fb3a5`.
- Released NUT 2.8.5 tag: `0e051f9f6853e9ae0087b388b70840c9651a5eed`. Upstream's latest-release URL resolved to this release during investigation.
- Pi: Debian `nut-server` and `nut-client` 2.8.1-5, libusb 1.0.28-1. The driver uses `pollonly`, with a ten-second polling interval.
- Installed `/usr/lib/nut/usbhid-ups` matches the Debian package manifest: MD5 `ecd343242d937ee55071aaf1b4e84a68`.
- Debian's original source and packaging archives were downloaded from its official pool and matched the SHA-256 entries in `nut_2.8.1-5.dsc`. Five relevant original files match upstream v2.8.1 byte-for-byte: `libhid.c`, `libusb1.c`, `usbhid-ups.c`, `apc-hid.c`, and `tools/nut-scanner/scan_usb.c`.
- None of Debian's seven active patches changes those files. Its scanner SONAME patch changes library loading in `nutscan-init.c`, not USB request or recovery behavior.

## 1. Confirmed: libusb errors can be lost or misclassified

In 2.8.1, `refresh_report_buffer()` returns failure without assigning the transport error to `errno`. `HIDGetDataValue()` subsequently returns `-errno`. libusb 1.x returns its own error codes and does not establish this `errno` contract.

For example, a device-removal result of `-4` can become zero when `errno` is clear, or an unrelated error when `errno` contains an old value. The polling loop can then ignore the failure or take the wrong recovery branch. A normalized timeout result of zero can also become a false permanent error when stale `errno` is nonzero.

Upstream [commit e85bd0416](https://github.com/networkupstools/nut/commit/e85bd04162968139cd5b9d13a3497225deafa9fa) adds `errno = -ret` before returning. Its commit explanation specifically identifies missed disconnects and reconnects in poll-only drivers. The fix is present from **2.8.2** onward and is absent from the installed Debian baseline.

Local source references: original `drivers/libhid.c:231`, `drivers/libhid.c:513`, and `drivers/usbhid-ups.c:1668` under the extracted `upstream-2.8.1-source/nut-2.8.1` directory.

This is a confirmed defect in the installed version and is directly applicable to its transport configuration. Its contribution to the 14 October initiating lockup remains an inference, not a demonstrated reproduction of that lockup.

## 2. Confirmed: the permission warning is incorrect

The old open-failure condition is effectively:

```c
count_open_errors > 0 || count_open_errors == count_open_EACCESS
```

It is true even when both counters are zero. It is also true for non-permission open errors. Thus `insufficient permissions on everything` does not establish an access problem.

[Commit 6d66de9b6](https://github.com/networkupstools/nut/commit/6d66de9b6eecd3b67d303bf25a566030b647baf8) changes the OR to AND. The corrected condition requires at least one error and requires all counted errors to be access errors. The fix is in **2.8.3** and later.

This explains the misleading warning observed while separate root descriptor inspection also failed. It fixes diagnosis, not the nonresponsive USB endpoint itself. Original reference: `drivers/libusb1.c:728`.

## 3. Relevant: newer code detects a completely unsuccessful polling cycle

The old polling walk can continue past per-item zero/temporary-failure results and finish successfully without a successful-read counter. `upsdrv_updateinfo()` then reaches `dstate_dataok()`. The actual path also depends on the error-propagation issue above and on whether the report cache supplies data.

[Commit badbed7ba](https://github.com/networkupstools/nut/commit/badbed7babfba5d3dc8ff76e3b8be153bbd6bfc9), included in **2.8.5**, changes handling of transient I/O errors and introduces successful-poll accounting. The released source checks that mapped items were polled, but none succeeded, before requesting a reconnect. This applies to control polling as well as interrupt operation.

This is another reason that a successful `upsc` query alone cannot prove every USB polling operation succeeded. Our USB trace is necessary independent evidence. The source comparison establishes a recovery improvement; it does not establish that 2.8.5 can recover an endpoint that no longer answers independent root descriptor requests.

## 4. Trace analysis: intermittent failures remain after the scanner change

The decoder paired control submissions with completions by URB tag and USB address. It used UTC wall-clock prefixes to avoid the USB monitor counter's wraparound. Raw negative statuses below are kernel completion statuses, not libusb return codes.

| Observation window | Earlier, 10 October | After scanner change, 14–15 October |
| --- | ---: | ---: |
| Captured duration | 4.34 hours | 9.84 hours |
| HID GET_REPORT submissions | 13,019 | 29,357 |
| Successful HID completions | 13,006 | 29,337 |
| Cancelled HID completions, about five seconds each | 11 | 17 |
| HID pipe-stall completions | 2 | 3 |
| String descriptor submissions, all indexes | 10,195 | 1,945 |
| Cancelled string completions, about one second each | 21 | 2 |

These are different observation windows and firmware/recovery states. The counts do not establish a controlled causal rate comparison.

The times match the implementation: NUT's `USB_TIMEOUT` is 5,000 ms; libusb 1.0.28's string-descriptor helper uses 1,000 ms. A cancellation status of `-2` means the request was cancelled; pairing it with the elapsed time supports a timeout interpretation, but the status alone is not a root cause.

The newer window contains 20 failed HID reads and 20 vendor/product/serial read bursts. Every burst followed a failed read within 15 seconds. The read order matches the driver's open path; the scanner uses the reverse serial/product/vendor order. This strongly supports **internal NUT reconnects without process restarts**. USB monitor records do not identify the requesting PID, so attribution remains an inference from order, timing, source, and stable topology.

No interrupt transfers were present in the analyzed newer capture. Independent root inspection during the failed state captured three unanswered HID report descriptor requests. Two lasted about five seconds; the last was cancelled when inspection ended. NUT was not the only program unable to obtain a descriptor in that state.

## 5. Fixes that should not be applied blindly

- **Zero interrupt-event reconnect option:** [PR 2671](https://github.com/networkupstools/nut/pull/2671) and its follow-up add `interrupt_pipe_no_events_tolerance`. The released source executes that logic only when interrupt transfers are enabled. Our `pollonly` setting disables that branch; adding the option alone cannot address this run's failure. It is also unsupported by 2.8.1.
- **APC max-report tweak:** the old automatic model list contains Back-UPS ES 525 and Back-UPS CS, not BX750MI. A NULL product warning is a consequence of a missing string, not evidence that this flag is the right fix.
- **Development libusb-context teardown fix:** master has changes for libusb shutdown deadlocks, originally reproduced with other USB bridges. The observed driver continued emitting retry logs, and independent descriptor reads failed too. A teardown deadlock alone does not explain those observations. Development HEAD should not be treated as equivalent to released 2.8.5.
- **APC low-battery filtering:** newer code has BX-family status workarounds. False status propagation and a nonresponsive USB endpoint are distinct problems; filtering alarms would not restore USB descriptors.

## Reproduction and validation

The isolated C program contains the exact original `refresh_report_buffer()` function, a second copy with the upstream one-line error fix, and the original/corrected permission predicate. USB transport and logging are stubs. It does not open a USB device or execute the full NUT driver.

On the Pi, `cc -std=c99 -Wall -Wextra -Werror` compiled it successfully. Nine combinations of transport results and initial `errno` values demonstrated the old misclassification and the corrected propagation. Three permission-predicate assertions passed. Example output:

```text
get_report=-4 initial_errno=0 old_observed=0 fixed_observed=-4
get_report=0 initial_errno=1 old_observed=-1 fixed_observed=0
```

Private evidence:

- Local clone, official Debian source, checksum verifier, reproduction generator, C source, raw trace copies, and JSON analysis: `C:\Users\gbolo\.cache\ups-diagnostics\`.
- On Pi: `/root/ups-recurrence-20261014-2214/nut-error-repro.c`, its compiled test program, and `nut-error-repro-results.txt`.
- New raw trace snapshot: `/root/ups-recurrence-20261014-2214/source-investigation-trace/`, captured 15 October at 08:11:34 Asia/Jerusalem.

The installed NUT driver and active observation were left unchanged. The UPS still returned online readings at the final verification.

## Next discriminating test

Use released NUT **2.8.5** for a controlled comparison with the same USB connection, single `ups` endpoint, `pollonly`, ten-second polling interval, and bounded trace. Preserve the present baseline and use a reversible package or isolated installation. Do not add an automatic reset loop or change several USB parameters at once.

That experiment is justified by applicable missing fixes, but it has not been built or deployed here. Recovery behavior and long-duration stability must be checked on the real APC. Cable, controller, and UPS firmware causes remain unresolved; the new source findings do not isolate the initial fault to one component.

Sources: [official NUT repository](https://github.com/networkupstools/nut), [Debian source descriptor](https://deb.debian.org/debian/pool/main/n/nut/nut_2.8.1-5.dsc), [released 2.8.5](https://github.com/networkupstools/nut/releases/tag/v2.8.5), [libusb 1.0.28 string helper](https://github.com/libusb/libusb/blob/v1.0.28/libusb/libusb.h#L2191).

## Requested polling restoration, 15 October at 08:26 Asia/Jerusalem

The user requested the original USB polling interval. The detector now generates `pollinterval = 2` for this BX750MI, replacing ten seconds. `pollonly` remains enabled and `pollfreq` remains thirty seconds. Both runtime and Pi project copies were updated. No NUT upgrade was performed. The ten-second comparison proposed above must therefore be treated as a separate historical baseline; a future upgrade comparison should hold the then-current interval constant.

The existing observation was paused during the planned driver restart and resumed after two-second readings and stable process IDs were verified. Its original deadline remains 21 October at 22:20:53 Asia/Jerusalem. Compare the ten-second and two-second phases separately; this does not constitute seven days at two seconds.

Backups, the pre-change capture, and before/after readings are retained in `/root/ups-poll-interval-20261015`. The transition is recorded in `/var/log/ups-stability/poll-interval-change-20261015.json` at `2026-10-15T05:26:22.378062+00:00`.

The detector regression check passed locally and on the Pi. Live NUT reported `OL`, 100% charge, 4% load, `pollinterval: 2`, `pollonly: enabled`, and `pollfreq: 30`. SNMP returned charge 100 and normal output source 3. All adapter and observation services were active. Long-duration stability under the restored interval remains unverified.

## Approved driver comparison, 15 October at 08:35 Asia/Jerusalem

The user subsequently approved the controlled test. The USB driver alone was built and activated at 2.8.5, with the server/client held at 2.8.1 and two-second polling retained. A fresh seven-day observation now ends on 22 October at 08:35; the preceding capture was archived. See [deployment, verification, evidence, and rollback details](nut-2.8.5-controlled-test-2026-10-15.md).
