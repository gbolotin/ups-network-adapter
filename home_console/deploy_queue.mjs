// Deploys only this repository's two queue assets through the existing File Editor.
import { createHash } from 'node:crypto';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { HomeAssistant } from './ha_client.mjs';
import { assertOutsideRepository } from './ha_snapshot.mjs';
import { buildDashboard } from './dashboard.mjs';
import { visitCards } from './enable_music.mjs';
import { APPROVED } from './install_hacs.mjs';

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

async function main() {
  const { values } = parseArgs({ options: {
    'token-file': { type: 'string' }, 'snapshot-dir': { type: 'string' },
  } });
  if (!values['token-file'] || !values['snapshot-dir']) throw new Error('Specify --token-file and --snapshot-dir');
  const directory = await realpath(resolve(values['snapshot-dir']));
  assertOutsideRepository(directory, fileURLToPath(new URL('..', import.meta.url)));
  const policy = await readFile(new URL('./ui/queue-policy.mjs', import.meta.url), 'utf8');
  const policyName = `queue-policy.${hash(policy).slice(0, 12)}.js`;
  const source = await readFile(new URL('./ui/home-console-queue.js', import.meta.url), 'utf8');
  if (!source.includes("'./queue-policy.mjs'")) throw new Error('Review the queue policy import before deployment');
  const script = source.replace("'./queue-policy.mjs'", `'./${policyName}'`);
  const assets = [{ name: policyName, text: policy }, { name: 'home-console-queue.js', text: script }];
  const ha = await HomeAssistant.fromFile('http://192.168.50.117', values['token-file']);
  let wasStopped = false;
  const record = { created_utc: new Date().toISOString(), files: [] };
  const recordPath = resolve(directory, 'queue-deployment.json');
  await writeFile(recordPath, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
  const save = () => writeFile(recordPath, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  try {
    await ha.connect();
    const staticProbe = await fetch(`${ha.baseUrl}/local/community/kiosk-mode/kiosk-mode.js`, { signal: AbortSignal.timeout(10000) });
    if (!staticProbe.ok || hash(new Uint8Array(await staticProbe.arrayBuffer())) !== APPROVED[0].sha256) {
      throw new Error('HA /local is not ready. Register the new www directory with one controlled HA restart before deployment.');
    }
    const current = await ha.command('lovelace/config', { url_path: 'home-console' });
    const previous = JSON.parse(await readFile(resolve(directory, 'home-console-music-private.json'), 'utf8'));
    if (JSON.stringify(current) !== JSON.stringify(previous)) throw new Error('Dashboard changed; inspect the private snapshot before proceeding');
    record.resources_before = await ha.command('lovelace/resources');
    await writeFile(resolve(directory, 'queue-dashboard-before.json'), JSON.stringify(current, null, 2), { flag: 'wx', mode: 0o600 });
    const info = await ha.command('supervisor/api', { endpoint: '/addons/core_configurator/info', method: 'get' });
    if (info.version !== '6.3.0' || !info.options.enforce_basepath || !['started', 'stopped'].includes(info.state)) throw new Error('Review the File Editor version/configuration first');
    wasStopped = info.state === 'stopped';
    record.file_editor_was_stopped = wasStopped;
    await save();
    if (wasStopped) await ha.command('supervisor/api', { endpoint: '/addons/core_configurator/start', method: 'post' }, 45000);
    const ready = await ha.command('supervisor/api', { endpoint: '/addons/core_configurator/info', method: 'get' });
    const url = new URL(ready.ingress_entry, ha.baseUrl);
    if (url.origin !== ha.baseUrl || !/^\/api\/hassio_ingress\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname)) throw new Error('Unexpected File Editor ingress URL');
    const session = await ha.command('supervisor/api', { endpoint: '/ingress/session', method: 'post' });
    if (!/^[a-zA-Z0-9_-]+$/.test(session.session)) throw new Error('Unexpected ingress session');
    const base = url.href.replace(/\/$/, '');
    async function request(path, body) {
      const response = await fetch(base + path, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Cookie: `ingress_session=${session.session}`, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        body: body ? new URLSearchParams(body) : undefined,
      });
      if (!response.ok) throw new Error(`File Editor request failed (${response.status})`);
      return response;
    }
    // Validate the mount using the public pinned asset, without reading other configuration.
    const installed = await (await request('/api/file?filename=' + encodeURIComponent('/homeassistant/www/community/kiosk-mode/kiosk-mode.js'))).text();
    if (hash(installed) !== APPROVED[0].sha256) throw new Error('File Editor is not exposing the expected HA www mount');
    for (const asset of assets) {
      const path = `/homeassistant/www/home-console/${asset.name}`;
      const existing = await (await request('/api/file?filename=' + encodeURIComponent(path))).text();
      if (existing !== 'File not found') throw new Error('A companion asset already exists; refusing to overwrite it');
    }
    const folder = await (await request('/api/newfolder', { path: '/homeassistant/www', name: 'home-console' })).json();
    if (folder.error && !String(folder.message).includes('File exists')) throw new Error('Cannot create the dedicated Home Console asset directory');
    for (const asset of assets) {
      const path = `/homeassistant/www/home-console/${asset.name}`;
      record.files.push({ path, sha256: hash(asset.text), status: 'pending' });
      await save();
      const result = await (await request('/api/save', { filename: path, text: asset.text })).json();
      if (result.error) throw new Error('Could not save a queue asset');
      const saved = await (await request('/api/file?filename=' + encodeURIComponent(path))).text();
      if (hash(saved) !== hash(asset.text)) throw new Error('Saved queue asset hash mismatch');
      record.files.at(-1).status = 'verified';
      await save();
    }
    const resourceUrl = `/local/home-console/home-console-queue.js?v=${hash(script).slice(0, 12)}`;
    if (record.resources_before.some(item => item.url.startsWith('/local/home-console/'))) throw new Error('A Home Console resource already exists; inspect it before updating');
    for (const asset of assets) {
      const response = await fetch(`${ha.baseUrl}/local/home-console/${asset.name}`, { signal: AbortSignal.timeout(10000) });
      if (!response.ok || hash(new Uint8Array(await response.arrayBuffer())) !== hash(asset.text)) throw new Error('HA served asset hash mismatch');
    }
    await ha.command('lovelace/resources/create', { res_type: 'module', url: resourceUrl });
    record.resource = resourceUrl;
    await save();
    const credentials = JSON.parse(await readFile(resolve(directory, 'ma-kiosk.json'), 'utf8'));
    const entries = (await ha.command('config_entries/get')).filter(item => item.domain === 'music_assistant' && item.state === 'loaded');
    if (entries.length !== 1) throw new Error('Expected one loaded MA integration');
    const playerMap = Object.fromEntries(credentials.mapping.map(item => [item.entity, item.player_id]));
    const config = buildDashboard({ music: true, navigation: true, configEntryId: entries[0].entry_id, queuePlayerMap: playerMap });
    visitCards(config, card => { if (['custom:ma-browser-card', 'custom:home-console-queue'].includes(card.type)) card.ma_token = credentials.token; });
    if (JSON.stringify(await ha.command('lovelace/config', { url_path: 'home-console' })) !== JSON.stringify(current)) throw new Error('Dashboard changed during asset deployment');
    await ha.command('lovelace/config/save', { url_path: 'home-console', config });
    await writeFile(resolve(directory, 'home-console-queue-private.json'), JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
    record.dashboard_saved = true;
    await save();
    console.log(JSON.stringify({ deployed: true, assets: record.files.map(item => ({ sha256: item.sha256, status: item.status })), resource: resourceUrl, packages_added: 0 }));
  } finally {
    try {
      if (wasStopped) await ha.command('supervisor/api', { endpoint: '/addons/core_configurator/stop', method: 'post' }, 30000);
    } finally { ha.close(); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
