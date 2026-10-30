# Home Console implementation tools

Operator tools for the approved [English](../docs/Home_Console_RaspberryPi_Plan/Home_Console_Raspberry_Pi_Plan_EN.md) and [Russian](../docs/Home_Console_RaspberryPi_Plan/Home_Console_Raspberry_Pi_Plan_RU.md) plans.

The Pi runs the six-view Home Console with full MA library/radio browsing, a selected-room queue companion, and an EN/RU touch keyboard. The three approved HACS versions and responsive household layouts are deployed. Physical input, live recovery, reboot, kiosk rollback, playback-swipe, and approved switch checks passed. TV/Denon wake/source and grouping are deferred by the user; observation continues. See the [measured record](../docs/Home_Console_RaspberryPi_Plan/IMPLEMENTATION_STATUS.md).

## Requirements

- Operator PC: existing Node.js 22+ with built-in `fetch` and `WebSocket`.
- Pi snapshot: existing Python 3.11+ and authorized root SSH/sudo.
- Existing HA administrator token in a protected file. Never put its contents in command arguments, Git, screenshots, or logs.
- Private output directory outside the checkout. On Windows, use a parent whose ACL permits only the user, Administrators, and SYSTEM. Unix creation modes do not establish Windows ACLs.

The operator tools and first-party UI use platform features without additional packages. The approved frontend dependencies are Kiosk Mode `v15.0.0`, zanna-37 Swipe Navigation `v1.16.1`, and MA Browser Card `v3.11.2`. They were exercised against HA `2026.10.4`, HACS `2.0.5`, and MA `2.10.8`.

## Tools and order

1. Run `capture_pi.py` on the Pi as root through SSH stdin. It creates `/var/backups/home-console/<UTC timestamp>/` with mode `0700`. `kiosk.tar` preserves file ownership/modes, helpers, readability, cursor assets, and protected PeaNUT credentials. `manifest.json` records hashes, process identities, service enablement, hardware, NUT, and private Docker metadata. No service is stopped. The live browser profile is **excluded**; capture it with the browser stopped before Phase 3.
2. Run `ha_snapshot.mjs` with `--token-file`, `--output`, and `--create-backup`. It privately records dashboard configs/metadata, resources, the current user's available frontend preferences, helpers, and entity registry. Generated/default configurations retain their explicit API result instead of becoming an empty dashboard. It requests a full HA backup and records the job ID. A successful request is **not** backup completion.
3. Confirm `backup/info` reports `idle` and the new backup exists on `hassio.local` with HA/database included and no failed additions. Keep its backup ID.
4. Run `apply_foundation.mjs` with `--token-file`, `--snapshot-dir`, and `--backup-id`. Its default is a read-only preflight. Add `--apply` to create the new configuration after reviewing the preview.
5. Run `prepare_kiosk_user.mjs` with those same three arguments. It creates only a new `pi-kiosk` account in `system-users`, with local-only access. A random password is saved in `pi-kiosk-credentials.json` in the protected snapshot directory. It refuses to change an existing account. The ordinary login check revokes its temporary session afterward; it does not inject a browser session or modify the Pi profile.
6. `install_hacs.mjs` accepts only the three approved versions and exact release-asset hashes. It checks the completed backup and saves its private journal before applying changes. The installed versions are recorded in the implementation record; this is not permission to update them later.
7. Before music deployment, prepare a dedicated non-admin MA identity with a filter containing exactly the four verified players. Keep its token and HA-to-MA player mapping in private `ma-kiosk.json`. Verify player access and denied administrator access. Never use the HA administrator token in a card.
8. `enable_music.mjs` applies the MA card configuration and dashboard-scoped navigation after the foundation. It preserves existing dashboard snapshots and disables swipes on the two existing manual dashboards. Its foundation-equality preflight intentionally refuses a rerun against the later queue-enhanced dashboard.
9. `deploy_queue.mjs` bootstraps the bounded queue companion and its private dashboard configuration. `deploy_ui.mjs --revision <unique-slug>` publishes subsequent content-addressed queue/keyboard modules and verifies their served hashes before updating the one Home Console resource. These are separate installation steps, not commands to rerun blindly.

These steps have already run on this installation. Private journals and the current live configuration are authoritative when resuming. A newly created `www` directory requires HA to register `/local` at startup. This installation needed one controlled HA restart, which has completed. Do not repeat it during routine UI deployment.

Example operator commands, using the recorded backup from October 27:

```powershell
node home_console/apply_foundation.mjs --token-file "$env:USERPROFILE\.ha_token\HA_token.txt" --snapshot-dir "$env:USERPROFILE\.ha_token\home-console-20261027T1825" --backup-id d591bb84
```

The foundation is already applied on this installation. Repeating `--apply` refuses to overwrite it. Read the private journal before handling an interrupted run.

## Configuration behavior

- Find runtime and voltage by the confirmed APC integration ID and NUT unique-ID suffix. Do not rename entities or select another UPS by a similar display name.
- Initialize each helper through the first option, with no persistent `initial` setting. This permits HA to restore subsequent room selections.
- Room selection only changes the Pi helper. Queue transfer requires a separate source selector and a confirmed button tap.
- Transfer rejects the same source/target, unavailable rooms, and sources without an active MA queue. External Spotify playback is not an MA queue. The user-approved Bedroom-to-Denon transfer and restoration passed.
- Both Pi helpers are hidden from automatically generated household dashboards using the entity registry's user-hidden flag. Explicit console cards continue to reference them.
- Denon and LG source scripts use fixed native entities, allowlisted sources, and a 30-second readiness wait. Invalid/unavailable devices do not trigger a source command. Physical standby/wake remains an acceptance test.
- The lock is a native tile with explicit more-info actions for tile/icon taps; hold/double-tap actions are disabled. The user requested the native popup on October 28; it includes HA lock controls, which were not operated during acceptance. Player status tiles on Players open the native media-player details (volume, mute, Join/grouping, source, browse) on tile/icon tap, as the user approved on October 28; hold/double-tap actions are disabled, so no single tap sends a player command. `players_details.mjs` applies this to the live dashboard (preflight by default; private journal `players-details.json`). Selected-room controls remain separate.
- Native volume sliders are hidden in off/unknown/unavailable states. Rendering or changing views does not call a device service.
- Scripts are saved through HA's supported configuration API, which reloads scripts. Preflight refuses active scripts. Never run deployment during another household script operation.
- `foundation-journal.json` records a pending entry before each mutation. An interrupted request can have succeeded remotely even if its journal entry remains pending. Inspect HA before retrying or reverting.

`dashboard.mjs` generates the deployed MA Browser Card configuration. Built-in conditionals choose one card for the Pi helper and suppress missing/unknown/unavailable selections. Each card allows one player, with `auto_follow: false`, `use_app_area: false`, and no other-playing-player strip. The pinned card remains unchanged.

The repository-owned queue companion supplies individual upcoming-item removal and movement, which the pinned card lacks. It uses stable IDs, rereads the queue before mutations, protects current/history items, cancels stale room requests, and never falls back to another player. It labels inactive queues without starting them. The touch keyboard attaches only to MA search fields on `/home-console/*?kiosk`; it does not handle sign-in or passwords. See the [bounded integration record](../docs/Home_Console_RaspberryPi_Plan/QUEUE_COMPANION_PROPOSAL.md).

Supported MA ingress is obtained through HA's `supervisor/api` WebSocket command. Tokens remain in private HA card configuration and operator snapshots. Use `sanitizedConfig` for review exports; it recursively removes `ma_token`. The current [dashboard export](../docs/Home_Console_RaspberryPi_Plan/home-console-dashboard.json) needs a newly supplied restricted token before deployment. The foundation export is historical.

## Rollback boundaries

The private HA snapshot can restore an existing manual dashboard using `lovelace/config/save` with its saved `url_path` and configuration, followed by `lovelace/dashboards/update` with its saved metadata. Restore only the affected dashboard. Do not send an empty configuration for a generated dashboard or restore every shared resource indiscriminately. D9 Home/Cameras layouts passed independent restore/readback/reapply drills using `restore_household.mjs`; see its read-only default preflight and [D9 record](../docs/Home_Console_RaspberryPi_Plan/D9_DASHBOARD_CLEANUP.md).

The new foundation's private journal identifies the new dashboard, two helpers, four scripts, and the two sensor enablement changes. Its credential record identifies the new kiosk user. These are independent of the Pi. Do not restore the whole HA installation merely to undo these additions. Do not delete an object that another user has since edited or adopted.

The current Pi rollback root is `/var/backups/home-console/20261027T210523Z/`; the earlier snapshot remains retained. It includes the original files, a consistent stopped Chromium profile, and the verified HA profile. The complete original-profile rollback and return to HA passed. Before any future restore, verify hashes, stop browser/login activity, wait for profile ownership to release, and preserve the then-current installation. Restore recorded ownership/modes and enablement. Never extract over a running profile. These archives contain credentials and must remain private.

For frontend rollback, use the affected dashboard from `navigation-before.json` or `queue-dashboard-before.json` and restore only the matching resource entry from the UI deployment journal. Preserve shared resources and HACS components until retained dashboards are checked for references. Content-addressed files can remain during the rollback period. Reverting a UI resource does not change Pi services.

UI deployment temporarily used the existing File Editor `6.3.0`, then stopped it. Its manual-start/watchdog-off settings remain unchanged. Supervisor records `error` after its SIGTERM shutdown (exit code `256`); logs confirm the service stopped. This is a recorded limitation, not an actively running editor. Do not repeatedly restart it to clear that status.

## Checks

```powershell
node --test home_console/test_foundation.mjs home_console/test_queue_policy.mjs home_console/test_keyboard_policy.mjs home_console/test_keyboard_lifecycle.mjs home_console/test_household.mjs home_console/test_playback_test_policy.mjs home_console/test_ups_layout.mjs
python -m unittest display.test_kiosk_policy home_console.test_capture_pi
```

The 40 Node and 12 Python checks cover preflight refusal, partial-failure journals, player isolation, queue boundaries, secret stripping, module imports, EN/RU edits, keyboard lifecycle, household roles, owned-test-queue cleanup, recovery/backlight policy, and archive integrity. Two opt-in real-Chromium fixture tests also passed on Linux; they use temporary profiles, not the signed-in kiosk profile. Live and physical acceptance are tracked separately in the implementation record.

## Pi operation and acceptance tools

The installed launcher needs all eight assets listed in `deploy_pi.py`; do not copy the launcher alone. Deploy only a reviewed hash manifest and a fresh private snapshot. The original one-time cutover has already run. `deploy_pi.py` refuses to overwrite its cutover journal.

`pi_browser_login.py` is a one-time normal-form login helper, not a token injector or autologin service. Send credentials only over SSH stdin from the protected file. Never print protocol payloads or capture password fields. Its focus checks were strengthened after the resolved sign-in incident documented in the implementation record.

The `check_pi_*.py` files are explicit acceptance commands, not unit tests. Recovery, crash/hang, full rollback, and reboot commands are disruptive and retain fixed installation paths and one-use evidence guards. Read the code and current journals before using them; do not repeat them during stability observation. Cold-boot fixtures are temporary, kiosk-UID-scoped, and automatically remove their network block. Their test unit must not remain enabled after acceptance.

Additional operator checks use a protected `--snapshot-dir`, one-use evidence journals, and read-only preflight unless `--apply` is supplied:

- `check_playback_swipe.mjs` coordinates the real Bedroom queue and `check_pi_playback_swipe.py`. It verifies **zero volume before playback**, uses a 120-second cleanup guardian, and restores the fresh idle/empty/mute/volume/helper baseline. Starting WiiM playback cleared mute in the first attempt, so mute alone cannot guarantee a quiet test. Never reuse an older volume snapshot over a newer state.
- `check_home_guards.mjs` also requires `--token-file`. The administrator reads exact script policy/traces; ordinary `pi-kiosk` sends invalid-source requests. The check requires traces to stop at the first condition, before device commands. It does not verify wake/source behavior.
- `check_home_controls.mjs` operates only the four explicitly approved aquarium/camera switches, one at a time, with 30-second per-switch restoration guardians. It restores and verifies the fresh original state before proceeding. It never calls lock, TV, or Denon services. Hardware-effect checks still require appropriate feedback; a reported 0 W during a brief on interval does not prove consumption under load.
- `check_pi_scroll.py` injects vertical touch gestures on Home and Music Library, verifies actual scroll movement and URL/room retention, then restores the previous URL. It does not change device state.

These checks have run on this installation. User confirmation now covers physical six-view swipes, EN/RU search, hidden cursor, and night wake. Aquarium/camera command/readback roundtrips and playback-to-UPS swipes passed. The user explicitly deferred TV/Denon wake/source and grouping tests; keep those devices off. Preserve that restriction when resuming.

Run these read-only commands **on the Pi through the existing SSH connection**:

```sh
sudo python3 /var/backups/home-console/20261027T210523Z/operator-stage/kiosk_health.py
sudo python3 /var/backups/home-console/20261027T210523Z/operator-stage/observe_pi.py --directory /var/backups/home-console/20261027T210523Z/observation --summary
sudo journalctl -t ups-kiosk-supervisor -n 40 --no-pager
sudo journalctl -u ups-kiosk-screen.service -n 20 --no-pager
sudo systemctl status ups-kiosk.service ups-kiosk-screen.service ups-kiosk-login.timer nut-server.service
upsc ups@localhost
```

For a necessary GUI restart, use `sudo systemctl restart ups-kiosk.service`. It does not restart NUT. Nighttime darkness is intentional. `sudo systemctl stop ups-kiosk-screen.service` restores the backlight and normal touch routing for diagnosis; start it again afterward.

The bounded observer uses existing Python/systemd, private minute samples, low process priority, and a fixed schedule file. It monitors actual `upsdisplay` account PSS because PAM places GUI children in a session scope outside the kiosk unit's memory cgroup. It also checks HA connection/rendering/live UPS status, NUT/services, available RAM, and temperature. A restart never renews the deadline. Read sample gaps and planned acceptance exclusions before declaring stability. The thread follow-up is bounded and quiet while unchanged.

Before a HACS/HA/MA update, capture configuration/resources privately, keep the previous files, and retest as `pi-kiosk`. The approved pins are not permission for unreviewed future versions. Final HA backup `8cc60c4a` includes the final swipe configuration; confirm backup completion rather than only a request ID.

## UPS readability layout

`ui/ups-layout.js` supplies a presentation-only wrapper around the existing status and five native sensor cards. Labels/status, values, headings, and icons are enlarged 50%; the battery charge spans the first row, with two paired rows below. The layout fills the available kiosk height. Native readings, units, unavailable states, and more-info actions remain owned by Home Assistant. No production dependency was added.

Deploy the seven hashed UI assets with `deploy_ui.mjs` before applying `resize_ups.mjs --token-file <private-file> --snapshot-dir <private-directory> --apply`. The latter defaults to preflight, refuses a changed UPS card structure, preserves the other five views, and writes private before/after evidence. It is a one-time upgrade, not an idempotent dashboard generator. The active entry is `/local/home-console/home-console-ui.e7d611519cc1.js`. Rollback uses the UPS view from private `ups-readability-change.json` and the matching resource journal; preserve subsequent unrelated edits.
Follow-up: the user approved another 25% on UPS only. Current labels/status are 26.25 px, values 22.5 px, headings 37.5 px, and icons 45 px (1.875 times the original sizes).

Battery runtime now uses a presentation-only secondary slot on the native tile: hours/minutes at or above one hour, minutes/seconds below one hour, seconds below one minute. Whole seconds/minutes are floored. Unknown, unavailable, missing, negative, and unsupported-unit values retain the native display. The sensor and history remain unchanged.

UPS load displays percent and estimated watts, calculated as percent × the live sensor.ups_nominal_real_power / 100. This BX750MI exposes 410 W nominal real power but no measured ups.realpower. The ≈ marker identifies an estimate; VA is never used as watts. The existing nominal power entity was enabled with a private before-record. Missing rating shows watts unavailable. Input/battery voltage use one decimal from their actual HA values; this does not increase measurement precision. Formatting helpers now live in ui/ups-format.mjs.

Do not rerun check_home_sources.mjs with --apply or --guardian: live execution is explicitly disabled after the failed October 28 acceptance. Inspect IMPLEMENTATION_STATUS.md and private v1/v2 evidence. Native Denon source/volume and HEOS disagree; preserve newer household changes. No test guardian remains active.

Grouping acceptance: check_grouping.mjs defaults to read-only preflight. Its protected v2 journal verifies zero-volume join/unjoin and queue/native-setting restoration. It opens only an empty existing Cast receiver to activate volume control; it sends no media/play commands. This is group control acceptance, not audible sync or complete physical Players UI acceptance. Native Denon mute state can be stale; the user physically confirmed restoration to TV Audio/-25 dB/unmuted. Do not substitute native/HEOS cached volume values for each other's control roles.

## Connected UPS switching — October 30, 2026

The live console and household UPS cards now follow `sensor.connected_ups_*`. The local `USB UPS Adapter` integration polls the stable NUT endpoint every ten seconds and keeps separate physical-device histories. APC is unavailable while Eaton 5E 2200 G2 is connected. The existing 22 APC entity IDs and their device ID were migrated through HA registry APIs; old history remains readable. The disabled native NUT entry is retained for rollback. The foundation generators above remain historical; use `switchUpsDashboard` after generating legacy card configuration.

Measured watts take priority; estimates retain `≈`. Missing Eaton battery voltage stays unavailable. Deployment, serial-less identity limits and rollback are described in [UPS_SWITCHING.md](UPS_SWITCHING.md). The active UI resource is `/local/home-console/home-console-ui.75ded33efa64.js`.

Verification: nine Python tests and 22 relevant Node tests passed. `check_ups_switching.mjs` verified original history, all 22 migrated entity IDs, actual Pi rendering at 1024×600, unavailable display during a brief HA adapter disable, and automatic recovery with unchanged IDs. Evidence: `output/ups-switching-validation.json` and `output/playwright/home-console-ups-switching*.png`. No physical USB swap or cable-disconnect test was performed. Playwright could not attach because the SSH key denies forwarding; the repository's existing loopback CDP diagnostic path verified the actual Pi browser instead. NUT monitoring continued independently.

Version 1.0.1 repairs missing labels and inherited disabled defaults on implemented physical Eaton metrics. The repair runs once and preserves explicit user disables. Output voltage/frequency and apparent power are implemented; other archived settings retain descriptive labels and remain disabled. Live reload verification preserved all 56 previous entity IDs, found zero missing names, confirmed the repaired measurements and readable APC history. Evidence: `output/ups-label-repair-validation.json`. Nine Python and eight relevant Node tests passed.

The Pi drawer now includes **Ночное гашение экрана**, a persistent device setting for the existing 23:00–07:00 / 120-second physical-backlight policy. The ordinary kiosk session verified both settings, persistence after a page reload and actual brightness 0→255 on disable; the original enabled setting was restored. Seven Node and fifteen Python tests passed. See [SCREENSAVER.md](SCREENSAVER.md) for deployment, storage and rollback. The current UI resource is `/local/home-console/home-console-ui.93bcb275e1f9.js`.

The drawer also includes **Тема → Светлая / Тёмная**, using HA's native preference storage for the kiosk user. Both modes and dark-mode persistence after a page reload passed on the actual Pi; original preferences were restored after testing. Eight relevant Node tests passed. Current UI resource: `/local/home-console/home-console-ui.ad2484a83a98.js`; private rollback journal: `ui-drawer-theme-mode.json`.

Passwordless login is enabled only from the Pi's exact `192.168.50.200/32` address as non-admin `pi-kiosk`; normal password authentication remains available. Fresh Pi browser login and rejection from the operator PC passed. The disposable test session was revoked; the retained kiosk session was preserved. Router DHCP reservation was not verified or changed. See [TRUSTED_PI_LOGIN.md](TRUSTED_PI_LOGIN.md) for the private rollback record and IP-change behavior.

## Receiver layout

The Receiver wrapper presents favorites as a vertically scrollable left column
and the existing native Now Playing/artwork card on the right. A full-width
bottom row contains the native volume slider, Mute and Off in that order.
The Receiver TV Audio button was removed at the owner's request. Native device actions and radio playback targets are preserved; rendering
the layout does not send device commands. Favorite refresh preserves vertical
scroll position. `check_pi_receiver_layout.py` verifies column geometry and
control order in the actual Pi browser. The same layout was checked on Samsung
Galaxy Tab A7 through Fully Kiosk; screenshots are under `output/playwright/`.

## TV audio routing

Every non-Off TV source/app button uses `script.home_console_tv_source`. Each
tap, including an already highlighted source, explicitly calls the existing
Denon source script with `TV Audio`. It then switches LG sound output to
`external_arc` if necessary and waits up to ten seconds for feedback. Off retains
its native turn-off action.
`route_tv_audio.mjs` upgrades only the existing script with a private rollback
journal and configuration readback. Deployment does not execute device commands;
physical rerouting during playback was not exercised by that deployment.

Receiver lists all Music Assistant library radio stations by default. The All/Favorites switch filters the list. Each separate heart adds or removes a station from MA favorites without starting playback. The library refreshes every 15 seconds. UPS presentation and optional confirmed output control are documented in [UPS_SWITCHING.md](UPS_SWITCHING.md).

Each live Receiver station tap now calls `script.home_console_receiver_radio`: verify/wake native Denon, select HEOS, wait for source readiness, then unconditionally replace the Music Assistant queue. Repeated taps restart the same station. The script uses restart mode so the latest station tap supersedes a pending selection. Unavailable devices and source timeouts stop before playback. Real first/repeat station tests are recorded privately; no UPS commands are involved.
