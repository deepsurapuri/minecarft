import path from 'node:path';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { BotManager } from './botManager.js';
import { createApp } from './api.js';

const config = loadConfig();
const store = new Store(path.join(config.dataDir, 'gateway.db'));
const botManager = new BotManager(config);
const app = createApp({ config, store, botManager });

const server = app.listen(config.port, config.host, () => {
  console.log(`┌─────────────────────────────────────────────────────────┐`);
  console.log(`│  Minecraft AI Gateway is listening                      │`);
  console.log(`│                                                         │`);
  console.log(`│  API:        http://${config.host}:${String(config.port).padEnd(5)}                      │`);
  console.log(`│  Target BDS: ${`${config.bdsHost}:${config.bdsPort}`.padEnd(45)}│`);
  console.log(`│  Bot auth:   ${config.defaultAuth.padEnd(45)}│`);
  console.log(`└─────────────────────────────────────────────────────────┘`);
  console.log(`Mint your first API key with:  npm run cli keys create --name "my-ai" --scopes bot:control,bot:command`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal} — disconnecting bots and closing the gateway…`);
  try {
    await botManager.disconnectAll();
  } catch (error) {
    console.error(`Error disconnecting bots: ${error.message}`);
  }
  server.close(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
    process.exit(0);
  });
  // Force-exit if connections linger
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  console.error('[uncaughtException]', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
