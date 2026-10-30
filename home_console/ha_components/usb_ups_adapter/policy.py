"""UPS identity and readings, independent of Home Assistant."""
import hashlib
import json
import math

METRICS = {
    "status": ("Status", None, None, "ups.status"),
    "status_display": ("Status display", None, None, "ups.status.display"),
    "battery_charge": ("Battery charge", "%", "battery", "battery.charge"),
    "load": ("Load", "%", None, "ups.load"),
    "input_voltage": ("Input voltage", "V", "voltage", "input.voltage"),
    "battery_voltage": ("Battery voltage", "V", "voltage", "battery.voltage"),
    "battery_runtime": ("Battery runtime", "s", "duration", "battery.runtime"),
    "nominal_real_power": ("Nominal real power", "W", "power", "ups.realpower.nominal"),
    "real_power": ("Real power", "W", "power", "ups.realpower"),
    "output_voltage": ("Output voltage", "V", "voltage", "output.voltage"),
    "output_frequency": ("Output frequency", "Hz", "frequency", "output.frequency"),
    "apparent_power": ("Apparent power", "VA", "apparent_power", "ups.power"),
    "nominal_apparent_power": ("Nominal apparent power", "VA", "apparent_power", "ups.power.nominal"),
}


def legacy_metric(unique_id):
    return next((metric for metric, description in METRICS.items()
                 if unique_id.endswith("_" + description[3])), None)


def legacy_name(unique_id):
    metric = legacy_metric(unique_id)
    if metric:
        return METRICS[metric][0]
    variable = unique_id.rsplit("_", 1)[-1]
    names = {
        "battery.charge.low": "Low battery setpoint",
        "battery.runtime.low": "Low battery runtime",
        "battery.mfr.date": "Battery manufacture date",
        "battery.type": "Battery chemistry",
        "battery.voltage.nominal": "Nominal battery voltage",
        "input.sensitivity": "Input power sensitivity",
        "input.transfer.high": "High voltage transfer",
        "input.transfer.low": "Low voltage transfer",
        "input.voltage.nominal": "Nominal input voltage",
        "output.frequency.nominal": "Nominal output frequency",
        "output.voltage.nominal": "Nominal output voltage",
        "ups.beeper.status": "Beeper status",
        "ups.delay.shutdown": "UPS shutdown delay",
        "ups.delay.start": "Load restart delay",
        "ups.test.result": "Self-test result",
        "ups.start.battery": "Start on battery",
        "ups.timer.reboot": "Load reboot timer",
        "ups.timer.shutdown": "Load shutdown timer",
        "ups.timer.start": "Load start timer",
    }
    return names.get(variable, variable.replace(".", " ").capitalize())


def identity(values):
    """Never treat a placeholder serial as a physical device identifier."""
    manufacturer = (values.get("device.mfr") or values.get("ups.mfr") or "").strip()
    model = (values.get("device.model") or values.get("ups.model") or "").strip()
    serial = (values.get("device.serial") or values.get("ups.serial") or "").strip()
    if serial.lower() in {"", "blank", "unknown", "(null)", "none", "n/a"} or set(serial) == {"0"}:
        serial = None
    if not manufacturer or not model:
        raise ValueError("UPS manufacturer and model are required")
    parts = [manufacturer, model, serial] if serial else [
        manufacturer, model, values.get("ups.vendorid", ""), values.get("ups.productid", "")]
    key = hashlib.sha256(json.dumps(parts, ensure_ascii=True).encode()).hexdigest()[:24]
    return {"id": key, "manufacturer": manufacturer, "model": model,
            "serial_number": serial, "identity_quality": "serial" if serial else "model_only"}


def metric_value(values, metric):
    if metric == "status_display":
        flags = values.get("ups.status", "").split()
        return "On battery" if "OB" in flags else "Online" if "OL" in flags else values.get("ups.status")
    value = values.get(METRICS[metric][3])
    if metric == "status":
        return value or None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number >= 0 else None
