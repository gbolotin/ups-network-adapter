# Samsung Galaxy Tab A7 Home Console

The tablet displays the existing Home Console. NUT, USB UPS drivers and the
local UPS fallback remain on the Raspberry Pi. Android root is not required.

## Installation

- Hardware verified over USB ADB: Samsung SM-T500, Android 12.
- Fully Kiosk Browser 1.61.4 installed from the vendor's APK download.
- Installer SHA-256: `42df2da1ef35074611159e1b07c7d16a442ba72079b652d1dd7d5168aa43dec7`.
- Home Assistant account: `samsung-a7`, local-only, ordinary user, not administrator.
- Android's photo Daydream was disabled to prevent a second screensaver.
- Dashie remains installed. Start on Boot was already off; Auto Reload on Forced
  Close was disabled. Its background process was stopped because it occupied
  the same remote administration port as Fully.
- Android drawer shows photo interval and theme, without Pi power or night controls.
- Start URL: `http://192.168.50.117/home-console/home?kiosk&device=tablet`.
- Local Fully Remote Admin: `http://192.168.50.245:2323`; password is in the
  private `fully-admin.json`. Cloud access and remote camera snapshots are off.
- Launch on Boot and Keep Screen On enabled; automatic orientation; brightness 160/255.
- Fully's own screensaver is off. Home Console supplies the two-minute overlay.
- Night sleep schedule removed at the owner's request. Keep Screen On is enabled,
  the screen-off timer is 0, and the photo overlay can remain visible all night.
  Tablet timezone: Asia/Jerusalem.
- Camera motion wake enabled; acoustic motion disabled. Real camera motion wake
  passed with the owner waving: screen off at 0.42 s, on at 3.19 s, without an
  explicit screen-on command.
- Wi-Fi reconnect reload and retry after page load failure enabled. Browser
  debugging remains disabled; diagnostics use Fully's ordinary JavaScript API.
- Home Assistant integration: Samsung Galaxy Tab A7, entity prefix `samsung_a7`.
  Camera snapshots and the root-only device restart entity are disabled.

Private credentials and installation evidence are outside the repository in
`C:\Users\gbolo\.ha_token\samsung-a7-20261030`. Never commit these files or raw
settings exports. They include the Fully password and the tablet's HA login.

The owner approved Fully's device administrator permission for screen control,
brightness changes, overlay access, battery optimization exemption and camera
access for motion wake. Microphone and location access are not part of this setup.
The administrator role is Android's screen-control permission, not Android root
or an Android Enterprise device-owner provisioning operation.

## Acceptance

Verified on the actual tablet: Home/UPS/TV/Receiver render without card errors;
ordinary HA login; Android-specific drawer; automatic photo overlay with clock
and weather; touch dismissal; UI-only simulated lock notification and persistent
128px top-right indicator; real camera motion wake; HA screen/brightness/battery
entities. The lock was not physically operated. Focused Node tests: 25 passed.

The owner purchased Fully PLUS on 2026-10-30. The tablet subsequently reported
`isLicensed=true`; the UI no longer displayed the PLUS trial watermarks. Payment
was performed by the owner. Local activation evidence is `license-activated.json`
in the private installation directory.

A real tablet reboot passed on 2026-10-30 with the original PIN lock: after its first unlock,
Fully was running without an operator app-launch command and retained the local
HA login. USB required a cable reconnect and authorization; the owner confirmed
Always allow for this computer. The panel was returned to the foreground after
the owner used Android Settings.

Real Wi-Fi recovery also passed: Wi-Fi was disabled on the tablet for three
seconds and re-enabled over USB. Fully and the HA WebSocket recovered automatically
within 16.4 seconds of re-enabling Wi-Fi. The owner subsequently disabled the night sleep schedule; no automatic nightly
screen-off is configured.

Keep Fully's own screensaver disabled: the Home Console web page provides photos,
weather, music metadata and lock indicators. Screen power and brightness belong
to Fully and Android. The tablet must not call the Pi's screen or power services.

## Rollback

Restore the previous launcher and original Android screen settings from the
private installation record. Re-enable Android's photo screensaver if desired.
Dashie can be opened manually; restore its automatic-reload setting only if
returning it to service. Do not run both apps' remote servers on port 2323.
Deactivate Fully's Android device administrator before uninstalling Fully.
Preserve existing HA users and sessions; revoke only the tablet's own session
and account if removing this installation.

## Screen lock removed

At the owner's explicit request, Android Screen lock type was changed from PIN to
None on 2026-10-30. The settings page confirmed None, Android `locksettings
get-disabled` returned true, and Android TrustManager reported `deviceLocked=0`
after a screen-off/on cycle. Home Console was visible without entering a PIN.
Fully still reported its keyguard flags as true; those flags did not match the
Android lock-disabled state and are not used as proof of credential protection.
A further full reboot was not performed for this change.

## Automatic orientation

On 2026-10-30, Fully forced landscape (`forceScreenOrientation=2`). This was changed over Wi-Fi to automatic (`0`) and read back successfully. Physical rotation was not verified; Android system rotation was not inspected because ADB was disconnected.

## Camera motion and the Home Console overlay

Camera motion now calls the custom Home Console screensaver through Fully's `onMotion` JavaScript event. It dismisses the overlay and restarts the two-minute idle period. Fully's native screensaver remains disabled. The JavaScript interface is enabled with a URL whitelist limited to `http://192.168.50.117/*`; keep browsing restricted to this trusted HA host.

Live verification at orientation 270 (camera below) showed a visible photo overlay followed by a fresh camera event and a hidden overlay. The owner confirmed waving at the lower camera. Motion detection remains enabled with sensitivity 90, without face recognition, microphone detection, camera snapshots or webcam access. Private prior interface/whitelist settings are in `motion-photo-bridge-before.json` outside Git.

After reports of false photo-overlay wake-ups, motion sensitivity was reduced from 90 to 80 and read back successfully. The detector remained running, without enabling face-only detection. Long-term false-trigger frequency has not yet been validated; room lighting and screen reflections remain possible causes.

The custom overlay now ignores camera events for two seconds after opening or changing photo/artwork. Outside that window, dismissal requires two events 0.6-2.5 seconds apart; isolated events do not reset the idle timer. Camera sensitivity remains 80. Unit tests cover display-change suppression, isolated events and confirmed motion; physical false-trigger validation is separate.
