# Connected USB UPS

The Home Console card follows one stable NUT endpoint. Each physical UPS has its own device and sensor history.

```text
USB UPS → Raspberry Pi autodetect → NUT ups:3493
                                      ↓ read-only, every 10 seconds
                              USB UPS Adapter in HA
                                ├─ stable Connected UPS sensors → console / automations
                                └─ physical UPS sensors → separate histories
```

## Identity and availability

- `sensor.connected_ups_connected` contains the current model, manufacturer, serial number and identity quality.
- `sensor.connected_ups_status`, `battery_charge`, `load`, `input_voltage`, `battery_voltage`, `battery_runtime`, `nominal_real_power`, and `real_power` share the same stable prefix.
- Physical identity uses manufacturer, model and serial number. Missing/placeholder serials use manufacturer, model and USB vendor/product IDs. Two identical serial-less devices cannot be distinguished.
- The adapter polls the read-only NUT `LIST VAR` command every ten seconds. It never controls the UPS or restarts the Pi driver.
- On a change, old physical sensors become unavailable. On return, the same device and sensor IDs resume. The inventory survives HA restarts.
- Network failures, `DATA-STALE`, missing identity and incomplete responses fail closed. They never retain the previous device as the current one.
- Unsupported measurements are unavailable, rather than zero or the previous UPS value.
- Eaton measured `ups.realpower` takes priority. When absent, the card labels its load × nominal real-power estimate with `≈`. VA is never substituted for watts.
- Stable adapter history intentionally follows the connection. Use physical-device sensors when comparing the history of one UPS.

## Deployment

The first-party custom integration lives in `ha_components/usb_ups_adapter`. It uses HA APIs and Python's standard library, with no additional packages. A HA restart is required after first installation.

`deploy_ups_switching.mjs` has explicit phases: `preflight`, `install`, `configure`, `cutover`. Use `update` to repair existing component files; it records their previous contents in the same private journal. Supply `--token-file` and an existing private `--snapshot-dir` outside Git. The private `ups-switching.json` journal saves registry metadata and before/after configurations. Deploy the matching UI assets with `deploy_ui.mjs` before cutover. Do not regenerate the foundation dashboard over the live console.

The optional `legacy_entry` migration disables the old NUT integration, moves its device and sensor registry entries through HA's supported migration APIs, and preserves entity IDs. The recorder database is not rewritten. Existing history remains as recorded, including any Eaton samples that the old integration already wrote under APC before this fix. Disabled legacy settings remain registered; this read-only integration exposes the listed monitoring metrics.

The main Home Console and household UPS views use the stable adapter sensors. Physical devices appear separately in Home Assistant. Assign physical devices to their actual area. Keep the adapter unassigned to avoid duplicate tiles in generated area dashboards.

## Rollback

Do not simply re-enable native NUT after migration: its entities have moved to another platform. Preserve the private preflight registry and HA backup.

1. Remove the adapter integration through HA's integration API/UI. Its removal hook restores migrated entity platforms/config entries/unique IDs and device identifiers through supported APIs, then re-enables native NUT. Do not delete the component files first.
2. Verify native NUT loaded and the migrated entity IDs returned to platform `nut`. For interrupted removal, recover from the private `registry_before`, `devices_before`, and integration inventory records through HA's registry APIs. Do not edit `.storage` directly.
3. Restore only the affected UPS references from the dashboard journal; preserve subsequent unrelated edits.
4. Restore the previous Home Console module resource from `ui-ups-switching.json` if required.

The rollback restores the former integration's fixed-device behavior. It does not make that integration support hot swapping.

## Verification boundary

Fast tests cover physical identity/return, placeholder serials, missing/nonfinite readings, full and partial NUT responses, stale/disconnected errors, card reference replacement and watts selection. Live checks must separately confirm HA setup/migration, Eaton readings and rendered console. A real USB swap or cable disconnect requires physical hardware and is not implied by fixture tests.

## Registry repair in 1.0.1

The interrupted initial migration preserved some disabled defaults from native NUT and lost labels on recovered entries. Version 1.0.1 restores missing labels and enables implemented monitoring metrics that inherited an integration default. Explicit user disables are preserved. This repair runs once per migrated device; subsequent starts do not reset entity enable/disable choices. New recovery records also save and restore original names directly.

Output voltage/frequency and apparent/nominal apparent power are now implemented monitoring metrics. Other archived legacy settings keep descriptive labels and remain disabled; they are not implemented control entities. Physical battery voltage remains unavailable when the UPS does not report it.

Live verification after an integration reload preserved all 56 prior entity IDs, found zero missing names, read the original APC history, and confirmed seven repaired Eaton readings. Evidence: `output/ups-label-repair-validation.json`. Nine Python regression tests and eight relevant Node tests passed.

## Console voltage and optional output control

The console prefers Battery voltage when available. Otherwise it displays Output voltage, retaining the corresponding native sensor action. Unsupported readings stay unavailable.

Monitoring and the SNMP bridge stay read-only. The separate Pi kiosk control service exposes authenticated `GET /ups` capabilities and `POST /ups/off`. The console shows the output-off button only when `load.off` is supported and the backend identity matches the connected HA device. Native HA confirmation explains that connected equipment immediately loses power.

`deploy_ups_power.mjs` installs the helper and a dedicated NUT account limited to `load.off`. Root-only credentials live in `/etc/ups-network-adapter/ups-power.json`. HA REST commands hold the existing Pi bearer token server-side. The helper checks identity before and after NUT authentication, rejects malformed requests, and limits successful commands to one per minute. It never accepts arbitrary NUT commands.

Private deployment journals preserve the prior HA YAML. Pi backups live under `/var/backups/home-console/<revision>`. For rollback, restore the affected assets and `upsd.users` from that revision, reload `nut-server.service`, restart `ups-kiosk-control.service`, and restore only the appended HA REST entries before reloading REST commands.

Validation used fake NUT commands, real read-only capabilities and authentication, and rendered console checks. No physical output-off command was sent. Fonts and sensor icons are doubled; the view scrolls when enlarged content exceeds the screen height.
