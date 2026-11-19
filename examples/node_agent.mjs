#!/usr/bin/env node
/**
 * Tiny zero-dependency example: drive the gateway with fetch().
 *
 *   AI_GATEWAY_KEY=mcai_... node examples/node_agent.mjs
 *
 * Optional env:
 *   AI_GATEWAY_URL   default http://127.0.0.1:3000
 *   BOT_NAME         default ExampleBot
 */
const baseUrl = process.env.AI_GATEWAY_URL ?? 'http://127.0.0.1:3000';
const apiKey = process.env.AI_GATEWAY_KEY;
const botName = process.env.BOT_NAME ?? 'ExampleBot';

if (!apiKey) {
  console.error('Set AI_GATEWAY_KEY to a key minted with `npm run cli keys create`');
  process.exit(1);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${json?.error?.code ?? ''}: ${json?.error?.message ?? res.statusText}`);
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('== server status ==');
console.log(await api('/v1/server/status').catch((e) => ({ offline: e.message })));

console.log('\n== spawning bot ==');
const bot = await api('/v1/bots', { method: 'POST', body: { username: botName, auth: process.env.BOT_AUTH ?? 'offline' } });
console.log(bot);

// Wait for the connection to come online (BDS takes a second or two).
process.stdout.write('\n== waiting for bot to come online');
let online = false;
for (let i = 0; i < 30; i++) {
  const status = await api(`/v1/bots/${bot.id}`);
  if (status.status === 'online') { online = true; break; }
  if (status.status === 'awaiting_device_code') {
    console.log(`\nMicrosoft sign-in required: open ${status.msa?.url} and enter code ${status.msa?.deviceCode}`);
    break;
  }
  if (['disconnected', 'kicked', 'error'].includes(status.status)) {
    console.log(`\nBot never came online (status=${status.status}${status.lastError ? `, ${status.lastError}` : ''})`);
    process.exit(1);
  }
  process.stdout.write('.');
  await sleep(1000);
}
console.log(online ? ' online!' : '');
if (!online) process.exit(1);
console.log('\n== sending chat ==');
await api(`/v1/bots/${bot.id}/chat`, { method: 'POST', body: { message: 'Hello Minecraft! An AI agent just joined via the gateway API.' } });

console.log('\n== giving myself a compass (admin cheat) ==');
await api(`/v1/bots/${bot.id}/command`, { method: 'POST', body: { command: 'give @s minecraft:compass 1' } }).catch((e) =>
  console.log('command failed (bot needs op + cheats on):', e.message),
);

console.log('\n== reading recent chat ==');
console.log(await api(`/v1/bots/${bot.id}/chat`));

console.log('\n== removing bot ==');
console.log(await api(`/v1/bots/${bot.id}`, { method: 'DELETE' }));

console.log('\nDone. Your AI controls the world — see README.md for the full API.');
