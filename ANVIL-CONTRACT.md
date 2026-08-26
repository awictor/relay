# anvil-engine API contract (the verified reference)

`src/anvil.ts` is the SOURCE OF TRUTH for talking to self-hosted anvil-engine. DataFaucet
(mcp-forge, `anvil-migration`) and any other consumer reimplement these exact calls — keep them in
sync with this file, and prefer copying the shapes here over rediscovering them.

Base URL: `ANVIL_BASE_URL` (default `http://localhost:3000`), trailing slash stripped.
Auth: optional `ANVIL_API_KEY`. When set, send `Authorization: Bearer <key>` on control-plane calls
AND append `&token=<key>` to the CDP ws + `/v1/view` URLs (the browser `<img>`/ws client can't send a
header). When unset, omit both.

## Session lifecycle

**Create** — `POST /v1/sessions`
- body `{ headless: true, stealth: true }` (both default true)
- returns `{ id: string }` (freeform id — NOT a UUID; a consumer that validates ids must use a bounded
  token regex like `[A-Za-z0-9_-]{1,128}`, never a UUID regex).
- 15s timeout is the working value.

**CDP endpoint** — you BUILD it, don't trust the returned one.
- anvil's returned websocketUrl hardcodes `localhost` and omits the token — unusable as-is.
- Build: `ws(s)://<host-from-ANVIL_BASE_URL>/cdp?session=<id>` (`wss` iff base is https), then
  `&token=<key>` iff `ANVIL_API_KEY` set. This is what puppeteer `connect({ browserWSEndpoint })` uses.

**Live view** — `GET /v1/view?session=<id>` (+ `&token=` iff key set)
- read-only MJPEG stream (no click injection — unlike Browserbase's interactive debugger). Maps to
  where Browserbase's `debuggerFullscreenUrl` was used.

**Release** — `POST /v1/sessions/<id>/release` (POST, NOT DELETE). Best-effort; ignore failure.

**Liveness** — `GET /v1/live` → 200 when anvil is up.

## HAR capture (DataFaucet auto-scan path)
`POST /v1/har/start`, `POST /v1/actions/navigate`, `POST /v1/actions/evaluate` (link discovery),
`POST /v1/har/stop`, `GET /v1/har` → `{ entries: [{ url, method, status, requestHeaders, requestBody?,
resourceType, responseContentType?, responseBodyPreview? }] }`. HAR entries record request AND response
detail (DEV-0006, anvil 429f570): `responseContentType` + a `responseBodyPreview` capped by
`harBodyPreviewBytes` (default 2048, 0=off) — a consumer classifies a JSON endpoint from the capture
alone, no re-fetch.

## Gotchas (each cost a real debugging session)
- puppeteer `connect()` to anvil `/cdp` had a Target-closed bug; the HAR path (navigate + read
  `/v1/har`) is the reliable capture route, not puppeteer-driven interaction.
- cdp-proxy must buffer client CDP messages until the Chrome ws opens (anvil fix 216d927) or early
  messages are dropped.
- `node --test` shares ONE process across file args: a test whose `before()` sets `BROWSER_BACKEND`/
  `ANVIL_*`/`BROWSERBASE_*` MUST restore in `after()`, or it leaks into sibling test files.
