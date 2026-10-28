# Home Console implementation record

Updated October 28, 2026, Asia/Jerusalem. **Deployed on the Pi; physical input/night wake, music, live recovery, reboots, kiosk rollback, and approved aquarium/camera switch checks passed. TV/Denon source/grouping tests are deferred by the user. The 48-hour observation remains open.**

[Open the console](http://192.168.50.117/home-console/ups?kiosk). The actual Pi screenshot is [here](../../output/playwright/home-console-pi-ups.png).

## Installed result

```text
Pi touch display -> Cage / Chromium -> Home Assistant Home Console
                                | HA unavailable
                                v
                         local PeaNUT -> offline page if both fail
NUT driver / server / autodetection / SNMP run independently.
```

- Six ordered views: UPS, Home, Now Playing, Music Library, Players, Internet Radio. HA chrome is hidden only with `?kiosk`.
- Non-admin, local-only `pi-kiosk` signs in normally. Its session survived kiosk restarts, browser failure recovery, profile restoration, and two Pi reboots. The existing private browser profile remains in use.
- Native NUT cards use the registered `sensor.ups_battery_runtime` and `sensor.ups_battery_voltage`, plus the existing APC entities. No entity was renamed.
- Home preserves the five approved groups. Lock status is read-only. Denon/LG source scripts use native entities, allowlists, unavailable guards, and bounded readiness waits. Four explicitly approved aquarium/camera switch roundtrips passed as `pi-kiosk` and restored their starting states. The user deferred TV/Denon wake/source and grouping tests: **keep them off for now**.
- Four MA music views follow `input_select.pi_console_player`. Its restored selection is not overridden by a fixed `initial`. Transfer has a separate source helper, explicit confirmation, and a source-queue guard. Room selection alone never transfers a queue.
- MA Browser Card supplies full search/play/enqueue/play-next. The small first-party companion supplies upcoming-item move/remove using stable IDs and fresh target checks. Current/history items stay protected. The browser keyboard supplies EN/RU search, not sign-in/password entry.
- The MA identity is non-admin and restricted to the four verified players. Both Pi helpers are hidden from generated household dashboards. PC/phone controls use fixed rooms without changing the Pi helper.
- D9 responsive Home and Cameras layouts are deployed at their existing URLs. Map and generated Overview remain intact. Home/Cameras independent original-restore/readback/reapply drills passed. See [D9 evidence](D9_DASHBOARD_CLEANUP.md).
- Eight Pi runtime assets are installed. Main kiosk startup no longer depends on Docker. Local PeaNUT, persistent data, scoped login helper/timer, hidden cursor assets, and readability remain available. No new system package was installed.
- `ups-kiosk-screen.service` applies the 07:00–23:00 day schedule and 23:00–07:00 night schedule. Darkness and the complete first wake contact are exclusively grabbed; the current policy sleeps after 120 seconds without touch activity. Every held contact and release refreshes the deadline; first-touch consumption is unchanged. Physical night wake acceptance passed on October 28: the user confirmed the battery pop-up required a **second touch after waking**. Three journal intervals lasted exactly 120 seconds before darkness returned.

## Acceptance actually performed

| Check | Result and boundary |
|---|---|
| Fast checks | **33 Node tests and 12 Python tests passed**. Four added cleanup-policy cases protect against unowned items, incomplete readbacks, and invalid/repeated identities. Operator/browser source syntax and whitespace checks passed. The scoped PeaNUT login test passed. |
| Isolated real Chromium | Two opt-in Linux tests passed on the Pi using temporary profiles and simulated loopback services. They cover authenticated-readiness policy, loading/WS loss/login expiry/local/offline recovery, healthy edit retention, process cleanup, missing/unavailable targets, 403/500 display, EN/RU keyboard, and gesture containment. These fixtures are not real device acceptance. |
| Ordinary kiosk user | Normal HA/MA login, four-player/queue access, helper control, and Bedroom queue actions passed. Administrator access was denied. |
| Audible music | User confirmed **“Yes, clear audio”** from Bedroom/WiiM Ultra at the original 20% volume. |
| Actual card/queue | Play now Mellow, Play next Global, Add to queue Beyond, stable-ID movement/removal, and queue inspection passed. Navigating to UPS preserved playback/order. Selecting Denon left Bedroom unchanged. Bounded cleanup restored the original idle/empty Bedroom queue. |
| Explicit transfer | User approved the brief Bedroom → Denon test while TV Audio was active. Actual Players button and confirmation moved the real queue: Bedroom idle/empty, Denon playing Radio Paradise at reduced 10%. Original queues and TV Audio were restored. A separate correction/readback verified Denon's original 49% volume. Later user power/volume changes were preserved. |
| Actual Pi browser | Chromium touch injection passed the complete six-view loop in both directions with `?kiosk`, EN `Bach` and RU `Аквариум` keyboard entry/submission, and return to UPS. Actual viewport **1024×600**, scale **1**, no document horizontal overflow. This does not prove physical touch/cursor behavior. |
| Actual Pi gesture isolation | Idle Bedroom slider drag **44% → 8% → 44%** stayed on Now Playing. A queue drag stayed on Music Library. The fresh 44% baseline and Denon helper selection were restored. Mute/unmute had already passed with restoration. |
| Physical display/touch/night wake | User photos show the actual UPS dashboard without HA header/sidebar and the battery detail dialog. The user clarified **“Second touch after waking”**: first touch wakes without opening the dialog; the next touch acts normally. Journal cycles **04:27:41–04:29:41**, **04:30:17–04:32:17**, and **04:37:49–04:39:49**, October 28 +02:00, each returned to darkness after 120 seconds. No code/service change was needed. |
| Physical music input | The user answered **“All three work”** for swiping through all six views, English `Bach` search, and Russian `Аквариум` search using the physical Pi keyboard. The user also confirmed **“No pointer is visible”** during normal taps/swipes. |
| Playback while swiping | A real Bedroom queue stayed `playing` with the same current item through actual-Pi injected swipes **Music Library → Players → Radio → UPS**, at verified **zero volume**. Cleanup restored idle/empty Bedroom, its original mute state, Denon selection, and the retry's fresh **1%** starting volume. The earlier 44% snapshot was not imposed on the newer baseline. The first attempt was safely stopped because starting WiiM playback cleared mute; that failed record/history was retained separately. |
| Vertical gestures | Actual Pi touch injection scrolled Home and Music Library while retaining the URL, `?kiosk`, and selected room. Probe setup was corrected to include the root scrolling element and use touch events; no dashboard change was needed. |
| Home source rejection | Two real `pi-kiosk` invalid-source calls passed. Deployed script policies matched the reviewed source. HA traces stopped at `sequence/0` with a false result; no device steps ran. These are negative guard tests, not physical wake/source acceptance. |
| Aquarium/camera controls | After explicit user approval, aquarium **off → on → off**, motion detection **on → off → on**, human tracking **off → on → off**, and camera power **on → off → on** passed with real service/readback checks as `pi-kiosk`. All four starting states were verified again after cleanup; temporary guardians exited. Aquarium power stayed **0 W** during the brief on interval, so consumption under load was not proved. Camera video/tracking effectiveness was not visually verified by these command tests. No lock or TV/Denon power action was issued. |
| Live HA failure | Existing `nft` temporarily blocked only kiosk UID access to HA. Browser navigation failure switched to local PeaNUT in **24.29 s**. No HA service or household network was stopped. |
| Both displays unavailable | Added kiosk-only loopback PeaNUT block: visible offline page in **5.07 s**. Safety guardian and finally cleanup removed the test rules. |
| Live HA return | After rule removal, authenticated Home Console returned in **16.53 s**. NUT remained `OL`. |
| Owned browser crash/hang | SIGKILL crash recovered in **16.75 s**; SIGSTOP hang recovered in **54.93 s**. A bounded thaw guardian protected the hang test. Only the owned Chromium process group was targeted. |
| Full Pi kiosk rollback | Verified original archive hashes, stopped/released Chromium, restored original launcher/unit/profile, and observed the old PeaNUT UPS screen. Then restored the verified HA profile/current files and observed authenticated HA again. Both profiles and archives remain private. This was a kiosk rollback, not a complete OS/HA backup restore. |
| Two actual Pi reboots | Authenticated HA and all recorded NUT/kiosk/helper/Docker/web services returned automatically in **71.75 s** and **64.02 s**, confirmed by three consecutive healthy samples and distinct boot IDs. NUT and HA reported `OL`. |
| HA-blocked cold boot | Temporary one-use unit blocked only kiosk UID HA traffic before kiosk startup. Authenticated local UPS appeared in **20.25 s** from kiosk activation, **7.29 s** after the first successful local PeaNUT ping. Unblock returned authenticated HA in **27.09 s**. Bedroom selection survived; Denon was restored. Test unit/table were removed. An earlier attempt captured local UPS but failed to save cleanup evidence; its partial records are retained separately. |
| Pi isolation | All **14 NUT configuration hashes and three executable hashes** match the fresh pre-cutover baseline. GUI outage/crash/rollback tests did not restart NUT. Normal and HA-blocked full Pi reboots restarted services normally. |
| Resource sample | After interaction tests: roughly **1.0 GiB available RAM**, **753 MiB kiosk-account PSS**, and **59°C**. Account lifetime CPU sum was 25.3% after active browser tests, not a steady-state benchmark. Observation remains necessary. |
| Final HA backup | **`8cc60c4a`**, “Home Console validated - Oct 28”, completed on `hassio.local`, **684871680 bytes**, HA/database/all eight installed addons included, no failed addons/agents/folders. It includes the final swipe fix. |

## Fixes found through acceptance

1. Initialization now tracks the owned HA page after fallback closure. It no longer tries to recreate a startup tab after successful recovery.
2. A bounded Chromium focus-emulation probe permits HA's deferred background rendering. Healthy views and in-progress edits are retained.
3. Supervisor state changes go to the journal under `ups-kiosk-supervisor`; raw browser protocol traffic is never logged by the runtime.
4. Actual Pi reverse swipes exposed competing native browser navigation. Dashboard-scoped **`prevent_default: true`**, `swipe_amount: 25`, and `wrap: true` passed all 12 retests. Slider, keyboard, and companion gestures remain isolated. Ordinary dashboards have swipe navigation disabled.
5. Rollback waits up to five seconds for Chromium to release its profile after service stop. The first drill refused safely before profile movement; the corrected complete drill passed.
6. The first one-time HA sign-in attempt targeted a language-search field and exposed part of the generated kiosk password in a private diagnostic capture. The field was cleared, the capture deleted, and the **password rotated**. Normal login with the replacement was verified. The helper now verifies the deeply focused field and targets the actual Log in label. No administrator or MA token was exposed. Credentials are absent from launcher arguments and repository exports.
7. The playback-swipe acceptance helper now sets and verifies **zero volume before playback**, because WiiM playback cleared a previously verified mute. It restores the fresh volume only after stopping/clearing its owned test queue. A shared, tested cleanup policy refuses incomplete or unowned queues. This changes operator test safety, not ordinary playback behavior.

## Private recovery artifacts

| Artifact | Verified location/state |
|---|---|
| Current Pi rollback root | **`/var/backups/home-console/20261027T210523Z/`**, root-owned `0700`; earlier `/var/backups/home-console/20261027T162212Z/` retained |
| Original kiosk archive | `kiosk.tar`, 77 entries, SHA-256 **`a4cd61d61d51c0ed3d555bd40cacb7e7358c087b1cc0d7fbc977c55bdcb32bb5`** |
| Original stopped profile | `chromium-stopped.tar`, 900 entries, SHA-256 **`941f418c8d18bc96fda7a92fada3969f9270a19c6d880dff4768747a59e43b80`** |
| Verified HA profile / old profile | `chromium-home-console-verified.tar` and `profile-original-after-drill/`; full rollback result in `full-rollback-drill.json` |
| Runtime evidence | `cutover.json`, `deployed-assets-v1.json`, `deployed-assets-current.json`, `final-acceptance-health.json`; current eight hashes also exported to `output/home-console-deployment-current.json` |
| Live test evidence | `live-recovery-test.json`, `live-browser-restart-test.json`, `pi-ui-acceptance.json`, `pi-gesture-acceptance.json`; failed setup attempts retained separately, not reported as passes |
| Durable operator stage | `operator-stage/` in the Pi rollback root; survives reboot unlike `/tmp` |
| Private Windows directory | **`C:\Users\gbolo\.ha_token\home-console-20261027T1825\`**, ACL limited to the user, Administrators, and SYSTEM |
| Original HA backup | `d591bb84`, completed before implementation, 683755520 bytes, HA/database/all addons included |
| Final HA export/backup evidence | `validated-deployment/ha-before.json` and `backup-completion.json`; export SHA-256 `ae39ffb2bb9334911316b855fd5746ef5033a8db2e11a1c6be6031b45b744014` |
| Other protected evidence | D9 before/after screenshots/configurations, playback baselines/cleanup, transfer readbacks, two-reboot record, rotated kiosk credentials, restricted MA identity, and UI deployment journals |
| Latest acceptance evidence | Windows: `physical-music-confirmation.json`, `pi-playback-swipe.json`, retained initial mute-reset attempt/history, `home-source-guard-acceptance.json`, and `home-switch-acceptance.json`. Pi: `pi-scroll-acceptance.json`, `pi-playback-swipe.png`, and `acceptance-after-music-home.json` |
| HA restore entry | Settings → System → Backups → the named backup on Home Assistant's local backup storage |

These snapshots contain sessions, protected PeaNUT credentials, Docker metadata, or private household configuration. Do not commit/share them. Sanitized review exports beside this record omit MA tokens; the dashboard needs a restricted token before redeployment.

## Versions and maintenance

| Component | Verified pin | Served SHA-256 |
|---|---|---|
| Kiosk Mode | `v15.0.0` | `b54c24054c27980faeace330bbf019f3b03e54acfda190573a26026cddbf6cf1` |
| zanna-37 Swipe Navigation | `v1.16.1` | `b2ff77b426145834afee28cf947758fe34d36e0b6330da9d711764bd17e9f148` |
| MA Browser Card | `v3.11.2` | `19c30a9f38e2a03c207b1542c90b4d62126b350875dacd78496ceddf73724d43` |

HA `2026.10.4`, HACS `2.0.5`, MA `2.10.8`, PeaNUT `brandawg93/peanut:6.0.0`, Pi Python `3.13.5`, Chromium `155`. The user approved those three HACS pins, not arbitrary future updates. Snapshot configuration/resources and test as `pi-kiosk` before an update; retain the previous resource and rollback archives.

The active first-party entry is **`/local/home-console/home-console-ui.f4c44a534929.js`** with five verified content-addressed modules. The initial `/local` deployment needed one HA restart; subsequent revisions did not. Existing WebRTC registration was preserved. Temporary File Editor `6.3.0` was stopped with manual start/watchdog off retained. Supervisor's historical SIGTERM/exit-256 `error` record remains; the editor is not left running. The pre-existing camera feed failure is recorded in D9, not claimed repaired.

Kernel logs recorded an unrelated UPS USB disconnect/reconnect at October 27 19:09:26–27 +02:00. Existing autodetection recovered the driver/server/SNMP at 19:09:35; hashes matched. This is one recovered event, not long-term USB proof or a hardware diagnosis.

## Observation and remaining gates

**Running:** `ups-kiosk-observe.service` samples once per minute under the private Pi root. Fixed interval: **2026-10-27T22:25:06Z → 2026-10-29T22:25:06Z**, or **October 28 00:25 → October 30 00:25 Israel time**. The initial 00:11 window was stopped openly for the final cold-boot acceptance; its samples remain in `observation-pre-cold-boot/`. The final window starts after that test. Restarting the collector does not renew its fixed deadline. Collection stops after 48 hours. Initial samples are healthy; elapsed minutes cannot establish 48-hour stability.

A bounded two-hour heartbeat, **Home Console 48-hour stability** (`home-console-48-hour-stability`), follows this thread. It stays quiet when unchanged, reports meaningful problems/final results, and must inspect coverage/gaps before completing the observation gate. The Pi collector runs independently; desktop follow-ups need the operator PC/app available.

During the additional acceptance work, the raw sample at **2026-10-28T02:59:15.947403Z** caught the intentionally navigated browser in `loading`. All nine services were active and both NUT/HA UPS values were `OL`. The raw sample remains unchanged and is specifically annotated in `observation/acceptance-annotations.json`; it must not be treated as an unexplained outage or used to dismiss other failures. At the 05:17 Israel check, 292 samples included this one loading sample, the latest sample was healthy, and the maximum interval was 60.84 seconds. No reboot or observation-deadline reset occurred during these tests.

Remaining acceptance:

- Native Denon/LG wake-and-select/Off and supported grouping are **deferred at the user's explicit request to keep TV and Denon off**. Invalid-source rejection passed without device commands. TV later reported `unavailable`; no wake was attempted.
- Aquarium consumption under load and physical camera tracking/video effectiveness remain unverified. The approved four switch state/permission roundtrips and restoration passed.
- Grouping capability inspection found Denon↔LG candidates; Bedroom and SHIELD had no current group peers. No group was created. Music-to-UPS swipes during a real playing queue have now passed at zero volume; audible Bedroom output had been confirmed earlier.
- Deliberate real-session expiry. Login-expiry behavior passed isolated fixtures; the retained real Pi session was not deliberately expired. HA-blocked cold boot passed separately.
- The complete observation window, sample gaps/trends, and final report. EN/RU checkboxes remain aligned and incomplete for the corresponding gates.

See [operator commands](../../home_console/README.md) and [kiosk diagnostics](../display-kiosk.md). No UPS mains-loss test, full OS restore, or full HA backup restore was performed.

## Краткий статус

Home Console установлена на Pi. Пройдены музыка/явный перенос, адаптивные Home/Cameras с отдельным откатом, реальные резервный экран/возврат, сбой/зависание браузера, полный откат киоска и перезагрузки. Пользователь подтвердил физические свайпы и поиск EN/RU: «All three work». Первое касание пробуждает экран, второе открывает сведения; журнал подтвердил 120 секунд до темноты. На самом Pi проверены вертикальная прокрутка и сохранение реального воспроизведения при свайпах к UPS с нулевой громкостью. После теста восстановлены пустая очередь, исходное отключение звука, выбор Denon и актуальная начальная громкость 1%.

По отдельному разрешению пользователя проверены четыре переключателя аквариума/камеры и возврат исходных состояний. Два запроса неверного источника остановились до команд устройствам. TV/Denon и группы отложены по просьбе «Keep TV and Denon off for now». Потребление аквариума под нагрузкой и визуальная работа слежения камеры не доказаны. Пользователь подтвердил отсутствие указателя: «No pointer is visible». 33 проверки Node, 10 Python и 2 изолированные проверки Chromium пройдены. Наблюдение продолжается до 30 октября 00:25 по Израилю. Один сырой отсчёт `loading` пришёлся на плановый переход страницы при тесте; NUT и службы работали, отсчёт сохранён с точной аннотацией. Отметки EN/RU синхронизированы.

## User-requested inactivity timer update — October 28

Replaced the fixed wake window with 120 seconds of touch inactivity. Every touch refreshes the timer; held contacts keep the display lit, and release starts a full idle interval. Only the first wake contact is consumed. The daytime schedule is unchanged. Twelve focused Python checks passed on Windows; ten policy checks passed against the installed Pi module. Only `ups-kiosk-screen.service` restarted. Kiosk/NUT service identities stayed unchanged and UPS remained `OL`. Physical extension timing has not been repeated since this change; earlier physical 120-second cycles describe the former fixed-window policy.

The private before-policy and deployment journal are in `/var/backups/home-console/20261027T210523Z/idle-timer-update/`. The active policy SHA-256 is `1fde2e4d99922edc8e719ebc030a0107af731943d8b955e9e8b10a715d082a23`; the current eight-asset manifests were updated. The observation deadline was not reset. No Home Assistant configuration, player, queue, TV, or Denon action was changed.

По просьбе пользователя фиксированное окно заменено на 120 секунд без касаний. Удержание и отпускание обновляют таймер; первое касание пробуждения по-прежнему поглощается. Перезапущена только служба экрана; службы киоска/NUT сохранили свои идентификаторы. Новая политика проверена тестами, повторная физическая проверка продления ещё не выполнялась.
