# Household dashboard cleanup evidence

October 27, 2026. The responsive layout is deployed and the targeted restore drills passed. Physical household-device acceptance remains separate.

## Before and after

| Original content | Destination and behavior |
|---|---|
| `dashboard-new`, title `new`, five sections with generic headings | Same URL, title **Home**, responsive Home/Music/UPS views; original `/dashboard-new/0` remains valid |
| Seven native Denon presentations for status, power, playback, volume buttons/slider, source, and sound mode | Living-room receiver section: native media control, full-width volume/source/sound-mode tile, explicit Off/TV/HEOS buttons; unique functions retained |
| MA Denon media control and MA source tile | Music view, separate from native hardware controls; Music Assistant remains reachable for full library/source work |
| Front-door lock commands | Entry section on household Home; existing household control retained. Home Console's lock stays read-only |
| SpotifyPlus source control | Music services section; fixed Spotify entity retained |
| Missing daily aquarium, camera, and LG groups | Confirmed D5/D8 controls reused from the same configuration builder as Home Console |
| Camera feed and position controls | `/dashboard-cameras/0` retains the feed and daily toggles; `/dashboard-cameras/positions` retains the original position controls and a Back link |
| Empty camera section and empty final `new` section | Removed; neither contained a useful control |
| Map strategy dashboard | Preserved as generated; Map link retained |
| Generated Overview and legacy `lovelace` configuration result | Preserved; no takeover, deletion, or forced default change |

The Home and Music layouts use fixed device entities. They never read or write `input_select.pi_console_player`. TV/receiver source buttons reuse the fixed native wake/select scripts. MA entities remain music targets.

## Validation

- Audited all four existing destinations on desktop and narrow phone layouts. Requested viewport sizes were 1440×900 and 390×844; scrollbar/capture dimensions vary. The first desktop capture was 1270×714. These are browser checks, not physical phone tests.
- Verified the cleaned Home layout, Music rooms link, UPS tab, Cameras route, saved-position subview, and Back navigation as non-admin `pi-kiosk`.
- Corrected the cramped receiver/TV controls found on the phone pass. Both volume controls now span the full section width. Native source/sound-mode controls remain available.
- Preflight required every original entity reference to survive and every referenced entity to exist. Service identifiers are excluded from entity-reference checks. No integration or entity ID was renamed or deleted.
- Deployment verified supported HA save/readback, unchanged current-user frontend preferences, and unchanged Pi room selection. Ordinary navigation remains visible; Swipe Navigation is disabled on both managed household dashboards.
- Independently restored and read back the original Home and Cameras configurations/metadata, then reapplied and verified their current configurations. Both drills completed at `2026-10-27T20:53:58Z`. No generated dashboard or shared resource was restored.
- Device power/source, lock, aquarium, camera rotation, and other household actions were not activated merely to validate layout. Music playback/mute/transfer acceptance is recorded separately.

The original camera page displayed **Unable to play media** during the before audit. Its stream configuration and controls were preserved. Cleanup does not establish camera-stream recovery. Offline devices are retained rather than treated as broken references.

## Intentionally retained overlap

Native Denon/LG and MA entities serve different roles. Household controls also appear in Home Console for the dedicated Pi. Camera tracking appears with daily controls and with saved-position work. These routes remain useful and are not accidental repeated cards within one task flow.

## Private evidence and restore

Private root: `C:\Users\gbolo\.ha_token\home-console-20261027T1825\`.

- `d9-before.json`: original manual/generated configs and metadata.
- `d9-journal.json`, `d9-after.json`, `d9-after-responsive.json`: deployment and phone-width revision.
- `d9-restore-drill-dashboard-new.json`, `d9-restore-drill-dashboard-cameras.json`: independent restore/reapply results.
- `d9-screenshots\`: before/after desktop and phone screenshots. Camera/map images remain private.

Current secret-free household export: [home-console-household.json](home-console-household.json). The camera config stays private because its feed may contain credentials. The builder preserves that private feed unchanged.

Use [restore_household.mjs](../../home_console/restore_household.mjs) with `--dashboard dashboard-new` or `--dashboard dashboard-cameras`, the existing protected `--snapshot-dir`, and `--token-file`. Choose `--mode restore`, `--mode reapply`, or `--mode drill`. Without `--apply`, the command performs read-only preflight. The command refuses independently changed configs and existing operation journals. Inspect the journal before resuming an interrupted operation.

No user default or sidebar preference was changed, so no preference restoration is needed. The original snapshot still preserves the earlier preferences. Keep original URLs and configs during the rollback period.
