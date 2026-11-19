import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, normalizeScopes } from '../src/store.js';
import { parseApiKey } from '../src/keys.js';

function makeStore() {
  return new Store(':memory:');
}

test('createKey stores only the hash, never the plaintext secret', () => {
  const store = makeStore();
  const created = store.createKey({ name: 'test-agent', scopes: ['bot:control'] });
  const { secret } = parseApiKey(created.key);
  const row = store.db.prepare('SELECT secret_hash FROM api_keys WHERE lookup_id = ?').get(created.lookupId);
  assert.ok(!row.secret_hash.includes(secret));
  store.close();
});

test('verifyKey accepts a valid key and reports its scopes', () => {
  const store = makeStore();
  const created = store.createKey({ name: 'agent', scopes: ['bot:control', 'bot:command'] });
  const record = store.verifyKey(created.key);
  assert.equal(record.name, 'agent');
  assert.deepEqual([...record.scopes].sort(), ['bot:command', 'bot:control']);
  store.close();
});

test('verifyKey rejects bad keys, revoked keys and wrong secrets', () => {
  const store = makeStore();
  const created = store.createKey({ name: 'agent', scopes: ['bot:control'] });
  assert.equal(store.verifyKey('mcai_ffffffff_' + 'a'.repeat(43)), null);
  assert.equal(store.verifyKey('not-a-key'), null);
  assert.equal(store.revokeKey(created.lookupId), true);
  assert.equal(store.verifyKey(created.key), null);
  assert.equal(store.revokeKey(created.lookupId), false, 'second revoke is a no-op');
  store.close();
});

test('normalizeScopes validates and deduplicates', () => {
  assert.deepEqual(normalizeScopes('bot:control,bot:command,bot:control'), ['bot:control', 'bot:command']);
  assert.throws(() => normalizeScopes('bot:control,fly'), /Unknown scope/);
  assert.throws(() => normalizeScopes(''), /At least one scope/);
});

test('audit log records and returns newest-first entries', () => {
  const store = makeStore();
  store.addAudit('abc12345', 'bot:command', { command: '/tp @s 1 2 3' });
  store.addAudit(null, 'bot:spawn', '{"id":"bot-1"}');
  const entries = store.listAudit(10);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].action, 'bot:spawn');
  assert.equal(entries[1].action, 'bot:command');
  assert.deepEqual(JSON.parse(entries[1].detail), { command: '/tp @s 1 2 3' });
  store.close();
});

test('listKeys never leaks secret material', () => {
  const store = makeStore();
  store.createKey({ name: 'agent', scopes: ['audit:read'] });
  const listed = store.listKeys();
  assert.equal(listed.length, 1);
  assert.ok(!('secret_hash' in listed[0]));
  assert.ok(!JSON.stringify(listed[0]).includes('scrypt:'));
  store.close();
});
