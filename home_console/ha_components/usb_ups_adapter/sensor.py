"""Stable adapter sensors plus separate, persistent physical UPS sensors."""
from homeassistant.components.sensor import SensorEntity
from homeassistant.core import callback
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from . import DOMAIN
from .policy import METRICS, metric_value


async def async_setup_entry(hass, entry, async_add_entities):
    coordinator = entry.runtime_data
    added = set()

    @callback
    def add_devices():
        entities = []
        for key, device in coordinator.inventory.items():
            if key not in added:
                added.add(key)
                entities.extend(AdapterSensor(coordinator, metric, device) for metric in METRICS)
        if entities:
            async_add_entities(entities)

    async_add_entities([AdapterSensor(coordinator, metric) for metric in ["connected", *METRICS]])
    add_devices()
    entry.async_on_unload(coordinator.async_add_listener(add_devices))


class AdapterSensor(CoordinatorEntity, SensorEntity):
    _attr_has_entity_name = True

    def __init__(self, coordinator, metric, device=None):
        super().__init__(coordinator)
        self.metric = metric
        self.physical = device
        identity = device["id"] if device else "adapter"
        self._attr_unique_id = f"{coordinator.entry.entry_id}_{identity}_{metric}"
        if device:
            self._attr_device_info = DeviceInfo(
                identifiers={(DOMAIN, f"{coordinator.entry.entry_id}_{identity}")},
                name=device["model"], manufacturer=device["manufacturer"],
                model=device["model"], serial_number=device["serial_number"],
                via_device_id=coordinator.adapter_device_id)
        else:
            self._attr_device_info = DeviceInfo(
                identifiers={(DOMAIN, coordinator.entry.entry_id)},
                name="Connected UPS", manufacturer="UPS Network Adapter", model="USB / NUT")
            # Stable, predictable entity IDs, independent of the physical UPS.
            self.entity_id = f"sensor.connected_ups_{metric}"
        if metric == "connected":
            self._attr_name = "Device"
            self._attr_icon = "mdi:power-plug-battery"
        else:
            name, unit, device_class, _ = METRICS[metric]
            self._attr_name = name
            self._attr_native_unit_of_measurement = unit
            self._attr_device_class = device_class
            if unit and metric not in {"battery_runtime", "nominal_real_power"}:
                self._attr_state_class = "measurement"

    @property
    def available(self):
        if not self.coordinator.last_update_success or not self.coordinator.data:
            return False
        if self.physical and self.physical["id"] != self.coordinator.data["device"]["id"]:
            return False
        return self.metric == "connected" or self.native_value is not None

    @property
    def native_value(self):
        if not self.coordinator.data:
            return None
        if self.metric == "connected":
            return self.coordinator.data["device"]["model"]
        return metric_value(self.coordinator.data["values"], self.metric)

    @property
    def extra_state_attributes(self):
        if not self.coordinator.data or not self.available:
            return None
        if self.metric == "connected":
            return self.coordinator.data["device"]
        return {"ups_identity": self.coordinator.data["device"]["id"]}
