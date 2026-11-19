import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/ratelimit.js';

test('allows up to the limit then blocks with retryAfter', () => {
  const limiter = new RateLimiter();
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) {
    const result = limiter.check('k', 3, 60_000, t0 + i * 1000);
    assert.equal(result.ok, true);
    assert.equal(result.remaining, 3 - i - 1);
  }
  const blocked = limiter.check('k', 3, 60_000, t0 + 4000);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.retryAfterMs > 0);
});

test('window resets after windowMs elapses', () => {
  const limiter = new RateLimiter();
  const t0 = 1_000_000;
  limiter.check('k', 1, 60_000, t0);
  assert.equal(limiter.check('k', 1, 60_000, t0 + 1000).ok, false);
  assert.equal(limiter.check('k', 1, 60_000, t0 + 61_000).ok, true);
});

test('buckets are independent per key', () => {
  const limiter = new RateLimiter();
  const t0 = 1_000_000;
  limiter.check('a', 1, 60_000, t0);
  assert.equal(limiter.check('a', 1, 60_000, t0).ok, false);
  assert.equal(limiter.check('b', 1, 60_000, t0).ok, true);
});
