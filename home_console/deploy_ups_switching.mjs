// Install/configure the local integration, then switch UPS cards with a private journal.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { HomeAssistant } from './ha_client.mjs';
import { assertOutsideRepository } from './ha_snapshot.mjs';
import { switchUpsDashboard } from './ups_switching.mjs';
import { sanitizedConfig } from './enable_music.mjs';

const DOMAIN = 'usb_ups_adapter';
const FILES = ['manifest.json', '__init__.py', 'config_flow.py', 'policy.py', 'nut.py', 'sensor.py', 'migration.py', 'strings.json'];
const hash = text => createHash('sha256').update(text).digest('hex');

export async function editor(ha) {
  const info = await ha.command('supervisor/api', { endpoint: '/addons/core_configurator/info', method: 'get' });
  if (info.version !== '6.3.0' || !info.options.enforce_basepath) throw new Error('Review File Editor configuration');
  const stop = info.state !== 'started';
  if (stop) {
    try { await ha.command('supervisor/api', { endpoint: '/addons/core_configurator/start', method: 'post' }, 45000); }
    catch (error) {
      const current = await ha.command('supervisor/api', { endpoint: '/addons/core_configurator/info', method: 'get' });
      if (current.state !== 'started') throw error;
    }
  }
  const ready = await ha.command('supervisor/api', { endpoint: '/addons/core_configurator/info', method: 'get' });
  const url = new URL(ready.ingress_entry, ha.baseUrl);
  if (url.origin !== ha.baseUrl || !/^\/api\/hassio_ingress\/[\w-]+\/?$/.test(url.pathname)) throw new Error('Unexpected ingress');
  const session = await ha.command('supervisor/api', { endpoint: '/ingress/session', method: 'post' });
  async function request(path, body) {
    const response = await fetch(url.href.replace(/\/$/, '') + path, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Cookie: `ingress_session=${session.session}`, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: body ? new URLSearchParams(body) : undefined,
    });
    if (!response.ok) throw new Error(`File Editor failed (${response.status})`);
    return response;
  }
  return {
    read: async path => (await request('/api/file?filename=' + encodeURIComponent(path))).text(),
    async save(path, text) {
      const saved = await (await request('/api/save', { filename: path, text })).json();
      if (saved.error) throw new Error('File Editor save failed');
      assert.equal(await this.read(path), text);
    },
    async folder(path, name) {
      const saved = await (await request('/api/newfolder', { path, name })).json();
      if (saved.error && !String(saved.message).includes('File exists')) throw new Error('Cannot create component folder');
    },
    async close() {
      if (stop) await ha.command('supervisor/api', { endpoint: '/addons/core_configurator/stop', method: 'post' }, 30000);
    },
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    'token-file': { type: 'string' }, 'snapshot-dir': { type: 'string' },
    phase: { type: 'string', default: 'preflight' },
  } });
  if (!values['token-file'] || !values['snapshot-dir']) throw new Error('Specify protected token and snapshot directory');
  const directory = await realpath(resolve(values['snapshot-dir']));
  assertOutsideRepository(directory, fileURLToPath(new URL('..', import.meta.url)));
  if (!['preflight', 'install', 'update', 'configure', 'cutover'].includes(values.phase)) throw new Error('Unknown phase');
  const path = resolve(directory, 'ups-switching.json');
  const ha = await HomeAssistant.fromFile('http://192.168.50.117', values['token-file']);
  try {
    await ha.connect();
    if (values.phase === 'preflight') {
      const registry = await ha.command('config/entity_registry/list');
      const old = registry.find(e => e.entity_id === 'sensor.ups_apc_status_data' && e.platform === 'nut');
      if (!old) throw new Error('Cannot identify legacy NUT entry');
      const record = { utc: new Date().toISOString(), legacy_entry: old.config_entry_id,
        legacy_device: old.device_id, phase: 'preflight',
        legacy_config: await ha.command('config_entries/get_single', { entry_id: old.config_entry_id }),
        devices_before: await ha.command('config/device_registry/list'),
        registry_before: registry, dashboards: [], files: [] };
      const dashboards = await ha.command('lovelace/dashboards/list');
      for (const dashboard of dashboards) {
        try {
          const before = await ha.command('lovelace/config', { url_path: dashboard.url_path });
          const after = switchUpsDashboard(before);
          if (JSON.stringify(before) !== JSON.stringify(after)) record.dashboards.push({ url_path: dashboard.url_path, before, after });
        } catch (error) {
          if (!error.message.includes('config_not_found')) throw error;
        }
      }
      if (!record.dashboards.some(d => d.url_path === 'home-console')) throw new Error('Expected current console UPS card');
      await writeFile(path, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ preflight: true, dashboards: record.dashboards.map(d => d.url_path), legacy_entry: old.config_entry_id }));
      return;
    }
    const record = JSON.parse(await readFile(path, 'utf8'));
    const save = () => writeFile(path, JSON.stringify(record, null, 2), { mode: 0o600 });
    if (['install', 'update'].includes(values.phase)) {
      const files = await editor(ha);
      try {
        await files.folder('/homeassistant', 'custom_components');
        await files.folder('/homeassistant/custom_components', DOMAIN);
        for (const name of FILES) {
          const target = `/homeassistant/custom_components/${DOMAIN}/${name}`;
          const text = await readFile(new URL(`./ha_components/${DOMAIN}/${name}`, import.meta.url), 'utf8');
          const before = await files.read(target);
          if (values.phase === 'install' && before !== 'File not found' && hash(before) !== hash(text)) throw new Error(`Existing component differs: ${name}`);
          record.files.push({ path: target, before, sha256: hash(text), status: 'pending' });
          await save();
          await files.save(target, text);
          record.files.at(-1).status = 'verified';
          await save();
        }
        await files.folder(`/homeassistant/custom_components/${DOMAIN}`, 'translations');
        await files.save(`/homeassistant/custom_components/${DOMAIN}/translations/en.json`, await readFile(new URL(`./ha_components/${DOMAIN}/strings.json`, import.meta.url), 'utf8'));
      } finally { await files.close(); }
      record.phase = 'installed';
      await save();
      console.log(JSON.stringify({ installed: true, restart_required: true, third_party_packages: 0 }));
    }
    if (values.phase === 'configure') {
      const entries = await ha.command('config_entries/get', { domain: DOMAIN });
      if (entries.length) throw new Error('Adapter already configured; inspect instead of duplicating');
      let flow = await ha.rest('/api/config/config_entries/flow', { method: 'POST', body: { handler: DOMAIN, show_advanced_options: false } });
      if (flow.type !== 'form') throw new Error(`Unexpected initial flow: ${flow.type}`);
      flow = await ha.rest(`/api/config/config_entries/flow/${flow.flow_id}`, { method: 'POST', body: { host: '192.168.50.200', port: 3493, alias: 'ups', legacy_entry: record.legacy_entry } });
      if (flow.type !== 'create_entry') throw new Error(`Adapter setup failed: ${JSON.stringify(flow.errors ?? flow.type)}`);
      record.adapter_entry = flow.result.entry_id;
      record.phase = 'configured';
      await save();
      console.log(JSON.stringify({ configured: true, entry_id: record.adapter_entry }));
    }
    if (values.phase === 'cutover') {
      const states = await ha.rest('/api/states');
      const identity = states.find(s => s.entity_id === 'sensor.connected_ups_connected');
      if (!identity || ['unknown', 'unavailable'].includes(identity.state)) throw new Error('Adapter identity is not live');
      for (const metric of ['battery_charge', 'load', 'status', 'nominal_real_power']) {
        if (!states.some(s => s.entity_id === `sensor.connected_ups_${metric}` && !['unknown', 'unavailable'].includes(s.state))) throw new Error(`Missing live adapter metric ${metric}`);
      }
      if (record.phase === 'cutover_verified') {
        for (const dashboard of record.dashboards) assert.deepEqual(await ha.command('lovelace/config', { url_path: dashboard.url_path }), dashboard.after);
        console.log(JSON.stringify({ cutover: true, already_applied: true, current_ups: identity.state }));
        return;
      }
      // Check every dashboard before changing any of them.
      for (const dashboard of record.dashboards) assert.deepEqual(await ha.command('lovelace/config', { url_path: dashboard.url_path }), dashboard.before);
      record.phase = 'cutover_pending';
      await save();
      for (const dashboard of record.dashboards) {
        await ha.command('lovelace/config/save', { url_path: dashboard.url_path, config: dashboard.after });
        assert.deepEqual(await ha.command('lovelace/config', { url_path: dashboard.url_path }), dashboard.after);
        dashboard.applied = true;
        await save();
      }
      const disabled = await ha.command('config_entries/disable', { entry_id: record.legacy_entry, disabled_by: 'user' });
      if (disabled.require_restart) throw new Error('Legacy integration did not unload');
      const registry = await ha.command('config/entity_registry/list');
      const devices = await ha.command('config/device_registry/list');
      const adapterId = registry.find(e => e.entity_id === 'sensor.connected_ups_connected')?.device_id;
      const physicalIds = new Set(registry.filter(e => e.platform === DOMAIN && e.device_id !== adapterId).map(e => e.device_id));
      const oldDevice = record.devices_before.find(d => d.id === record.legacy_device);
      for (const device of devices.filter(d => physicalIds.has(d.id))) {
        await ha.command('config/device_registry/update', { device_id: device.id, area_id: oldDevice.area_id });
      }
      record.phase = 'cutover_verified';
      await save();
      const consoleDashboard = record.dashboards.find(d => d.url_path === 'home-console');
      await writeFile(fileURLToPath(new URL('../docs/Home_Console_RaspberryPi_Plan/home-console-dashboard.json', import.meta.url)), JSON.stringify(sanitizedConfig(consoleDashboard.after), null, 2) + '\n');
      console.log(JSON.stringify({ cutover: true, current_ups: identity.state, dashboards: record.dashboards.map(d => d.url_path), legacy_history_preserved: true }));
    }
  } finally { ha.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
