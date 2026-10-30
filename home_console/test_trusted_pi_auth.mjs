import test from 'node:test';
import assert from 'node:assert/strict';
import { addTrustedPiAuth } from './trusted_pi_auth.mjs';

test('passwordless login is limited to the one verified Pi IP and kiosk user', () => {
  const user = '2724a316c89b454b9f53e86fef3cd3ba';
  const original = 'default_config:\nrest_command: !include commands.yaml\n';
  const result = addTrustedPiAuth(original, user);
  assert.ok(result.startsWith(original));
  assert.equal((result.match(/192\.168\.50\.200\/32/g) || []).length, 2);
  assert.equal((result.match(new RegExp(user, 'g')) || []).length, 1);
  assert.ok(!result.includes('/24'));
  assert.ok(result.indexOf('type: trusted_networks') < result.indexOf('type: homeassistant'));
  assert.ok(result.includes('allow_bypass_login: true'));
});

test('existing auth/proxy configuration and injected user IDs require review', () => {
  for (const config of ['homeassistant:\n', 'homeassistant: !include ha.yaml\n', 'http:\n  trusted_proxies:\n    - 127.0.0.1\n']) {
    assert.throws(() => addTrustedPiAuth(config, 'a'.repeat(32)));
  }
  assert.throws(() => addTrustedPiAuth('default_config:\n', 'user\n- admin'));
});
