import test from 'node:test';
import assert from 'node:assert/strict';
import { assertOwnedTestQueue } from './playback_test_policy.mjs';

test('acceptance cleanup permits an empty or fully owned queue', () => {
  assert.doesNotThrow(() => assertOwnedTestQueue({ items: 0 }, [], []));
  assert.doesNotThrow(() => assertOwnedTestQueue({ items: 2 }, [{ queue_item_id: 'one' }, { queue_item_id: 'two' }], ['one', 'two']));
});

test('acceptance cleanup rejects incomplete pages and invalid counts', () => {
  for (const count of [2, -1, 1.5, undefined]) {
    assert.throws(() => assertOwnedTestQueue({ items: count }, [{ queue_item_id: 'one' }], ['one']), /Incomplete/);
  }
});

test('acceptance cleanup refuses another controllers item', () => {
  assert.throws(() => assertOwnedTestQueue({ items: 2 }, [{ queue_item_id: 'one' }, { queue_item_id: 'user-new' }], ['one']), /Another controller/);
});

test('acceptance cleanup refuses missing and repeated item identities', () => {
  assert.throws(() => assertOwnedTestQueue({ items: 1 }, [{}], ['one']), /Another controller/);
  assert.throws(() => assertOwnedTestQueue({ items: 2 }, [{ queue_item_id: 'one' }, { queue_item_id: 'one' }], ['one']), /Another controller/);
});
