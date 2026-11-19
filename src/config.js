/**
 * Central configuration for the Minecraft AI gateway.
 * Everything is driven by environment variables so the same image can run
 * locally, in Docker Compose, or on a VPS without code changes.
 */
export function loadConfig(env = process.env) {
  const int = (value, fallback) => {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    /** HTTP API bind address/port for the gateway itself. */
    host: env.HOST || '0.0.0.0',
    port: int(env.PORT, 3000),

    /** Target Bedrock Dedicated Server. */
    bdsHost: env.BDS_HOST || '127.0.0.1',
    bdsPort: int(env.BDS_PORT, 19132),
    /** Pin a protocol version (e.g. "1.21.0"). Defaults to the newest bedrock-protocol supports. */
    bdsVersion: env.BDS_VERSION || undefined,

    /** Where API keys (hashed) and the audit log live. */
    dataDir: env.DATA_DIR || './data',
    /** Where Microsoft/Xbox Live auth tokens are cached between restarts. */
    profilesFolder: env.PROFILES_FOLDER || './data/profiles',

    /** Default auth mode for spawned bots: 'microsoft' (Xbox Live) or 'offline' (LAN / online-mode=false). */
    defaultAuth: env.BOT_AUTH || 'microsoft',

    /** Safety rails. */
    maxBots: int(env.MAX_BOTS, 10),
    rateLimitPerMin: int(env.RATE_LIMIT_PER_MIN, 120),
    commandRateLimitPerMin: int(env.COMMAND_RATE_LIMIT_PER_MIN, 60),
    maxChatMessageLength: 256,
    maxCommandLength: 256,
    chatLogSize: int(env.CHAT_LOG_SIZE, 100),
  };
}
