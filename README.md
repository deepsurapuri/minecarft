# minecarft — AI-agent gateway for your Minecraft Bedrock world

An HTTP control plane that lets AI agents with an **API key** connect to your
Minecraft **Bedrock Edition** world as bots — chat in game, read chat, teleport,
and run cheat commands (`/tp`, `/give`, `/gamemode`, `/time`, `/weather`, `/kick`,
`/ban`, `/setblock`, `/fill`, …) as operators, plus full per-key audit logging.

Works against a **Bedrock Dedicated Server** (a.k.a. BDS) — the same software you
can self-host with Docker (included) or rent from any Bedrock host.

```text
┌────────────┐   HTTPS + Bearer key   ┌─────────────────┐   RakNet (Bedrock protocol)  ┌──────────────────┐
│  AI agent  │ ─────────────────────▶ │  ai-gateway     │ ───────────────────────────▶ │  Bedrock world   │
│ (GPT/Claude│   REST /v1/*           │  (this repo)    │   bot connections            │  (BDS / Docker)  │
│  /your bot)│ ◀───────────────────── │  auth · audit   │ ◀─────────────────────────── │                  │
└────────────┘   JSON responses       └─────────────────┘   chat · spawn · packets     └──────────────────┘
```

## What you get

- **Per-key authentication** — keys are generated on your machine (CLI), stored as
  scrypt hashes, never logged, revocable at any time.
- **Scoped access** — `bot:control` (spawn/chat/read), `bot:command` (run cheats as
  an operator bot), `audit:read` (see who did what).
- **Multiple bots** — each AI gets its own bot(s); list/inspect/remove them via API.
- **Chat both ways** — the AI sends chat and can poll recent in-game chat messages.
- **Full admin through cheats** — any `/command` an operator can run, including all
  administrative commands, gated by the `bot:command` scope + rate limits + audit log.
- **Audit log** — every spawn/chat/command/teleport is written to SQLite with the
  key id, so you always know which AI did what.
- **Local test world included** — `docker compose up` runs a real Bedrock world and
  the gateway side by side.
- **Example AI agents** — `examples/python_agent.py` (scripted demo + an LLM
  tool-use loop that drives the gateway as tools) and `examples/node_agent.mjs`.

## Honest limitations (read this)

- **Bedrock bots can't (yet) mine, dig or pathfind** at the quality of Java's
  mineflayer. This gateway controls the world through chat and cheat commands —
  which *is* full server-side admin (`/tp`, `/give`, `/setblock`, `/fill`,
  `/gamemode`, `/kick`, …) — but it does not simulate clicking blocks. Walking
  physics/pathfinding is on the roadmap (see below).
- Each bot on an `online-mode=true` server needs its **own Microsoft account that
  owns Minecraft Bedrock**. For private/LAN use, `online-mode=false` +
  `offline` bots need no accounts.
- Commands only take effect if the bot is an **operator** and the server has
  **`allow-cheats=true`**.
- This is a self-hosted tool for *your* world. Don't point it at servers you
  don't own or aren't allowed to automate.

## Requirements

- Docker + Docker Compose (easiest), or Node.js ≥ 22.5 (for `node:sqlite`)
- A Bedrock Dedicated Server — either the one in `docker-compose.yml` (created for
  you) or an existing one you administer

## Quickstart — local test world with Docker

```bash
git clone <this repo> minecarft && cd minecarft
docker compose up -d --build
```

Watch the BDS boot (first run downloads the server — needs internet):

```bash
docker compose logs -f bds
```

Mint an API key (this is the only way to create keys — there is no HTTP route for it):

```bash
docker compose exec gateway node src/cli.js keys create \
  --name "my-first-ai" --scopes bot:control,bot:command
# → prints a key like  mcai_1a2b3c4d_…  (shown exactly once)
```

Check the API answers and spawn a bot:

```bash
export KEY=mcai_1a2b3c4d_replace_me

curl http://localhost:3000/healthz
# {"ok":true,"uptimeSeconds":12}

curl -s -H "Authorization: Bearer $KEY" http://localhost:3000/v1/server/status
# {"online":true,"motd":"Minecraft AI World","playersOnline":0,...}

curl -s -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"username":"TestBot","auth":"offline"}' \
  http://localhost:3000/v1/bots
```

Open Minecraft (Bedrock) → Servers → add `<host-ip>:19132` and join the same world
— you'll see `TestBot` in the player list. Then give the bot a gift:

```bash
curl -s -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"command":"give @s minecraft:diamond 3"}' \
  http://localhost:3000/v1/bots/bot-1/command
```

Scripted demo of the whole flow (join → chat → teleport → read chat → leave):

```bash
AI_GATEWAY_KEY=$KEY node examples/node_agent.mjs
AI_GATEWAY_KEY=$KEY python3 examples/python_agent.py
```

## Pointing at your own Bedrock server instead

Stop the bundled BDS and just run the gateway:

```bash
docker compose up -d --build gateway
# or without Docker:
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt npm install --ignore-scripts
BDS_HOST=my.server.ip BDS_PORT=19132 BOT_AUTH=offline npm start
```

Set `BDS_HOST`/`BDS_PORT` via environment (see [.env.example](.env.example)).
If the server is `online-mode=false` **and on the same LAN**, `BOT_AUTH=offline`
is all you need. Otherwise use Xbox Live sign-in (next section).

## Online servers — Microsoft/Xbox Live sign-in

When `online-mode=true` (the default on BDS, and **always** required for
non-LAN/internet play), each bot must authenticate with Xbox Live:

1. Set `BOT_AUTH=microsoft` (or `ONLINE_MODE=true` + `BOT_AUTH=microsoft` for compose).
2. Spawn a bot. Its status becomes `awaiting_device_code`.
3. Read the sign-in code:

   ```bash
   curl -s -H "Authorization: Bearer $KEY" http://localhost:3000/v1/bots/bot-1
   # { "status": "awaiting_device_code", "msa": { "deviceCode": "ABCD-EFGH", "url": "https://www.microsoft.com/link", ... } }
   ```

4. Open <https://www.microsoft.com/link> in a browser, enter the code, and sign
   in **with the bot's Microsoft account**. Tokens are cached in
   `PROFILES_FOLDER` (a volume in Docker), so subsequent restarts don't ask again.
5. The bot connects once auth completes. Poll the same endpoint until
   `status` becomes `online`.

The bot account needs to own Minecraft Bedrock. Use spare/secondary accounts —
never your main one.

## Making bots operators (required for cheats)

Commands like `/give` or `/tp @s` only work if the bot is an operator **and** the
server has `allow-cheats=true`.

- **Dev/test (compose default):** `DEFAULT_PLAYER_PERMISSION_LEVEL=operator` —
  everyone, including bots, is an operator. Convenient, unsafe for real worlds.
- **Real server:** set `DEFAULT_PLAYER_PERMISSION_LEVEL=member`, then grant each
  bot operator rights by **XUID** (decimal, *not* the gamertag):
  - `OPS="1234567890123456,6543210987654321"` on the `itzg/minecraft-bedrock-server`
    image (set before first start, or edit `permissions.json` in the `./data`
    volume), or
  - edit `permissions.json` in your BDS directory:
    `[{"permission":"operator","xuid":"1234567890123456"}]`
- Find a bot's XUID by signing in once with that account and checking the server
  log or the `permissions.json` it tries to write — or via any XUID lookup service.

## API reference

Base URL `http://<host>:3000`. Every `/v1/*` route requires
`Authorization: Bearer <key>`. All responses are JSON. Errors look like
`{"error":{"code":"insufficient_scope","message":"..."}}`.

| Method & path | Scope | What it does |
| --- | --- | --- |
| `GET /healthz` | *public* | Liveness probe for Docker/load balancers |
| `GET /v1/server/status` | `bot:control` | Ping the Bedrock server (MOTD, players, version) |
| `POST /v1/bots` | `bot:control` | Spawn a bot → `{"id":"bot-1",...}` (201) |
| `GET /v1/bots` | `bot:control` | List spawned bots |
| `GET /v1/bots/:id` | `bot:control` | Bot detail — status, position, MS-auth code if pending |
| `DELETE /v1/bots/:id` | `bot:control` | Disconnect & remove a bot |
| `GET /v1/bots/:id/chat` | `bot:control` | Last N chat messages (in & out) |
| `POST /v1/bots/:id/chat` | `bot:control` | Send chat `{"message":"hi"}` ≤ 256 chars |
| `POST /v1/bots/:id/command` | `bot:command` | Run `{"command":"give @s minecraft:stick 1"}` as the bot (op) |
| `POST /v1/bots/:id/teleport` | `bot:command` | `{"x":1,"y":64,"z":-5}` or `{"to":"Steve","subject":"@s"}` |
| `GET /v1/audit?limit=50` | `audit:read` | Recent audit entries, newest first |

Notes:

- `POST /v1/bots` body fields are all optional: `{"username":"Ada", "auth":"offline"|"microsoft",
  "host":"…", "port":19132, "version":"1.21.0"}`. Omitted `username` → random `AIBotNNNN`.
- Cheat commands are sent as op chat (`/…`). The gateway returns `{"sent":"/…"}` —
  the game itself decides whether the command executes (op + cheats required).
- A bot takes a few seconds to connect. Chat/command/teleport sent too early
  return `409 {"error":{"code":"bot_not_ready", …}}` — poll `GET /v1/bots/:id`
  until `status` is `online` (the example scripts do this for you).
- Chat history is in-memory per bot (ring buffer, `CHAT_LOG_SIZE`, default 100).
- Rate limits: `RATE_LIMIT_PER_MIN` (default 120/min) and `COMMAND_RATE_LIMIT_PER_MIN`
  (default 60/min), per key. `429` + `Retry-After` when exceeded.
- Keys can never be created over HTTP — only via `src/cli.js keys create`.

### system prompt snippet for your AI

> You can act inside a Minecraft Bedrock world through an HTTP API at `$BASE`.
> Authenticate with `Authorization: Bearer $KEY`. A bot takes a few seconds to connect:
> spawn first, poll `GET /v1/bots/{id}` until `status` is `online`, then act. Tools: `POST /v1/bots` (spawn,
> returns `id`), `POST /v1/bots/{id}/chat` (say something), `GET /v1/bots/{id}/chat`
> (read chat), `POST /v1/bots/{id}/command` (run an operator cheat command without
> the leading slash), `POST /v1/bots/{id}/teleport` (`{x,y,z}` or `{to}`),
> `GET /v1/bots` (list), `DELETE /v1/bots/{id}` (leave). Cheats require your bot to
> be an operator. Be polite in chat.

`examples/python_agent.py --llm "build a house"` does exactly this with an
OpenAI-compatible tool-calling loop.

## CLI

```bash
node src/cli.js keys create --name "my-ai" --scopes bot:control,bot:command
node src/cli.js keys list
node src/cli.js keys revoke 1a2b3c4d        # by key id (first 8 hex chars)
node src/cli.js audit --limit 20
node src/cli.js ping                        # can the gateway see the BDS?
```

## Configuration (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Gateway HTTP bind |
| `BDS_HOST` / `BDS_PORT` | `127.0.0.1` / `19132` | Target Bedrock server |
| `BDS_VERSION` | *(newest supported)* | Pin protocol version, e.g. `1.21.0` |
| `BOT_AUTH` | `microsoft` | `offline` (LAN/online-mode=false) or `microsoft` |
| `DATA_DIR` | `./data` | Where `gateway.db` (keys + audit) lives |
| `PROFILES_FOLDER` | `./data/profiles` | Cached Xbox Live tokens |
| `MAX_BOTS` | `10` | Max simultaneous bots |
| `RATE_LIMIT_PER_MIN` | `120` | General per-key HTTP rate limit |
| `COMMAND_RATE_LIMIT_PER_MIN` | `60` | Per-key command rate limit |
| `CHAT_LOG_SIZE` | `100` | Chat ring buffer size per bot |
| `RAKNET_BACKEND` | `jsp-raknet` | `raknet-native` if you built the addon |

See [.env.example](.env.example).

## Security checklist

- Keep `ONLINE_MODE=false` **only** on trusted LANs; use `online-mode=true` +
  Xbox auth on anything routable.
- Run the gateway behind HTTPS (Caddy/nginx + Let's Encrypt) or on a private
  network — the API key **is** the credential.
- Hand out one key per agent. Revoke freely: `keys revoke <id>`.
- Prefer `DEFAULT_PLAYER_PERMISSION_LEVEL=member` + explicit `OPS` xuids.
- Enable `allow-list` on the BDS so only intended accounts (incl. bots) can join.
- Scrub the audit log with `GET /v1/audit` / `node src/cli.js audit`.
- Rotate keys; they're cheap. Nothing is logged except hashes.

## Performance note: raknet-native

`bedrock-protocol` can use a native RakNet addon (`raknet-native`) for lower
latency, but it needs a cmake toolchain and Node headers. Everything works out of
the box with the pure-JS backend, so installs are all
`npm install --ignore-scripts`. If you have cmake + nodejs.org access,
`npm rebuild raknet-native` and `RAKNET_BACKEND=raknet-native`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `server_unreachable` on `/v1/server/status` | BDS down or port wrong; remember **19132/udp**; from compose, use `BDS_HOST=bds` |
| Bot spawns but never reaches `online` | Wrong `BDS_VERSION`; Xbox device-code not completed; server full (`max-players`); allow-list blocks the account |
| `/command` returns 200 but nothing happens in game | Bot is not an operator, or `allow-cheats=false`, or bad command (check `docker compose logs bds`) |
| Bot instantly kicked | `online-mode=true` server but bot has no Xbox auth → use `BOT_AUTH=microsoft`; or account lacks Minecraft license |
| Login works once then fails after days | Xbox tokens cached in `profiles/` expired — delete the folder and re-auth |
| `npm install` fails at `raknet-native` | Use `npm install --ignore-scripts` (jsp-raknet fallback). This is the default everywhere |
| Client wants to build a player-walking pathfinder | Not supported yet — see roadmap |

## Project layout

```text
src/
  server.js       entry point, graceful shutdown
  config.js       env-driven configuration
  keys.js         API key generation + scrypt hashing
  store.js        SQLite (node:sqlite) — keys & audit log
  ratelimit.js    fixed-window limiter
  botManager.js   bedrock-protocol wrapper — connect/chat/commands/teleport
  api.js          express app (dependency-injected for tests)
  cli.js          admin CLI (keys, audit, ping)
test/             22 unit/integration tests (node:test, no Minecraft needed)
examples/         python (scripted + LLM tool-use) and node agents
docker-compose.yml  local BDS world + gateway
.github/workflows/ci.yml
```

## Development

```bash
npm install --ignore-scripts
npm test            # 22 tests, fully offline
npm run dev         # --watch mode
DATA_DIR=./data node src/cli.js keys create --name dev --scopes bot:control,bot:command,audit:read
```

## Roadmap

- Physics/pathfinding movement (evaluate `mineflayer-bedrock`/`bedboo` once it matures)
- SSE/WebSocket chat stream instead of polling
- Per-bot webhooks, richer selectors, world/inventory queries
- Multi-server support (one gateway, many worlds)

## License

MIT — see [LICENSE](LICENSE).
