import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateApiKey, parseApiKey, hashSecret, verifySecret } from '../src/keys.js';

test('generated keys have the expected mcai_<id>_<secret> shape', () => {
  const { lookupId, key } = generateApiKey();
  assert.match(lookupId, /^[0-9a-f]{8}$/);
  assert.match(key, /^mcai_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
  const parsed = parseApiKey(key);
  assert.equal(parsed.lookupId, lookupId);
});

test('parseApiKey rejects malformed keys', () => {
  for (const bad of [
    '',
    'mcai_',
    'mcai_zz_notasecret',
    'mcai_01234567_short',
    'Bearer mcai_01234567_' + 'a'.repeat(43),
    `mcai_01234567_${'a'.repeat(42)}`,
    `mcai_01234567_${'a'.repeat(44)}`,
    123,
    null,
  ]) {
    assert.equal(parseApiKey(bad), null, `expected ${String(bad)} to be rejected`);
  }
});

test('hashSecret + verifySecret round-trip', () => {
  const secret = 'super-secret-value';
  const stored = hashSecret(secret);
  assert.ok(stored.startsWith('scrypt:'));
  assert.ok(!stored.includes(secret));
  assert.equal(verifySecret(secret, stored), true);
});

test('verifySecret rejects wrong secrets and tampered hashes', () => {
  const stored = hashSecret('right');
  assert.equal(verifySecret('wrong', stored), false);
  const [scheme, salt, hash] = stored.split(':');
  assert.equal(verifySecret('right', `scrypt:${salt}:${'0'.repeat(hash.length)}`), false);
  assert.equal(verifySecret('right', 'garbage'), false);
  assert.equal(verifySecret('right', `${scheme}:zz:hash`), false);
});

test('hashSecret uses unique salts', () => {
  const a = hashSecret('same');
  const b = hashSecret('same');
  assert.notEqual(a, b);
});
