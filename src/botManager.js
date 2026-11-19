import crypto from 'node:crypto';
import bedrockProtocol from 'bedrock-protocol';
import { httpError } from './httpError.js';

const { createClient, ping } = bedrockProtocol;

const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

/**
 * Owns every connected bot. Wraps bedrock-protocol so the rest of the app
 * never touches the wire format directly.
 */
export class BotManager {
  /**
   * @param {object} config   from loadConfig()
   * @param {object} [logger] defaults to console
   */
  constructor(config, logger = console) {
    this.config = config;
    this.log = logger;
    /** @type {Map<string, BotEntry>} */
    this.bots = new Map();
    this.nextBotNumber = 1;
  }

  /** Ping the Bedrock server for its MOTD/player count. */
  async pingServer() {
    try {
      const result = await ping({
        host: this.config.bdsHost,
        port: this.config.bdsPort,
        version: this.config.bdsVersion,
        raknetBackend: raknetBackend(),
      });
      return normalizeAdvertisement(result);
    } catch (error) {
      throw httpError(502, 'server_unreachable', `Could not reach Bedrock server at ${this.config.bdsHost}:${this.config.bdsPort} — ${error.message}`);
    }
  }

  listBots() {
    return [...this.bots.values()].map((entry) => this.summary(entry));
  }

  getBot(id) {
    const entry = this.bots.get(id);
    return entry ? this.summary(entry) : null;
  }

  getChatLog(id) {
    const entry = this.bots.get(id);
    return entry ? [...entry.chatLog] : null;
  }

  /**
   * Spawn a new bot. Returns immediately — the connection completes in the
   * background and clients should poll GET /v1/bots/:id for status.
   */
  spawnBot({ username, auth, host, port, version } = {}) {
    if (this.bots.size >= this.config.maxBots) {
      throw httpError(429, 'bot_limit_reached', `This gateway already has ${this.bots.size} bot(s). Raise MAX_BOTS to connect more.`);
    }

    const mode = auth ?? this.config.defaultAuth;
    if (!['microsoft', 'offline'].includes(mode)) {
      throw httpError(400, 'invalid_auth', `auth must be "microsoft" or "offline", got "${auth}"`);
    }

    const finalUsername = (username && String(username).trim()) || `AIBot${crypto.randomInt(1000, 10000)}`;
    if (!USERNAME_RE.test(finalUsername)) {
      throw httpError(400, 'invalid_username', 'username must be 3–16 characters: letters, digits and underscores only');
    }
    for (const existing of this.bots.values()) {
      if (existing.username.toLowerCase() === finalUsername.toLowerCase()) {
        throw httpError(409, 'username_taken', `A bot named "${finalUsername}" is already on this gateway`);
      }
    }

    const targetHost = host ?? this.config.bdsHost;
    const targetPort = Number.isFinite(Number(port)) ? Number(port) : this.config.bdsPort;
    const targetVersion = version ?? this.config.bdsVersion;
    const id = `bot-${this.nextBotNumber++}`;

    /** @type {BotEntry} */
    const entry = {
      id,
      username: finalUsername,
      auth: mode,
      host: targetHost,
      port: targetPort,
      version: targetVersion,
      status: 'connecting',
      spawned: false,
      createdAt: new Date().toISOString(),
      client: null,
      chatLog: [],
      position: null,
      msa: null,       // device-code info, when Microsoft auth needs it
      lastError: null,
    };

    let client;
    try {
      client = createClient({
        host: targetHost,
        port: targetPort,
        username: finalUsername,
        offline: mode === 'offline',
        version: targetVersion,
        raknetBackend: raknetBackend(),
        profilesFolder: this.config.profilesFolder,
        onMsaCode: (data) => {
          entry.msa = {
            deviceCode: data.user_code ?? null,
            url: data.verification_uri ?? 'https://www.microsoft.com/link',
            message: data.message ?? 'Sign in with the bot\'s Microsoft account to finish linking',
            expiresInSeconds: data.expires_in ?? null,
          };
          entry.status = 'awaiting_device_code';
          this.log.log(`[${id}] Microsoft sign-in required. Code ${entry.msa.deviceCode} at ${entry.msa.url}`);
        },
      });
    } catch (error) {
      // createClient throws synchronously for bad options — no point keeping a zombie entry
      throw httpError(502, 'connect_failed', `Could not create bot client: ${error.message}`);
    }

    entry.client = client;
    this.wireEvents(entry);
    this.bots.set(id, entry);
    return this.summary(entry);
  }

  /** Send a public chat message as the bot. */
  sendChat(id, message) {
    const entry = this.mustGet(id);
    const text = validateChatMessage(message, this.config.maxChatMessageLength);
    this.queue(entry, 'text', {
      type: 'chat',
      needs_translation: false,
      source_name: entry.username,
      xuid: '',
      platform_chat_id: '',
      filtered_message: '',
      message: text,
    });
    this.pushChat(entry, { direction: 'out', source: entry.username, message: text });
    return { sent: text };
  }

  /**
   * Run a server command as the bot by sending it as an op chat message.
   * Requires the bot to be an operator and `allow-cheats=true` on the server.
   */
  runCommand(id, command) {
    const entry = this.mustGet(id);
    const cmd = validateCommand(command, this.config.maxCommandLength);
    this.queue(entry, 'text', {
      type: 'chat',
      needs_translation: false,
      source_name: entry.username,
      xuid: '',
      platform_chat_id: '',
      filtered_message: '',
      message: `/${cmd}`,
    });
    this.pushChat(entry, { direction: 'out', source: entry.username, message: `/${cmd}` });
    return { sent: `/${cmd}` };
  }

  /**
   * Teleport a subject (default: the bot itself) to coordinates or to another player.
   * Implemented via the /tp cheat — the reliable cross-version path on Bedrock.
   */
  teleport(id, { x, y, z, to, subject } = {}) {
    const entry = this.mustGet(id);
    const subj = sanitizeToken(subject) || '@s';
    let cmd;
    if (to !== undefined && to !== null && String(to).trim() !== '') {
      const dest = sanitizeToken(to);
      if (!dest) throw httpError(400, 'invalid_target', 'to must be a player name, @a/@s/@r or a valid selector');
      cmd = `tp ${subj} ${dest}`;
    } else {
      const [nx, ny, nz] = [Number(x), Number(y), Number(z)];
      if (![nx, ny, nz].every(Number.isFinite)) {
        throw httpError(400, 'invalid_coordinates', 'Teleport needs either an absolute x, y, z (numbers) or "to" (a player name)');
      }
      cmd = `tp ${subj} ${round3(nx)} ${round3(ny)} ${round3(nz)}`;
    }
    return { ...this.runCommand(id, cmd), subject: subj };
  }

  /** Disconnect and forget a bot. */
  async removeBot(id) {
    const entry = this.mustGet(id);
    try {
      entry.client?.disconnect();
    } catch (error) {
      this.log.warn?.(`[${id}] error while disconnecting: ${error.message}`);
    }
    entry.status = 'disconnected';
    this.bots.delete(id);
    return { removed: id };
  }

  /** Disconnect everything (used on graceful shutdown). */
  async disconnectAll() {
    const pending = [];
    for (const entry of this.bots.values()) {
      try {
        entry.client?.disconnect();
      } catch {
        // best effort on shutdown
      }
      pending.push(entry.id);
    }
    this.bots.clear();
    return pending;
  }

  // ---------- internals ----------

  mustGet(id) {
    const entry = this.bots.get(id);
    if (!entry) throw httpError(404, 'bot_not_found', `No bot with id "${id}". It may have been kicked and removed, or never existed.`);
    return entry;
  }

  queue(entry, packetName, payload) {
    if (!entry.client) throw httpError(502, 'bot_not_connected', 'Bot has no connection (it may be awaiting Microsoft sign-in or already disconnected)');
    if (entry.status !== 'online') {
      throw httpError(409, 'bot_not_ready', `Bot is "${entry.status}" — wait until status is "online" (poll GET /v1/bots/${entry.id})${entry.lastError ? `. Last error: ${entry.lastError}` : ''}`);
    }
    try {
      entry.client.queue(packetName, payload);
    } catch (error) {
      throw httpError(502, 'send_failed', `Failed to send ${packetName} packet: ${error.message}`);
    }
  }

  wireEvents(entry) {
    const client = entry.client;

    client.on('spawn', () => {
      entry.spawned = true;
      entry.status = 'online';
    });
    // Some bedrock-protocol versions emit 'join' instead of 'spawn'
    client.on('join', () => {
      entry.spawned = true;
      entry.status = 'online';
    });

    client.on('text', (packet) => {
      const message = typeof packet.message === 'string' ? packet.message : String(packet.message ?? '');
      this.pushChat(entry, {
        direction: 'in',
        source: packet.source_name || packet.xuid || packet.type || 'server',
        message,
      });
    });

    const trackPosition = (packet) => {
      const pos = packet?.position ?? packet;
      if (pos && [pos.x, pos.y, pos.z].every(Number.isFinite)) {
        entry.position = { x: pos.x, y: pos.y, z: pos.z };
      }
    };
    client.on('move_player', trackPosition);
    client.on('player_auth_input', trackPosition);

    client.on('disconnect', (reason) => {
      entry.status = 'disconnected';
      entry.lastError = stringifyReason(reason);
    });
    client.on('kick', (reason) => {
      entry.status = 'kicked';
      entry.lastError = stringifyReason(reason);
    });
    client.on('close', () => {
      if (entry.status === 'connecting' || entry.status === 'awaiting_device_code') entry.status = 'disconnected';
      else entry.status = 'disconnected';
    });
    client.on('error', (error) => {
      // Errors are expected (e.g. wrong password, unreachable server) — record, don't crash.
      entry.lastError = error?.message ?? String(error);
      this.log.warn?.(`[${entry.id}] client error: ${entry.lastError}`);
    });
  }

  pushChat(entry, { direction, source, message }) {
    entry.chatLog.push({
      at: new Date().toISOString(),
      direction,
      source,
      message: String(message).slice(0, 512),
    });
    if (entry.chatLog.length > this.config.chatLogSize) {
      entry.chatLog.splice(0, entry.chatLog.length - this.config.chatLogSize);
    }
  }

  summary(entry) {
    return {
      id: entry.id,
      username: entry.username,
      auth: entry.auth,
      host: entry.host,
      port: entry.port,
      version: entry.version ?? null,
      status: entry.status,
      spawned: entry.spawned,
      position: entry.position,
      createdAt: entry.createdAt,
      msa: entry.status === 'awaiting_device_code' ? entry.msa : undefined,
      lastError: entry.lastError ?? undefined,
    };
  }
}


function rejectControlChars(value, code) {
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw httpError(400, code, 'must not contain control characters (newlines, tabs, …)');
  }
}

function raknetBackend() {
  // raknet-native needs a cmake toolchain; the pure-JS jsp-raknet works everywhere.
  return process.env.RAKNET_BACKEND || 'jsp-raknet';
}

function normalizeAdvertisement(result) {
  const raw = result && typeof result === 'object' ? result : {};
  const motd = raw.motd ?? raw.description?.text ?? raw.serverName ?? null;
  const playersOnline = firstFinite(raw.playersOnline, raw.players?.online, raw.onlinePlayers);
  const playersMax = firstFinite(raw.playersMax, raw.players?.max, raw.maxPlayers);
  const version = raw.version ?? raw.protocolVersion ?? raw.minecraftVersion ?? null;
  return {
    online: true,
    motd,
    playersOnline: playersOnline ?? null,
    playersMax: playersMax ?? null,
    version,
    levelName: raw.levelName ?? raw.worldName ?? null,
  };
}

function firstFinite(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function validateChatMessage(message, maxLength) {
  if (typeof message !== 'string') throw httpError(400, 'invalid_message', 'message must be a string');
  rejectControlChars(message, 'invalid_message');
  const trimmed = message.trim();
  if (!trimmed) throw httpError(400, 'invalid_message', 'message must not be empty');
  if (trimmed.length > maxLength) {
    throw httpError(400, 'message_too_long', `message is ${trimmed.length} chars; the limit is ${maxLength}`);
  }
  return trimmed;
}

function validateCommand(command, maxLength) {
  if (typeof command !== 'string') throw httpError(400, 'invalid_command', 'command must be a string');
  rejectControlChars(command, 'invalid_command');
  const cmd = command.trim().replace(/^\/+/, '');
  if (!cmd) throw httpError(400, 'invalid_command', 'command must not be empty');
  if (cmd.length > maxLength) {
    throw httpError(400, 'command_too_long', `command is ${cmd.length} chars; the limit is ${maxLength}`);
  }
  return cmd;
}

/** Allow player names and benign selectors only — no spaces, no brackets, no newlines. */
function sanitizeToken(token) {
  if (token === undefined || token === null) return null;
  const clean = String(token).trim();
  if (!clean) return null;
  if (!/^[A-Za-z0-9_@\[\]=,.!-]{1,64}$/.test(clean)) {
    throw httpError(400, 'invalid_target', 'target must be a player name or a simple selector like @a, @s, @r or @e[type=player]');
  }
  return clean;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function stringifyReason(reason) {
  if (reason == null) return 'unknown';
  if (typeof reason === 'string') return reason;
  if (reason.message) return reason.message;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

/** @typedef {{ id: string, username: string, auth: string, host: string, port: number, version?: string, status: string, spawned: boolean, createdAt: string, client: any, chatLog: Array<{at: string, direction: string, source: string, message: string}>, position: {x: number, y: number, z: number} | null, msa: object | null, lastError: string | null }} BotEntry */
