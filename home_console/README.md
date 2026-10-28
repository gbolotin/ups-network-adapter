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
- The lock appears as text with no entity action. Player status tiles on Players have no tap/hold actions; selected-room controls remain separate.
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
node --test home_console/test_foundation.mjs home_console/test_queue_policy.mjs home_console/test_keyboard_policy.mjs home_console/test_keyboard_lifecycle.mjs home_console/test_household.mjs home_console/test_playback_test_policy.mjs
python -m unittest display.test_kiosk_policy home_console.test_capture_pi
```

The 33 Node and 12 Python checks cover preflight refusal, partial-failure journals, player isolation, queue boundaries, secret stripping, module imports, EN/RU edits, keyboard lifecycle, household roles, owned-test-queue cleanup, recovery/backlight policy, and archive integrity. Two opt-in real-Chromium fixture tests also passed on Linux; they use temporary profiles, not the signed-in kiosk profile. Live and physical acceptance are tracked separately in the implementation record.

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
