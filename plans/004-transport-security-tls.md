# Plan 004: Document and optionally enable transport security (TLS)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. The plans index (`plans/README.md`) is maintained
> by the operator/reviewer, not by you — do not edit it.
>
> **Drift check (run first)**: `git diff --stat 89f594c..HEAD -- server.js .env.example README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `89f594c`, 2026-07-08 (refreshed post-006; originally written at `3bb254c`)

## Why this matters

The bridge authenticates every request with a bearer token (`BRIDGE_TOKEN`) sent as `Authorization: Bearer <token>` over **plain HTTP**. `HOST` defaults to `0.0.0.0` (intentional — for Tailscale/LAN reachability, per `AGENTS.md`). On any network where the token is sniffable (public Wi-Fi, untrusted LAN segments, anything that isn't Tailscale's encrypted WireGuard), an attacker who reads one request gets the token — which is effectively a root password for the signed-in Chrome session, since `/eval` runs arbitrary JS in it. `AGENTS.md` and `README.md` frame `127.0.0.1` as "the safe default," but the **code** defaults to `0.0.0.0` and never warns about cleartext. This plan: (1) makes TLS **opt-in** via `TLS_CERT`/`TLS_KEY` env vars, (2) logs a startup warning when running cleartext on a non-loopback bind, and (3) updates the docs to state the threat and the mitigations. It does **not** change the `HOST=0.0.0.0` default (intentional) and does **not** force TLS (Tailscale is already encrypted; forcing TLS would break the primary use case).

## Current state

- `server.js` config block (~lines 10–50) — post-006, it now contains `PORT`/`HOST`/`TOKEN`/`BROWSER`/`DEFAULT_TIMEOUT_MS` **plus** `isLoopbackHost(h)` (bracket-normalized loopback check) and `AUTH_REQUIRED` (auto-derives `!isLoopbackHost(HOST)`, `REQUIRE_AUTH` override), and `TOKEN_BUF = TOKEN ? Buffer.from(TOKEN) : null`. 004 reuses `isLoopbackHost` (do NOT redefine `isLoopback`).
- `app` is created with `const app = Fastify({ logger: true })` (~line 382).
- Boot block (~lines 1935–1955) — post-006, the `.then()` already contains an **auth-status note** (loopback NOTE / `REQUIRE_AUTH=false` WARNING / `auth: bearer token required`). 004 must ADD the cleartext warning to this existing `.then()` WITHOUT removing the auth-status logic.
- No TLS code anywhere.
- `.env.example` — documents `PORT`, `HOST=0.0.0.0`, `BROWSER`, `BRIDGE_TOKEN`, `REQUIRE_AUTH`; does not mention TLS.
- `README.md` — has an "Authentication" subsection (post-006); no transport-security section.
- `AGENTS.md` — states `HOST=0.0.0.0` is intentional; do not change it.
- `AGENTS.md` — states `HOST=0.0.0.0` is intentional; frames `127.0.0.1` as conservative.

### Repo conventions to honor

- No build step; plain JS, ES modules, 2-space indent, double quotes.
- Config from env via `process.env.X || 'default'` pattern; `.env` + `dotenv/config`.
- `AGENTS.md`: "`HOST=0.0.0.0` is the intended default... Don't change it to `127.0.0.1` to 'be safe'." → **do not change the HOST default.**
- Startup logging via `console.log`/`console.error` (see existing boot block); Fastify's own logger is for request logs.
- Uniform envelope and auth hook are unchanged.

### Design: opt-in TLS, additive only

Node's built-in `https` server can wrap Fastify. Fastify supports `https: { key, cert }` in its options. Reading cert/key from the filesystem is the standard pattern (paths via env). When `TLS_CERT` and `TLS_KEY` are both set, listen on HTTPS; otherwise HTTP (current behavior). A startup warning prints when `HOST` is not loopback AND TLS is not enabled. No new dependency — Node's `fs` (already imported) and Fastify's built-in `https` option suffice.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|----------------------|
| Syntax check | `pnpm check` | exit 0 |
| Tests | `pnpm test` | all pass (no new tests; TLS is env-gated and not unit-tested here) |
| Start (HTTP) | `pnpm start` | logs `http://...` + (if non-loopback) a cleartext warning |
| Start (TLS) | `TLS_CERT=... TLS_KEY=... pnpm start` | logs `https://...` |
| Self-signed cert for testing | see Test plan | generates `cert.pem`/`key.pem` |

## Scope

**In scope**:
- `server.js` — read `TLS_CERT`/`TLS_KEY` env vars, pass `https` option to Fastify when both are set, change the listen/log to reflect `http` vs `https`, and add a startup warning for cleartext-on-non-loopback.
- `.env.example` — document `TLS_CERT`/`TLS_KEY` (paths to PEM files) with a security note.
- `README.md` — add a short "Transport security" subsection: the token is sent on every request; prefer loopback or Tailscale; enable TLS with the env vars; generate a cert with `openssl`.

**Out of scope** (do NOT touch):
- The `HOST` default (`0.0.0.0`) — intentional per `AGENTS.md`.
- The auth hook, rate-limit, CORS, or any route.
- HSTS / redirect-HTTP-to-HTTPS (out of scope; a single-port server can't easily do both; document instead).
- Client-cert/mTLS, automatic cert reload, Let's Encrypt automation.
- Forcing TLS (Tailscale is already encrypted; TLS must stay opt-in).
- `AGENTS.md` (operator-owned; do not edit its `HOST` framing).

## Git workflow

- Branch: `security/transport-tls-opt-in`.
- Commit message (match repo): `feat: opt-in TLS (TLS_CERT/TLS_KEY) + cleartext warning + docs`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add TLS env config and an `https` option to Fastify

In `server.js` config block (after the `DEFAULT_TIMEOUT_MS` line, ~line 14), add:

```js
const TLS_CERT = process.env.TLS_CERT; // path to PEM cert file
const TLS_KEY = process.env.TLS_KEY;   // path to PEM key file
const USE_TLS = Boolean(TLS_CERT && TLS_KEY);
// Fail fast if only one of TLS_CERT/TLS_KEY is set (otherwise USE_TLS would
// silently be false and the server would serve cleartext HTTP while the
// operator thinks TLS is on).
if (Boolean(TLS_CERT) !== Boolean(TLS_KEY)) {
  console.error('FATAL: TLS_CERT and TLS_KEY must be set together (both PEM file paths, or neither)');
  process.exit(1);
}
```

Add the sync `readFileSync` import at the top with the other `node:` imports (~line 1–12). The repo already imports async `fs/promises` (`readFile`, `writeFile`, `mkdtemp`, `rm`); add the sync one separately:

```js
import { readFileSync } from 'node:fs';
```

Where `app` is created (~line 382, `const app = Fastify({ logger: true });`), conditionally pass `https`:

```js
const app = Fastify({
  logger: true,
  ...(USE_TLS
    ? { https: { key: readFileSync(TLS_KEY), cert: readFileSync(TLS_CERT) } }
    : {}),
});
```

Note: `readFileSync` is fine here — it runs once at boot. If the cert/key files don't exist or are unreadable, `readFileSync` throws and the process exits at startup with a clear error (acceptable; same as the `BRIDGE_TOKEN` fatal-exit pattern). Do NOT add a try/catch that swallows it.

**Verify**: `pnpm check` → exit 0. `pnpm start` (without TLS env) → boots on `http://` exactly as before (including the post-006 auth-status note).

### Step 2: Reflect http/https in the listen/log + add a cleartext warning

**Do NOT replace the boot `.then()` wholesale** — post-006 it contains the auth-status note, which must be preserved. Instead, MODIFY the existing `.then()` (a) to use `${SCHEME}://` in the listen line, and (b) to append a cleartext warning when `!USE_TLS && !isLoopbackHost(HOST)`. Reuse the existing `isLoopbackHost` helper (do NOT define a new `isLoopback`).

Add `const SCHEME = USE_TLS ? 'https' : 'http';` near the boot block (or inline the ternary). The boot block becomes:

```js
const SCHEME = USE_TLS ? 'https' : 'http';
app
  .listen({ port: PORT, host: HOST })
  .then(() => {
    console.log(`chrome-bridge listening on ${SCHEME}://${HOST}:${PORT}`);
    // cleartext warning (004) — only when exposed (non-loopback) and not using TLS
    if (!USE_TLS && !isLoopbackHost(HOST)) {
      console.warn(
        `WARNING: serving cleartext HTTP on non-loopback bind (${HOST}). ` +
          `Requests (including any bearer token, when auth is on) are sniffable on this network — ` +
          `and BRIDGE_TOKEN is a root password for your Chrome session. ` +
          `Use Tailscale, bind 127.0.0.1, or set TLS_CERT/TLS_KEY.`,
      );
    }
    // auth-status note (006) — PRESERVE this block unchanged:
    if (!AUTH_REQUIRED) {
      if (isLoopbackHost(HOST)) {
        console.warn(
          `NOTE: auth disabled (loopback bind ${HOST}). Any local process can drive Chrome. ` +
          `Set REQUIRE_AUTH=true to force the bearer token.`,
        );
      } else {
        console.warn(
          `WARNING: auth disabled by REQUIRE_AUTH=false on non-loopback bind ${HOST} — the bridge is open to the network with no token.`,
        );
      }
    } else {
      console.log('auth: bearer token required');
    }
  })
  .catch((err) => { console.error(err); process.exit(1); });
```

The ONLY changes from the live (post-006) boot block are: (1) the `SCHEME` const + `${SCHEME}://` in the listen line, and (2) the new `if (!USE_TLS && !isLoopbackHost(HOST))` cleartext-warning block inserted before the auth-status `if`. The auth-status logic is byte-identical to 006's. Do NOT remove or reorder it.

**Verify**: `pnpm check` → exit 0. `PORT=8766 BRIDGE_TOKEN=$TOK node server.js` (no TLS, default `HOST=0.0.0.0`) → logs `http://0.0.0.0:8766` AND the cleartext `WARNING: serving cleartext…` line AND `auth: bearer token required`. `HOST=127.0.0.1` added → no cleartext warning (loopback). `TLS_CERT=… TLS_KEY=…` → logs `https://…` and no cleartext warning (see Test plan for cert generation).

### Step 3: Update `.env.example`

Add after the existing `BROWSER`/`BRIDGE_TOKEN` lines, with a comment block:

```
# Transport security (optional). By default the bridge serves plain HTTP, so the
# bearer token travels in cleartext. That's fine over Tailscale or on 127.0.0.1.
# On any other network, set TLS_CERT and TLS_KEY to PEM file paths to enable HTTPS.
# Generate a self-signed cert for local use:
#   openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=localhost"
# TLS_CERT=./cert.pem
# TLS_KEY=./key.pem
```

**Verify**: `grep -n "TLS_CERT\|TLS_KEY" .env.example` shows the new lines; `git diff .env.example` is additive only.

### Step 4: Update `README.md`

Add a short "Transport security" subsection near the existing security note. Keep it to ~5 lines:

```markdown
## Transport security

The bearer token is sent on every request. By default the bridge serves plain
HTTP, so the token travels in cleartext — safe over Tailscale or on `127.0.0.1`,
but sniffable on shared networks. To enable HTTPS, set `TLS_CERT` and `TLS_KEY`
to PEM file paths (see `.env.example` for a self-signed-cert one-liner). The
server warns at startup if it's serving cleartext on a non-loopback bind.
```

**Verify**: `grep -n "Transport security" README.md` shows the new heading; `git diff README.md` is one additive hunk; the existing endpoint table and examples are unchanged.

## Test plan

Run against a live server. These boot the server with explicit env (no reliance on `.env`/shell `$BRIDGE_TOKEN`) — same pattern as plan 006. Set a token var once:
```bash
TOK=$(openssl rand -hex 32); P=8766
```

1. **HTTP unchanged (default bind, auth on).**
   ```bash
   PORT=$P BRIDGE_TOKEN=$TOK node server.js > /tmp/cb004-t1.log 2>&1 &  SERVER=$!; sleep 2
   curl -s -i http://127.0.0.1:$P/health | head -1                                         # → 401 (auth on)
   curl -s -H "Authorization: Bearer $TOK" http://127.0.0.1:$P/health                    # → {"ok":true,...}
   grep -E 'WARNING: serving cleartext|auth: bearer' /tmp/cb004-t1.log                     # → both lines
   kill $SERVER 2>/dev/null
   ```
   **Expected**: logs `http://0.0.0.0:$P` + the cleartext `WARNING: serving cleartext…` line + `auth: bearer token required`; `/health` 401 without token, 200 with. With `HOST=127.0.0.1` added → NO cleartext warning (loopback).

2. **TLS works.** Generate a self-signed cert and start with TLS:
   ```bash
   openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/cb-key.pem -out /tmp/cb-cert.pem -days 365 -subj "/CN=localhost" 2>/dev/null
   PORT=$P BRIDGE_TOKEN=$TOK TLS_CERT=/tmp/cb-cert.pem TLS_KEY=/tmp/cb-key.pem node server.js > /tmp/cb004-t2.log 2>&1 &  SERVER=$!; sleep 2
   curl -sk -H "Authorization: Bearer $TOK" "https://127.0.0.1:$P/health"   # → {"ok":true,...}
   curl -s -H "Authorization: Bearer $TOK" "http://127.0.0.1:$P/health" 2>&1 | head -1      # → fails (wrong scheme)
   kill $SERVER 2>/dev/null
   ```
   **Expected**: server logs `https://0.0.0.0:$P`, NO cleartext warning; `curl -sk https://…` returns `200`; plain `http://` to the same port **fails** (TLS enforced).

3. **Bad cert path fails fast (no silent HTTP fallback).**
   ```bash
   PORT=$P BRIDGE_TOKEN=$TOK TLS_CERT=/nope/cert.pem TLS_KEY=/nope/key.pem node server.js; echo "exit=$?"
   ```
   **Expected**: exits non-zero with an `ENOENT` error at startup; no listen line.

4. **Paired-cert guard (only one of TLS_CERT/TLS_KEY set → fatal).**
   ```bash
   PORT=$P BRIDGE_TOKEN=$TOK TLS_CERT=/tmp/cb-cert.pem node server.js; echo "exit=$?"
   ```
   **Expected**: `FATAL: TLS_CERT and TLS_KEY must be set together …`, non-zero exit; does NOT silently serve HTTP.

5. **TLS + loopback + auth-off (interaction with 006).**
   ```bash
   PORT=$P HOST=127.0.0.1 BRIDGE_TOKEN= TLS_CERT=/tmp/cb-cert.pem TLS_KEY=/tmp/cb-key.pem node server.js > /tmp/cb004-t5.log 2>&1 &  SERVER=$!; sleep 2
   curl -sk https://127.0.0.1:$P/health | head -1        # → 200 (auth off, TLS on)
   grep -E 'https://|NOTE: auth disabled' /tmp/cb004-t5.log                              # → both (https + auth-disabled NOTE)
   kill $SERVER 2>/dev/null
   ```
   **Expected**: logs `https://127.0.0.1:$P`, the auth-disabled NOTE, NO cleartext warning (TLS on); `/health` 200 with no token. Confirms TLS + 006 coexist.

6. **Existing unit tests still pass.** `pnpm test` → 5/5.

Clean up `/tmp/cb-*.pem` after.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm check` exits 0.
- [ ] `pnpm test` exits 0 (unchanged).
- [ ] `PORT=8766 BRIDGE_TOKEN=$TOK node server.js` (no TLS, default HOST) logs `http://0.0.0.0:8766` AND the cleartext WARNING AND `auth: bearer token required`.
- [ ] `HOST=127.0.0.1` added → no cleartext warning.
- [ ] With `TLS_CERT`/`TLS_KEY` set: logs `https://...`, no warning, `curl -sk https://...` works, plain `http://` fails.
- [ ] `TLS_CERT=/nope TLS_KEY=/nope` → non-zero exit, ENOENT (no silent HTTP fallback).
- [ ] Only one of `TLS_CERT`/`TLS_KEY` set → `FATAL: … must be set together`, non-zero exit (Test 4).
- [ ] Test 5: TLS + loopback + auth-off coexist (https + NOTE, 200 no-token).
- [ ] `.env.example` documents `TLS_CERT`/`TLS_KEY` with the openssl one-liner (additive).
- [ ] `README.md` has a "Transport security" subsection (additive, endpoint table untouched).
- [ ] `git status` shows changes only to `server.js`, `.env.example`, `README.md`.
- [ ] `grep -n "HOST = process.env.HOST" server.js` — the `HOST` default is still `0.0.0.0`.

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the cited locations doesn't match the excerpts (drift since `89f594c`).
- Fastify rejects the `https: { key, cert }` option in this version (5.8.5) — it should be supported, but if `pnpm start` errors with an option error, STOP and report rather than switching to a manual `https.createServer` wrapper (that's a different design).
- The cert `readFileSync` at boot is blocked by the AGENTS.md "no top-level side effects for testability" concern — note: `server.js` already has top-level side effects (it boots), so this is consistent; but if a future plan makes `server.js` importable, the `readFileSync` would need guarding. Out of scope here; just note it.
- You are tempted to change the `HOST` default, force TLS, add HTTP→HTTPS redirect, or add mTLS — all out of scope.
- `openssl` is unavailable in the test environment (Test 2) — skip that test and report, but the cert-gen is only for verification, not a deliverable.

## Maintenance notes

- **TLS is opt-in and single-scheme.** One port serves either HTTP or HTTPS, not both (no redirect). That's intentional for simplicity; a future plan could add a redirect listener if needed.
- **Cert reload requires restart.** `readFileSync` runs once at boot. For long-running deployments with rotating certs, a future plan could watch the files; out of scope.
- **The cleartext warning uses `console.warn`** and prints once at boot, not per-request (per-request would spam logs). If someone wants a structured log entry instead, that's a follow-up.
- **`AGENTS.md` is intentionally not edited** — its `HOST=0.0.0.0` framing stays; this plan adds TLS as an option, not a mandate.
- **Reviewer should scrutinize:** (1) `HOST` default unchanged; (2) no try/catch swallowing cert errors (fail-fast); (3) the warning fires only for non-loopback + no-TLS (not for loopback, not for TLS); (4) `.env.example`/`README` changes are purely additive; (5) no auth/route changes.
