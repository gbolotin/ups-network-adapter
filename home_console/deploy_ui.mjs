// Content-addressed first-party UI assets. No package installation or HA restart.
import { createHash } from 'node:crypto';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { HomeAssistant } from './ha_client.mjs';
import { assertOutsideRepository } from './ha_snapshot.mjs';
import { APPROVED } from './install_hacs.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');

export async function buildUiAssets() {
  const assets = [];
  function asset(stem, text) {
    const result = { name: `${stem}.${hash(text).slice(0, 12)}.js`, text, sha256: hash(text) };
    assets.push(result);
    return result.name;
  }
  const queuePolicy = asset('queue-policy', await readFile(new URL('./ui/queue-policy.mjs', import.meta.url), 'utf8'));
  const queueSource = await readFile(new URL('./ui/home-console-queue.js', import.meta.url), 'utf8');
  if (!queueSource.includes("'./queue-policy.mjs'")) throw new Error('Review the queue policy import');
  const queue = asset('home-console-queue', queueSource.replace("'./queue-policy.mjs'", `'./${queuePolicy}'`));
  const keyboardPolicy = asset('keyboard-policy', await readFile(new URL('./ui/keyboard-policy.mjs', import.meta.url), 'utf8'));
  const keyboardSource = await readFile(new URL('./ui/touch-keyboard.js', import.meta.url), 'utf8');
  if (!keyboardSource.includes("'./keyboard-policy.mjs'")) throw new Error('Review the keyboard policy import');
  const keyboard = asset('touch-keyboard', keyboardSource.replace("'./keyboard-policy.mjs'", `'./${keyboardPolicy}'`));
  const entry = asset('home-console-ui', `import './${queue}';\nimport './${keyboard}';\n`);
  return { assets, entry };
}

async function main() {
  const { values } = parseArgs({ options: {
    'token-file': { type: 'string' }, 'snapshot-dir': { type: 'string' }, revision: { type: 'string' },
  } });
  if (!values['token-file'] || !values['snapshot-dir'] || !/^[a-z0-9-]{1,48}$/.test(values.revision || '')) throw new Error('Specify --token-file, --snapshot-dir, and a short --revision slug');
  const directory = await realpath(resolve(values['snapshot-dir']));
  assertOutsideRepository(directory, fileURLToPath(new URL('..', import.meta.url)));
  const built = await buildUiAssets();
  const record = { created_utc: new Date().toISOString(), revision: values.revision, files: [] };
  const recordPath = resolve(directory, `ui-${values.revision}.json`);
  await writeFile(recordPath, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
  const save = () => writeFile(recordPath, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  const ha = await HomeAssistant.fromFile('http://192.168.50.117', values['token-file']);
  let stopEditor = false;
  try {
    await ha.connect();
    const probe = await fetch(`${ha.baseUrl}/local/community/kiosk-mode/kiosk-mode.js`, { signal: AbortSignal.timeout(10000) });
    if (!probe.ok || hash(new Uint8Array(await probe.arrayBuffer())) !== APPROVED[0].sha256) throw new Error('HA /local is not registered; resolve it before deployment');
    const resources = await ha.command('lovelace/resources');
    const existing = resources.filter(item => item.url.startsWith('/local/home-console/'));
    if (existing.length > 1) throw new Error('Resolve duplicate Home Console resources before deployment');
    record.resources_before = resources;
    const info = await ha.command('supervisor/api', { endpoint: '/addons/core_configurator/info', method: 'get' });
    if (info.version !== '6.3.0' || !info.options.enforce_basepath || !['started', 'stopped', 'error'].includes(info.state)) throw new Error('Review the installed File Editor configuration');
    record.file_editor_before = info.state;
    stopEditor = info.state !== 'started';
    await save();
    if (stopEditor) await ha.command('supervisor/api', { endpoint: '/addons/core_configurator/start', method: 'post' }, 45000);
    const ready = await ha.command('supervisor/api', { endpoint: '/addons/core_configurator/info', method: 'get' });
    const url = new URL(ready.ingress_entry, ha.baseUrl);
    if (url.origin !== ha.baseUrl || !/^\/api\/hassio_ingress\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname)) throw new Error('Unexpected File Editor ingress');
    const session = await ha.command('supervisor/api', { endpoint: '/ingress/session', method: 'post' });
    if (!/^[a-zA-Z0-9_-]+$/.test(session.session)) throw new Error('Unexpected ingress session');
    async function request(path, body) {
      const response = await fetch(url.href.replace(/\/$/, '') + path, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Cookie: `ingress_session=${session.session}`, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        body: body ? new URLSearchParams(body) : undefined,
      });
      if (!response.ok) throw new Error(`File Editor request failed (${response.status})`);
      return response;
    }
    const pinned = await (await request('/api/file?filename=' + encodeURIComponent('/homeassistant/www/community/kiosk-mode/kiosk-mode.js'))).text();
    if (hash(pinned) !== APPROVED[0].sha256) throw new Error('Unexpected HA configuration mount');
    const folder = await (await request('/api/newfolder', { path: '/homeassistant/www', name: 'home-console' })).json();
    if (folder.error && !String(folder.message).includes('File exists')) throw new Error('Cannot prepare the dedicated asset directory');
    for (const asset of built.assets) {
      const path = `/homeassistant/www/home-console/${asset.name}`;
      const prior = await (await request('/api/file?filename=' + encodeURIComponent(path))).text();
      if (prior !== 'File not found' && hash(prior) !== asset.sha256) throw new Error('Content-addressed asset already exists with different bytes');
      record.files.push({ path, sha256: asset.sha256, already_present: prior !== 'File not found', status: 'pending' });
      await save();
      if (prior === 'File not found') {
        const saved = await (await request('/api/save', { filename: path, text: asset.text })).json();
        if (saved.error) throw new Error('Could not save a UI asset');
      }
      const response = await fetch(`${ha.baseUrl}/local/home-console/${asset.name}`, { signal: AbortSignal.timeout(10000) });
      if (!response.ok || hash(new Uint8Array(await response.arrayBuffer())) !== asset.sha256) throw new Error('Served UI asset hash mismatch');
      record.files.at(-1).status = 'verified';
      await save();
    }
    const resourceUrl = `/local/home-console/${built.entry}`;
    if (existing.length) await ha.command('lovelace/resources/update', { resource_id: existing[0].id, res_type: 'module', url: resourceUrl });
    else await ha.command('lovelace/resources/create', { res_type: 'module', url: resourceUrl });
    record.resource = resourceUrl;
    await save();
    console.log(JSON.stringify({ deployed: true, revision: values.revision, files_verified: built.assets.length, resource: resourceUrl, packages_added: 0 }));
  } finally {
    try {
      if (stopEditor) {
        await ha.command('supervisor/api', { endpoint: '/addons/core_configurator/stop', method: 'post' }, 30000);
        record.file_editor_after = (await ha.command('supervisor/api', { endpoint: '/addons/core_configurator/info', method: 'get' })).state;
        await save();
      }
    } finally { ha.close(); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
