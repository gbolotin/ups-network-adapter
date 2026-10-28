// Private operator export. Never point --output inside a Git checkout.
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { HomeAssistant } from './ha_client.mjs';

export function assertOutsideRepository(output, repository) {
  const path = relative(repository, output);
  if (!path || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))) {
    throw new Error('Secret-bearing snapshots must be saved outside the repository');
  }
}

export async function capture(ha) {
  const result = { created_utc: new Date().toISOString(), commands: {} };
  // Keep errors explicit. A generated dashboard has no stored manual config.
  async function read(type, parameters = {}, key = type) {
    try {
      const value = await ha.command(type, parameters);
      result.commands[key] = { success: true, result: value };
      return value;
    } catch (error) {
      result.commands[key] = { success: false, error: error.message };
      return undefined;
    }
  }
  result.config = await ha.rest('/api/config');
  const dashboards = await read('lovelace/dashboards/list');
  if (!dashboards) throw new Error('Dashboard inventory is required before taking a snapshot');
  await read('lovelace/resources');
  await read('frontend/get_user_data');
  await read('get_panels');
  await read('config/entity_registry/list');
  await read('input_select/list');
  await read('backup/info');
  for (const dashboard of [{ url_path: null }, ...dashboards]) {
    await read('lovelace/config', dashboard.url_path ? { url_path: dashboard.url_path } : {}, `dashboard:${dashboard.url_path ?? 'lovelace'}`);
  }
  return result;
}

async function main() {
  const { values } = parseArgs({ options: {
    url: { type: 'string', default: 'http://192.168.50.117' },
    'token-file': { type: 'string' }, output: { type: 'string' },
    'create-backup': { type: 'boolean', default: false },
    'backup-name': { type: 'string', default: 'Before Home Console implementation' },
  } });
  if (!values['token-file'] || !values.output) throw new Error('Specify --token-file and --output');
  const output = resolve(values.output);
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  assertOutsideRepository(output, repository);
  // Refuse pre-existing destinations and resolve the parent to reject symlink escapes.
  const parent = await realpath(dirname(output));
  assertOutsideRepository(resolve(parent, output.split(/[\\/]/).at(-1)), repository);
  await mkdir(output, { mode: 0o700 });
  const ha = await HomeAssistant.fromFile(values.url, values['token-file']);
  try {
    await ha.connect();
    const snapshot = await capture(ha);
    const bytes = JSON.stringify(snapshot, null, 2) + '\n';
    await writeFile(resolve(output, 'ha-before.json'), bytes, { flag: 'wx', mode: 0o600 });
    const summary = { directory: output, snapshot_sha256: createHash('sha256').update(bytes).digest('hex'), dashboard_count: snapshot.commands['lovelace/dashboards/list'].result.length };
    if (values['create-backup']) {
      const info = snapshot.commands['backup/info'];
      if (!info?.success || info.result.state !== 'idle') throw new Error('Backup manager must be idle before creating a migration backup');
      const backup = await ha.command('backup/generate', {
        agent_ids: ['hassio.local'], name: values['backup-name'],
        include_all_addons: true, include_database: true,
        include_homeassistant: true, include_folders: ['ssl', 'share', 'media'],
      }, 30000);
      await writeFile(resolve(output, 'backup-request.json'), JSON.stringify(backup, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      summary.backup_request = backup;
      summary.backup_completion = 'Must confirm using backup/info before any dashboard mutation';
    }
    await writeFile(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(summary));
  } finally {
    ha.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
