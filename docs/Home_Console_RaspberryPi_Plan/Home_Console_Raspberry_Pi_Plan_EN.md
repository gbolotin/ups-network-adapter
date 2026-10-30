# Home Console on Raspberry Pi 4 — Implementation Plan

> **Status:** Home Console is deployed on the Pi. The fixed 48-hour observation ended October 29, 22:25 UTC; stability acceptance did not pass. A shutdown/new boot, an 11-minute sample gap, and missing Home Assistant UPS data require investigation. Earlier functional checks remain valid within their recorded limits. TV/Denon feedback, physical grouping, and audible acceptance remain open. See the [implementation record](IMPLEMENTATION_STATUS.md).
>
> **Date:** October 28, 2026.
>
> **Language versions:** [English](Home_Console_Raspberry_Pi_Plan_EN.md) · [Русский](Home_Console_Raspberry_Pi_Plan_RU.md). Keep both versions synchronized when changing decisions, scope, phases, or acceptance criteria.
>
> **Core idea:** Build one dedicated Home Assistant dashboard (`Home Console`) with six views tuned for the 5-inch `1024×600` Pi touchscreen, and clean up a separate responsive main HA dashboard for normal PC/phone use. Keep the existing NUT stack and `cage` kiosk. Show local UPS data when HA is unavailable, then return to HA automatically. Full music-library search and queue control belong in the first release.

### Implementation Progress — October 28, 2026

The music software feasibility gate passed. The approved pinned components, restricted MA identity, six views, EN/RU search, queue controls, play-now, play-next, enqueue, and explicit Bedroom-to-Denon transfer were verified. Transfer cleanup restored the original queues, TV Audio, and 49% Denon volume. A later quiet Pi slider test preserved Bedroom's then-current 44% volume and restored Denon selection. Subsequent user power/volume changes are preserved.

The responsive household Home dashboard is deployed at the existing `dashboard-new` URL. Native controls, independent music rooms, camera controls, Map, and generated Overview remain reachable. Independent Home/Cameras restore-and-reapply drills passed. Desktop/phone screenshots are private; the existing camera feed problem is recorded separately.

The Pi now opens `/home-console/ups?kiosk` as non-admin `pi-kiosk` at `1024×600`, scale 1. Live HA/local/offline recovery, browser crash/hang, full original-profile rollback followed by HA restoration, and two reboots passed. The normal reboots returned to authenticated HA in 71.75 and 64.02 seconds. A separate HA-blocked cold boot showed local UPS in 20.25 seconds, then returned to HA in 27.09 seconds after unblock; Bedroom selection survived. Actual Pi browser touch injection passed both swipe directions and EN/RU search; `prevent_default: true` prevents competing native horizontal browser gestures. Slider and queue gestures preserved their view.

Observation runs from October 28 at 00:25 to October 30 at 00:25 Israel time, with minute samples and two-hour follow-ups. It is not complete. Physical night wake passed: the first touch wakes, the second opens battery details, and three logged cycles returned to darkness after 120 seconds. The user also confirmed physical six-view swipes, EN/RU searches, and no visible pointer. A real Bedroom queue stayed playing through Pi swipes to UPS at zero volume; fresh state was restored. Four approved aquarium/camera switch roundtrips passed and restored their starting states. TV/Denon wake/source and grouping tests are deferred by explicit request to keep those devices off. Aquarium consumption under load and camera tracking/video effectiveness were not proved by these short command tests.

See [implementation evidence](IMPLEMENTATION_STATUS.md), [operator tools](../../home_console/README.md), [current console export](home-console-dashboard.json), [household export](home-console-household.json), and [scripts](home-console-scripts.json). The earlier [foundation export](home-console-foundation.json) is historical.

## 1. Existing Setup and Evidence (October 27, 2026)

Separate direct observations from earlier inventory and proposed behavior. A successful connection check does not validate touch input, playback, reboot recovery, or outage recovery.

| Component | Observed or recorded state | Intended role |
|---|---|---|
| Lenovo 720, Windows 11 Pro | HA `2026.10.4` (HA OS `18.3`, Supervisor `2026.10.4`) reports `RUNNING` at **`http://192.168.50.117/`**; HACS `2.0.5` is loaded. The VM runs on **Hyper-V, confirmed by the user on October 27, 2026** | Hosts `Home Console`, PC/phone dashboards, and device data; use Hyper-V for host-side VM diagnostics and recovery |
| Raspberry Pi 4 (`ups-adapter`) | `192.168.50.200`; Debian GNU/Linux 13 (`trixie`) `aarch64` (kernel `6.18.50+rpt-rpi-v8`), **1.8 GiB RAM** (~1.1 GiB available, 0 B swap used); runs **`nut-server`** (`ups`: APC Back-UPS BX750MI) and **`ups-kiosk.service`** (`cage` Wayland compositor + Chromium on `tty1` as user `upsdisplay`) | **Keep `nut-server` running**; update `ups-kiosk-browser` to open the HA `Home Console` dashboard in Chromium kiosk mode |
| Raspberry Pi display | 5-inch DSI touchscreen (`DSI-1`), verified via KMS at **`1024×600 @ 59.94 Hz`** | Displays the HA dashboard and accepts touch input |
| NUT → Home Assistant | Connected and working; active entities: `sensor.ups_apc_status`, `sensor.ups_apc_status_data`, `sensor.ups_apc_battery_charge`, `sensor.ups_apc_load`, `sensor.ups_apc_input_voltage` (`battery.runtime` is available from `upsc ups`) | Use the existing NUT entities and **enable `battery_runtime` and `battery_voltage`** in HA's NUT integration |
| Music Assistant | Music Assistant **`2.10.8`** deployed; **Radio Browser** (4 favorites + ~75 library stations) and **SpotifyPlus (`v1.0.224`)** are configured | Play music and internet radio through supported players |
| Audio players | MA integration membership verified for `media_player.bedroom_3` (**Linkplay WiiM Ultra** in Bedroom), `media_player.denon_avc_x4700h_3`, `media_player.lg_tv_oled83c_2`, and `media_player.shield_3`. Entity availability does not prove audible playback | Use these four MA-owned entities. `media_player.bedroom_wiim` (native WiiM), `media_player.bedroom` (Cast), and `media_player.bedroom_2` (DLNA) represent the same Bedroom WiiM Ultra outside MA; do not treat them as interchangeable MA targets |
| Local UPS fallback | `ups-peanut` is running with image `brandawg93/peanut:6.0.0` and restart policy `unless-stopped`; `ups-kiosk-login.timer` is active. The existing login helper checks the PeaNUT origin and `/login` path | **Keep PeaNUT, its data, Docker, and scoped login recovery as the automatic local UPS fallback** |
| Pi maintenance UI | `ups-web.service` is active on port `80` | Keep it during migration. Do not make its unrelated, unreviewed local changes a prerequisite for this plan |

**HA hosting:** Other devices access HA directly at `http://192.168.50.117/`. No additional Pi web server or reverse proxy is required for the HA dashboard. The existing local UPS fallback remains independent of HA.

**Evidence limits:** OS, kernel, RAM, and panel mode were recorded in the earlier inventory. Recheck them before deployment. The live launcher differs from `display/ups-kiosk-browser`: its session-cleanup block is absent. Back up deployed files before reconciling this difference. The host-information API returned `401`; the user separately confirmed Hyper-V. Host-side VM settings were not inspected during this review.

### User Decisions

| ID | Decision | Status |
|---|---|---|
| D1 | Show local UPS data during an HA outage, then return to HA automatically | **Confirmed by user** |
| D2 | Share one selected room across Now Playing, Music Library, Players, and Radio on the Pi using a dedicated Pi-only HA helper (`input_select.pi_console_player`), defaulting to `Denon AVC-X4700H` on first setup; PC/phone use their own dashboard | **Confirmed by user** |
| D3 | Full library search and queue control are required in the first release; evaluate one custom card if needed | **Confirmed by user**; evaluation does not authorize installing a new production dependency |
| D4 | Selecting another room changes the control target while existing playback stays in its original room; include a separate explicit "Transfer playback to room" button on the `Players` view | **Confirmed by user** |
| D5 | Home-view groups 1–4: Lock Ultra 17 state tile with native details popup; aquarium outlet status/control/power; Xiaomi C400 power/motion detection/human tracking; Denon power/volume/TV–HEOS source (tapping a source when off wakes Denon, waits for readiness, and selects that source, plus an explicit Off button) | **Confirmed by user**; exact entity mapping below; October 28 update: native lock popup requested by user; no direct tile toggle or lock-operation acceptance test |
| D6 | Search-keyboard languages: **English and Russian (`EN + RU`)** via a lightweight Chromium/browser virtual keyboard so the existing `cage` Wayland kiosk remains untouched | **Confirmed by user** |
| D7 | Nighttime display behavior: stay on during the day (`07:00–23:00`); at night (`23:00–07:00`) turn backlight off, wake on first touch and stay lit until 2 minutes of touch inactivity; consume the first wake contact so it cannot trigger a UI click (verified Xiaomi C400 has no illuminance sensor and IR events report `unknown`) | **Confirmed by user** |
| D8 | Include the living-room LG TV group (`media_player.lg_webos_tv_oled83c36la`) as the 5th group in the `Home` view (vertical scrolling allowed): `PC` (`HDMI 1`), `SHIELD` (`SHIELD Game Console` / HDMI 4), `Denon` (`Denon Sound Bar` / HDMI 2); `YouTube`, `Plex`, `Netflix`, and `Apple TV` shortcuts. Tapping a source/app when off wakes the TV, waits for readiness, and selects it (plus an explicit Off button) | **Confirmed by user** |
| D9 | Keep `Home Console` tuned specifically for the 5-inch `1024×600` Pi screen, and clean up a separate responsive main HA dashboard for PC and phone layouts/navigation | **Confirmed by user**; inventory, backups, cleanup, validation, and rollback are required, not just creation of the Pi dashboard |

Do not silently replace D3 with a favorites-only release. All initial interview decisions (`D1`–`D9`) are confirmed above.

### Existing Dashboard Inventory — D9

Read-only WebSocket inventory on October 27, 2026 found these dashboard panels. This is a structural inventory, not a visual review or a finding that any dashboard is empty or redundant.

| Current title | URL path | Observed structure | Cleanup scope |
|---|---|---|---|
| Map | `map` | Storage-mode dashboard; one view | Check whether it remains useful, preserve its map function, and place it sensibly in navigation |
| Cameras | `dashboard-cameras` | Storage-mode dashboard; one sections view with two sections | Review actual camera/status/control cards, unavailable feeds, and duplicate controls |
| new | `dashboard-new` | Storage-mode dashboard; one sections view with five sections | Audit the content, give any retained dashboard a meaningful title, and reorganize or merge duplicate content |
| Default panel | `lovelace` | Panel present; stored configuration query returned `config_not_found` | Inspect its generated/managed status in HA before choosing the supported customization method; do not assume it is empty or broken |

All three listed storage dashboards are currently shown in the sidebar and are not marked admin-only. Inspect the actual cards, household use, and default/sidebar preferences before changing their organization. Preserve useful controls and existing URLs during the initial cleanup.

## 2. Architecture

```text
                         ┌─────────────────────────────────────────┐
                         │ Lenovo 720 · Home Assistant 2026.10.4   │
                         │ http://192.168.50.117/ (Port 80)        │
                         │ Home Console: 6 Views                  │
                         │ NUT integration + Music Assistant      │
                         └──────────────────┬──────────────────────┘
                                            │ local network
                        ┌───────────────────┴───────────────────┐
                        │                                       │
             ┌──────────▼──────────┐                  ┌─────────▼────────┐
             │ Raspberry Pi 4      │                  │ Other browsers   │
             │ cage + Chromium     │                  │ PC / phone       │
             │ 5" Touch 1024×600   │                  │ Home Assistant   │
             │ + NUT Server        │                  └──────────────────┘
             └──────────┬──────────┘
                        │ USB (usbhid-ups)
                   ┌────▼──────────────┐
                   │ APC Back-UPS      │
                   │ BX750MI           │
                   └───────────────────┘

NUT Server on Pi ──────────> NUT integration in HA ──> UPS View
Music Assistant (HA/MA server) ─────────────────────> Music/Radio Views
NUT Server on Pi ──────────> Local PeaNUT fallback ─> Pi display during HA outages
```

**Reliability principle:** NUT (`nut-server`, `ups-autodetect.service`, `ups-snmp.service`) is an independent system service stack. The GUI (`ups-kiosk.service` / `cage` / Chromium), PeaNUT, and HA dashboards must not be dependencies in the UPS/device safe-shutdown chain.

The kiosk needs recovery logic throughout its lifetime. A shell loop that waits for HA and then uses `exec chromium` only checks startup. `Restart=always` handles process exit; it cannot detect a running browser on an error page.

```text
Start kiosk --> Local UPS fallback --> HA dashboard confirmed ready
                       ^                       |
                       | HA unavailable,       |
                       | browser error,        |
                       | or readiness timeout  |
                       +-----------------------+
Local fallback unavailable --> Visible offline screen + bounded retries
```

Use one small browser supervisor within the existing kiosk service. It owns Chromium and its retry state. Reuse available platform features and runtimes. Prove the browser-readiness/reload transport before choosing implementation details; ask before adding a production dependency. The HA recovery path must work even when Docker or PeaNUT fails. Recovery may restart the kiosk browser, never NUT or the Pi.

## 3. Structure of the Single Home Console Dashboard

Create **one new dashboard from scratch** in Home Assistant (`Home Console`), with six views inside it tuned specifically for the 5-inch `1024×600` Pi touchscreen. This structure enables swipe navigation between pages of the same dashboard.

| # | View / example path | Content | Design notes for 1024×600 |
|---|---|---|---|
| 1 | **UPS** (`ups`) | Status (`sensor.ups_apc_status` / `sensor.ups_apc_status_data`), battery charge % (`sensor.ups_apc_battery_charge`), load % (`sensor.ups_apc_load`), input voltage (`sensor.ups_apc_input_voltage`), plus enabled `battery_runtime` and `battery_voltage` entities from HA's NUT integration | 3–5 large readings (including remaining runtime); add a graph if space permits |
| 2 | **Home** (`home`) | Five confirmed groups: (1) Lock status/battery, (2) aquarium outlet/power, (3) Xiaomi C400 on/off/motion detection/human tracking, (4) Denon on/off/volume/TV–HEOS source, (5) Living-room LG TV inputs (`PC`, `SHIELD`, `Denon`) + 4 apps (`YouTube`, `Plex`, `Netflix`, `Apple TV`) and Off button | Preserve the five-group order; vertical scrolling on `Home` is allowed. Lock tile/icon taps open native details; hold/double-tap do nothing. Use native Denon and LG webOS entities independently of the selected MA room |
| 3 | **Now Playing** (`now-playing`) | Album art, track/radio station, Play/Pause, Next, volume, selected player (`input_select.pi_console_player`) | Large controls and minimal text |
| 4 | **Music Library** (`music-library`) | Albums, artists, playlists, search (`EN + RU` browser touch keyboard), queue | May require vertical scrolling on a small screen |
| 5 | **Players** (`players`) | Select target player/room (`input_select.pi_console_player`, default `Denon AVC-X4700H`), view status, control volume/mute, explicit "Transfer playback to room" button, and groups (if supported by MA) | Four verified MA players: `media_player.denon_avc_x4700h_3`, `media_player.bedroom_3` (Linkplay WiiM Ultra), `media_player.lg_tv_oled83c_2`, `media_player.shield_3` |
| 6 | **Internet Radio** (`radio`) | The 4 existing Radio Paradise FLAC favorites (`Radio Paradise (flac)`, `Mellow Mix`, `Global Mix`, `Beyond...`) as large quick-play buttons, plus access to the full MA Radio library (~75 saved stations + Radio Browser) | 4 large favorite station buttons + full MA Radio library browser; starts playback in the selected room |

**Navigation:** Swipe horizontally between views. Music/radio continues playing on the selected player. Vertical scrolling is only needed on views with longer content (`Home` and `Music Library`). Do not confuse swiping between views with switching between separate dashboards.

### Confirmed Home View — D5 and D8

Preserve these five groups in the order selected by the user. Fit them at `1024×600` with readable labels, large touch targets, and vertical scrolling. The camera group contains three independent toggles.

| Order | Group | Exact HA entities | Required behavior |
|---|---|---|---|
| 1 | Lock Ultra 17 | `lock.lock_ultra_17`; `sensor.lock_ultra_17_battery` | Show a compact state tile; tile/icon taps open the native details popup requested October 28. Hold/double-tap are disabled. The popup exposes HA lock controls; no lock operation was tested. Battery entity is retained. |
| 2 | Aquarium, office | `switch.power_plug_cd43`; `sensor.power_plug_cd43_power` | Show outlet state, explicit on/off control, and measured power in W |
| 3 | Xiaomi C400, living room | `switch.chuangmi_sg_1069362690_039c04_on_p_2_1`; `switch.chuangmi_sg_1069362690_039c04_motion_detection_p_5_1`; `switch.chuangmi_sg_1069362690_039c04_human_tracking_p_2_9` | Separate camera on/off, motion-detection, and human-tracking toggles with current states |
| 4 | Denon AVC-X4700H | Native receiver entity `media_player.denon_avc_x4700h` | Explicit Off button, volume control, and two source buttons: TV → `TV Audio`; HEOS → `HEOS Music`. Tapping a source while `off` wakes Denon, waits for readiness, and selects that source |
| 5 | Living-Room LG TV (`D8`) | Native webOS entity `media_player.lg_webos_tv_oled83c36la` | Explicit Off button, 3 HDMI input buttons (`PC`, `SHIELD`, `Denon`), and 4 app buttons (`YouTube`, `Plex`, `Netflix`, `Apple TV`). Tapping any input/app while `off` wakes the TV, waits for readiness, and selects that source/app |

The Denon entity mapping and source names were read directly from HA after the user's selection. `TV Audio` and `HEOS Music` are **receiver input sources**. Interpret the user's TV/HEOS choice as input selection; physical HDMI output routing is a different feature and is not implied by this mapping.

Use native Denon power/volume/source actions for the Home group. Keep MA playback/queue actions on `media_player.denon_avc_x4700h_3` in the music views. The receiver's native entity was `off`, while its MA/HEOS entities reported `idle`; do not derive receiver power from the MA state. Home-view Denon controls always address Denon, regardless of which room is selected for music.

When the receiver is off, its current volume can be unavailable. Display the unavailable value correctly. Do not initialize the receiver to a guessed volume or source during page load. Because one-tap wake-and-select is confirmed by the user, implement an HA script that powers on the receiver when `off`, waits for confirmed readiness, and then sends `media_player.select_source`; validate that sequence during implementation. No receiver or household controls were exercised during this planning check.

### Confirmed Living-Room LG TV Group — D8

The native webOS integration exposes `media_player.lg_webos_tv_oled83c36la` for the living-room TV. Use it for input and TV-app selection, independently of the selected MA room. Keep the MA entity `media_player.lg_tv_oled83c_2` for Music Assistant playback rather than treating it as the TV's native input controller.

| Confirmed button | Exact source exposed by HA | Confirmed mapping & status |
|---|---|---|
| PC — HDMI 1 | `HDMI 1` | Confirmed by user as PC (`HDMI 1`) |
| SHIELD — HDMI 4 | `SHIELD Game Console` | Confirmed by user as physical HDMI 4 (`SHIELD Game Console`) |
| Denon — HDMI 2 | `Denon Sound Bar` | Confirmed by user as physical HDMI 2 (`Denon Sound Bar`) |
| YouTube | `YouTube` | App source present; launch to be verified during implementation |
| Plex | `Plex` | App source present; launch to be verified during implementation |
| Netflix | `Netflix` | App source present; launch to be verified during implementation |
| Apple TV | `Apple TV` | App source present; launch to be verified during implementation |

HA's webOS integration supports `media_player.select_source` for both input sources and installed TV apps. Use the exact exposed strings (`HDMI 1`, `SHIELD Game Console`, `Denon Sound Bar`).

The native TV entity reported `off` during the read-only check. No input or app was changed. Because the user confirmed automatic wake-on-source/app tap when the TV is `off`, implement an HA script that triggers the supported wake mechanism (Wake-on-LAN / webOS `media_player.turn_on`), waits for `media_player.lg_webos_tv_oled83c36la` to reach a ready state, and then sends `media_player.select_source` (plus an explicit Off button). Test both already-on switching and standby wake-up during implementation.

Include this as the fifth Home group after the four D5 groups, with vertical scrolling on the `Home` view. TV controls always address the living-room TV; selecting a different MA room must not retarget them. These shortcuts open the TV's own apps; app browsing, account sign-in, and selecting a film are separate interactions.

### Music Interaction Contract

- Every playback, queue, mute, and volume action on `Home Console` targets the room selected on the Pi console. Show that room beside the controls.
- Because `Home Console` is dedicated specifically to the 5-inch Pi screen (while PC and phone browsers use their own separate main dashboard per `D9`), store the Pi's selected room in a dedicated Pi-only HA helper (`input_select.pi_console_player`), initialized to **`Denon AVC-X4700H`** (`media_player.denon_avc_x4700h_3`) on first setup. PC/phone dashboards must not bind to `input_select.pi_console_player`.
- Selecting a different room changes `input_select.pi_console_player` and retargets the UI controls without transferring, stopping, or restarting existing playback. Include a separate explicit **"Transfer playback to room"** button on the `Players` view (`music_assistant.transfer_queue`). Swiping between views sends no playback command.
- Persist the selected room across swipes, page reloads, and kiosk restarts via `input_select.pi_console_player`. If the selected player becomes unavailable, display that state clearly and require another selection; do not silently send playback elsewhere.
- Do not automatically follow another room merely because it starts playing. If the evaluated card enables `auto_follow` by default, disable it for an explicitly selected-room workflow.
- Built-in Media control cards bind to individual entities. Use templates/conditional binding or the evaluated Music Assistant card synced to `input_select.pi_console_player` so all four music views (`now-playing`, `music-library`, `players`, `radio`) follow the same selected room.
- Prove library search, queue operations, radio playback, explicit queue transfer, and selection behavior as `pi-kiosk` before switching the Pi. The same behavior must work after leaving and reopening a view.
- Provide touch-only text entry in **English and Russian (`EN + RU`)** at `1024×600` using a lightweight Chromium/browser virtual keyboard extension/component so the existing `cage` single-window Wayland kiosk remains untouched. Search cannot depend on a physical USB keyboard.

## 4. Components and Dependencies

### Required for the Intended User Experience

1. **Home Assistant dashboard** — Built-in functionality; create a dedicated dashboard using *New dashboard from scratch*.
2. **[Kiosk Mode](https://github.com/NemesisRE/kiosk-mode)** via HACS — Hides the HA header and sidebar. Since live HA is verified at **`2026.10.4`**, install **Kiosk Mode `15.0.0+`** (required for HA `2026.10.1+`).
3. **[Home Assistant Swipe Navigation](https://github.com/zanna-37/hass-swipe-navigation)** via HACS — Enables swipe navigation between views. Use the maintained `zanna-37` fork instead of the older `maykar` project. Select and record the exact version tested in Chromium on the Pi.
4. **Cage + Chromium kiosk mode** on the Raspberry Pi — Already installed and running via `ups-kiosk.service` (`/usr/bin/cage -d -s -- /usr/local/bin/ups-kiosk-browser`). Hides the browser's own chrome and mouse cursor (a *different* mechanism from HACS Kiosk Mode).

### Already Available

- **NUT integration in HA** — Do not install it again.
- **Music Assistant + Radio Browser** — Do not install them again. Use the existing `media_player.*` entities, providers, and saved radio stations.
- **Wayland kiosk infrastructure on Pi** — `cage`, `chromium`, user `upsdisplay`, hidden cursor theme (`/usr/local/share/ups-kiosk/icons`), and `ups-kiosk.service` are already deployed and working.

### Music UI Feasibility Gate

- Use built-in HA cards for UPS, household controls, and simple player status where suitable.
- Evaluate **[Music Assistant Browser Card](https://github.com/PMizz13/ma-browser-card)** against D2–D4 and the actual MA server version. Its current requirements include MA `2.8+`. Full queue access uses an MA token; basic browsing alone is not evidence that queue control works.
- The project stores `ma_token` in plaintext dashboard configuration. Use a restricted MA identity if supported and verified. Keep secrets out of Git, screenshots, diagnostic output, and shared exports. Do not reuse the administrator's HA token as an MA token.
- Test the chosen direct-MA or HA-ingress connection as the non-admin kiosk user. Verify library access, artwork, queue access, and permitted players. Do not assume an administrator's working session proves kiosk-user access.
- Do not assume separate card instances share their selected player. Record the supported mechanism or small integration required. If the card cannot meet the contract, show the bounded adapter proposal or request a view-structure change before proceeding. Do not silently combine the user's six views or maintain an unreviewed card fork.
- Select a touch-compatible text-entry method and demonstrate search submission, clearing, dismissal, and scrolling. Name any required package or card, check Cage compatibility, and request approval before installation.
- Record the chosen UI, pinned component versions, selection mechanism, input method, connection method, and secret-handling approach. **Do not start the Pi cutover until this gate passes.**

## 5. Step-by-Step Implementation

### Phase 0 — Inventory and Rollback Point

- [x] Record **HA Core version** (`2026.10.4`), HACS availability (`update.hacs_update` present), working HA URL (`http://192.168.50.117/`), and the current kiosk's launch/configuration location (`/etc/systemd/system/ups-kiosk.service` + `/usr/local/bin/ups-kiosk-browser`).
- [x] Recheck the earlier OS/RAM/display inventory and record timestamps. Do not change Hyper-V VM settings for this dashboard migration.
- [x] Check NUT: `ups` reports `OL`; HA reports `100%` battery charge and live input-voltage/load sensors. Voltage is a sampled reading, not a fixed acceptance value.
- [x] Create an HA backup and confirm its completion and restore location. Export sanitized dashboard/helper/script configuration separately for review.
- [x] For D9, privately snapshot each current dashboard's configuration and metadata, resource registrations, and available default/sidebar preferences. Record which configuration is generated versus manually managed. Keep full secret-bearing snapshots outside Git; use sanitized exports for review.
- [x] Create a root-only Pi backup directory under `/var/backups/home-console/` and record its exact absolute path. Copy the **deployed** launcher, kiosk unit, login service/timer/helper, and readability extension. Record ownership, modes, enabled/active unit states, and file hashes.
- [x] Record the PeaNUT image/version, restart policy, persistent-data location, and protected credential-file location. Preserve the existing container and data. Do not print or commit credential contents.
- [x] Record hashes and process identities for the NUT driver, server, autodetection, and SNMP configuration/services. Use them to confirm that kiosk changes leave the UPS stack untouched.
- [x] Confirm SSH access to the Pi (`upsadmin@192.168.50.200`) **without relying on** the old kiosk.
- [x] **Do not stop or remove anything yet:** NUT, PeaNUT, `ups-web.service`, and the current kiosk all remain in place.

**Checkpoint:** NUT is running, HA shows live UPS sensors, and backup contents match the deployed files. Record the rollback directory before proceeding.

### Phase 1 — Create the Dashboard on Lenovo / Home Assistant

- [x] In HA, navigate to `Settings → Dashboards → Add dashboard` and create a **blank, user-managed** dashboard named `Home Console` (for example with URL path `home-console`, not the built-in Default Dashboard).
- [x] Create the dedicated non-admin HA user `pi-kiosk` (created local-only; ordinary login and read-only dashboard/MA API access verified).
- [x] Complete music-UI and action-permission checks using `pi-kiosk` before the Pi cutover.
- [x] Create the dedicated Pi-only helper `input_select.pi_console_player` containing the four verified MA entities (`media_player.denon_avc_x4700h_3`, `media_player.bedroom_3`, `media_player.lg_tv_oled83c_2`, `media_player.shield_3`) with initial default `media_player.denon_avc_x4700h_3` (`Denon AVC-X4700H`).
- [x] Pass the Music UI Feasibility Gate. Record the exact approved dependencies and verify that all four music views sync via `input_select.pi_console_player`.
- [x] Add the six views in the table's order, using short paths: `ups`, `home`, `now-playing`, `music-library`, `players`, `radio`.
- [x] In `Settings → Devices & Services → NUT`, **enable** the disabled `battery_runtime` and `battery_voltage` entities from the NUT integration, then add all verified NUT entities to the UPS view:
  - `sensor.ups_apc_status`
  - `sensor.ups_apc_status_data`
  - `sensor.ups_apc_battery_charge`
  - `sensor.ups_apc_load`
  - `sensor.ups_apc_input_voltage`
  - `sensor.ups_battery_runtime` (and `sensor.ups_battery_voltage`)
- [x] Populate the Home view with the five confirmed groups (`D5` groups 1–4 plus `D8` group 5 for the Living-Room LG TV), allowing vertical scrolling on `Home`. Use the requested compact lock state tile and native details popup.
- [ ] Implement the confirmed Home mapping above. Verify the lock tile and native details popup, aquarium state/power, the three camera toggles, and native Denon and LG TV wake-then-select scripts + explicit Off buttons as `pi-kiosk`. Exercise physical controls only during the implementation acceptance test.
- [x] Use the verified MA entities in views 3–6 synced via `input_select.pi_console_player`, including persistence, unavailable-player behavior, and the explicit "Transfer playback to room" action on the `Players` view (`D4`).
- [x] On the Radio view, add large quick-play buttons for the 4 confirmed Radio Paradise FLAC favorites (`library://radio/52`, `library://radio/53`, `library://radio/50`, `library://radio/49`) plus access to browse the full MA Radio library (~75 saved stations + Radio Browser).
- [x] Test all six views as `pi-kiosk` on a regular computer at a `1024×600` viewport. Verify `EN + RU` touch keyboard search, queue changes, selected-room consistency, and isolation from the PC/phone dashboard. Verify on the actual touchscreen later.

**Checkpoint:** All six views and the required music interactions work as `pi-kiosk`, before modifying the Pi kiosk. Keep a sanitized configuration export with the plan's implementation evidence.

### Phase 1A — Clean Up Existing HA Dashboards for PC and Phone

This phase is part of the requested result (`D9`). Keep `Home Console` tuned specifically for the 5-inch `1024×600` Pi touchscreen, and clean up a separate responsive main dashboard for PC and phone users. It can proceed independently of the Pi cutover and must preserve ordinary browser navigation.

1. **Inspect the current dashboards.** Open `map`, `dashboard-cameras`, `dashboard-new`, and the default dashboard on desktop and phone-sized layouts. Capture private before screenshots and record each view/card, its purpose, and its entity/action references. Do not infer visual defects from section counts alone.
2. **Make a content map.** Assign every useful control or status display a destination: retain, reorganize into the responsive PC/phone main dashboard, include in `Home Console` (where part of `D5`/`D8`), or archive as duplicate. Distinguish broken entity references from temporarily unavailable devices. Do not delete a useful offline device merely to make the screen look cleaner.
3. **Correct entity roles.** Use native Denon/LG entities for physical power, input, and TV-app controls; use MA-owned entities for music playback and queues. Treat native/MA pairs as different roles, not duplicate devices to remove from the registry. Check existing scripts, buttons, and navigation links for stale targets.
4. **Rework the layouts.** Group related household controls by room or task, use clear display names and units, and remove accidental repeated cards from the same task flow. Apply the confirmed D5 and D8 controls consistently without constraining the PC/phone dashboard to `1024×600`. Keep diagnostic/configuration switches out of the main daily-control flow while preserving a maintenance route.
5. **Consolidate navigation.** Provide a clean, responsive main everyday dashboard for PC/phone (not constrained to the Pi's `1024×600` 6-view kiosk layout), while keeping `Home Console` dedicated to the Pi (`pi-kiosk`). Keep Cameras and Map as focused destinations where useful. Replace the generic `new` title if that dashboard remains visible. If its content moves elsewhere, hide it from the sidebar after checking the replacement; retain its configuration and URL during the rollback period.
6. **Preserve defaults and links.** Keep existing dashboard URL paths and useful deep links during the first cleanup. Snapshot preferences before adjusting them. Distinguish the administrator's initial default from each user's personal default/sidebar choices. The Pi keeps its dedicated `pi-kiosk` account and explicit `/home-console/ups?kiosk` URL. Do not impose kiosk navigation or the Pi's `input_select.pi_console_player` helper on household PC/phone users.
7. **Use the supported editing model.** Inspect whether the default dashboard is generated before editing it. Prefer a managed custom dashboard for detailed layout work. Do not take control of an automatically generated dashboard without identifying the loss of automatic updates and the recovery method. Do not delete integrations, rename entity IDs, or change device behavior as a shortcut for a dashboard cleanup.
8. **Validate the cleaned result.** Test desktop and narrow phone layouts, navigation links, entity availability displays, and the selected household/media actions as the appropriate regular user. Verify lock tile/icon taps open details without directly toggling the lock. Verify that Kiosk Mode and Swipe Navigation do not hide navigation or intercept gestures on ordinary dashboards.

**Completion evidence:** Save an inventory and before/after content map, private screenshots at desktop and phone sizes, sanitized configuration changes, a list of intentionally retained duplicates, and the dashboard/default/sidebar restore procedure. Delete no dashboard or resource during this phase merely because it was hidden; first verify that no retained dashboard references it.

**Checkpoint:** Existing dashboards have clear purposes, useful controls remain reachable, broken references and accidental duplicates are resolved, normal browser navigation works, and each affected dashboard can be restored independently of the Pi.

### Phase 2 — HACS Kiosk Mode and Swipe Navigation

- [x] After dependency approval, install a selected **Kiosk Mode version compatible with HA `2026.10.4`** (`15.0.0` minimum). Record the exact version; do not treat `15.0.0+` as approval for every future release.
- [x] Install the selected approved **Swipe Navigation (`zanna-37` fork)** version through HACS, confirm resource registration, and refresh the browser page.
- [x] On a test device/display, verify that `?kiosk` hides the header and sidebar **only when used in the URL**. On a regular PC, opening `http://192.168.50.117/<dashboard-path>/ups` without `?kiosk` should preserve normal navigation.
- [x] Test swipes: UPS → Home → Now Playing → Music Library → Players → Radio → UPS, then swipe in the opposite direction. Verified with synthetic browser touch input at `1024×600`; physical Pi input remains open.
- [x] Watch for gesture conflicts with volume sliders, media-library scrolling, and browser gestures. Actual Pi slider/queue/keyboard isolation and vertical Home/library scrolling passed; physical swipes and EN/RU entry were confirmed by the user.
- [x] Verify that `?kiosk` survives swipes and that keyboard input or queue gestures do not trigger view navigation. Test ordinary dashboards because HACS resources can load outside `Home Console`; disable swipe navigation there if needed.
- [x] Adjust `swipe_amount`, `wrap`, and `prevent_default` if needed; do not blindly copy configurations from other projects.

**Important:** Do not enable unconditional `kiosk_mode: kiosk: true` for the entire dashboard if it should also be usable normally from a PC. Instead, enable `?kiosk` **only in the Pi's URL** (or apply Kiosk Mode conditions).

Example of an *incomplete* top-level dashboard configuration, to be added via the **Raw configuration editor**. Do **not** replace existing `views:` with this fragment:

```yaml
swipe_nav:
  wrap: true
  swipe_amount: 25
  prevent_default: true

# Note: ?kiosk is enabled via the URL on Raspberry Pi,
# so a global kiosk_mode section is optional here.
# views: ... the six views already created
```

**Checkpoint:** Swipe navigation works on a touchscreen; normal HA access is unaffected.

### Phase 3 — Re-Point the Local `cage` + Chromium Kiosk on the Pi

> **Important Architecture Note:** The Pi does **not** use a desktop environment (`labwc` / `wayfire` / `X11`). It runs the Wayland kiosk compositor **`cage`** via `/etc/systemd/system/ups-kiosk.service` as user `upsdisplay` on `tty1`, launching `/usr/local/bin/ups-kiosk-browser` (tracked in the repository under `display/`). Keep this lightweight architecture and update its target URL and startup checks.

- [x] Implement and test the small browser supervisor before changing the boot target. Keep process ownership and retry state inside `ups-kiosk.service`. Validate its browser-readiness/reload transport without depending on Docker's Node runtime for HA recovery.
- [x] Keep `ups-peanut`, Docker autostart, and the PeaNUT login helper/timer. Verify the helper's strict PeaNUT origin/path checks; it must never submit credentials to HA. Retain the verified PeaNUT-only readability extension for fallback use.
- [x] Briefly stop the login timer/service and kiosk for a consistent backup of `/var/lib/ups-kiosk/chromium`. Store it privately with the rollback files. Do not copy an active browser profile. Leave all NUT services running.
- [x] Update `/usr/local/bin/ups-kiosk-browser` and the matching repository files to launch the supervisor with these exact destinations:
  - HA: `http://192.168.50.117/home-console/ups?kiosk`.
  - Local UPS fallback: `http://127.0.0.1:8080/device/ups`.
  - If both fail: a visible local offline screen; never an endless blank startup wait.
- [x] Preserve the browser profile, hidden cursor, Chromium sandbox, and `--overscroll-history-navigation=0`. Session-file cleanup must run only while Chromium is stopped. Never erase authentication storage to recover a connection failure.
- [x] Remove `docker.service` from the kiosk unit's `After=`/`Wants=` so HA access can start without Docker. Keep Docker independently enabled for the fallback. Run `daemon-reload`, start the kiosk, and restore the scoped PeaNUT login timer.
- [x] Sign in once as `pi-kiosk` using the tested on-screen keyboard, an optional temporary USB keyboard, or a supported secure login flow. Verify that HA actually retains the session across restarts; do not assume a particular login checkbox exists.
- [x] If authorized login assistance uses loopback CDP over SSH, do not log credentials, tokens, or protocol payloads. Keep the existing loopback-only debug port if recovery or fallback login requires it; remove it only after replacing and testing those uses.
- [x] Implement the runtime failure/recovery policy below and verify browser errors as well as HTTP reachability. HA's root page returning `200` does not prove the authenticated dashboard and live connection are ready.
- [x] Verify display scale and touchscreen behavior at `1024×600`: confirm 100% zoom, hidden mouse cursor (`XCURSOR_PATH=/usr/local/share/ups-kiosk/icons`), and that dashboard cards do not cause unwanted horizontal scrolling.
- [x] Apply `D6`: configure the lightweight Chromium/browser virtual keyboard with **English and Russian (`EN + RU`)** layouts and demonstrate search using both languages without a physical keyboard.
- [x] Apply `D7`: keep the backlight on during the day (`07:00–23:00`); during night hours (`23:00–07:00`) turn the backlight off, wake on first touch without clicking a dashboard button; turn the backlight off after 2 minutes of touch inactivity. Keep UPS monitoring independent of the display policy. Physical first/second-touch behavior was confirmed by the user; three logged night cycles lasted 120 seconds each. Updated by user request: every touch/held contact and its release refresh the 120-second idle timer. The new timing policy passed regression tests; the earlier physical cycles validate the previous fixed-window timing.
- [x] Check that Chromium's CPU/RAM use does not interfere with `nut-server`.

**Checkpoint:** The Pi boots into a usable display even while HA is offline. HA opens without manual login when available. Automatic fallback and return both work; NUT stays available throughout.

#### Runtime Failure and Recovery Policy

The following timing values are **proposed acceptance targets**, not observed results. Record any agreed adjustment before testing.

| Condition | Required behavior | Proposed bound |
|---|---|---|
| Boot with HA unavailable | Open local PeaNUT, restore its scoped login, and keep checking HA | Usable local UPS screen within 30 seconds after the kiosk service starts, when local NUT/PeaNUT are ready |
| HA fails after startup, including an error page during navigation | Detect failure; show local UPS data with an HA-offline indication | Fallback within 60 seconds of sustained failure |
| HA recovers | Require stable reachability and successful authenticated dashboard loading; return to the UPS view | Within 120 seconds after HA is fully ready |
| HA login expires or access is denied | Show a clear sign-in-required state and retain local UPS fallback; require supported reauthentication | No password guessing, token injection, or repeated restart loop |
| PeaNUT/Docker also fails | Show a visible offline state with retry status; keep HA recovery working independently | No blank wait and no NUT/Pi restart |
| Browser crashes or hangs | Restart only the browser/kiosk with capped backoff | Proposed retries: 5, 15, 30, then 60 seconds maximum frequency |
| Both interfaces are available | Stay on HA; do not reload healthy views or interrupt text entry | No periodic unconditional reload |

Probe with timeouts and require consecutive healthy checks before switching back. Log state changes rather than every poll. Cancel/reap owned processes on kiosk shutdown. An unavailable or stale UPS value must be labeled as such; never render a failed read as `0`, `100%`, or Online.

Updated night policy: each touch extends the timeout; a held finger keeps the screen lit, and release starts a full 120-second idle interval. The first wake contact remains consumed.

### Phase 4 — Configure Music and Radio for Touch Control

- [x] Verify that all four MA players (`media_player.denon_avc_x4700h_3`, `media_player.bedroom_3` [Linkplay WiiM Ultra], `media_player.lg_tv_oled83c_2`, `media_player.shield_3`) are visible and responsive, with `Denon AVC-X4700H` set as initial default in `input_select.pi_console_player`.
- [x] On **Now Playing**, show the selected player (`input_select.pi_console_player`), album art, and essential transport controls.
- [x] On **Music Library**, demonstrate full search in `EN + RU` plus play-now, enqueue, play-next, queue inspection, and supported removal/reordering. Define the exact queue controls supported by the selected UI; do not promise unsupported operations.
- [x] Select Bedroom (`media_player.bedroom_3`), then traverse Now Playing → Music Library → Players → Radio. Confirm that every control still targets Bedroom. Reload and restart the kiosk; confirm selection persistence.
- [x] Select another room while Bedroom is playing. Verify Bedroom continues unchanged and no implicit queue transfer occurs. Test the separate explicit **"Transfer playback to room"** button on `Players` and verify that PC/phone dashboard use does not alter `input_select.pi_console_player`.
- [ ] On **Players**, test volume levels, mute, room/player selection, explicit playback transfer, and grouping (where supported by the provider and devices). **Partial:** Denon/LG temporary join/unjoin and queue preservation passed as pi-kiosk at verified zero volume. Since October 28 the player tiles open the native details dialog (volume, mute, Join); on the Pi it opened and closed without player commands. Audible sync and all physical grouping gestures remain unverified.
- [x] On **Internet Radio**, show the 4 confirmed Radio Paradise FLAC favorites (`Radio Paradise (flac)`, `Mellow Mix`, `Global Mix`, `Beyond...`) as quick-play buttons plus access to the full MA Radio library; test playback on the chosen player.
- [x] Verify that swiping from the music screen to the UPS view **does not interrupt playback**. The real Bedroom queue retained its current item and playing state through actual Pi browser touch injection at verified zero volume; cleanup restored its fresh baseline.
- [x] Remember: the Pi is a **controller**, not the playback device. To play audio through the Pi itself, it would need to be configured separately as an audio player; that is **outside this baseline plan**.

**Checkpoint:** Music and radio can be started with a tap, audio plays on the chosen MA player, and controls remain available after switching views.

### Phase 5 — Acceptance, Observation, and Maintenance

- [x] Reboot the Raspberry Pi multiple times. After each restart, `nut-server` must start automatically and `ups-kiosk.service` must open the HA dashboard without manual login or intervention.
- [x] Briefly interrupt HA or network access and verify that Chromium recovers when connectivity returns. Do not perform destructive UPS power tests without a separately approved test plan.
- [ ] Monitor stability for 24–48 hours (free RAM, temperature, Chromium freezes, NUT connectivity). Fixed collection completed; acceptance remains open: 139 unhealthy samples, two boot IDs, and a 676-second gap. See the final observation result in IMPLEMENTATION_STATUS.md; do not silently restart or extend collection.
- [x] Create another configuration backup and document commands for restarting/diagnosing `ups-kiosk.service`.
- [x] Perform the complete rollback drill, then restore the reviewed HA setup and repeat its basic recovery checks.
- [x] **Keep PeaNUT, Docker, persistent data, and scoped login recovery:** they now implement D1. Successful HA tests do not make them unused components.
- [x] Keep `ups-web.service` during the migration. Consider later retirement only through a separate change after verifying that maintenance and fallback paths do not depend on it.
- [x] Keep `nut-server`, `ups-autodetect.service`, and `ups-snmp.service` untouched. Retain a known-good rollback directory and document the selected HACS/MA versions and update procedure.

## 6. Security and Constraints

- Do not expose NUT to the WAN. Restrict TCP port **3493** to the local network and authorized clients.
- Use a dedicated non-admin HA account (`pi-kiosk`) for the touchscreen; avoid using an administrator account on an accessible display. Hiding menus with Kiosk Mode is **not access control**.
- Do not store the HA password in shell scripts or Chromium command-line arguments. Protect `/var/lib/ups-kiosk/chromium` and its backups using OS permissions. The profile can contain both HA authentication tokens and PeaNUT sessions; do not commit or share it.
- Keep Chromium's remote debugging port (`9222`) bound strictly to loopback (`--remote-debugging-address=127.0.0.1`). Verify the listening socket. Remove it only if neither recovery nor scoped fallback login still depends on it and replacement behavior has passed testing.
- If MA Browser Card is used, heed its warning about the `ma_token` in YAML; do not publish it in GitHub repositories, screenshots, or shared links.
- For system stability and storage longevity, avoid excessive log writes and heavy background pages on the Pi.
- Update third-party HACS components **only after** confirming compatibility with the installed HA release.
- Confirm access as the non-admin kiosk user. Menu hiding, confirmation dialogs, and view visibility are presentation features; they do not establish entity-level authorization.
- Keep the PeaNUT helper restricted to its exact loopback origin and login path. Do not extend it to inject HA credentials. Preserve protected PeaNUT credential/data files for fallback and rollback.
- Stay within the trusted LAN for the existing HTTP endpoints. A change to transport or external access requires a separate design and validation step.

## 7. Acceptance Tests

| Test | Success criterion |
|---|---|
| NUT independence | `upsc ups` remains available during kiosk stop/restart, browser failure, and HA outage; no driver/server/configuration changes caused by the kiosk migration |
| Autostart, HA available | Three controlled Pi reboots open HA's UPS view without manual login; NUT and SNMP recover normally |
| Autostart, HA unavailable | Local PeaNUT shows current UPS data within the stated startup target; no blank wait for Lenovo |
| Kiosk | The Pi shows only the HA dashboard (`?kiosk`), with no Chromium frame, cursor, or HA sidebar |
| Swipes | All six views work in both directions; adjusting volume does not accidentally switch views |
| UPS | Values (including enabled `battery_runtime` and `battery_voltage`) match contemporaneous `upsc`/HA samples; unavailable or stale values are clearly identified rather than replaced with healthy defaults |
| Music | Search finds actual configured-provider/library content, and MA audibly plays the selected album/playlist on the chosen physical player |
| Touchscreen search | Enter, edit, clear, and submit searches in both `EN` and `RU` (`D6`) at `1024×600` via the Chromium/browser virtual keyboard, with no physical keyboard; dismiss input without accidental swipes |
| Nighttime backlight (`D7`) | Backlight stays on `07:00–23:00`, turns off `23:00–07:00`, wakes on first touch (consumed without a UI click), then sleeps after 2 minutes of touch inactivity |
| Queue | Inspect the selected player's queue and exercise every promised queue action; verify behavior on the physical player |
| Shared room selection | All four music views follow `input_select.pi_console_player` across swipes, reloads, and kiosk restart |
| Selection isolation | Using the separate PC/phone dashboard does not change the Pi's `input_select.pi_console_player` target |
| Room change & explicit transfer | Changing the control target leaves the original room playing with its original queue (no implicit transfer); the separate explicit "Transfer playback to room" button on `Players` moves the active queue when tapped |
| Unavailable player | Its unavailable state remains visible; actions do not silently target a different room |
| Radio | Each of the 4 Radio Paradise FLAC favorite buttons starts playback with a tap, and full MA Radio library browsing works |
| Continuity | Swiping from Now Playing/Radio to UPS does not stop playback |
| Network and browser errors | Test HA unavailable at boot, failure during initial navigation, and a runtime outage; local fallback and automatic return meet the stated bounds |
| Expired HA session | Local fallback stays usable; a sign-in-required message replaces restart loops; supported reauthentication restores access |
| Fallback failure | With PeaNUT unavailable, show a visible offline state and still return to HA when HA becomes ready |
| Kiosk permissions | All selected Home and music actions work as `pi-kiosk`; no administrator session is needed |
| Home groups | Display the five confirmed groups (`D5` 1–4 + `D8` LG TV) in the selected order at `1024×600` with vertical scrolling; lock tile opens native details without a direct toggle; aquarium readings and camera toggle states match HA |
| Denon Home controls | Explicit Off button and volume use the native receiver entity (`media_player.denon_avc_x4700h`); tapping TV (`TV Audio`) or HEOS (`HEOS Music`) while `off` wakes Denon, waits for readiness, and selects the source |
| Denon isolation and standby | Selecting another MA room does not retarget Denon's Home controls; standby/unavailable volume renders correctly; page load sends no power, source, or volume command |
| LG TV (`D8`) | PC (`HDMI 1`), SHIELD (`SHIELD Game Console` / HDMI 4), and Denon (`Denon Sound Bar` / HDMI 2) buttons select the physical HDMI inputs; YouTube/Plex/Netflix/Apple TV buttons open the native TV apps; MA room changes do not retarget these controls |
| LG TV standby wake | Tapping a source/app button while the TV is `off` wakes the TV, waits for readiness, and selects the source/app; explicit Off button turns the TV off; an unavailable TV does not cause repeated source commands |
| Browser access from PC | `Home Console` and the separate responsive PC/phone dashboard are available directly in HA at `http://192.168.50.117/`; no separate Pi web server is required |
| Existing dashboard cleanup | D9 inventory accounts for every existing dashboard and useful control; repeated cards and broken references are fixed or explicitly recorded, rather than concealed by creating another dashboard |
| Desktop/phone layouts | Cleaned PC/phone dashboard has readable groups, useful labels, no unwanted horizontal overflow, working links, and normal HA navigation at desktop and narrow phone sizes (not constrained to `1024×600`) |
| Sidebar and defaults | Clear visible dashboard titles and deliberate sidebar order/defaults; existing useful URLs work; household preferences and the Pi's dedicated kiosk account do not conflict |
| HA dashboard rollback | Restore one changed dashboard's configuration/metadata and relevant preferences without rolling back the Pi or changing device integrations |
| Rollback | Restore deployed files/profile, running Docker/PeaNUT, and scoped login recovery; verify current UPS data and reboot; NUT remains untouched |
| Observation | Complete 24–48 hours of bounded monitoring; no OOM kills, repeated browser restart loop, thermal throttling, or new stale NUT data attributable to the kiosk |

**Validation status:** These migration acceptance tests are **not run**. Baseline API/SSH, entity membership, current service activity/boot enablement, and current UPS `OL` status were checked during review. Read-only MA library queries returned album, artist, playlist, and radio items. They do not prove search UX, queue control, or playback. A browser screenshot cannot validate physical touch response or audible playback.

## 8. Resilience and Quick Rollback

1. If **Swipe Navigation** is unstable, disable/remove its HACS resource. Ordinary view/tab navigation remains available in a regular browser; on the Pi, temporarily open the dashboard without `?kiosk`.
2. If **Kiosk Mode** does not work, remove `?kiosk` from the URL in `/usr/local/bin/ups-kiosk-browser`. The dashboard itself remains intact.
3. If the HA kiosk has broader issues, perform the complete rollback procedure below. Automatic outage fallback is not a substitute for restoring a known-good configuration.
4. If HA becomes unavailable, use local UPS fallback and troubleshoot Hyper-V/networking on Lenovo independently. **NUT continues running on the Pi.**
5. Keep PeaNUT and its data permanently for D1. Keep `ups-web.service` during migration. Retiring the automatic fallback requires a new user decision and a replacement that passes the same tests.

### HA Dashboard Rollback — Independent of the Pi

Before D9 changes, keep private per-dashboard configuration/metadata snapshots, resource registrations, and default/sidebar preferences with a tested restore method. Preserve generated-dashboard status where applicable; do not treat a generated layout as a missing manual configuration.

For a dashboard regression, restore that dashboard through supported HA editing/API mechanisms, then restore any changed titles, sidebar visibility, and affected user defaults. Restore a shared resource only after checking the versions required by the other dashboards. Verify old URLs and household controls after restoration. Keep the Pi's kiosk profile, NUT, and device integrations unchanged for a layout-only rollback. Use the full HA backup only if targeted restoration is insufficient.

### Complete Pi Kiosk Rollback Procedure

All paths below refer to the private snapshot recorded in Phase 0 and completed with a stopped-browser profile snapshot in Phase 3. Before cutover, verify that the snapshot includes the deployed launcher, unit, login service/timer/helper, readability directory, Chromium profile, metadata, and original enablement states.

1. Verify the snapshot is complete and matches its recorded hashes. Do not overwrite a running installation from an incomplete backup.
2. Ensure Docker and the existing `ups-peanut` container are running. This step is required even if someone previously stopped PeaNUT. Preserve its existing credentials and persistent data:

   ```bash
   sudo systemctl start docker.service
   sudo docker start ups-peanut
   curl --fail --silent --show-error --max-time 3 http://127.0.0.1:8080/api/ping
   ```

   Allow up to 60 seconds for container readiness. If it is still unavailable, inspect Docker/PeaNUT before restoring a launcher that waits for it. Never restart NUT to repair the web UI.
3. Stop browser-related activity before restoring files or the profile:

   ```bash
   sudo systemctl stop ups-kiosk-login.timer ups-kiosk-login.service ups-kiosk.service
   ```

4. Restore the deployed `/usr/local/bin/ups-kiosk-browser`, `/etc/systemd/system/ups-kiosk.service`, login `.service`/`.timer`, helper script, and readability directory from the recorded snapshot. Preserve ownership and executable modes. Restore the stopped-browser profile if needed; preserve the current profile privately before replacing it. Do not merge an active profile or leave new extension files mixed into the restored directory.
5. Reload unit definitions and restore the original boot enablement. For the verified baseline, the kiosk and login timer are enabled:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now docker.service ups-kiosk.service ups-kiosk-login.timer
   ```

   The login helper is a static oneshot service; enable its timer rather than trying to enable the helper service itself. Confirm the container still has its recorded `unless-stopped` restart policy.
6. Verify the browser opens `http://127.0.0.1:8080/device/ups`, scoped login recovers, and displayed values match `upsc ups@localhost`. Check NUT/SNMP service activity and configuration hashes. Finish with a controlled reboot and repeat the checks.

During the rollback drill, record exact copy/restore commands with the real snapshot path and every deployed recovery artifact. An unused helper file may remain, but no new recovery process or timer may continue fighting the restored launcher.

## 9. Verified System Parameters & Confirmed Decisions

### Directly Rechecked During Review (October 27, 2026)
- **HA Versions:** HA Core `2026.10.4`, HA Supervisor `2026.10.4`, HA OS `18.3`, HACS `2.0.5`, Music Assistant `2.10.8`, SpotifyPlus `v1.0.224`.
- **HA URL:** `http://192.168.50.117/` (HTTP port `80`).
- **Pi Kiosk Architecture:** `ups-kiosk.service` running `cage` Wayland compositor + `/usr/local/bin/ups-kiosk-browser` as user `upsdisplay` on `tty1`.
- **Active HA NUT Entities:** `sensor.ups_apc_status`, `sensor.ups_apc_status_data`, `sensor.ups_apc_battery_charge`, `sensor.ups_apc_load`, `sensor.ups_apc_input_voltage`. Enabling `battery_runtime` and `battery_voltage` in HA is confirmed for Phase 1.
- **MA-Owned Media Players:** `media_player.bedroom_3` (verified in HA device registry as **Linkplay WiiM Ultra**, `wiim_uuid:FF98F7F4-0EAC-0ED0-8BA0-CFDBFF98F7F4`), `media_player.denon_avc_x4700h_3`, `media_player.lg_tv_oled83c_2`, `media_player.shield_3`. Audible playback remains to be tested during implementation.
- **Local Fallback:** PeaNUT `6.0.0` running with restart policy `unless-stopped`; login timer and NUT/autodetect/SNMP/kiosk/maintenance services active.
- **Boot Enablement:** `docker.service`, `ups-kiosk.service`, and `ups-kiosk-login.timer` report `enabled`.
- **MA Library & Radio Favorites:** Read-only `get_library` queries succeeded for album, artist, playlist, and radio categories. Four stations are currently marked `favorite: true`: `Radio Paradise (flac)` (`library://radio/52`), `Radio Paradise: Mellow Mix (flac)` (`library://radio/53`), `Radio Paradise: Global Mix (flac)` (`library://radio/50`), and `Radio Paradise: Beyond... (flac)` (`library://radio/49`), alongside ~75 total saved radio stations.
- **Home Mapping & Xiaomi C400 Check:** Selected lock, aquarium, and camera entities were inventoried. Verified that Xiaomi C400 (`chuangmi_sg_1069362690_039c04`) does not expose an illuminance sensor and its IR events (`ir_turned_on_e_2_1`, `ir_turned_off_e_2_2`) report `unknown`. Native Denon integration ownership and the `TV Audio` / `HEOS Music` source options were checked through HA; physical control actions remain untested.
- **Confirmed LG TV Mapping (`D8`):** Native webOS entity (`media_player.lg_webos_tv_oled83c36la`) and source names read from HA and confirmed by user: `PC` = `HDMI 1`, `SHIELD` = `SHIELD Game Console` (HDMI 4), `Denon` = `Denon Sound Bar` (HDMI 2), plus `YouTube`, `Plex`, `Netflix`, and `Apple TV`. Physical switching and wake-up remain to be tested during implementation.
- **Existing Dashboards (baseline):** WebSocket metadata/configuration reads found `map`, `dashboard-cameras`, and `dashboard-new`, all in storage mode and visible in the sidebar, plus the default `lovelace` panel. Phase 1A later completed the visual/layout audit and targeted restore drills; see the D9 implementation record for current results and the retained camera-feed limitation.
- **Text Entry (`D6`):** No OS on-screen keyboard was installed; user confirmed using a lightweight Chromium/browser virtual keyboard supporting `EN + RU` so `cage` stays untouched.

### Confirmed by the User (October 27, 2026)

- **VM Hypervisor:** Hyper-V on Lenovo 720.
- **All Design Decisions (`D1`–`D9`):** Confirmed during the interactive review on October 27, 2026:
  - Enable NUT `battery_runtime` and `battery_voltage` entities in HA.
  - `D2`: Sync the 4 music views on `Home Console` via a dedicated Pi-only helper `input_select.pi_console_player`, defaulting to `Denon AVC-X4700H`.
  - `D4`: Normal room selection never moves active playback; include a separate explicit "Transfer playback to room" button on `Players`.
  - `D5` & `D8`: Include all 5 groups on `Home` (vertical scrolling allowed); tapping a Denon or LG TV source/app button when `off` wakes the device, waits for readiness, and selects that source/app (plus explicit Off buttons).
  - `D6`: `EN + RU` touch keyboard via Chromium/browser virtual keyboard inside `cage`.
  - `D7`: Backlight stays on `07:00–23:00`, turns off `23:00–07:00`, wakes on first touch (consuming that contact), then sleeps after 2 minutes of touch inactivity.
  - `D9`: Keep `Home Console` dedicated to the 5-inch `1024×600` Pi screen and clean up a separate responsive main dashboard for PC/phone.
  - Any later retirement of `ups-web.service` remains a separate maintenance decision; PeaNUT remains required by `D1`.

### Earlier Inventory to Recheck Before Deployment

- Pi OS/hardware: Debian 13 `aarch64`, `1.8 GiB` RAM, `DSI-1` at `1024×600 @ 59.94 Hz`.

## 10. Implementation Sequence (Summary)

1. **Backups and inventory (Phase 0):** Recheck Pi hardware inventory and record private HA/Pi backup and rollback locations.
2. **Feasibility:** Prove full library search, queue control, `input_select.pi_console_player` shared room selection, `EN + RU` browser touch keyboard input, and `pi-kiosk` access. Obtain approval for named new production dependencies before installing them.
3. **HA (Phase 1 & 1A):** Enable NUT runtime/voltage entities, create `Home Console` and its six `1024×600` views, and test their behavior as `pi-kiosk`. Complete Phase 1A cleanup of the separate responsive PC/phone dashboard, with before/after evidence and targeted rollback.
4. **Pi (Phase 2 & 3):** Back up the stopped-browser profile. Deploy runtime recovery, `EN + RU` browser virtual keyboard, and `07:00–23:00` / nighttime wake-on-touch backlight control around the existing Cage/Chromium kiosk. Retain PeaNUT and its scoped login/readability support. Sign in once to HA as `pi-kiosk`.
5. **Acceptance (Phase 4 & 5):** Verify touch, audible playback, explicit queue transfer, wake-and-select on Denon/LG TV, startup, fallback, automatic return, and unchanged NUT operation. Perform the complete rollback drill.
6. **Observation:** Complete 24–48 hours of monitoring, then document operation and updates. Keep the local UPS fallback and known-good backups.

## Sources (Checked October 27, 2026)

- [Kiosk Mode — GitHub / README](https://github.com/NemesisRE/kiosk-mode) — HA compatibility requirements (`15.0.0+` for HA `2026.10.1+`) and the `?kiosk` URL option.
- [Home Assistant Swipe Navigation — GitHub](https://github.com/zanna-37/hass-swipe-navigation) — HACS installation, swipe settings, and `swipe_nav`.
- [Home Assistant — Music Assistant integration](https://www.home-assistant.io/integrations/music_assistant/) — MA-owned entities, playback actions, library/search/queue actions, and duplicated native/MA player entities.
- [Home Assistant — Media control card](https://www.home-assistant.io/dashboards/media-control/) — a built-in card targets an individual `media_player` entity.
- [Home Assistant — Denon AVR Network Receivers](https://www.home-assistant.io/integrations/denonavr/) — native receiver control and network/standby considerations; live source strings are recorded above.
- [Home Assistant — Media player](https://www.home-assistant.io/integrations/media_player/) — power, volume, and source-selection actions.
- [Home Assistant — LG webOS TV](https://www.home-assistant.io/integrations/webostv/) — native input/app source selection and separate wake-up requirements.
- [Home Assistant — Multiple dashboards](https://www.home-assistant.io/dashboards/dashboards/) — generated/custom dashboards, default-dashboard settings, sidebar visibility, and personal preferences.
- [Music Assistant — FAQ: Adding Internet Radio Stations](https://www.music-assistant.io/faq/how-to/) — Radio Browser → Add to library.
- [Music Assistant Browser Card — GitHub](https://github.com/PMizz13/ma-browser-card) — optional browser card and plain-text token warning.
- [Cage Wayland Kiosk Compositor](https://www.hjdskes.nl/projects/cage/) & repo `display/ups-kiosk.service` — existing single-application Wayland kiosk setup on the Pi.

UPS readability update (October 28): deployed 50% larger text/values/icons and a height-filling layout, retaining all five native sensor cards and history actions. Actual Pi rendering verified at 1024×600; see IMPLEMENTATION_STATUS.md. Remaining acceptance gates are unchanged.

Follow-up: another 25% enlargement applied to UPS only (1.875 times original sizes); verified on Pi 1024×600.

Battery runtime uses readable hours/minutes or minutes/seconds according to duration; native unknown/unavailable states and history remain available.

UPS load displays percent plus approximate watts using live rated real power. Both voltages display one decimal; no extra measurement precision is claimed.

UPS header also shows the manufacturer and model from the existing HA device registry.

October 28 source-test update: the user approved the deferred TV/Denon tests. Denon acceptance failed on conflicting native/HEOS source and volume readbacks; recovery and the later external volume change are documented in IMPLEMENTATION_STATUS.md. Further device actions await clarification. TV/grouping gates remain unchecked. Built-in TV Wake-on-LAN configuration exists; wake automation and cold-wake acceptance are unfinished.

Continued source acceptance: physical Denon feedback confirms native readback was stale. The v3 source checks passed quietly, but restoration failed again; overall Denon acceptance remains open. HEOS recovery restored TV Audio/55%/muted. The TV Wake-on-LAN automation is now configured and verified by readback; physical wake/source/grouping tests remain unpassed. See IMPLEMENTATION_STATUS.md.

Post-power-cycle results: Denon TV/HEOS/Off cases passed at zero volume, with a bounded standby delay and an operator restoration retry. TV Wake-on-LAN, Off, all three inputs and four app selections passed. Final Denon mute feedback remains inconsistent, so full restoration/Home acceptance and grouping remain open. Previous YouTube video playback is not claimed restored. See IMPLEMENTATION_STATUS.md.

Physical Denon restoration confirmed by the user: TV Audio, -25 dB, not muted. Native mute feedback is stale. Temporary Denon/LG grouping control passed after opening an empty Cast receiver; no audio/media playback was requested, and queues/settings were preserved. Full physical/audible acceptance and the fixed observation remain open.

UPS switching update, October 30: deployed separate physical UPS devices and stable `sensor.connected_ups_*` adapter sensors. Home Console now follows Eaton 5E 2200 G2; APC is unavailable with its original 22 entity IDs and readable history preserved. Actual Pi rendering, unavailable presentation and recovery after a brief HA adapter disable passed. Nine Python and 22 relevant Node checks passed. Physical USB swapping/disconnection remains unverified. Eaton reports serial `BLANK`; identical serial-less units cannot be distinguished. Measured watts take priority, estimates retain `≈`, and unsupported measurements stay unavailable. Earlier misattributed history is not rewritten. Installation errors/restarts do not count as uninterrupted stability observation; its fixed interval was not reset or extended. See `home_console/UPS_SWITCHING.md` and `IMPLEMENTATION_STATUS.md`.

UPS 1.0.1 follow-up: restored missing migrated labels and enabled implemented Eaton monitoring metrics that inherited disabled defaults. Explicit user disables remain intact. Output voltage/frequency and apparent power are supported; archived service settings remain disabled with readable labels. Live reload verification preserved all 56 previous entity IDs and readable APC history, with zero missing names. Nine Python and eight relevant Node tests passed. Physical USB acceptance remains open.

Pi drawer update, October 30: added a persistent night-backlight switch. Enabled uses 23:00–07:00 with 120 seconds of inactivity; disabled keeps the backlight on. The actual kiosk session verified both settings, page-reload persistence and physical brightness 0→255. Original enabled state restored. Seven Node and fifteen Python tests passed. Physical finger interaction remains unverified. Neither machine was rebooted; no power/media command was sent.

The Pi drawer also offers Light/Dark theme selection through native HA preferences. Both modes and dark-mode persistence after a page reload passed on the actual Pi; original preferences were restored afterward. Eight relevant Node tests passed. Physical finger interaction remains unverified.

Approved passwordless Pi login is now limited to `192.168.50.200/32` as non-admin `pi-kiosk`; normal password authentication remains available. A fresh disposable Pi browser session passed; another PC was denied passwordless access and retained its password form. The temporary session was revoked without clearing the retained kiosk session. Two builder tests passed. Router DHCP reservation was not verified or changed; a new IP requires password login. See `home_console/TRUSTED_PI_LOGIN.md` for rollback.
