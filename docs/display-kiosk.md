# Physical UPS dashboard

The Pi at `192.168.50.200` uses a SpotPear 5inch DSI LCD (C), 1024×600.
Chromium runs PeaNUT's `/device/ups` page full-screen inside Cage. The dedicated
`upsdisplay` account has no sudo access. Its private browser profile is at
`/var/lib/ups-kiosk/chromium`.

The installed files are maintained in `display/`:

- `ups-kiosk-browser` → `/usr/local/bin/ups-kiosk-browser`
- `ups-kiosk.service` → `/etc/systemd/system/ups-kiosk.service`
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
session uses the dedicated cursor path. Physical disappearance of the arrow
still requires confirmation on the screen; a browser screenshot does not
capture the compositor's pointer.

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

`ups-kiosk.service` starts at boot, takes tty1, and waits for PeaNUT before opening
the browser. Chromium retains its sandbox. The browser profile's PeaNUT refresh
interval is set to five seconds. Touch scrolling exposes the charts and full
UPS variable table below the status and gauges.

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
sudo journalctl -u ups-kiosk.service -u ups-kiosk-login.service -n 50
sudo systemctl restart ups-kiosk.service
```

To restore the text login screen:

```bash
sudo systemctl disable --now ups-kiosk-login.timer ups-kiosk.service
sudo systemctl enable --now getty@tty1.service
sudo chvt 1
```

This leaves the display driver and saved browser profile available.

## Checks

The dependency-free login check can run wherever Node is installed:

```bash
node display/test-kiosk-login.mjs
```

It covers successful login submission, credential escaping, origin and path
restrictions, missing credentials, and the browser's startup and signed-in
states. Live validation also checks the 1024×600 browser viewport, displayed
NUT readings, automatic refresh, login recovery, and service startup after a
Pi reboot. Physical touch response requires confirmation at the screen.

Verified on 2026-10-16: full-screen viewport 1024×600, five-second refresh,
APC Back-UPS BX750MI status Online, charge 100%, and load matching NUT when
sampled together. Clearing the kiosk cookies recovered the login automatically.
After a Pi reboot, the dashboard, NUT driver/server, and UPS SNMP service were
active; the kiosk service had zero automatic restarts. The automation port was
bound only to loopback. A screenshot is saved locally at
`output/playwright/ups-kiosk-preview.png`.
