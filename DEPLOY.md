# Deploying Relay 24/7 (free)

Goal: Relay + anvil running always-on so anyone can text the bot anytime — on
**free** infra. Recommended host: **Oracle Cloud Always Free** (a genuinely
always-on VM that fits Chrome; Render/Fly free tiers spin down or are too small).

You need three secrets first (only you can create these — login walls):
- `TELEGRAM_BOT_TOKEN` — [@BotFather](https://t.me/BotFather) → `/newbot`.
- `GEMINI_API_KEY` — https://aistudio.google.com/apikey (free tier).
- `ANVIL_API_KEY` — optional; any random string to lock down anvil.

## Option A — Oracle Cloud Always Free VM (recommended, 24/7)

1. **Create the VM**: Oracle Cloud → Compute → Instances → Create. Pick an
   **Always Free eligible** shape:
   - Ampere A1 (ARM): up to 4 OCPU / 24 GB — best, or
   - VM.Standard.E2.1.Micro (x86): 1 OCPU / 1 GB — works but tight for Chrome; set `ANVIL_MAX_SESSIONS=2`.
   Ubuntu 22.04 image. Add your SSH key. Open no inbound ports (Relay long-polls; nothing inbound needed).

2. **Install Docker** (on the VM):
   ```bash
   sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin git
   sudo usermod -aG docker $USER && newgrp docker
   ```

3. **Clone both repos side by side**:
   ```bash
   git clone https://github.com/awictor/anvil-engine.git
   git clone https://github.com/awictor/relay.git
   ```

4. **Build both** (compose copies pre-built dist/):
   ```bash
   cd anvil-engine && npm ci && npm run build && cd ..
   cd relay && npm ci && npm run build
   ```

5. **Create `relay/.env`** (next to docker-compose.yml):
   ```
   TELEGRAM_BOT_TOKEN=123456:AA...
   GEMINI_API_KEY=AIza...
   ANVIL_API_KEY=some-long-random-string
   ```

6. **Launch**:
   ```bash
   docker compose up -d --build
   docker compose logs -f relay      # watch it come up; "Relay polling Telegram…"
   ```

7. **Test**: text your bot on Telegram ("top story on Hacker News"). It should
   reply after driving anvil.

Auto-restart on reboot is handled by `restart: unless-stopped` in the compose file.

## Option B — your own machine (free, not 24/7)

Runs only while your machine is on. No Docker needed:
```bash
# terminal 1 — anvil (needs local Chrome)
cd anvil-engine && npm run build && CHROME_PATH="<path-to-chrome>" npm start
# terminal 2 — relay
cd relay && cp .env.example .env   # fill TELEGRAM_BOT_TOKEN + GEMINI_API_KEY
npm run build && npm start
```

## Health & troubleshooting

- **Is it up?** `docker compose ps` — both `anvil` and `relay` should be `running`
  (anvil `healthy`). anvil's healthcheck probes `/v1/live`; relay waits for anvil to be
  healthy before starting (`depends_on: condition: service_healthy`).
- **Watch it work**: `docker compose logs -f relay` — on boot it prints `anvil
  reachable: true` and starts polling. Each inbound text logs `[in] <chat>: …`.
- **anvil check from the host** (only if you published its port): `curl
  localhost:3000/v1/live` → `{"status":"ok"...}`. By default the port isn't published;
  exec in instead: `docker compose exec anvil node -e "fetch('http://localhost:3000/v1/live').then(r=>r.text()).then(console.log)"`.
- **Bot silent?** Check, in order: (1) `GEMINI_API_KEY` valid (logs show a model
  error if not); (2) anvil `healthy` (`docker compose ps`); (3) the token is for the
  bot you're texting (`getMe`). Relay auto-fails-over across Gemini models on quota/429.
- **Model note**: don't set `GEMINI_MODEL=gemini-2.0-flash` — it's not valid for the
  free `AQ.`/`AIza` key shape. Leave it unset to use Relay's failover chain
  (`gemini-flash-lite-latest` first).
- **Update**: `git -C anvil-engine pull && git -C relay pull && cd relay && npm ci &&
  npm run build && docker compose up -d --build`.

## Notes / honest limits
- **Compute, not vendor, is the wall.** Self-hosting removes Browserbase's per-call
  meter + quota, but you still run the Chrome fleet. The Micro shape handles a
  couple concurrent sessions; the Ampere A1 shape handles many. Tune
  `ANVIL_MAX_SESSIONS`.
- **anvil auth**: set `ANVIL_API_KEY` so only Relay can drive the browser. Relay
  reads the same var and sends it automatically.
- **Secrets**: `.env` is gitignored — never commit it. On the VM it lives only on disk.
