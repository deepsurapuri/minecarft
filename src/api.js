import express from 'express';
import { httpError } from './httpError.js';
import { RateLimiter } from './ratelimit.js';

/**
 * Build the HTTP API. Dependencies are injected so tests can swap the
 * BotManager for a fake and the store for an in-memory database.
 *
 * @param {{ config: object, store: object, botManager: object, rateLimiter?: RateLimiter }} deps
 */
export function createApp({ config, store, botManager, rateLimiter = new RateLimiter() }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '16kb' }));

  // Minimal security headers — the API speaks JSON only.
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Cache-Control', 'no-store');
    next();
  });

  // Unauthenticated liveness probe for load balancers / Docker HEALTHCHECK.
  app.get('/healthz', (req, res) => {
    res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
  });

  // Everything under /v1 requires a valid API key. Scopes are enforced per route.
  app.use('/v1', authenticate(store));

  // Per-key general rate limit for everything under /v1.
  app.use('/v1', (req, res, next) => {
    const result = rateLimiter.check(`${req.apiKey.lookupId}:general`, config.rateLimitPerMin);
    res.set('X-RateLimit-Limit', String(config.rateLimitPerMin));
    res.set('X-RateLimit-Remaining', String(Math.max(result.remaining, 0)));
    if (!result.ok) {
      res.set('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
      return next(httpError(429, 'rate_limited', 'Too many requests — slow down and retry later'));
    }
    next();
  });

  const audit = (keyLookupId, action, detail) => {
    try {
      store.addAudit(keyLookupId, action, detail);
    } catch (error) {
      console.error(`[audit] failed to write audit log: ${error.message}`);
    }
  };

  const commandRateLimit = (req) => {
    const result = rateLimiter.check(`${req.apiKey.lookupId}:command`, config.commandRateLimitPerMin);
    if (!result.ok) {
      throw httpError(429, 'rate_limited', 'Command rate limit exceeded — slow down and retry later');
    }
  };

  // ---------- status ----------
  app.get('/v1/server/status', requireScope('bot:control'), asyncHandler(async (req, res) => {
    const status = await botManager.pingServer();
    res.json(status);
  }));

  // ---------- bots ----------
  app.get('/v1/bots', requireScope('bot:control'), (req, res) => {
    res.json({ bots: botManager.listBots() });
  });

  app.post('/v1/bots', requireScope('bot:control'), (req, res) => {
    const { username, auth, host, port, version } = req.body ?? {};
    const bot = botManager.spawnBot({ username, auth, host, port, version });
    audit(req.apiKey.lookupId, 'bot:spawn', { id: bot.id, username: bot.username, auth: bot.auth });
    res.status(201).json(bot);
  });

  app.get('/v1/bots/:id', requireScope('bot:control'), (req, res) => {
    const bot = botManager.getBot(req.params.id);
    if (!bot) throw httpError(404, 'bot_not_found', `No bot with id "${req.params.id}"`);
    res.json(bot);
  });

  app.delete('/v1/bots/:id', requireScope('bot:control'), asyncHandler(async (req, res) => {
    const result = await botManager.removeBot(req.params.id);
    audit(req.apiKey.lookupId, 'bot:remove', { id: req.params.id });
    res.json(result);
  }));

  // ---------- chat ----------
  app.get('/v1/bots/:id/chat', requireScope('bot:control'), (req, res) => {
    const messages = botManager.getChatLog(req.params.id);
    if (!messages) throw httpError(404, 'bot_not_found', `No bot with id "${req.params.id}"`);
    res.json({ messages });
  });

  app.post('/v1/bots/:id/chat', requireScope('bot:control'), (req, res) => {
    const result = botManager.sendChat(req.params.id, req.body?.message);
    audit(req.apiKey.lookupId, 'bot:chat', { id: req.params.id, message: result.sent });
    res.json(result);
  });

  // ---------- commands (cheats / admin) ----------
  app.post('/v1/bots/:id/command', requireScope('bot:command'), (req, res) => {
    commandRateLimit(req);
    const result = botManager.runCommand(req.params.id, req.body?.command);
    audit(req.apiKey.lookupId, 'bot:command', { id: req.params.id, command: result.sent });
    res.json(result);
  });

  app.post('/v1/bots/:id/teleport', requireScope('bot:command'), (req, res) => {
    commandRateLimit(req);
    const { x, y, z, to, subject } = req.body ?? {};
    const result = botManager.teleport(req.params.id, { x, y, z, to, subject });
    audit(req.apiKey.lookupId, 'bot:teleport', { id: req.params.id, ...result });
    res.json(result);
  });

  // ---------- audit log ----------
  app.get('/v1/audit', requireScope('audit:read'), (req, res) => {
    res.json({ entries: store.listAudit(req.query.limit) });
  });

  // 404 for anything else under /v1
  app.use('/v1', (req, res, next) => {
    next(httpError(404, 'not_found', `No route ${req.method} ${req.path}`));
  });

  // Central error handler — always JSON, never a stack trace on the wire.
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (error?.type === 'entity.parse.failed' || error?.type === 'entity.too.large') {
      return res.status(400).json({ error: { code: 'bad_request', message: 'Request body must be valid JSON and under 16 KB' } });
    }
    const status = Number.isInteger(error?.status) ? error.status : 500;
    const code = error?.code || (status === 500 ? 'internal_error' : 'error');
    if (status >= 500) console.error(`[error] ${req.method} ${req.path}:`, error);
    res.status(status).json({
      error: {
        code,
        message: status >= 500 && !error?.code ? 'Internal server error' : error.message,
      },
    });
  });

  return app;
}

function authenticate(store) {
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    const presented = match ? match[1].trim() : null;
    const record = presented ? store.verifyKey(presented) : null;
    if (!record) {
      res.set('WWW-Authenticate', 'Bearer realm="minecarft-ai-gateway"');
      return next(httpError(401, 'unauthorized', 'Missing or invalid API key. Pass `Authorization: Bearer <key>`.'));
    }
    store.touchKey(record.lookupId);
    req.apiKey = record;
    next();
  };
}

function requireScope(scope) {
  return (req, res, next) => {
    if (!req.apiKey?.scopes?.includes(scope)) {
      return next(httpError(403, 'insufficient_scope', `This API key is missing the "${scope}" scope`));
    }
    next();
  };
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
