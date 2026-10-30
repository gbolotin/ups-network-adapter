"""Model HA registry lifecycle rules to test migration and interrupted recovery."""
from copy import deepcopy
from enum import StrEnum
import importlib.util
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

from home_console.test_usb_ups_adapter import policy, APC, EATON


class Disabler(StrEnum):
    USER = "user"
    INTEGRATION = "integration"
    CONFIG_ENTRY = "config_entry"


class MigrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_mixed_devices_keep_ids_and_restore_on_removal(self):
        await self.exercise(interrupted=False)

    async def test_interrupted_device_move_recovers_missing_entity_without_new_id(self):
        await self.exercise(interrupted=True)

    async def exercise(self, interrupted):
        legacy = SimpleNamespace(domain="nut", disabled_by=None)
        original = {
            "sensor.ups_apc_load": SimpleNamespace(entity_id="sensor.ups_apc_load", unique_id="APC_ups.load", platform="nut", config_entry_id="old", device_id="apc", disabled_by=None),
            "sensor.eaton_load": SimpleNamespace(entity_id="sensor.eaton_load", unique_id="old_ups.load", platform="nut", config_entry_id="old", device_id="eaton", disabled_by=None),
        }
        for entity in original.values():
            entity.original_name = "Load"
        original["sensor.eaton_runtime"] = SimpleNamespace(
            entity_id="sensor.eaton_runtime", unique_id="old_battery.runtime", original_name="Battery runtime",
            platform="nut", config_entry_id="old", device_id="eaton", disabled_by=Disabler.INTEGRATION)
        original["sensor.eaton_low_battery"] = SimpleNamespace(
            entity_id="sensor.eaton_low_battery", unique_id="old_battery.charge.low", original_name="Low battery setpoint",
            platform="nut", config_entry_id="old", device_id="eaton", disabled_by=Disabler.INTEGRATION)
        entities = deepcopy(original)
        devices = {
            "apc": SimpleNamespace(id="apc", manufacturer=APC["ups.mfr"], model=APC["ups.model"], serial_number=APC["ups.serial"], config_entry_id="old", identifiers={("nut", "APC")}),
            "eaton": SimpleNamespace(id="eaton", manufacturer=EATON["ups.mfr"], model=EATON["ups.model"], serial_number=None, config_entry_id="old", identifiers={("nut", "old")}),
        }
        persisted = {}

        class Store:
            def __init__(self, *args):
                pass

            async def async_save(self, value):
                persisted.clear()
                persisted.update(deepcopy(value))

            async def async_load(self):
                return deepcopy(persisted)

        class Registry:
            def async_get(self, entity_id):
                return entities.get(entity_id)

            def async_update_entity_platform(self, entity_id, platform, **changes):
                entity = entities[entity_id]
                entity.platform = platform
                entity.config_entry_id = changes["new_config_entry_id"]
                entity.unique_id = changes["new_unique_id"]

            def async_update_entity(self, entity_id, **changes):
                for key, value in changes.items():
                    setattr(entities[entity_id], "unique_id" if key == "new_unique_id" else key, value)

            def async_get_or_create(self, domain, platform, unique_id, *, suggested_object_id, config_entry, device_id, original_name, has_entity_name):
                entity_id = domain + "." + suggested_object_id
                entities[entity_id] = SimpleNamespace(entity_id=entity_id, unique_id=unique_id,
                    platform=platform, config_entry_id=config_entry.entry_id, device_id=device_id,
                    original_name=original_name, disabled_by=None)
                return entities[entity_id]

        class Devices:
            def async_update_device(self, device_id, **changes):
                device = devices[device_id]
                old_entry = device.config_entry_id
                device.config_entry_id = changes["new_config_entry_id"]
                device.identifiers = changes["new_identifiers"]
                # HA immediately removes entities still owned by the old entry.
                if old_entry != device.config_entry_id:
                    for entity_id, entity in list(entities.items()):
                        if entity.device_id == device_id and entity.config_entry_id == old_entry:
                            del entities[entity_id]

        async def disable(entry_id, disabled_by):
            legacy.disabled_by = disabled_by

        hass = SimpleNamespace(config_entries=SimpleNamespace(
            async_get_entry=lambda entry_id: legacy,
            async_set_disabled_by=disable))
        coordinator = SimpleNamespace(inventory={}, store=Store(),
            data={"device": policy.identity(EATON), "values": EATON})
        entry = SimpleNamespace(entry_id="new", data={"legacy_entry": "old"})
        registry = Registry()
        device_registry = Devices()
        er = SimpleNamespace(async_get=lambda hass: registry, RegistryEntryDisabler=Disabler,
            async_entries_for_config_entry=lambda registry, entry_id: [e for e in entities.values() if e.config_entry_id == entry_id])
        dr = SimpleNamespace(async_get=lambda hass: device_registry,
            async_entries_for_config_entry=lambda registry, entry_id: [d for d in devices.values() if d.config_entry_id == entry_id])
        package = ModuleType("migration_test")
        package.DOMAIN = "usb_ups_adapter"
        helpers = ModuleType("homeassistant.helpers")
        helpers.device_registry = dr
        helpers.entity_registry = er
        config_entries = ModuleType("homeassistant.config_entries")
        config_entries.ConfigEntryDisabler = Disabler
        storage = ModuleType("homeassistant.helpers.storage")
        storage.Store = Store
        modules = {"migration_test": package, "migration_test.policy": policy,
            "homeassistant.helpers": helpers, "homeassistant.config_entries": config_entries,
            "homeassistant.helpers.storage": storage}
        spec = importlib.util.spec_from_file_location("migration_test.migration",
            Path(__file__).parent / "ha_components/usb_ups_adapter/migration.py")
        migration = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, modules):
            spec.loader.exec_module(migration)
        await migration.migrate_legacy(hass, entry, coordinator)
        self.assertEqual(set(entities), set(original))
        self.assertTrue(all(entity.platform == "usb_ups_adapter" for entity in entities.values()))
        self.assertIn(policy.identity(EATON)["id"], coordinator.inventory)
        self.assertIsNone(entities["sensor.eaton_runtime"].disabled_by)
        self.assertEqual(entities["sensor.eaton_low_battery"].disabled_by, Disabler.INTEGRATION)
        # Reproduce the deployed v1 damage: missing labels and inherited defaults.
        entities["sensor.eaton_runtime"].original_name = None
        entities["sensor.eaton_runtime"].disabled_by = Disabler.INTEGRATION
        entities["sensor.eaton_low_battery"].original_name = None
        coordinator.inventory[policy.identity(EATON)["id"]]["registry_repair_version"] = 0
        await migration.migrate_legacy(hass, entry, coordinator)
        self.assertEqual(entities["sensor.eaton_runtime"].original_name, "Battery runtime")
        self.assertIsNone(entities["sensor.eaton_runtime"].disabled_by)
        self.assertEqual(entities["sensor.eaton_low_battery"].original_name, "Low battery setpoint")
        self.assertEqual(entities["sensor.eaton_low_battery"].disabled_by, Disabler.INTEGRATION)
        entities["sensor.eaton_runtime"].disabled_by = Disabler.USER
        if interrupted:
            del entities["sensor.eaton_load"]
        # Retry is idempotent, including a missing registry entry from an interrupted move.
        await migration.migrate_legacy(hass, entry, coordinator)
        self.assertEqual(set(entities), set(original))
        self.assertEqual(entities["sensor.eaton_runtime"].disabled_by, Disabler.USER)
        await migration.restore_legacy(hass, entry)
        self.assertEqual(set(entities), set(original))
        for entity_id, entity in entities.items():
            for name in ["entity_id", "unique_id", "platform", "config_entry_id", "device_id", "disabled_by", "original_name"]:
                self.assertEqual(getattr(entity, name), getattr(original[entity_id], name))
        self.assertIsNone(legacy.disabled_by)


if __name__ == "__main__":
    unittest.main()
