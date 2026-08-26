# Relay worker — a Telegram long-poll agent. No inbound port (long-poll) and no
# browser (anvil-engine owns Chrome), so this image is tiny: just Node + dist.
FROM node:22-slim

WORKDIR /app

# Production deps only (puppeteer-core has no bundled Chromium — it connects to anvil).
COPY package*.json ./
RUN npm ci --omit=dev

# Pre-built output (run `npm run build` before docker build).
COPY dist/ ./dist/

# Config comes from the environment (see .env.example). ANVIL_BASE_URL must point
# at the anvil service (e.g. http://anvil:3000 in docker-compose).
ENV NODE_ENV=production

# Long-poll worker: no EXPOSE. Liveness = process up (it exits non-zero if
# TELEGRAM_BOT_TOKEN is missing).
CMD ["node", "dist/index.js"]
