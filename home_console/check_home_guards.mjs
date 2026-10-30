// Negative acceptance only: invalid sources must stop before any device command.
import assert from 'node:assert/strict';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { HomeAssistant } from './ha_client.mjs';
import { loginForCheck } from './prepare_kiosk_user.mjs';
import { buildScripts } from './dashboard.mjs';
import { assertOutsideRepository } from './ha_snapshot.mjs';

const { values } = parseArgs({ options: { 'snapshot-dir': { type: 'string' }, 'token-file': { type: 'string' }, apply: { type: 'boolean' } } });
if (!values['snapshot-dir'] || !values['token-file']) throw new Error('Specify protected --snapshot-dir and --token-file');
const directory = await realpath(resolve(values['snapshot-dir']));
assertOutsideRepository(directory, fileURLToPath(new URL('..', import.meta.url)));
const administrator = await HomeAssistant.fromFile('http://192.168.50.117', values['token-file']);
let kiosk;
try {
  await administrator.connect();
  const scripts = buildScripts();
  for (const id of ['home_console_denon_source', 'home_console_tv_source']) {
    const deployed = await administrator.rest('/api/config/script/config/' + id);
    assert.deepEqual(deployed.sequence, scripts[id].sequence, 'Source policy changed; inspect before testing');
    if ((await administrator.rest('/api/states/script.' + id)).state !== 'off') throw new Error('Source script is active; preserve the existing operation');
  }
  if (!values.apply) {
    console.log(JSON.stringify({ preflight: true, policy_matches: true, device_commands: false }));
  } else {
    const path = resolve(directory, 'home-source-guard-acceptance.json');
    const record = { utc: new Date().toISOString(), status: 'running', cases: [] };
    await writeFile(path, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
    kiosk = await loginForCheck(administrator.baseUrl, JSON.parse(await readFile(resolve(directory, 'pi-kiosk-credentials.json'), 'utf8')));
    for (const id of ['home_console_denon_source', 'home_console_tv_source']) {
      const old = new Set((await administrator.command('trace/list', { domain: 'script', item_id: id })).map(trace => trace.run_id));
      await kiosk.client.rest('/api/services/script/' + id, { method: 'POST', body: { source: '__invalid_console_acceptance__' } });
      let current;
      for (let attempt = 0; attempt < 20; attempt++) {
        current = (await administrator.command('trace/list', { domain: 'script', item_id: id })).find(trace => !old.has(trace.run_id));
        if (current) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!current) throw new Error('No new trace available; inspect the guarded run');
      const detail = await administrator.command('trace/get', { domain: 'script', item_id: id, run_id: current.run_id });
      const steps = detail.trace;
      if (steps?.['sequence/0']?.[0]?.result?.result !== false || Object.keys(steps).some(step => /^sequence\/[1-9]/.test(step))) throw new Error('Source guard did not stop at its first condition');
      record.cases.push({ script: id, actor: 'pi-kiosk', rejected_at_first_condition: true, device_steps_executed: false, trace: detail });
      await writeFile(path, JSON.stringify(record, null, 2));
    }
    record.status = 'passed';
    await writeFile(path, JSON.stringify(record, null, 2));
    console.log(JSON.stringify({ invalid_source_cases_passed: record.cases.length, device_steps_executed: false }));
  }
} finally {
  try { kiosk?.client.close(); if (kiosk) await kiosk.revoke(); } finally { administrator.close(); }
}
