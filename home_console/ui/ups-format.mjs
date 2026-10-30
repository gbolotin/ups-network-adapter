// Return null when the native HA unavailable/unknown display must be retained.
function reading(state, unit) {
  if (state?.attributes?.unit_of_measurement !== unit || typeof state.state !== 'string'
      || state.state.trim() === '') return null;
  const value = Number(state.state);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function formatUpsVoltage(state) {
  const value = reading(state, 'V');
  return value === null ? null : `${value.toFixed(1)} V`;
}

export function upsVoltageCard(config, states) {
  if (config.entity !== 'sensor.connected_ups_battery_voltage') return config;
  const output = 'sensor.connected_ups_output_voltage';
  if (formatUpsVoltage(states?.[config.entity]) !== null || formatUpsVoltage(states?.[output]) === null) return config;
  return { ...config, entity: output, name: 'Output voltage', icon: 'mdi:sine-wave' };
}

export function formatUpsLoad(state, nominalPower, measuredPower) {
  const load = reading(state, '%');
  if (load === null) return null;
  const measured = reading(measuredPower, 'W');
  if (measured !== null) return `${load}% · ${measured.toFixed(0)} W`;
  const watts = reading(nominalPower, 'W');
  if (watts === null || watts === 0) return `${load}% · watts unavailable`;
  return `${load}% · ≈${(load * watts / 100).toFixed(0)} W`;
}

export function formatUpsRuntime(state) {
  if (!state || !['s', 'min', 'h'].includes(state.attributes?.unit_of_measurement)
      || typeof state.state !== 'string' || state.state.trim() === '') return null;
  const value = Number(state.state);
  if (!Number.isFinite(value) || value < 0) return null;
  const seconds = Math.floor(value * ({ s: 1, min: 60, h: 3600 }[state.attributes.unit_of_measurement]));
  if (!Number.isSafeInteger(seconds)) return null;
  const unit = (value, name) => `${value} ${name}${value === 1 ? '' : 's'}`;
  if (seconds >= 3600) return `${unit(Math.floor(seconds / 3600), 'hour')}, ${unit(Math.floor(seconds % 3600 / 60), 'minute')}`;
  if (seconds >= 60) return `${unit(Math.floor(seconds / 60), 'minute')}, ${unit(seconds % 60, 'second')}`;
  return unit(seconds, 'second');
}
