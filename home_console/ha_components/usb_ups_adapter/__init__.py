"""Separate a stable adapter from the physical UPS currently connected to it."""
from datetime import timedelta
import logging

from homeassistant.const import Platform
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.storage import Store
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .nut import read_vars
from .policy import identity

DOMAIN = "usb_ups_adapter"
LOGGER = logging.getLogger(__name__)


class AdapterCoordinator(DataUpdateCoordinator):
    def __init__(self, hass, entry):
        super().__init__(hass, LOGGER, config_entry=entry, name="USB UPS Adapter",
                         update_interval=timedelta(seconds=10))
        self.entry = entry
        self.inventory = {}
        self.store = Store(hass, 1, f"{DOMAIN}.{entry.entry_id}")

    async def _async_update_data(self):
        try:
            values = await read_vars(**{key: self.entry.data[key] for key in ("host", "port", "alias")})
            device = identity(values)
        except (OSError, TimeoutError, ValueError) as error:
            raise UpdateFailed("UPS disconnected or NUT data unavailable") from error
        saved = self.inventory.get(device["id"], {})
        if any(saved.get(key) != value for key, value in device.items()):
            self.inventory[device["id"]] = {**saved, **device}
            await self.store.async_save(self.inventory)
        return {"device": device, "values": values}


async def async_setup_entry(hass, entry):
    coordinator = AdapterCoordinator(hass, entry)
    coordinator.inventory = await coordinator.store.async_load() or {}
    # Set up even while disconnected. Saved physical devices remain unavailable.
    await coordinator.async_refresh()
    if entry.data.get("legacy_entry"):
        from .migration import migrate_legacy
        await migrate_legacy(hass, entry, coordinator)
    entry.runtime_data = coordinator
    adapter = dr.async_get(hass).async_get_or_create(
        config_entry_id=entry.entry_id, identifiers={(DOMAIN, entry.entry_id)},
        name="Connected UPS", manufacturer="UPS Network Adapter", model="USB / NUT")
    coordinator.adapter_device_id = adapter.id
    await hass.config_entries.async_forward_entry_setups(entry, [Platform.SENSOR])
    return True


async def async_unload_entry(hass, entry):
    return await hass.config_entries.async_unload_platforms(entry, [Platform.SENSOR])


async def async_remove_entry(hass, entry):
    if entry.data.get("legacy_entry"):
        from .migration import restore_legacy
        await restore_legacy(hass, entry)
