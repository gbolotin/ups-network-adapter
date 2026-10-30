// Only replace the old UPS references. Other dashboard controls stay unchanged.
export const UPS_ENTITIES = {
  'sensor.ups_apc_status': 'sensor.connected_ups_status',
  'sensor.ups_apc_status_data': 'sensor.connected_ups_status',
  'sensor.ups_apc_battery_charge': 'sensor.connected_ups_battery_charge',
  'sensor.ups_apc_load': 'sensor.connected_ups_load',
  'sensor.ups_apc_input_voltage': 'sensor.connected_ups_input_voltage',
  'sensor.ups_battery_runtime': 'sensor.connected_ups_battery_runtime',
  'sensor.ups_battery_voltage': 'sensor.connected_ups_battery_voltage',
  'sensor.ups_nominal_real_power': 'sensor.connected_ups_nominal_real_power',
};

export const UPS_SUMMARY = `{% if has_value('sensor.connected_ups_connected') %}
{{ state_attr('sensor.connected_ups_connected', 'manufacturer') }} · {{ states('sensor.connected_ups_connected') }}<br>Status: **{{ states('sensor.connected_ups_status') }}**
{% else %}
**UPS not connected or data unavailable**
{% endif %}`;

export function switchUpsDashboard(before) {
  function visit(value) {
    if (typeof value === 'string') {
      if (value.includes('## UPS') && value.includes("device_attr('sensor.ups_apc_status'")) return UPS_SUMMARY;
      return value.replace(/\bsensor\.[a-z0-9_]+\b/g, entity => UPS_ENTITIES[entity] ?? entity);
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
    return value;
  }
  return visit(before);
}
