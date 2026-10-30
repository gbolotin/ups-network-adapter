import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HomeAssistant } from './ha_client.mjs';
import { editor } from './deploy_ups_switching.mjs';
import { addTrustedPiAuth } from './trusted_pi_auth.mjs';

const [tokenFile, directory] = process.argv.slice(2);
assert.ok(tokenFile && directory);
const journalPath = resolve(directory, 'trusted-pi-auth-before.json');
const record = JSON.parse(await readFile(journalPath, 'utf8'));
const ha = await HomeAssistant.fromFile('http://192.168.50.117', tokenFile);
try {
  await ha.connect();
  const users = (await ha.command('config/auth/list')).filter(u => u.name === 'pi-kiosk');
  assert.equal(users.length, 1);
  const user = users[0];
  assert.ok(user.is_active && !user.is_owner && !user.group_ids.includes('system-admin'));
  const files = await editor(ha);
  try {
    assert.equal(await files.read(record.path), record.before, 'Configuration changed since preflight');
    record.after = addTrustedPiAuth(record.before, user.id);
    record.kiosk_user_id = user.id;
    record.status = 'pending';
    await writeFile(journalPath, JSON.stringify(record, null, 2), { mode: 0o600 });
    await files.save(record.path, record.after);
    try {
      const check = await ha.rest('/api/config/core/check_config', { method: 'POST', body: {}, timeoutMs: 60000 });
      assert.equal(check.result, 'valid');
      record.status = 'validated-awaiting-restart';
    } catch (error) {
      await files.save(record.path, record.before);
      record.status = 'rolled-back';
      throw error;
    } finally { await writeFile(journalPath, JSON.stringify(record, null, 2), { mode: 0o600 }); }
    console.log(JSON.stringify({ validated: true, trusted_ip: '192.168.50.200/32', user: 'pi-kiosk', password_fallback: true, restart_required: true }));
  } finally { await files.close(); }
} finally { ha.close(); }
