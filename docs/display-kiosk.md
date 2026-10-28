# Physical UPS dashboard

The Pi at `192.168.50.200` uses a SpotPear 5inch DSI LCD (C), 1024×600.
Chromium runs Home Assistant's `/home-console/ups?kiosk` full-screen inside Cage,
with local PeaNUT as its automatic fallback. The dedicated
`upsdisplay` account has no sudo access. Its private browser profile is at
`/var/lib/ups-kiosk/chromium`.

The installed files are maintained in `display/`:

- `ups-kiosk-browser` → `/usr/local/bin/ups-kiosk-browser`
- `ups-kiosk.service` → `/etc/systemd/system/ups-kiosk.service`
- `kiosk_supervisor.py`, `kiosk_cdp.py`, `kiosk_policy.py`, and `kiosk_screen.py` → `/usr/local/lib/ups-network-adapter/`
- `offline.html` → `/usr/local/share/ups-kiosk/offline.html`
- `ups-kiosk-screen.service` → `/etc/systemd/system/ups-kiosk-screen.service`
- `ups-kiosk-login.mjs` → `/usr/local/lib/ups-network-adapter/ups-kiosk-login.mjs`
- `ups-kiosk-login.service` and `.timer` → `/etc/systemd/system/`
- `readability/` → `/usr/local/share/ups-kiosk/readability/`

Chromium loads the local `readability` extension to enlarge only the Voltage and
UPS Data cards. Their headings use 22px text; chart labels use 18px; table text
uses 20px. The extension contains only CSS and applies to the loopback PeaNUT
page in the kiosk browser. It requires no additional packages and does not
change PeaNUT's container or other browsers. The styling survives page refreshes
and kiosk restarts.

The kiosk also uses a transparent cursor theme at
`/usr/local/share/ups-kiosk/icons/default`. Generate it with
`sudo python3 display/install-hidden-cursor.py` before installing the kiosk
service. The service's `XCURSOR_PATH` applies it to Cage and Chromium, including
the session's default pointer. The stylesheet also hides browser cursors.
Browser CSS alone did not hide the arrow visible on the physical display.
Touch controls remain available.

The native wlroots cursor loader verified that the default arrow and all
installed cursor aliases resolve to fully transparent images. The running Cage
session uses the dedicated cursor path. On October 28, the user confirmed that
no pointer is visible during physical taps/swipes. This physical feedback is
separate from browser screenshots, which do not capture the compositor's pointer.

The 2026-10-16 readability check verified these computed font sizes on the
running 1024×600 display after a kiosk restart and page reload. Both cards fit
without horizontal page scrolling; the main gauge text remains 48px. Screenshots
are saved locally as `output/playwright/kiosk-voltage.png` and
`output/playwright/kiosk-ups-data.png`.

The existing boot configuration includes:

```ini
dtoverlay=vc4-kms-v3d
dtoverlay=vc4-kms-dsi-waveshare-panel,7_0_inchC
```

The panel parameter is `7_0_inchC`, as specified by the manufacturer for this
5-inch model. The configuration backup is
`/boot/firmware/config.txt.before-spotpear-20261016-055054`.

## Startup and login

`ups-kiosk.service` starts at boot and takes tty1. Its Python supervisor opens a
visible offline page immediately, then selects authenticated HA or local PeaNUT.
It checks the actual HA connection and rendered view, not only HTTP 200. A bounded
Chromium active-page probe permits HA's deferred rendering before switching tabs.
It keeps healthy views and text entry intact. Browser failures use capped retries;
owned browser processes are stopped and reaped on service shutdown.

The HA target is `http://192.168.50.117/home-console/ups?kiosk`. Local fallback is
`http://127.0.0.1:8080/device/ups`. If both displays fail, the local offline page
states that no live UPS reading is available. Docker is not a main kiosk dependency.
NUT services are independent of the browser, display policy, HA, and PeaNUT.

Chromium retains its sandbox, existing private profile, hidden cursor, and
`--overscroll-history-navigation=0`. HA uses the non-admin, local-only `pi-kiosk`
account through normal sign-in. Its authentication survived kiosk restart testing.
No HA password or token is placed in launcher arguments. PeaNUT's existing
five-second refresh and scoped login recovery remain available during fallback.

`ups-kiosk-screen.service` uses the verified Goodix event device and DSI backlight.
During 07:00–23:00 it keeps the backlight on. During 23:00–07:00 it turns the
backlight off, grabs only the sleeping/wake contact, and consumes the complete
first touch before returning normal input to Cage. Each touch refreshes a two-minute inactivity timer. A held contact keeps the
screen lit; its release starts a full 120-second idle interval. The first wake
contact is still consumed.
Stopping this service releases its grab and restores the backlight. It uses no
virtual input device or additional package. Physical first-touch acceptance is
recorded separately in the implementation record. On October 28, the user confirmed
that the battery dialog appeared only on the second touch after waking. Three real
night wake intervals returned to darkness after exactly 120 seconds under the
original fixed-window policy. The user subsequently requested the inactivity
policy described above; its new timing passed regression tests. Physical
keyboard/swipe and hidden-cursor acceptance were subsequently confirmed by the
user. The real queue also stayed playing through Pi browser swipes to UPS at
verified zero volume, with its original state restored afterward.

The October 28 acceptance included two normal Pi reboots, an HA-blocked cold boot,
live local/offline/HA recovery, browser crash/hang recovery, and a full original
kiosk/profile rollback followed by restoration of Home Console. The blocked cold
boot displayed authenticated local UPS in 20.25 seconds, then returned to HA in
27.09 seconds after unblock. The final 48-hour observation runs until October 30
00:25 Israel time. See the implementation record for measured results and open
physical checks; a short successful test does not establish long-term stability.

Every 30 seconds, the login helper checks whether the kiosk displays PeaNUT's
login page. If needed, it submits the existing credentials from the PeaNUT
container environment. Credentials are not copied to scripts or command-line
arguments. The helper uses PeaNUT's existing Node runtime; no Node installation
is needed on the host.

Chromium's automation endpoint listens only on `127.0.0.1:9222`. Do not expose
this port to the LAN: it grants control of the signed-in kiosk browser. Physical
screen users can also access the signed-in PeaNUT interface. NUT control commands
still require the separately configured NUT permissions.

If the PeaNUT password changes, update the container's credentials through its
normal configuration before relying on automatic login. The existing helper
uses the `WEB_USERNAME` and `WEB_PASSWORD` values in the running container.

## Operator commands (Pi SSH shell)

```bash
sudo systemctl status ups-kiosk.service ups-kiosk-login.timer
sudo systemctl status ups-kiosk-screen.service
sudo journalctl -u ups-kiosk.service -u ups-kiosk-login.service -n 50
sudo journalctl -t ups-kiosk-supervisor -n 30
sudo journalctl -u ups-kiosk-screen.service -n 30
sudo systemctl restart ups-kiosk.service
```

To restore the text login screen:

```bash
sudo systemctl disable --now ups-kiosk-screen.service ups-kiosk-login.timer ups-kiosk.service
sudo systemctl enable --now getty@tty1.service
sudo chvt 1
```

This leaves the display driver and saved browser profile available.

## Checks

The dependency-free login check can run wherever Node is installed:

```bash
node display/test-kiosk-login.mjs
python -m unittest display.test_kiosk_policy home_console.test_capture_pi
```

It covers successful login submission, credential escaping, origin and path
restrictions, missing credentials, and the browser's startup and signed-in
states. Live validation also checks the 1024×600 browser viewport, displayed
NUT readings, automatic refresh, login recovery, and service startup after a
Pi reboot. The user subsequently confirmed physical touch, six-view swipes,
EN/RU keyboard search, hidden cursor, and night wake on October 28.

Earlier PeaNUT validation on 2026-10-16: full-screen viewport 1024×600, five-second refresh,
APC Back-UPS BX750MI status Online, charge 100%, and load matching NUT when
sampled together. Clearing the kiosk cookies recovered the login automatically.
After a Pi reboot, the dashboard, NUT driver/server, and UPS SNMP service were
active; the kiosk service had zero automatic restarts. The automation port was
bound only to loopback. A screenshot is saved locally at
`output/playwright/ups-kiosk-preview.png`.

The October 27 Home Console deployment uses only the existing Python runtime and
platform APIs. Its opt-in real-Chromium tests run in temporary profiles with
simulated services; they do not replace live acceptance. See the synchronized
[implementation plan](Home_Console_RaspberryPi_Plan/Home_Console_Raspberry_Pi_Plan_EN.md),
[implementation evidence](Home_Console_RaspberryPi_Plan/IMPLEMENTATION_STATUS.md), and
[operator tools](../home_console/README.md) for the approved dependencies, deployment,
private profile backups, restore procedure, and remaining physical/observation work.

The launcher now requires the four Python modules above. Do not copy the launcher
alone. `home_console/deploy_pi.py` verifies the staged asset list, a fresh root-only
rollback snapshot, and a stopped-browser profile archive before changing the kiosk.
It does not install a desktop environment or modify the NUT configuration.
