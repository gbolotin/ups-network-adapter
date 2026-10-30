// Targeted restore/reapply; never restores other dashboards or global preferences.
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { HomeAssistant } from './ha_client.mjs';
import { assertOutsideRepository } from './ha_snapshot.mjs';

async function main() {
  const { values } = parseArgs({ options: {
    'token-file': { type: 'string' }, 'snapshot-dir': { type: 'string' }, dashboard: { type: 'string' },
    mode: { type: 'string' }, apply: { type: 'boolean', default: false },
  } });
  if (!values['token-file'] || !values['snapshot-dir'] || !['dashboard-new', 'dashboard-cameras'].includes(values.dashboard)
      || !['restore', 'reapply', 'drill'].includes(values.mode)) throw new Error('Specify token file, private snapshot directory, one approved dashboard, and mode restore/reapply/drill');
  const directory = await realpath(resolve(values['snapshot-dir']));
  assertOutsideRepository(directory, fileURLToPath(new URL('..', import.meta.url)));
  const before = JSON.parse(await readFile(resolve(directory, 'd9-before.json'), 'utf8')).dashboards.find(d => d.metadata.url_path === values.dashboard);
  const after = JSON.parse(await readFile(resolve(directory, 'd9-after-responsive.json'), 'utf8')).find(d => d.path === values.dashboard);
  const desiredMetadata = { ...before.metadata, ...(values.dashboard === 'dashboard-new' ? { title: 'Home', icon: 'mdi:home' } : {}) };
  const source = values.mode === 'reapply' ? before.config : after.config;
  const sourceMetadata = values.mode === 'reapply' ? before.metadata : desiredMetadata;
  const target = values.mode === 'reapply' ? after.config : before.config;
  const targetMetadata = values.mode === 'reapply' ? desiredMetadata : before.metadata;
  const ha = await HomeAssistant.fromFile('http://192.168.50.117', values['token-file']);
  const read = () => ha.command('lovelace/config', { url_path: values.dashboard });
  const metadata = async () => (await ha.command('lovelace/dashboards/list')).find(d => d.url_path === values.dashboard);
  async function check(config, details) {
    if (!isDeepStrictEqual(await read(), config) || !isDeepStrictEqual(await metadata(), details)) throw new Error('Dashboard changed independently; inspect it before restoring');
  }
  async function save(config, details) {
    await ha.command('lovelace/config/save', { url_path: values.dashboard, config });
    await ha.command('lovelace/dashboards/update', { dashboard_id: details.id, title: details.title, icon: details.icon });
    await check(config, details);
  }
  try {
    await ha.connect();
    await check(source, sourceMetadata);
    if (!values.apply) { console.log(JSON.stringify({ preflight: 'passed', dashboard: values.dashboard, mode: values.mode })); return; }
    const journalPath = resolve(directory, `d9-${values.mode}-${values.dashboard}.json`);
    const journal = { created_utc: new Date().toISOString(), dashboard: values.dashboard, mode: values.mode, status: 'pending' };
    await writeFile(journalPath, JSON.stringify(journal), { flag: 'wx', mode: 0o600 });
    await save(target, targetMetadata);
    journal.status = 'restored';
    await writeFile(journalPath, JSON.stringify(journal, null, 2));
    if (values.mode === 'drill') {
      await check(target, targetMetadata);
      await save(source, sourceMetadata);
      journal.status = 'restored_and_reapplied';
      await writeFile(journalPath, JSON.stringify(journal, null, 2));
    }
    console.log(JSON.stringify(journal));
  } finally { ha.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
