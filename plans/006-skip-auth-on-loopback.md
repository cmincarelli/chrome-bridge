# Plan 006: Skip auth on loopback bind (with browser-CSRF guard)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. The plans index (`plans/README.md`) is maintained
> by the operator/reviewer, not by you — do not edit it.
>
> **Drift check (run first)**: `git diff --stat d3ab236..HEAD -- server.js .env.example README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (security-sensitive auth change — the CSRF guard is load-bearing)
- **Depends on**: none
- **Category**: dx / security
- **Planned at**: commit `d3ab236`, 2026-07-08
- **Motivation**: eliminates the `.env`/`BRIDGE_TOKEN` friction that blocks local automation and test harnesses (it burned real time in this project's own plan-execution sessions — executors couldn't boot the server without a token).

## Why this matters

Today the server `process.exit(1)`s at boot if `BRIDGE_TOKEN` is unset, and every request must carry `Authorization: Bearer <token>`. For the common local-only case (`HOST=127.0.0.1`, single user on the machine), the token is pure friction — the only network caller is the same machine. This plan makes auth **auto-skip when the effective bind is loopback**, so local scripts, curl, and test harnesses work with zero config (no `.env`), while keeping auth **mandatory on any non-loopback bind** (the default `HOST=0.0.0.0` stays secured — Tailscale/LAN exposure still requires the token).

The threat model has two parts:
1. **Local processes** — when bound to loopback with auth off, any local process can drive Chrome. This is the accepted trade-off (local code execution ≈ owning the box anyway); the token's real value is on non-loopback binds.
2. **Browser CSRF** — a visited webpage issuing a `fetch('http://localhost:8765/navigate', …)` could drive the user's Chrome if auth is off. Modern Chrome blocks most of this via mixed-content (HTTPS page → HTTP localhost) + Private Network Access preflight, but **not all** (HTTP pages, extensions, other HTTP clients). This plan therefore adds a **browser-CSRF guard**: when auth is off, reject any request carrying a cross-origin `Origin` header. Local scripts/curl send no `Origin` and are unaffected; same-machine browser dev tools on `localhost`/`127.0.0.1` are allowed.

## Current state

- `server.js` config block (~lines 10–26):
  ```js
  const PORT = parseInt(process.env.PORT || '8765', 10);
  const HOST = process.env.HOST || '0.0.0.0';
  const TOKEN = process.env.BRIDGE_TOKEN;
  const BROWSER = process.env.BROWSER || 'Google Chrome';
  const DEFAULT_TIMEOUT_MS = 30_000;

  if (!TOKEN) {
    console.error('FATAL: BRIDGE_TOKEN env var is required');
    process.exit(1);
  }

  const TOKEN_BUF = Buffer.from(TOKEN);
  ```
- `tokenMatches(provided)` (~line 32) — length-checked `timingSafeEqual`; called from the auth hook. If `TOKEN` were unset, `Buffer.from(undefined)` throws — so the fatal exit above is currently the only thing keeping it safe.
- Auth preHandler hook (~lines 417–423):
  ```js
  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/docs' || req.url.startsWith('/docs/')) return;
    const auth = req.headers.authorization || '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!tokenMatches(provided))
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
  });
  ```
- CORS: `app.register(cors, { origin: true, methods: ['GET', 'POST', 'OPTIONS'] })` (~line 393). Left unchanged (the CSRF guard in the hook is the mitigation; CORS is browser-enforced and doesn't protect non-browser clients or simple-request side effects).
- `/docs` and `/docs/*` are exempt from auth (kept).
- `.env.example` — documents `PORT`, `HOST=0.0.0.0`, `BROWSER`, `BRIDGE_TOKEN`.
- Boot block (~lines 1885–1895): `app.listen({ port, host })` + a `console.log` listening line.
- `/batch` forwards `req.headers.authorization` to internal `app.inject` calls (~line 1847) — when auth is off, `authorization` is undefined; injected calls re-run the hook, which skips (consistent).

### Repo conventions to honor

- No build step; plain JS, ES modules, 2-space indent, double quotes. Config from env via `process.env.X || 'default'`.
- `AGENTS.md`: **`HOST=0.0.0.0` is the intended default — do NOT change it.** This plan keeps the `0.0.0.0` default and only relaxes auth on explicit loopback binds.
- Auth uses `crypto.timingSafeEqual` (length-checked first) — preserve the constant-time comparison for the auth-on path.
- Uniform response envelope: `reply.code(N).send({ ok:false, error:'...' })`.

### Design

- **`AUTH_REQUIRED` auto-derives**: `REQUIRE_AUTH=true` → always on; `REQUIRE_AUTH=false` → always off (even on `0.0.0.0` — operator's explicit choice, log a warning); unset → `!isLoopbackHost(HOST)` (on for `0.0.0.0`, off for `127.0.0.1`/`localhost`/`::1`).
- **`TOKEN` optional when `!AUTH_REQUIRED`**: drop the unconditional fatal exit; only fatal-exit when `AUTH_REQUIRED && !TOKEN`. `TOKEN_BUF = TOKEN ? Buffer.from(TOKEN) : null`; `tokenMatches` returns `false` if `TOKEN_BUF` is null (defensive — it won't be called when auth is off).
- **Auth hook**: if `AUTH_REQUIRED` → current behavior (token check, 401 on miss). If `!AUTH_REQUIRED` → skip the token check, BUT run the **CSRF guard**: if `req.headers.origin` is present and not a loopback origin → 403. `/docs` stays exempt.
- **Boot log**: when `!AUTH_REQUIRED`, print a one-line note: `auth disabled (loopback bind HOST=<h>); any local process can drive Chrome — set REQUIRE_AUTH=true to force the token`. When `REQUIRE_AUTH=false` on a non-loopback bind, print a louder warning.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|----------------------|
| Syntax check | `pnpm check` | exit 0 |
| Tests | `pnpm test` | all pass (no new unit tests — auth logic is route-level, hand-tested) |
| Start (loopback, no token) | `PORT=8766 HOST=127.0.0.1 BRIDGE_TOKEN= node server.js` | boots, logs "auth disabled" note |
| Start (default, no token) | `node server.js` | FATAL exit (BRIDGE_TOKEN required) — unchanged |
| Start (default + token) | `BRIDGE_TOKEN=… node server.js` | boots, auth on (status quo) |

## Scope

**In scope**:
- `server.js` — config block (`AUTH_REQUIRED`, `isLoopbackHost`, optional `TOKEN`), `tokenMatches` null-guard, auth hook (skip + CSRF guard), boot log note.
- `.env.example` — document `REQUIRE_AUTH` and the loopback-no-token mode.
- `README.md` — add a short "Authentication" subsection explaining auto-skip-on-loopback, the CSRF guard, and `REQUIRE_AUTH`.

**Out of scope** (do NOT touch):
- The `HOST` default (`0.0.0.0`) — intentional per `AGENTS.md`.
- CORS config (`origin: true`) — the CSRF guard in the hook is the mitigation; leave CORS as-is.
- TLS (plan 004 covers transport security).
- The token comparison itself (`timingSafeEqual`), the rate-limit, `/docs` exemption, or any route handler.
- Extracting auth logic into `lib.js` (it touches `req`/`reply` — impure; stays in `server.js`).
- `AGENTS.md` (operator-owned).

## Git workflow

- Branch: `dx/skip-auth-on-loopback`.
- Commit message (match repo): `feat: skip bearer auth on loopback bind (with browser-CSRF guard)`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Config — `AUTH_REQUIRED`, loopback helpers, optional `TOKEN`

In `server.js` config block (~line 10), replace the `HOST`/`TOKEN`/fatal-exit/`TOKEN_BUF` lines with:

```js
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN = process.env.BRIDGE_TOKEN;
const BROWSER = process.env.BROWSER || 'Google Chrome';
const DEFAULT_TIMEOUT_MS = 30_000;

// Auth is required on any non-loopback bind (the default 0.0.0.0 exposes LAN
// + Tailscale). On a loopback bind it is skipped for local DX (any local
// process can already reach loopback). REQUIRE_AUTH=true|false overrides.
// NOTE: new URL().hostname returns IPv6 literals WITH brackets (e.g. "[::1]"),
// so normalize brackets before comparing.
const isLoopbackHost = (h) => {
  if (!h) return false;
  const n = h.replace(/^\[|\]$/g, '').toLowerCase();
  return ['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1'].includes(n);
};
const AUTH_REQUIRED =
  process.env.REQUIRE_AUTH === 'true' ? true
  : process.env.REQUIRE_AUTH === 'false' ? false
  : !isLoopbackHost(HOST);

if (AUTH_REQUIRED && !TOKEN) {
  console.error('FATAL: BRIDGE_TOKEN env var is required (auth required on bind ' + HOST + ')');
  process.exit(1);
}

const TOKEN_BUF = TOKEN ? Buffer.from(TOKEN) : null;
```

Then guard `tokenMatches` (~line 32):

```js
function tokenMatches(provided) {
  if (!TOKEN_BUF) return false;
  if (!provided) return false;
  const buf = Buffer.from(provided);
  if (buf.length !== TOKEN_BUF.length) return false;
  return timingSafeEqual(buf, TOKEN_BUF);
}
```

**Verify**: `pnpm check` → exit 0. (Boot behavior is verified by the Test plan in Step 4; `node -e "import('./server.js')"` is not viable because the server boots at top level.)

### Step 2: Auth hook — skip on loopback + browser-CSRF guard

Replace the auth preHandler hook (~lines 417–423):

```js
// Reject cross-origin browser requests when auth is off (browser-CSRF guard).
// Local scripts/curl send no Origin; same-machine browser dev tools on
// localhost/127.0.0.1 are allowed. Returns true if Origin is absent or loopback.
function isLoopbackOrigin(origin) {
  if (!origin) return true;
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false; // malformed Origin → reject
  }
}

app.addHook('preHandler', async (req, reply) => {
  if (req.url === '/docs' || req.url.startsWith('/docs/')) return;
  if (!AUTH_REQUIRED) {
    // Auth skipped (loopback bind). Still block browser CSRF from cross-origin pages.
    if (!isLoopbackOrigin(req.headers.origin))
      return reply.code(403).send({ ok: false, error: 'cross-origin requests not allowed when auth is disabled' });
    return; // no token check
  }
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!tokenMatches(provided))
    return reply.code(401).send({ ok: false, error: 'unauthorized' });
});
```

Place `isLoopbackOrigin` as a module-level function near `isLoopbackHost` (top, with the other helpers) — NOT inline in the hook. Do NOT touch the `/docs` exemption or the rate-limit hook.

**Verify**: `pnpm check` → exit 0.

### Step 3: Boot log note

In the boot block (~line 1885, the `.then(() => console.log(...))` after `app.listen`), add the auth-status note. Keep the existing listen log; add after it:

```js
.then(() => {
  console.log(`chrome-bridge listening on http://${HOST}:${PORT}`);
  if (!AUTH_REQUIRED) {
    console.warn(
      `NOTE: auth disabled (loopback bind ${HOST}). Any local process can drive Chrome. ` +
      `Set REQUIRE_AUTH=true to force the bearer token.`,
    );
    if (!isLoopbackHost(HOST))
      console.warn(`WARNING: REQUIRE_AUTH=false on non-loopback bind ${HOST} — the bridge is open to the network with no token.`);
  } else {
    console.log('auth: bearer token required');
  }
})
```

(If the existing boot block is structured differently, preserve its shape and just add the `if (!AUTH_REQUIRED)…` lines inside the `.then`.)

**Verify**: `pnpm check` → exit 0.

### Step 4: Update `.env.example`

After the `HOST=` block, add:

```
# Auth. By default the bearer token is REQUIRED on non-loopback binds (0.0.0.0,
# Tailscale IP) and SKIPPED on loopback (127.0.0.1 / localhost) — so local
# scripts/curl work with no .env at all. Override:
#   REQUIRE_AUTH=true  always require the token (even on loopback)
#   REQUIRE_AUTH=false never require the token (even on 0.0.0.0 — NOT recommended)
# When auth is skipped, cross-origin browser requests are still blocked (CSRF).
# REQUIRE_AUTH=
```

And update the `BRIDGE_TOKEN` comment to note it's optional on loopback:

```
# Bearer token (required when auth is on; optional on loopback bind).
# Generate with: openssl rand -hex 32
BRIDGE_TOKEN=replace-me-with-a-64-char-hex-string
```

**Verify**: `grep -n "REQUIRE_AUTH" .env.example` shows the new lines; `git diff .env.example` is additive.

### Step 5: Update `README.md`

Add a short "Authentication" subsection near the existing security note (~5–7 lines):

```markdown
## Authentication

By default, the bearer token is **required** on any non-loopback bind (`0.0.0.0`,
Tailscale IP) and **skipped** on loopback (`127.0.0.1` / `localhost`) — so local
scripts and `curl` work with no `.env` at all. Set `REQUIRE_AUTH=true` to force
the token even on loopback, or `REQUIRE_AUTH=false` to disable it everywhere
(not recommended on `0.0.0.0`). When auth is skipped, cross-origin browser
requests are still rejected (browser-CSRF guard); local processes remain trusted.
```

**Verify**: `grep -n "## Authentication" README.md` shows the new heading; `git diff README.md` is one additive hunk; the endpoint table is unchanged.

## Test plan

Run against a live server. These tests use `/health` and `/navigate` (no Chrome needed — the CSRF guard blocks at `preHandler` before any route handler runs) and curl's `-H "Origin: …"` / `-H "Authorization: …"`.

**Important — dotenv caveat:** the repo loads `.env` via `dotenv/config`. dotenv does **not** override env vars already set, so to force "no token" reliably, set `BRIDGE_TOKEN=` (empty) explicitly in the command (this also overrides any real token in `.env`). Use a non-default port (`PORT=8766`) to avoid clashing with a running bridge.

Set a real token var once for the auth-on tests:
```bash
TOK=$(openssl rand -hex 32)
```

1. **Loopback, no token → 200.**
   ```bash
   PORT=8766 HOST=127.0.0.1 BRIDGE_TOKEN= node server.js &  SERVER=$!; sleep 2
   curl -s -i http://127.0.0.1:8766/health | head -1            # → HTTP/1.1 200 OK
   curl -s http://127.0.0.1:8766/health                         # → {"ok":true,...}
   kill $SERVER 2>/dev/null
   ```
   **Expected**: 200, no token needed. Boot log includes the "auth disabled" NOTE.

2. **Loopback, cross-origin `Origin` on a side-effect route (POST /navigate) → 403, no route side effect.**
   ```bash
   PORT=8766 HOST=127.0.0.1 BRIDGE_TOKEN= node server.js &  SERVER=$!; sleep 2
   curl -s -i -H "Origin: https://evil.example" -H "Content-Type: application/json" \
     -d '{"url":"https://example.org"}' http://127.0.0.1:8766/navigate | head -1   # → 403
   curl -s -H "Origin: https://evil.example" http://127.0.0.1:8766/health          # → {"ok":false,"error":"cross-origin requests not allowed when auth is disabled"}
   kill $SERVER 2>/dev/null
   ```
   **Expected**: `HTTP/1.1 403`; the POST `/navigate` body is the CSRF-guard error (the route handler never runs — no Chrome navigation). Confirms the guard blocks side effects, not just reads.

3. **Loopback, same-machine Origin → 200.**
   ```bash
   PORT=8766 HOST=127.0.0.1 BRIDGE_TOKEN= node server.js &  SERVER=$!; sleep 2
   curl -s -i -H "Origin: http://localhost:3000" http://127.0.0.1:8766/health | head -1   # → 200
   kill $SERVER 2>/dev/null
   ```
   **Expected**: `200` (localhost origin allowed).

4. **Loopback variants (`localhost`, `::1`) auto-disable auth.**
   ```bash
   PORT=8766 HOST=localhost BRIDGE_TOKEN= node server.js &  S1=$!; sleep 2
   curl -s -i http://127.0.0.1:8766/health | head -1; kill $S1 2>/dev/null   # → 200
   PORT=8766 HOST=::1 BRIDGE_TOKEN= node server.js &  S2=$!; sleep 2
   curl -s -i http://[::1]:8766/health | head -1; kill $S2 2>/dev/null        # → 200
   ```
   **Expected**: both 200 (auth auto-disabled on `localhost` and `::1`).

5. **Default bind (0.0.0.0), no token → fatal exit (unchanged).**
   ```bash
   PORT=8766 BRIDGE_TOKEN= node server.js; echo "exit=$?"
   ```
   **Expected**: `FATAL: BRIDGE_TOKEN env var is required (auth required on bind 0.0.0.0)`, non-zero exit. (Confirms the default stays secured; `BRIDGE_TOKEN=` overrides any `.env` token.)

6. **Default bind + token → auth on (status quo).**
   ```bash
   PORT=8766 BRIDGE_TOKEN=$TOK node server.js &  SERVER=$!; sleep 2
   curl -s -i http://127.0.0.1:8766/health | head -1                                        # → 401
   curl -s -i -H "Authorization: Bearer $TOK" http://127.0.0.1:8766/health | head -1       # → 200
   kill $SERVER 2>/dev/null
   ```
   **Expected**: 401 without token, 200 with.

7. **`REQUIRE_AUTH=true` on loopback → token required even on loopback.**
   ```bash
   PORT=8766 HOST=127.0.0.1 REQUIRE_AUTH=true BRIDGE_TOKEN=$TOK node server.js &  SERVER=$!; sleep 2
   curl -s -i http://127.0.0.1:8766/health | head -1                                          # → 401
   curl -s -i -H "Authorization: Bearer $TOK" http://127.0.0.1:8766/health | head -1          # → 200
   kill $SERVER 2>/dev/null
   ```
   **Expected**: 401 without token, 200 with.

8. **`REQUIRE_AUTH=false` on default bind → boots with a loud warning (explicit override).**
   ```bash
   PORT=8766 REQUIRE_AUTH=false BRIDGE_TOKEN= node server.js 2>&1 &  SERVER=$!; sleep 2
   curl -s -i http://127.0.0.1:8766/health | head -1; kill $SERVER 2>/dev/null   # → 200
   ```
   **Expected**: boots (no fatal), boot log includes the `WARNING: REQUIRE_AUTH=false on non-loopback bind 0.0.0.0` line, `/health` 200. (Confirms the explicit-override footgun is allowed + warned.)

9. **Existing unit tests still pass.** `pnpm test` → 5/5 (no `lib.js` change).

If tests 1, 2, 5, 6, 7, 8 pass, the change is correct. Tests 3, 4, 9 are sanity.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm check` exits 0.
- [ ] `pnpm test` exits 0 (5/5, unchanged).
- [ ] `PORT=8766 HOST=127.0.0.1 BRIDGE_TOKEN= node server.js` boots with no `BRIDGE_TOKEN` and logs the "auth disabled" NOTE.
- [ ] Test 1: loopback `/health` returns 200 with no token.
- [ ] Test 2: loopback + cross-origin `Origin` on POST `/navigate` returns 403 (route handler never runs).
- [ ] Test 4: `HOST=localhost` and `HOST=::1` auto-disable auth (200).
- [ ] Test 5: default `0.0.0.0` with no token (`BRIDGE_TOKEN=`) → FATAL exit (default stays secured).
- [ ] Test 6: default + token → 401 without, 200 with (auth-on path unchanged).
- [ ] Test 7: `REQUIRE_AUTH=true` on loopback → token required.
- [ ] Test 8: `REQUIRE_AUTH=false` on default bind → boots with loud warning.
- [ ] `grep -n "isLoopbackHost\|AUTH_REQUIRED\|isLoopbackOrigin" server.js` shows the helpers + usages.
- [ ] `grep -n "REQUIRE_AUTH" .env.example` and `grep -n "## Authentication" README.md` show the docs.
- [ ] `git status` shows changes only to `server.js`, `.env.example`, `README.md`.
- [ ] The `HOST` default is still `0.0.0.0` (`grep -n "HOST = process.env.HOST" server.js`).

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the cited locations doesn't match the excerpts (drift since `d3ab236`).
- Removing the unconditional `if (!TOKEN) process.exit` would leave any path that calls `tokenMatches` with `TOKEN_BUF === null` AND `AUTH_REQUIRED` true — the fatal exit must still guard the auth-on path.
- The CSRF guard would block `/docs` (the `/docs` exemption runs first; confirm the hook returns early for `/docs` before the Origin check).
- A test reveals the auth-off path accepts a cross-origin `Origin` (Test 2 must 403) — the CSRF guard is mis-wired; do not ship without it.
- The default `0.0.0.0` bind ever boots without a token (Test 5 must fatal-exit) — the default must stay secured.
- You are tempted to change the `HOST` default, drop the `timingSafeEqual` comparison, or touch CORS — all out of scope.

## Maintenance notes

- **The CSRF guard is load-bearing.** It is the only thing stopping a visited HTTP webpage (or browser extension) from driving the user's Chrome when auth is off on loopback. Do not remove the `isLoopbackOrigin` check from the auth-off branch. If a future change relaxes it, that's a security regression — flag it in review.
- **Modern Chrome blocks most browser→localhost:HTTP CSRF** via mixed-content + Private Network Access preflight; this guard covers the residual surface (HTTP pages, extensions, non-PNA clients). It is defense-in-depth, not redundant.
- **`AUTH_REQUIRED` auto-derives from `HOST`.** The default `0.0.0.0` → auth on. Operators wanting the no-token convenience MUST set `HOST=127.0.0.1` (or `localhost`). `REQUIRE_AUTH=false` on `0.0.0.0` prints a loud warning but is allowed (operator's explicit choice).
- **`/batch` is consistent**: when auth is off, the caller sends no `Authorization`, and internal `app.inject` calls re-run the hook (which skips). No change needed to `/batch`.
- **`TOKEN_BUF` can be `null`** when auth is off and no token is set; `tokenMatches` guards against it. The hook never calls `tokenMatches` when `!AUTH_REQUIRED`, so this is defensive only.
- **Reviewer should scrutinize:** (1) the default `0.0.0.0` still fatal-exits without a token; (2) the auth-off branch always runs the `isLoopbackOrigin` check before returning (no path skips it); (3) `/docs` exemption is unchanged; (4) `timingSafeEqual` is still used on the auth-on path; (5) `REQUIRE_AUTH=true` on loopback still requires the token.
