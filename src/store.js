import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { generateApiKey, hashSecret, parseApiKey, verifySecret } from './keys.js';

export const KNOWN_SCOPES = Object.freeze(['bot:control', 'bot:command', 'audit:read']);

/**
 * Persistent storage for API keys and the admin audit log.
 * Uses the built-in node:sqlite module — zero native dependencies.
 */
export class Store {
  /** @param {string} dbPath file path, or ':memory:' for tests */
  constructor(dbPath) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
    }
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        lookup_id    TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        scopes       TEXT NOT NULL,
        secret_hash  TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        revoked_at   TEXT,
        last_used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        key_lookup_id TEXT,
        action        TEXT NOT NULL,
        detail        TEXT,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_log_id ON audit_log (id);
    `);
  }

  /**
   * Create a new API key. The plaintext key is returned exactly once — only its
   * scrypt hash is stored.
   */
  createKey({ name, scopes }) {
    if (!name || typeof name !== 'string') throw new Error('Key name is required');
    const cleanScopes = normalizeScopes(scopes);
    const { lookupId, key } = generateApiKey();
    const { secret } = parseApiKey(key);
    this.db
      .prepare(
        `INSERT INTO api_keys (lookup_id, name, scopes, secret_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(lookupId, name.trim(), JSON.stringify(cleanScopes), hashSecret(secret), new Date().toISOString());
    return { lookupId, key, name: name.trim(), scopes: cleanScopes };
  }

  /**
   * Verify a presented key. Returns the key record (without hash) or null.
   */
  verifyKey(key) {
    const parsed = parseApiKey(key);
    if (!parsed) return null;
    const row = this.db
      .prepare('SELECT * FROM api_keys WHERE lookup_id = ?')
      .get(parsed.lookupId);
    if (!row || row.revoked_at) return null;
    if (!verifySecret(parsed.secret, row.secret_hash)) return null;
    return {
      lookupId: row.lookup_id,
      name: row.name,
      scopes: safeParseScopes(row.scopes),
    };
  }

  touchKey(lookupId) {
    this.db
      .prepare('UPDATE api_keys SET last_used_at = ? WHERE lookup_id = ?')
      .run(new Date().toISOString(), lookupId);
  }

  listKeys() {
    const rows = this.db
      .prepare(
        `SELECT lookup_id, name, scopes, created_at, revoked_at, last_used_at
         FROM api_keys ORDER BY created_at DESC`
      )
      .all();
    return rows.map((row) => ({
      lookupId: row.lookup_id,
      name: row.name,
      scopes: safeParseScopes(row.scopes),
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
      lastUsedAt: row.last_used_at,
    }));
  }

  /** Revoke a key by lookup id. Returns true if a live key was revoked. */
  revokeKey(lookupId) {
    const result = this.db
      .prepare('UPDATE api_keys SET revoked_at = ? WHERE lookup_id = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), lookupId);
    return Number(result.changes) > 0;
  }

  addAudit(keyLookupId, action, detail) {
    this.db
      .prepare(
        'INSERT INTO audit_log (key_lookup_id, action, detail, created_at) VALUES (?, ?, ?, ?)'
      )
      .run(
        keyLookupId ?? null,
        action,
        detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)),
        new Date().toISOString()
      );
  }

  listAudit(limit = 50) {
    const capped = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const rows = this.db
      .prepare(
        `SELECT id, key_lookup_id, action, detail, created_at
         FROM audit_log ORDER BY id DESC LIMIT ?`
      )
      .all(capped);
    return rows.map((row) => ({
      id: Number(row.id),
      keyLookupId: row.key_lookup_id,
      action: row.action,
      detail: row.detail,
      createdAt: row.created_at,
    }));
  }

  close() {
    this.db.close();
  }
}

export function normalizeScopes(scopes) {
  const list = Array.isArray(scopes)
    ? scopes
    : String(scopes ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const unique = [...new Set(list)];
  const invalid = unique.filter((s) => !KNOWN_SCOPES.includes(s));
  if (invalid.length > 0) {
    throw new Error(`Unknown scope(s): ${invalid.join(', ')}. Known scopes: ${KNOWN_SCOPES.join(', ')}`);
  }
  if (unique.length === 0) {
    throw new Error(`At least one scope is required. Known scopes: ${KNOWN_SCOPES.join(', ')}`);
  }
  return unique;
}

function safeParseScopes(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
