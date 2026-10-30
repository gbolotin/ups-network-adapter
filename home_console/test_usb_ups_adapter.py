"""Fast identity and actual TCP protocol tests; no HA install or real UPS."""
import asyncio
import importlib.util
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parent / "ha_components" / "usb_ups_adapter"


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


policy = load("policy")
nut = load("nut")
APC = {"ups.mfr": "American Power Conversion", "ups.model": "Back-UPS BX750MI",
       "ups.serial": "9B2444A13997"}
EATON = {"ups.mfr": "EATON", "ups.model": "Eaton 5E 2200 G2", "ups.serial": "BLANK",
         "ups.vendorid": "0463", "ups.productid": "ffff"}


def load_sensor():
    """Exercise entity behavior with only HA's outer framework replaced."""
    package = ModuleType("adapter_test")
    package.__path__ = [str(ROOT)]
    package.DOMAIN = "usb_ups_adapter"
    sensor_base = ModuleType("homeassistant.components.sensor")
    sensor_base.SensorEntity = type("SensorEntity", (), {})
    core = ModuleType("homeassistant.core")
    core.callback = lambda function: function
    entity = ModuleType("homeassistant.helpers.entity")
    entity.DeviceInfo = dict
    coordinator = ModuleType("homeassistant.helpers.update_coordinator")

    class CoordinatorEntity:
        def __init__(self, coordinator):
            self.coordinator = coordinator

    coordinator.CoordinatorEntity = CoordinatorEntity
    modules = {"adapter_test": package, "adapter_test.policy": policy,
               "homeassistant.components.sensor": sensor_base,
               "homeassistant.core": core, "homeassistant.helpers.entity": entity,
               "homeassistant.helpers.update_coordinator": coordinator}
    spec = importlib.util.spec_from_file_location("adapter_test.sensor", ROOT / "sensor.py")
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, modules):
        spec.loader.exec_module(module)
    return module


sensors = load_sensor()


class AvailabilityTests(unittest.TestCase):
    def test_swap_disconnect_and_return_keep_physical_histories_separate(self):
        apc = policy.identity(APC)
        eaton = policy.identity(EATON)
        coordinator = SimpleNamespace(entry=SimpleNamespace(entry_id="adapter"), adapter_device_id="hub",
                                      last_update_success=True, data=None)
        old = sensors.AdapterSensor(coordinator, "battery_charge", apc)
        current = sensors.AdapterSensor(coordinator, "battery_charge", eaton)
        stable = sensors.AdapterSensor(coordinator, "battery_charge")
        old_id, stable_id = old._attr_unique_id, stable._attr_unique_id
        for device, charge in [(apc, "75"), (eaton, "100"), (apc, "74")]:
            coordinator.data = {"device": device, "values": {"battery.charge": charge}}
            self.assertEqual(old.available, device == apc)
            self.assertEqual(current.available, device == eaton)
            self.assertTrue(stable.available)
            self.assertEqual(stable.native_value, float(charge))
            self.assertEqual(old._attr_unique_id, old_id)
            self.assertEqual(stable._attr_unique_id, stable_id)
            coordinator.last_update_success = False
            self.assertFalse(old.available)
            self.assertFalse(current.available)
            self.assertFalse(stable.available)
            coordinator.last_update_success = True

    def test_missing_voltage_never_reuses_previous_ups_measurement(self):
        coordinator = SimpleNamespace(entry=SimpleNamespace(entry_id="adapter"),
                                      last_update_success=True,
                                      data={"device": policy.identity(EATON), "values": EATON})
        voltage = sensors.AdapterSensor(coordinator, "battery_voltage")
        self.assertFalse(voltage.available)
        self.assertIsNone(voltage.native_value)
        connected = sensors.AdapterSensor(coordinator, "connected")
        self.assertEqual(connected.native_value, "Eaton 5E 2200 G2")
        self.assertEqual(connected.extra_state_attributes["identity_quality"], "model_only")


class IdentityTests(unittest.TestCase):
    def test_swap_and_return_preserve_identity(self):
        old = policy.identity(APC)
        self.assertNotEqual(old["id"], policy.identity(EATON)["id"])
        self.assertEqual(old, policy.identity(dict(APC, **{"battery.charge": "52"})))
        self.assertNotEqual(old["id"], policy.identity(dict(APC, **{"ups.serial": "another"}))["id"])

    def test_placeholder_serial_is_explicitly_model_only(self):
        original = policy.identity(EATON)
        self.assertIsNone(original["serial_number"])
        self.assertEqual(original["identity_quality"], "model_only")
        for value in ["BLANK", "unknown", "000000", "", "(null)"]:
            self.assertEqual(original, policy.identity(dict(EATON, **{"ups.serial": value})))

    def test_missing_metadata_and_nonfinite_readings_do_not_reuse_old_values(self):
        with self.assertRaises(ValueError):
            policy.identity({"ups.status": "OL"})
        for value in [None, "", "NaN", "inf", "-1", "unknown"]:
            self.assertIsNone(policy.metric_value({"battery.voltage": value}, "battery_voltage"))
        self.assertIsNone(policy.metric_value(EATON, "battery_voltage"))
        self.assertEqual(policy.metric_value({"ups.realpower": "107"}, "real_power"), 107)


class NutTests(unittest.IsolatedAsyncioTestCase):
    async def query(self, response):
        requests = []

        async def handler(reader, writer):
            requests.append(await reader.readline())
            writer.write(response.encode())
            await writer.drain()
            writer.close()
            await writer.wait_closed()

        server = await asyncio.start_server(handler, "127.0.0.1", 0)
        async with server:
            result = await nut.read_vars("127.0.0.1", server.sockets[0].getsockname()[1], "ups")
        self.assertEqual(requests, [b"LIST VAR ups\n"])
        return result

    async def test_reads_fresh_complete_data_without_any_control_commands(self):
        result = await self.query('BEGIN LIST VAR ups\nVAR ups ups.status "OL"\nVAR ups ups.model "Eaton 5E 2200 G2"\nEND LIST VAR ups\n')
        self.assertEqual(result["ups.model"], "Eaton 5E 2200 G2")

    async def test_disconnect_stale_and_partial_data_fail_closed(self):
        for response in ["ERR DATA-STALE\n", "ERR UNKNOWN-UPS\n", "BEGIN LIST VAR ups\n",
                         "BEGIN LIST VAR ups\nVAR ups battery.charge \"100\"\nEND LIST VAR ups\n"]:
            with self.subTest(response=response), self.assertRaises(ValueError):
                await self.query(response)


if __name__ == "__main__":
    unittest.main()
