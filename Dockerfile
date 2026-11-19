# syntax=docker/dockerfile:1
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# raknet-native (an optional bedrock-protocol accelerator) can't build without a
# cmake toolchain, so scripts are skipped — the pure-JS jsp-raknet backend is
# used instead (set RAKNET_BACKEND=raknet-native only if you rebuild the addon).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src

USER node
ENV PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    PROFILES_FOLDER=/data/profiles \
    BOT_AUTH=offline

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1 || exit 1

CMD ["node", "src/server.js"]
