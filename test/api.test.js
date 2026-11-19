import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/api.js';

/**
 * End-to-end tests of the HTTP layer with a fake bot manager — no Minecraft
 * server required. Verifies auth, scopes, validation, audit logging and routing.
 */

class FakeBotManager {
  constructor() {
    this.bots = new Map();
    this.chats = [];
    this.commands = [];
    this.nextId = 1;
  }
  async pingServer() {
    return { online: true, motd: 'Test World', playersOnline: 1, playersMax: 10, version: '1.21.0' };
  }
  listBots() {
    return [...this.bots.values()];
  }
  getBot(id) {
    return this.bots.get(id) ?? null;
  }
  getChatLog(id) {
    if (!this.bots.has(id)) return null;
    return [{ at: new Date().toISOString(), direction: 'in', source: 'Player1', message: 'hello' }];
  }
  spawnBot({ username, auth } = {}) {
    const id = `bot-${this.nextId++}`;
    const bot = { id, username: username ?? `AIBot${1000 + this.nextId}`, auth: auth ?? 'offline', status: 'connecting', spawned: false };
    this.bots.set(id, bot);
    return bot;
  }
  async removeBot(id) {
    if (!this.bots.has(id)) {
      const err = new Error(`No bot with id "${id}"`);
      err.status = 404;
      err.code = 'bot_not_found';
      throw err;
    }
    this.bots.delete(id);
    return { removed: id };
  }
  sendChat(id, message) {
    if (!this.bots.has(id)) {
      const err = new Error('not found');
      err.status = 404;
      err.code = 'bot_not_found';
      throw err;
    }
    this.chats.push({ id, message });
    return { sent: message };
  }
  runCommand(id, command) {
    if (!this.bots.has(id)) {
      const err = new Error('not found');
      err.status = 404;
      err.code = 'bot_not_found';
      throw err;
    }
    this.commands.push({ id, command });
    return { sent: `/${String(command).replace(/^\/+/, '')}` };
  }
  teleport(id, { x, y, z, to, subject } = {}) {
    const cmd = to ? `tp ${subject ?? '@s'} ${to}` : `tp ${subject ?? '@s'} ${x} ${y} ${z}`;
    return this.runCommand(id, cmd);
  }
}

let server, baseUrl, store, botManager, app;

function configForTests() {
  const config = loadConfig({});
  config.rateLimitPerMin = 10_000;
  config.commandRateLimitPerMin = 10_000;
  return config;
}

before(async () => {
  const config = configForTests();
  store = new Store(':memory:');
  botManager = new FakeBotManager();
  app = createApp({ config, store, botManager });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  store.close();
});

async function api(path, { method = 'GET', key, body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // no body
  }
  return { status: res.status, json, headers: res.headers };
}

function mintKey(scopes, name = 'test-key') {
  const created = store.createKey({ name, scopes });
  return created.key;
}

test('healthz is public', async () => {
  const { status, json } = await api('/healthz');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
});

test('v1 endpoints reject missing and invalid keys', async () => {
  assert.equal((await api('/v1/bots')).status, 401);
  const bad = await api('/v1/bots', { key: 'mcai_00000000_' + 'a'.repeat(43) });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error.code, 'unauthorized');
});

test('full bot lifecycle: spawn, list, chat, command, chat log, delete', async () => {
  const key = mintKey(['bot:control', 'bot:command'], 'lifecycle');

  const spawned = await api('/v1/bots', { method: 'POST', key, body: { username: 'TestBot', auth: 'offline' } });
  assert.equal(spawned.status, 201);
  const id = spawned.json.id;
  assert.equal(spawned.json.username, 'TestBot');

  const list = await api('/v1/bots', { key });
  assert.equal(list.json.bots.length, 1);

  const chat = await api(`/v1/bots/${id}/chat`, { method: 'POST', key, body: { message: 'Hello world' } });
  assert.equal(chat.status, 200);
  assert.deepEqual(botManager.chats, [{ id, message: 'Hello world' }]);

  const command = await api(`/v1/bots/${id}/command`, { method: 'POST', key, body: { command: 'gamemode creative @s' } });
  assert.equal(command.status, 200);
  assert.deepEqual(botManager.commands.at(-1), { id, command: 'gamemode creative @s' });

  const history = await api(`/v1/bots/${id}/chat`, { key });
  assert.equal(history.status, 200);
  assert.equal(history.json.messages.length, 1);

  const removed = await api(`/v1/bots/${id}`, { method: 'DELETE', key });
  assert.equal(removed.status, 200);
  assert.equal((await api(`/v1/bots/${id}`, { key })).status, 404);
});

test('scopes are enforced: command scope required for /command and /teleport', async () => {
  const chatOnly = mintKey(['bot:control'], 'chat-only');
  const spawned = await api('/v1/bots', { method: 'POST', key: chatOnly, body: { username: 'ScopeBot' } });
  const id = spawned.json.id;

  const forbidden = await api(`/v1/bots/${id}/command`, { method: 'POST', key: chatOnly, body: { command: 'say hi' } });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.json.error.code, 'insufficient_scope');

  const forbiddenTp = await api(`/v1/bots/${id}/teleport`, { method: 'POST', key: chatOnly, body: { x: 1, y: 64, z: 1 } });
  assert.equal(forbiddenTp.status, 403);

  const audit = await api('/v1/audit', { key: chatOnly });
  assert.equal(audit.status, 403);
});

test('audit:read scope allows reading the audit log and entries are recorded', async () => {
  const admin = mintKey(['bot:control', 'bot:command', 'audit:read'], 'auditor');
  const spawned = await api('/v1/bots', { method: 'POST', key: admin, body: { username: 'AuditBot' } });
  const id = spawned.json.id;
  await api(`/v1/bots/${id}/command`, { method: 'POST', key: admin, body: { command: 'time set day' } });

  const audit = await api('/v1/audit?limit=10', { key: admin });
  assert.equal(audit.status, 200);
  const actions = audit.json.entries.map((e) => e.action);
  assert.ok(actions.includes('bot:spawn'));
  assert.ok(actions.includes('bot:command'));
});

test('teleport builds a /tp command from coordinates or a player', async () => {
  const key = mintKey(['bot:command', 'bot:control'], 'tp-tester');
  const spawned = await api('/v1/bots', { method: 'POST', key, body: { username: 'TpBot' } });
  const id = spawned.json.id;

  const byCoords = await api(`/v1/bots/${id}/teleport`, { method: 'POST', key, body: { x: 10, y: 64, z: -20 } });
  assert.equal(byCoords.status, 200);
  assert.equal(byCoords.json.sent, '/tp @s 10 64 -20');

  const byPlayer = await api(`/v1/bots/${id}/teleport`, { method: 'POST', key, body: { to: 'Steve' } });
  assert.equal(byPlayer.status, 200);
  assert.equal(byPlayer.json.sent, '/tp @s Steve');
});

test('invalid JSON body returns a clean 400', async () => {
  const key = mintKey(['bot:control'], 'json-test');
  const res = await fetch(`${baseUrl}/v1/bots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: '{nope',
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'bad_request');
});

test('unknown v1 route returns JSON 404', async () => {
  const key = mintKey(['bot:control'], 'route-test');
  const { status, json } = await api('/v1/nope', { key });
  assert.equal(status, 404);
  assert.equal(json.error.code, 'not_found');
});
