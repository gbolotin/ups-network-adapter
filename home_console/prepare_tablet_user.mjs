// Create a separate local-only, non-admin Home Assistant account for the tablet.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HomeAssistant } from './ha_client.mjs';
import { assertOutsideRepository } from './ha_snapshot.mjs';
import { loginForCheck } from './prepare_kiosk_user.mjs';

const [tokenFile, evidencePath] = process.argv.slice(2);
assert.ok(tokenFile && evidencePath);
const directory = await realpath(resolve(evidencePath));
assertOutsideRepository(directory, fileURLToPath(new URL('..', import.meta.url)));
const ha = await HomeAssistant.fromFile('http://192.168.50.117', tokenFile);
let session;
try {
  await ha.connect();
  const users = await ha.command('config/auth/list');
  const username = 'samsung-a7';
  assert.ok(!users.some(user => user.name === username || user.username === username), 'Tablet account already exists; preserve its credentials');
  const credentials = { username, password: randomBytes(24).toString('hex'), user_id: null };
  const file = resolve(directory, 'ha-tablet-credentials.json');
  await writeFile(file, JSON.stringify(credentials, null, 2), { flag: 'wx', mode: 0o600 });
  const created = await ha.command('config/auth/create', { name: username, group_ids: ['system-users'], local_only: true });
  credentials.user_id = created.user.id;
  await writeFile(file, JSON.stringify(credentials, null, 2));
  await ha.command('config/auth_provider/homeassistant/create', { user_id: credentials.user_id, username, password: credentials.password });
  session = await loginForCheck(ha.baseUrl, credentials);
  await session.client.connect();
  const user = await session.client.command('auth/current_user');
  assert.equal(user.is_admin, false);
  assert.equal(user.is_owner, false);
  const dashboard = await session.client.command('lovelace/config', { url_path: 'home-console' });
  console.log(JSON.stringify({ username, local_only: true, admin: user.is_admin, dashboard_views: dashboard.views.length }));
} finally {
  session?.client.close();
  try { if (session) await session.revoke(); } finally { ha.close(); }
}
