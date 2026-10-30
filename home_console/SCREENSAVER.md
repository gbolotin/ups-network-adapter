# Pi photo frame

The first-party UI module shows a full-screen overlay after two minutes without
input, only on `/home-console/*?kiosk`. Normal desktop pages are unaffected.
Input dismisses the overlay and consumes the wake gesture to avoid pressing a
device control underneath it. It never starts playback or changes volume.

Photos come from the existing authenticated Home Assistant media mount:
`media-source://media_source/local/Media/PhotoFramePhotos`
(`\\Lenovo720\Media\PhotoFramePhotos`). Images change every 30 seconds by default;
the folder list refreshes every five minutes. Signed media URLs are resolved
through the current HA session. Photos are not copied to public `/local` storage.
On a temporary network failure, the last loaded image remains on screen.

The overlay reads the time from the Pi browser and current weather from
`weather.forecast_home`. It replaces the photo with artwork and track information
only when `media_player.denon_avc_x4700h_3` is `playing`, the native receiver is
available and on, and its source is `HEOS Music` or `NET`. Stopping or pausing
music returns to photos. TV Audio and old idle-track metadata do not trigger it.
Album artwork uses HA's `entity_picture_local` proxy first, retaining its query
parameters. A same-origin `entity_picture` is the fallback. External artwork
URLs are not loaded directly by the overlay. Verified with the current album
on both Samsung and Pi: the proxied JPEG loaded at 1000×1000 pixels.
In music mode only, the artwork can use almost the full screen height. Clock
and date overlay the top right; weather overlays the bottom right. Photo mode
keeps the clock at the top left. When the lock is open, the music clock shifts
left to leave room for the existing top-right lock indicator. Geometry was
verified with explicitly illustrative artwork on Pi and Samsung; the track
playing during that layout check supplied no artwork metadata.

While the overlay is active, a completed change of `lock.lock_ultra_17` to
`locked` or `unlocked` shows a large lock icon and Russian status for five seconds.
The current HA state is checked once per second. A newer change restarts the timer.
Initial state and recovery from unavailable state do not generate notifications.
Transitional locking/unlocking states do not generate notifications. Touch dismisses
the overlay normally. This display does not operate the lock or wake the backlight.
`check_pi_lock_notice.py` checks simulated UI events on the Pi without lock commands;
physical lock event delivery remains a separate acceptance check.
While HA reports `unlocked`, a persistent 128px orange open-lock icon appears at
the top right. It remains after the five-second notification ends.
Other states, including unavailable state, hide the icon.

When `sensor.lock_ultra_17_battery` reports 0–20%, the idle overlay shows a large
battery alert icon, **Заменить батарею в замке** and the remaining percentage
instead of photos or artwork. Touch returns to the dashboard normally. A good
battery reading restores the ordinary screensaver; missing, unavailable and
invalid readings do not generate a low-battery alert. Five-second lock events
temporarily appear above the warning, and the persistent open-lock indicator
remains visible. This display does not wake a powered-off screen.

Deployment uses `deploy_ui.mjs`; the private deployment journal retains the
previous module resource for rollback. Local UPS fallback is outside this scope.

## Pi control drawer

Swipe down from the top edge (the centre handle is the touch target), or tap the
handle, on a console kiosk page. The drawer also works over the photo frame.
It pauses the idle timer while open. Select 5, 10, 15, 30, 60, 120 or 300 seconds
between photos. The setting persists in this browser's local storage.

The **Ночное гашение экрана** switch controls the Pi's physical backlight policy.
Enabled (the default): between 23:00 and 07:00, the screen turns off after 120
seconds without physical touch. Disabled: the backlight stays on, including at
night. Photos/music still use their normal idle overlay. Re-enabling grants a
fresh 120-second interval before darkness. The complete wake contact remains
consumed until release.

The drawer reads the confirmed Pi setting each time it opens. Changes are saved
atomically in `/var/lib/ups-kiosk-control/screen.json`, independent of browser or
HA restarts. The existing authenticated HA-to-Pi endpoint serves `/screen`;
HA uses `home_console_pi_screen` and `home_console_pi_set_screen`. No token is
sent to browser assets. The screen service reads the setting without restarting.
`deploy_night_screen.mjs` upgrades existing installations, preserves private
before-records, validates HA configuration and reloads REST commands without an
HA reboot. Pi source backups are under
`/var/backups/home-console/night-screen-20261030`; HA's previous REST command
file is in private `night-screen-ha-before.json`. UI rollback uses the previous
resource in `ui-night-screen-toggle.json`.

The **Тема** selector chooses **Светлая** or **Тёмная** through HA's native
`settheme` event on the root application. HA stores the preference for the kiosk
user and applies it to all native cards and the drawer. Existing compatible
custom themes and palette settings are preserved. A custom theme without the
requested mode falls back to HA's default theme. The selector reflects the
effective mode whenever the drawer opens. No HA or Pi service change is needed.

Restart and shutdown each require an explicit second confirmation. Shutdown
stops UPS monitoring and requires physical access to power the Pi on again.
The controls target the Raspberry Pi, never the Home Assistant host.

`deploy_pi_controls.mjs` installs the standard-library-only
`ups-kiosk-control.service` and adds two HA REST commands. The endpoint accepts
only the HA host IP and a dedicated bearer token, and allows only two fixed
systemctl commands. Secrets remain in private installation files, outside the
dashboard and browser assets. The read-only health command checks connectivity
without sending a power command.

The private `pi-control-install.json` journal and configuration backups are in
the deployment directory. For rollback, restore `configuration.yaml` from its
recorded backup, validate HA configuration, and restart HA. Disable the Pi
endpoint with `sudo systemctl disable --now ups-kiosk-control.service`.
Restore the previous UI resource from the UI deployment journal if needed.

## Validation on 2026-10-29

- HA could browse 74 images from the existing mount and resolve signed media URLs.
- Browser verification passed the real two-minute idle delay, image loading and
  automatic image change, HA weather, 1024x600 layout, and input dismissal.
- Mode transitions, stale idle metadata, TV Audio exclusion and wake-input
  consumption passed automated tests. Live Denon playback was not started.
- The Pi kiosk was restarted to load the deployed module; kiosk and NUT services
  both reported active. Physical touchscreen interaction remains unverified.
- Drawer verification passed browser swipe, both confirmation/cancel flows,
  interval persistence after reload, and the 1024x600 layout. Fifteen relevant
  Node tests and two Python endpoint tests passed. HA-to-Pi health checks passed
  as both the operator and ordinary kiosk user. Live restart/shutdown commands
  were deliberately not sent; physical touchscreen swipe remains unverified.

## Night switch validation on 2026-10-30

Seven Node and fifteen Python tests passed, including authenticated boolean-only
settings, persistent storage, nighttime disable/re-enable, and held wake contact.
The actual ordinary Pi kiosk session opened the drawer, changed both settings,
retained the disabled setting after a browser reload, then restored the original
enabled setting. Physical backlight brightness changed from 0 to 255 when night
blanking was disabled. Screenshot: `output/playwright/home-console-night-screen.png`.
Input was injected through Chromium; physical touchscreen interaction remains
unverified. No restart/shutdown command was sent to either machine.

Theme selector validation: eight relevant Node tests passed. The real Pi drawer
selected both modes; the native page background changed from `#fafafa` to `#111`.
Dark mode persisted after a page reload. Original theme preferences were restored
after the check. Screenshots: `output/playwright/home-console-drawer-light.png`
and `home-console-drawer-dark.png`. Physical finger interaction remains unverified.
UI resource: `/local/home-console/home-console-ui.ad2484a83a98.js`; previous
resource is recorded in private `ui-drawer-theme-mode.json` for rollback.

The top control drawer includes a Screensaver switch. It persists per browser/device in local storage. Disabling immediately dismisses the overlay and prevents idle activation; enabling starts a fresh two-minute idle period. This does not alter Android/Fully screen power settings or the Pi night-blanking setting.

While connected UPS status contains NUT `OB`, the console dismisses and blocks the screensaver and stays on UPS. It saves the previous console URL and idle state in session storage. Unknown/unavailable telemetry does not release the override. Explicit `OL` restores the previous view and idle state. The per-device screensaver preference remains unchanged. Reloading during an outage retains the return location. Validation uses isolated UI state simulations; it does not remove mains power from the real UPS.

On the Samsung Fully client, the native `onMotion` callback dismisses the custom overlay and resets idle time. It does not replace the UPS battery override. No camera images are requested by this integration.

The drawer now offers an idle timeout of 15/30 seconds or 1/2/5/10/15/30 minutes. It persists per device under `home-console-screensaver-delay-seconds`, defaults to two minutes, and restarts the idle period when changed. Photo change interval remains separate. UPS battery mode still takes priority over any timeout.
