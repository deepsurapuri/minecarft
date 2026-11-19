/**
 * Simple fixed-window rate limiter. In-memory, per API key — plenty for a
 * self-hosted gateway. Swap for Redis if you ever run multiple replicas.
 */
export class RateLimiter {
  constructor() {
    /** @type {Map<string, { start: number, count: number }>} */
    this.buckets = new Map();
    this.lastSweep = Date.now();
  }

  /**
   * @param {string} bucketKey   e.g. `${keyId}:general` or `${keyId}:command`
   * @param {number} limit       max hits per window
   * @param {number} windowMs    window size in milliseconds
   * @param {number} [now]       injectable clock for tests
   * @returns {{ ok: boolean, remaining: number, retryAfterMs: number }}
   */
  check(bucketKey, limit, windowMs = 60_000, now = Date.now()) {
    this.sweep(now);
    const bucket = this.buckets.get(bucketKey);
    if (!bucket || now - bucket.start >= windowMs) {
      this.buckets.set(bucketKey, { start: now, count: 1 });
      return { ok: true, remaining: limit - 1, retryAfterMs: 0 };
    }
    if (bucket.count >= limit) {
      return { ok: false, remaining: 0, retryAfterMs: bucket.start + windowMs - now };
    }
    bucket.count += 1;
    return { ok: true, remaining: limit - bucket.count, retryAfterMs: 0 };
  }

  /** Periodically drop expired buckets so the map doesn't grow forever. */
  sweep(now = Date.now()) {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.start > 120_000) this.buckets.delete(key);
    }
  }
}
