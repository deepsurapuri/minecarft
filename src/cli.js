/**
 * Admin CLI for the gateway.
 *
 *   node src/cli.js keys create --name "my-ai" --scopes bot:control,bot:command
 *   node src/cli.js keys list
 *   node src/cli.js keys revoke <lookupId>
 *   node src/cli.js audit --limit 20
 *   node src/cli.js ping
 *
 * Minting keys is CLI-only on purpose: no HTTP route can create credentials,
 * so a leaked API key can never clone itself.
 */
import path from 'node:path';
import { loadConfig } from './config.js';
import { Store, KNOWN_SCOPES, normalizeScopes } from './store.js';
import { BotManager } from './botManager.js';

const config = loadConfig();
const [command, subcommand, ...rest] = process.argv.slice(2);

function usage(exitCode = 0) {
  console.log(`Minecraft AI Gateway — admin CLI

Usage:
  node src/cli.js keys create --name <name> --scopes <scope[,scope…]>
  node src/cli.js keys list
  node src/cli.js keys revoke <lookupId>
  node src/cli.js audit [--limit N]
  node src/cli.js ping

Known scopes: ${KNOWN_SCOPES.join(', ')}
  bot:control  manage bots, send chat, read chat history and server status
  bot:command  run cheat commands (/tp, /give, /gamemode, …) as the bot — op required
  audit:read   read the audit log (who ran what, when)
`);
  process.exit(exitCode);
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

async function main() {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    usage(0);
  }

  const store = new Store(path.join(config.dataDir, 'gateway.db'));

  try {
    switch (command) {
      case 'keys': {
        const { flags, positional } = parseFlags(rest);
        switch (subcommand) {
          case 'create': {
            const name = flags.name;
            if (!name || name === true) {
              console.error('Missing --name "My AI agent"');
              process.exit(1);
            }
            let scopes;
            try {
              scopes = normalizeScopes(flags.scopes ?? 'bot:control');
            } catch (error) {
              console.error(error.message);
              process.exit(1);
            }
            const created = store.createKey({ name, scopes });
            console.log('API key created. Store it somewhere safe — it is shown only once:\n');
            console.log(`  Name:      ${created.name}`);
            console.log(`  Key id:    ${created.lookupId}`);
            console.log(`  Scopes:    ${created.scopes.join(', ')}`);
            console.log(`  Key:       ${created.key}\n`);
            console.log('Example:');
            console.log(`  curl -H "Authorization: Bearer ${created.key}" http://127.0.0.1:${config.port}/v1/bots`);
            break;
          }
          case 'list': {
            const keys = store.listKeys();
            if (keys.length === 0) {
              console.log('No API keys yet. Create one with:  node src/cli.js keys create --name "my-ai" --scopes bot:control,bot:command');
              break;
            }
            for (const key of keys) {
              const flags = [key.revokedAt ? `REVOKED ${key.revokedAt}` : 'active'];
              console.log(`${key.lookupId}  ${key.name}\n    scopes: ${key.scopes.join(', ')}\n    created: ${key.createdAt}  last used: ${key.lastUsedAt ?? 'never'}  ${flags[0]}`);
            }
            break;
          }
          case 'revoke': {
            const [lookupId] = positional;
            if (!lookupId) {
              console.error('Usage: node src/cli.js keys revoke <lookupId>');
              process.exit(1);
            }
            const revoked = store.revokeKey(lookupId);
            console.log(revoked ? `Revoked key ${lookupId}.` : `No active key with id ${lookupId} (already revoked or unknown).`);
            break;
          }
          default:
            usage(1);
        }
        break;
      }

      case 'audit': {
        const { flags } = parseFlags(rest);
        const limit = Number(flags.limit ?? 20);
        const entries = store.listAudit(limit);
        if (entries.length === 0) {
          console.log('No audit entries yet.');
          break;
        }
        for (const entry of entries) {
          const who = entry.keyLookupId ?? 'system';
          console.log(`#${entry.id}  ${entry.createdAt}  [${who}]  ${entry.action}  ${entry.detail ?? ''}`);
        }
        break;
      }

      case 'ping': {
        const botManager = new BotManager(config, { log: () => {}, warn: () => {} });
        try {
          const status = await botManager.pingServer();
          console.log(`Bedrock server at ${config.bdsHost}:${config.bdsPort} answered:`);
          console.log(JSON.stringify(status, null, 2));
        } catch (error) {
          console.error(`Could not reach ${config.bdsHost}:${config.bdsPort}: ${error.message}`);
          process.exitCode = 1;
        }
        break;
      }

      default:
        usage(1);
    }
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
