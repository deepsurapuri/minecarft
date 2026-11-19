import crypto from 'node:crypto';

const KEY_PREFIX = 'mcai';
const LOOKUP_ID_BYTES = 4; // 8 hex chars — used only to find the row, not to authenticate
const SECRET_BYTES = 32;   // 256 bits of entropy
const SCRYPT_KEYLEN = 32;

/**
 * Generate a fresh API key.
 * @returns {{ lookupId: string, key: string }} the key is shown to the user exactly once.
 */
export function generateApiKey() {
  const lookupId = crypto.randomBytes(LOOKUP_ID_BYTES).toString('hex');
  const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  return { lookupId, key: `${KEY_PREFIX}_${lookupId}_${secret}` };
}

/**
 * Parse and validate the shape of an API key.
 * @returns {{ lookupId: string, secret: string } | null}
 */
export function parseApiKey(key) {
  if (typeof key !== 'string') return null;
  const match = /^mcai_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/.exec(key.trim());
  if (!match) return null;
  return { lookupId: match[1], secret: match[2] };
}

/**
 * Hash a secret with scrypt + random salt. Only hashes are stored, never raw keys.
 */
export function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(secret, salt, SCRYPT_KEYLEN);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

/**
 * Constant-time verification of a secret against a stored hash.
 */
export function verifySecret(secret, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split(':');
    if (scheme !== 'scrypt') return false;
    if (!/^[0-9a-f]{32}$/.test(saltHex ?? '')) return false;
    if (!/^[0-9a-f]{64}$/.test(hashHex ?? '')) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(secret, salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
