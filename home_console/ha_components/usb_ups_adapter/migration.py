"""One-time supported registry migration; entity IDs and recorder history stay intact."""
from homeassistant.config_entries import ConfigEntryDisabler
from homeassistant.helpers import device_registry as dr, entity_registry as er
from homeassistant.helpers.storage import Store

from . import DOMAIN
from .policy import identity, legacy_metric, legacy_name


async def migrate_legacy(hass, entry, coordinator):
    legacy_id = entry.data["legacy_entry"]
    legacy = hass.config_entries.async_get_entry(legacy_id)
    if not legacy or legacy.domain != "nut":
        raise ValueError("Migration requires the existing NUT config entry")
    registry = er.async_get(hass)
    devices = dr.async_get(hass)
    # Persist source metadata before unloading the old integration.
    for device in dr.async_entries_for_config_entry(devices, legacy_id):
        values = {"ups.mfr": device.manufacturer, "ups.model": device.model,
                  "ups.serial": device.serial_number}
        metadata = identity(values)
        if metadata["identity_quality"] != "serial" and coordinator.data:
            current = coordinator.data["device"]
            if (metadata["manufacturer"], metadata["model"]) == (current["manufacturer"], current["model"]):
                metadata = dict(current)
        if "legacy_entities" in coordinator.inventory.get(metadata["id"], {}):
            continue
        metadata["legacy_device_id"] = device.id
        metadata["legacy_identifiers"] = [list(value) for value in device.identifiers]
        metadata["legacy_entities"] = [
            {"entity_id": entity.entity_id, "unique_id": entity.unique_id,
             "original_name": entity.original_name,
             "disabled_by": entity.disabled_by.value if entity.disabled_by else None}
            for entity in er.async_entries_for_config_entry(registry, legacy_id)
            if entity.device_id == device.id]
        coordinator.inventory[metadata["id"]] = metadata
    await coordinator.store.async_save(coordinator.inventory)
    if not legacy.disabled_by:
        await hass.config_entries.async_set_disabled_by(legacy_id, ConfigEntryDisabler.USER)
    for key, device in coordinator.inventory.items():
        if "legacy_device_id" not in device:
            continue
        identifier = f"{entry.entry_id}_{key}"
        for saved in device["legacy_entities"]:
            entity = registry.async_get(saved["entity_id"])
            metric = legacy_metric(saved["unique_id"])
            # Disabled NUT settings stay registered with their original history.
            suffix = metric or "legacy_" + saved["unique_id"].rsplit("_", 1)[-1]
            if entity is None:
                # Recover an interrupted move using the saved ID, without touching recorder history.
                entity = registry.async_get_or_create(
                    "sensor", DOMAIN, f"{identifier}_{suffix}",
                    suggested_object_id=saved["entity_id"].split(".", 1)[1],
                    original_name=saved.get("original_name") or legacy_name(saved["unique_id"]),
                    has_entity_name=True,
                    config_entry=entry, device_id=device["legacy_device_id"])
                if entity.entity_id != saved["entity_id"]:
                    raise ValueError("Legacy entity ID is occupied; refusing to mix histories")
            elif entity.platform != DOMAIN:
                registry.async_update_entity_platform(
                    entity.entity_id, DOMAIN, new_config_entry_id=entry.entry_id,
                    new_unique_id=f"{identifier}_{suffix}", new_device_id=device["legacy_device_id"])
            # Repair the previous migration once, without undoing later user choices.
            if device.get("registry_repair_version", 0) < 1:
                changes = {}
                if not getattr(entity, "original_name", None):
                    changes.update(original_name=saved.get("original_name") or legacy_name(saved["unique_id"]),
                                   has_entity_name=True)
                if metric and entity.unique_id != f"{identifier}_{suffix}":
                    changes["new_unique_id"] = f"{identifier}_{suffix}"
                original_disabled = saved["disabled_by"]
                if entity.disabled_by != er.RegistryEntryDisabler.USER:
                    if metric and original_disabled in (None, "integration"):
                        changes["disabled_by"] = None
                    elif original_disabled and entity.disabled_by is None:
                        changes["disabled_by"] = er.RegistryEntryDisabler(original_disabled)
                if changes:
                    registry.async_update_entity(entity.entity_id, **changes)
        # Move entities first: HA removes old-entry entities when device ownership changes.
        devices.async_update_device(device["legacy_device_id"], new_config_entry_id=entry.entry_id,
                                    new_identifiers={(DOMAIN, identifier)}, disabled_by=None)
        device["registry_repair_version"] = 1
    await coordinator.store.async_save(coordinator.inventory)


async def restore_legacy(hass, entry):
    """Removal rolls registry ownership back before HA deletes this entry's devices."""
    legacy_id = entry.data["legacy_entry"]
    legacy = hass.config_entries.async_get_entry(legacy_id)
    if not legacy:
        return
    inventory = await Store(hass, 1, f"{DOMAIN}.{entry.entry_id}").async_load() or {}
    registry = er.async_get(hass)
    devices = dr.async_get(hass)
    for device in inventory.values():
        if "legacy_device_id" not in device:
            continue
        for saved in device["legacy_entities"]:
            entity = registry.async_get(saved["entity_id"])
            if entity and entity.platform == DOMAIN:
                registry.async_update_entity_platform(
                    entity.entity_id, "nut", new_config_entry_id=legacy_id,
                    new_unique_id=saved["unique_id"], new_device_id=device["legacy_device_id"])
                disabled = er.RegistryEntryDisabler(saved["disabled_by"]) if saved["disabled_by"] else None
                registry.async_update_entity(entity.entity_id, disabled_by=disabled)
        devices.async_update_device(
            device["legacy_device_id"], new_config_entry_id=legacy_id,
            new_identifiers={tuple(value) for value in device["legacy_identifiers"]}, via_device_id=None)
    await hass.config_entries.async_set_disabled_by(legacy_id, None)
