# Plan 001: Fix `POST /navigate {wait:true}` returning before the new page loads

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. The plans index (`plans/README.md`) is maintained
> by the operator/reviewer, not by you — do not edit it.
>
> **Drift check (run first)**: `git diff --stat 59c1168..HEAD -- server.js AGENTS.md README.md`
> (These are the in-scope edit targets plus `AGENTS.md`, which is guidance/context,
> not edited.) If any in-scope file changed since this plan was written, compare
> the "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `59c1168`, 2026-07-08
- **Issue**: https://github.com/cmincarelli/chrome-bridge/issues/7
- **Scope of issue #7**: `POST /navigate` with `wait:true` only. The sibling
  `POST /wait-for-ready` has a related staleness concern and is **deliberately
  out of scope** here; a follow-up issue will be filed for it (see Maintenance
  notes). Do not fix `/wait-for-ready` in this plan.

## Why this matters

`POST /navigate {wait:true}` is documented as "block until readyState=complete,"
but because `chromeNavigate` issues `set URL of <tab> to "..."` asynchronously,
the wait loop polls the **old** page's `document.readyState` — which is already
`'complete'` — and returns immediately, ~1s before the new page has even begun
loading and ~1s before it reaches `complete`. Any caller that reads page content
(`/eval`, `/inner-text`, `/get-html`, `/state`) immediately after a waited
navigate gets the **previous** page's data. In sequential batch automation (e.g.
scraping N sites) this silently returns site N's content labeled as site N+1.

A naive "wait for readyState to drop, then rise" fix is **not sufficient**: if
Chrome takes longer than the settle bound to *begin* the new load, Phase 1 falls
through and Phase 2 immediately sees the old page still at `'complete'` — the
original bug with a delay. The fix must tie the observed `complete` to **this**
navigation by capturing the pre-navigation URL and requiring the post-wait URL to
differ from it (for different-URL navigations). This plan does that.

## Current state

- `server.js` — the entire application (~1400 lines, single file, ES modules,
  no build/test/lint). Relevant sections:
  - **`osa(script, timeoutMs = DEFAULT_TIMEOUT_MS)`** (~line 40) — runs
    `osascript -e <script>` with a subprocess `timeout`. This is the hard
    ceiling on any single AppleScript call.
  - **`chromeNavigate(url, tab)`** (~line 58) — `tell application "Chrome" to
    set URL of <tab> to "<url>"`. Returns immediately; Chrome navigates async.
  - **`chromeReadyState(tab)`** (~line 66) — `execute <tab> javascript
    "document.readyState"`, returns `'loading'|'interactive'|'complete'`.
    Currently calls `osa(...)` with **no** timeout arg → uses `DEFAULT_TIMEOUT_MS`
    (30000ms). This plan adds an optional timeout param.
  - **`chromeEval(js, timeoutMs, tab)`** (~line 130) — arbitrary JS via tempfile;
    already accepts a `timeoutMs` arg (passed to `osa`).
  - **`POST /navigate` handler** (~lines 406–474) — the buggy wait loop.
  - **`POST /wait-for-ready`** (~lines 571–610) — OUT OF SCOPE.
  - **`fail(req, reply, err)`** — catch-all; logs server-side, returns
    `{ ok:false, error:'internal error' }` (HTTP 500). Special-cases AppleScript
    error `-1719` (no window) → HTTP 409 with a hint to call `/ensure-window` or
    `/navigate` first. **Never** leaks `err.message`.
  - **`ok()` / `sendError(reply, code, msg)`** — the uniform response envelope.

Buggy wait loop (`server.js`, `POST /navigate`, ~lines 453–470):

```js
await chromeNavigate(url, tab);
if (wait) {
  const deadline = Date.now() + timeout_ms;
  while (Date.now() < deadline) {
    const state = await chromeReadyState(tab);
    if (state === 'complete') {                       // ← BUG: old page is already 'complete'
      const raw = await chromeEval(
        `String(performance.getEntriesByType('navigation')[0]?.responseStatus ?? '')`,
        timeout_ms,
        tab,
      );
      const status = raw ? parseInt(raw, 10) : undefined;
      return ok({ state, ...(status ? { status } : {}) });
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return sendError(reply, 408, 'timeout waiting for ready');
}
```

### Repo conventions to honor (from `AGENTS.md`)

- **Single file.** All logic stays in `server.js`; do not split into modules.
- **Helpers are module-level `async function`s**; routes are `app.post` with the
  schema object as the second arg. Match this.
- **Uniform response envelope:** success → `ok({...})`; client error →
  `sendError(reply, code, msg)`; thrown operational errors propagate to
  `fail(req, reply, err)` (which never leaks `err.message` and special-cases
  `-1719` → 409). **Do not add per-route try/catch that surfaces detail**, and do
  not invent new HTTP status codes inside helpers.
- **AppleScript injection:** any user string interpolated into AppleScript must
  go through `asString()`. Numeric tab refs go through `tabRef()` (clamped with
  `Math.max(1, Number(tab))`). This fix interpolates **no new user data** into
  AppleScript — it only reads page state via existing-style helpers.
- **No build/test/lint.** Verify by running the server and hitting endpoints.
- Style: 2-space indent, double quotes, plain JS, ES modules. See existing
  helpers (`chromeReadyState`, `chromeEval`) as the exemplar.

### Design: navigation identity (the load-bearing idea)

Chrome's `document.readyState` transitions are `loading` → `interactive` →
`complete`. When a tab is already loaded, `readyState === 'complete'`. Issuing
`set URL` does **not** synchronously drop it; there is a window (tens to a few
hundred ms) during which the old page is still at `'complete'` before the new
document begins. **`readyState` alone cannot prove the observed `complete`
belongs to the requested navigation** — so this plan adds a URL-identity guard:

1. **Before** `chromeNavigate`, capture the tab's current `location.href`
   (`beforeUrl`).
2. Classify the navigation as **same-URL** or **different-URL** by comparing the
   requested `url` to `beforeUrl` with a small normalizer (`urlsMatch`):
   - **Different-URL** (the common case): Phase 1 waits for `readyState` to leave
     `'complete'` **or** for `location.href` to change away from `beforeUrl`,
     whichever happens first (some fast navigations flip the URL while still
     `'complete'` for a moment). Phase 2 then accepts `readyState === 'complete'`
     **only after** `location.href !== beforeUrl`. This is redirect-tolerant: any
     final URL different from the pre-nav URL counts (A→B redirect, A→A+hash,
     etc.). It refuses to return the old page's `complete`.
   - **Same-URL** (navigating to the URL already shown): Chrome may not reload,
     or may serve from bfcache already at `'complete'` with no URL change. The
     URL guard can never pass, so same-URL uses a **bounded settle** then accepts
     `complete` (this is the best achievable signal for same-URL and is
     documented as such).
3. The settle bound is an **internal constant**, not a public API field.

Known limitations (documented, not fixed here): (a) a pathological redirect that
lands back on `beforeUrl` would never satisfy the different-URL guard and would
408; (b) concurrent writes to the same tab are not serialized by this server and
can confuse the guard — documented as unsupported. See Maintenance notes.

## Commands you will need

There is no build, typecheck, test, or lint step. Verification is runtime only.
Have a working `.env` with `BRIDGE_TOKEN` set (see `.env.example`); generate one
with `openssl rand -hex 32` if missing. Chrome must have
`View → Developer → Allow JavaScript from Apple Events` enabled.

| Purpose | Command | Expected on success |
|---------|---------|----------------------|
| Syntax check | `node --check server.js` | exit 0, no errors |
| Install | `pnpm install` | exit 0 |
| Start server | `pnpm start` (separate terminal) | logs `listening on <HOST>:<PORT>` |
| Reproduce (before fix) | curl sequence in Test plan | returns OLD page ~0.5s early |
| Verify (after fix) | curl sequence in Test plan | waited navigate returns only when target page loaded |

Set shell vars once for the verify commands (values from your `.env`):

```bash
source .env
B="${BRIDGE_BASE_URL:-http://127.0.0.1:$PORT}"
T="Authorization: Bearer $BRIDGE_TOKEN"
CT="Content-Type: application/json"
```

## Scope

**In scope** (the only files you should modify):
- `server.js` — add two module-level helpers (`chromeLocationHref`, `urlsMatch`),
  add an optional timeout param to `chromeReadyState`, add the
  `waitForNavigationReady` helper, and rewire the `POST /navigate` `wait` block.
- `README.md` — only the `/navigate` row's `wait` description: clarify it waits
  for the **new** page to load (one clause). Do not restructure the docs.

**Out of scope** (do NOT touch, even though they look related):
- `POST /wait-for-ready` — separate endpoint, separate staleness concern; a
  follow-up issue will be filed. Do not change it here.
- `POST /back`, `POST /forward` — navigation triggers with no `wait` param.
- The public response shape of `/navigate` (`{ ok, data:{ state, status? } }`).
- Auth, rate-limit, `/batch`, or any schema object other than the optional
  param additions/clarifications noted below (there are **no** new public input
  fields in this version — `settle_ms` is internal).
- `plans/README.md` (the operator/reviewer maintains the index).

## Git workflow

- Branch: `fix/navigate-wait-stale-state`.
- Commit per logical unit (helpers + handler in one, README tweak in another).
  Message style (match repo): `fix: /navigate {wait:true} waits for the new page to load (#7)`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a bounded `chromeLocationHref` helper and a timeout param to `chromeReadyState`

Right after `chromeReadyState` (~line 67), add a sibling helper that reads
`location.href` (mirrors `chromeReadyState`'s osa-based style — no tempfile):

```js
async function chromeLocationHref(tab, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return osa(
    `tell application "${BROWSER}" to execute ${tabRef(tab)} javascript "location.href"`,
    timeoutMs,
  );
}
```

Then change `chromeReadyState` to accept an optional timeout (additive, default
unchanged so no other caller breaks):

```js
async function chromeReadyState(tab, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return osa(
    `tell application "${BROWSER}" to execute ${tabRef(tab)} javascript "document.readyState"`,
    timeoutMs,
  );
}
```

**Verify**: `node --check server.js` → exit 0. Then `grep -n "chromeLocationHref\|chromeReadyState" server.js` shows both definitions, `chromeReadyState` now takes a second param.

### Step 2: Add the `urlsMatch` normalizer

Near the Chrome helpers (after `chromeLocationHref`), add a pure function that
classifies same-URL vs different-URL. It must be defensive: if either URL fails
to parse, return `false` (treat as different-URL → require a URL change, the safe
default that refuses to return the old page).

```js
// Compare two URLs for "same navigation target" ignoring fragments and trivial
// normalization (trailing slash, host case, default ports) via the URL parser.
// Returns false when either value is not a parseable absolute http(s) URL —
// the safe default is "different", which forces the URL-change guard.
function urlsMatch(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    if (ua.protocol !== ub.protocol) return false;
    if (ua.hostname.toLowerCase() !== ub.hostname.toLowerCase()) return false;
    if ((ua.port || defaultPort(ua.protocol)) !== (ub.port || defaultPort(ub.protocol))) return false;
    // Ignore hash; normalize empty pathname to "/".
    const norm = (p) => (p === '' ? '/' : p);
    if (norm(ua.pathname) !== norm(ub.pathname)) return false;
    if (ua.search !== ub.search) return false;
    return true;
  } catch {
    return false;
  }
}
function defaultPort(protocol) {
  return protocol === 'https:' ? '443' : protocol === 'http:' ? '80' : '';
}
```

**Verify**: `node --check server.js` → exit 0.

### Step 3: Add the `waitForNavigationReady` helper

Add a new module-level `async function` after the helpers above (not inside the
route). It returns a **sentinel** `{ state, timedOut }` — it does NOT throw a
faux HTTP error. Operational failures (osa rejections, including `-1719`) are
**not caught** here; they propagate to the route's outer `catch` → `fail()`.

```js
// After chromeNavigate, the old page's readyState is still 'complete' until the
// new navigation begins. Wait for evidence that THIS navigation happened, then
// for readyState to return to 'complete'. beforeUrl is the pre-navigation
// location.href; requestedUrl is the url passed to /navigate. SETTLE_MS bounds
// Phase 1 (covers same-URL / bfcache where readyState/URL may never change).
// Returns { state, timedOut:false } on success or { state, timedOut:true } on
// timeout. Operational errors propagate (not caught) → fail().
const NAV_SETTLE_MS = 2000;
async function waitForNavigationReady(tab, timeoutMs, beforeUrl, requestedUrl) {
  const deadline = Date.now() + timeoutMs;
  const settleDeadline = Date.now() + Math.min(NAV_SETTLE_MS, timeoutMs);
  const poll = (ms) => new Promise((r) => setTimeout(r, ms));
  // Per-call osa timeout: leftover budget with a 500ms floor so osascript honors
  // it. Bounded overrun of up to ~500ms per trailing poll is expected; the
  // one-shot ensureWindow()/chromeNavigate() calls are NOT bounded here (fast,
  // not on the polling loop).
  const remaining = () => Math.max(500, deadline - Date.now());
  const isSameUrl = beforeUrl != null && requestedUrl != null && urlsMatch(requestedUrl, beforeUrl);

  // Phase 1: wait for the new navigation to begin — readyState leaves 'complete',
  // OR (different-URL only) location.href changed away from beforeUrl. Bounded by
  // settleDeadline so same-URL / instant-bfcache falls through.
  while (Date.now() < settleDeadline && Date.now() < deadline) {
    const s = await chromeReadyState(tab, remaining());
    if (s !== 'complete') break;
    if (!isSameUrl) {
      const cur = await chromeLocationHref(tab, remaining());
      if (cur !== beforeUrl) break; // URL flipped while still 'complete' (fast nav)
    }
    await poll(100);
  }

  // Phase 2: wait for readyState 'complete', with the URL-identity guard for
  // different-URL navigations.
  let lastState = 'loading';
  while (Date.now() < deadline) {
    const s = await chromeReadyState(tab, remaining());
    lastState = s;
    if (s === 'complete') {
      if (isSameUrl) return { state: s, timedOut: false };
      const cur = await chromeLocationHref(tab, remaining());
      if (cur !== beforeUrl) return { state: s, timedOut: false };
      // different-URL but URL hasn't changed yet → nav not begun/slow; keep waiting
    }
    await poll(200);
  }
  return { state: lastState, timedOut: true };
}
```

Notes for the executor:
- `remaining()` bounds **each** AppleScript subprocess call **on the polling
  loop** to a small per-call floor near the leftover budget (the `Math.max(500, …)`
  floor keeps `osascript` from rejecting a sub-100ms timeout; with 10ms left it
  permits one ~500ms call). It does **not** bound the one-shot `ensureWindow()` /
  `chromeNavigate()` calls, which use the default `DEFAULT_TIMEOUT_MS` (30s) —
  those are fast commands not on the polling loop and are not the source of the
  stall. So the **total** request can exceed `timeout_ms` by the one-shot setup
  time plus up to one ~500ms floor per trailing poll; this is a bounded,
  documented overrun, not exact adherence. The tests below assert 408 returns in
  roughly `timeout_ms` (with small slack), not the 30s default.
- `isSameUrl` decides the branch. `urlsMatch` returning `false` for unparseable
  inputs means a malformed-but-accepted-by-route `url` (the route already
  validated `^https?://`) takes the different-URL path → safe.
- Do NOT add `settle_ms` to the request body or schema — it is the internal
  `NAV_SETTLE_MS` constant.

**Verify**: `node --check server.js` → exit 0. `grep -n "waitForNavigationReady\|NAV_SETTLE_MS" server.js` shows the const, the function, and (after Step 4) the call site.

### Step 4: Rewire the `POST /navigate` `wait` block

Replace the existing `try` body's `if (wait) { ... }` block (~lines 453–470).
Capture `beforeUrl` **before** `chromeNavigate`, then call the helper and map
the sentinel. Keep the response shape identical; do not add `settle_ms` to the
schema or destructuring.

Target shape for the handler `try` body:

```js
if (wait) await ensureWindow();          // bootstrap a window/tab first (chromeNavigate
let beforeUrl = null;                    //   also does this, but we need a tab before we
if (wait) beforeUrl = await chromeLocationHref(tab, timeout_ms);  //  can read location.href)
await chromeNavigate(url, tab);
if (wait) {
  const result = await waitForNavigationReady(tab, timeout_ms, beforeUrl, url);
  if (result.timedOut) return sendError(reply, 408, 'timeout waiting for ready');
  // Post-wait status probe: bounded overhead (see notes). Not on the polling loop.
  const raw = await chromeEval(
    `String(performance.getEntriesByType('navigation')[0]?.responseStatus ?? '')`,
    Math.min(timeout_ms, 10_000),
    tab,
  );
  const status = raw ? parseInt(raw, 10) : undefined;
  return ok({ state: result.state, ...(status ? { status } : {}) });
}
return ok({});
```

Notes:
- **`ensureWindow()` must run before the `beforeUrl` capture.** `chromeNavigate`
  calls `ensureWindow()` internally, but the `beforeUrl` read happens first and
  needs a tab. Without this, `/navigate {wait:true}` into a windowless Chrome
  would throw `-1719` → 409 instead of bootstrapping a window — a regression of
  today's behavior. The double `ensureWindow()` (here + inside `chromeNavigate`)
  is harmless; do not remove the one inside `chromeNavigate`.
- `beforeUrl` capture uses `chromeLocationHref(tab, timeout_ms)` (bounded to the
  request budget, same as the wait path). If there's no window/tab *after*
  `ensureWindow`, this throws an AppleScript `-1719` which propagates to `fail()`
  → HTTP 409 with the existing hint. Do not special-case it here.
- The final response-status `chromeEval` is capped at `Math.min(timeout_ms,
  10_000)`; it is a **post-wait** fast call and may add bounded overhead on top
  of the wait budget (it is intentionally NOT on the polling deadline — the page
  is already loaded when it runs). See Maintenance notes.
- `result.timedOut` → `sendError(reply, 408, ...)`; everything else (osa/eval
  rejections) propagates to the outer `catch (err) { return fail(req, reply, err); }`.
  Do NOT wrap the helper call in its own try/catch.

**Verify**: `node --check server.js` → exit 0. Then run the Test plan against a
started server.

### Step 5: Update README wording (only if inaccurate)

In `README.md`, find the `/navigate` row / `wait` description. If it says only
"block until readyState=complete," add one terse clause noting it waits for the
**new** page to load (no need to mention same-URL/bfcache internals in the user
endpoint table). Keep it to one short clause.

**Verify**: `grep -n "wait" README.md` shows the updated clause; `git diff README.md` is a one-line hunk; nothing else in README changed.

## Test plan

There is no test runner. Verify by hand against a running server with Chrome
showing `View → Developer → Allow JavaScript from Apple Events` enabled. Use the
two distinct, fast, stable pages from the issue (`example.com` and
`iana.org/help/example-domains`).

Set vars (from `.env`):

```bash
source .env
B="${BRIDGE_BASE_URL:-http://127.0.0.1:$PORT}"
T="Authorization: Bearer $BRIDGE_TOKEN"
CT="Content-Type: application/json"
# helper: read current page identity
page(){ curl -s -H "$T" -H "$CT" -d '{"js":"JSON.stringify({href:location.href,title:document.title,rs:document.readyState})","parse_json":true}' "$B/eval"; }
```

1. **Regression (different-URL) — must NOT reproduce.** Land on A, ensure loaded,
   navigate to B with `wait:true`, then immediately read identity:

   ```bash
   curl -s -H "$T" -H "$CT" -d '{"url":"https://example.com","wait":true}' "$B/navigate" >/dev/null
   sleep 3
   curl -s -H "$T" -H "$CT" -d '{"url":"https://www.iana.org/help/example-domains","wait":true}' "$B/navigate"
   page
   ```

   **Expected**: `/navigate` returns `{"ok":true,"data":{"state":"complete",...}}`
   and `page` immediately reports `href` = `https://www.iana.org/help/example-domains`,
   `rs:"complete"`. (Before the fix `href` was `https://example.com`.) Record the
   observed `href` — it MUST be B, not A.

2. **Timing sanity.** Confirm `/navigate {wait:true}` returns no earlier than the
   target's `complete`:

   ```bash
   curl -s -H "$T" -H "$CT" -d '{"url":"https://example.com","wait":true}' "$B/navigate" >/dev/null
   sleep 3
   t0=$(date +%s%3N)
   curl -s -H "$T" -H "$CT" -d '{"url":"https://www.iana.org/help/example-domains","wait":true}' "$B/navigate"
   t1=$(date +%s%3N); echo "elapsed_ms=$((t1 - t0))"; page
   ```

   **Expected**: `page` shows `rs:"complete"`; `elapsed_ms` is the target page's
   real load time (hundreds of ms–low seconds), not ~0.

3. **Same-URL edge case (settle bound).** Navigate to the URL already shown; must
   not hang and must not 408:

   ```bash
   curl -s -H "$T" -H "$CT" -d '{"url":"https://example.com","wait":true}' "$B/navigate" >/dev/null
   sleep 3
   t0=$(date +%s%3N)
   curl -s -H "$T" -H "$CT" -d '{"url":"https://example.com","wait":true}' "$B/navigate"
   t1=$(date +%s%3N); echo "elapsed_ms=$((t1 - t0))"
   ```

   **Expected**: returns `{"ok":true,"data":{"state":"complete",...}}` within
   roughly `NAV_SETTLE_MS` (2000ms) + a small Phase-2 poll — NOT the full
   `timeout_ms` (30000ms), and no 408.

4. **Redirect target (deterministic).** A URL that 301-redirects to a *different*
   final URL than requested must still satisfy the guard (the guard requires
   final != beforeUrl, NOT final == requested). Use `https://wikipedia.org` which
   301-redirects to `https://en.wikipedia.org/...` (a different host). Pre-nav on
   `example.com` so `beforeUrl` is clearly different from the redirect target:

   ```bash
   curl -s -H "$T" -H "$CT" -d '{"url":"https://example.com","wait":true}' "$B/navigate" >/dev/null
   sleep 3
   curl -s -H "$T" -H "$CT" -d '{"url":"https://wikipedia.org","wait":true}' "$B/navigate"
   page
   ```

   **Expected**: returns `state:"complete"` (NOT 408); `page` reports
   `href` starting with `https://en.wikipedia.org` — which differs from both the
   requested `https://wikipedia.org` AND the pre-nav `https://example.com`. This
   proves a redirect whose final URL != requested is accepted. If wikipedia's
   redirect behavior ever changes, substitute any deterministic 301-to-different-host
   URL you can verify (e.g. a URL shortener that 301s to a different domain) —
   the assertion is: final `href` != pre-nav `href` AND != requested URL, and the
   response is `complete` not 408.

5. **Tiny timeout_ms (budget enforcement).** Confirm a small `timeout_ms` is
   honored and a stuck/slow AppleScript call cannot overrun it. Point at a host
   that won't load and a short `timeout_ms`:

   ```bash
   t0=$(date +%s%3N)
   curl -s -i -H "$T" -H "$CT" -d '{"url":"http://10.255.255.1","wait":true,"timeout_ms":2000}' "$B/navigate" | head -1
   t1=$(date +%s%3N); echo "elapsed_ms=$((t1 - t0))"
   ```

   **Expected**: HTTP `408` with `{"ok":false,"error":"timeout waiting for ready"}`,
   and `elapsed_ms` is close to 2000 (not 30000). This proves `remaining()` bounds
   the per-call osa timeout. Must be a 408, NOT a 500.

6. **timeout_ms smaller than settle (clamp).** `timeout_ms` below `NAV_SETTLE_MS`
   must not let Phase 1 overrun the total budget:

   ```bash
   t0=$(date +%s%3N)
   curl -s -i -H "$T" -H "$CT" -d '{"url":"http://10.255.255.1","wait":true,"timeout_ms":700}' "$B/navigate" | head -1
   t1=$(date +%s%3N); echo "elapsed_ms=$((t1 - t0))"
   ```

   **Expected**: 408 within ~700–1500ms (never 30000ms). Confirms
   `Math.min(NAV_SETTLE_MS, timeoutMs)` and the `Date.now() < deadline` guard both
   hold.

7. **No-wait path unchanged.** `{"url":"https://example.com"}` (no `wait`)
   returns `{"ok":true,"data":{}}` quickly, exactly as before.

8. **Negative URL assertion (automation guard).** After any waited different-URL
   navigate, assert the evaluated `href` is not the pre-navigation URL. (This is
   what steps 1 & 4 check manually; record the values.)

If steps 1, 3, 5, 6, 7 pass and step 4 passes with a real redirect pair, the fix
is correct. Steps 2 and 8 are sanity/record-keeping.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `node --check server.js` exits 0.
- [ ] `pnpm start` boots and logs a listen line.
- [ ] Test step 1: `page` after a waited different-URL navigate reports the
      **target** `href` and `rs:"complete"` (not the source page).
- [ ] Test step 3: same-URL navigate with `wait:true` returns within ~2–3s, not
      the full `timeout_ms`; no 408.
- [ ] Test step 5: unreachable target returns HTTP **408** (not 500) within
      ~`timeout_ms`; `elapsed_ms` ≈ 2000, not 30000.
- [ ] Test step 6: `timeout_ms:700` returns 408 well under 30000ms.
- [ ] Test step 7: no-`wait` navigate returns `{"ok":true,"data":{}}` fast.
- [ ] `git status` shows changes only to `server.js` and (optionally)
      `README.md`; nothing else.
- [ ] `grep -n "waitForNavigationReady\|chromeLocationHref\|urlsMatch\|NAV_SETTLE_MS" server.js`
      shows the new helpers and the call site in `/navigate`.
- [ ] `grep -n "settle_ms" server.js` returns **no** matches (it is internal,
      named `NAV_SETTLE_MS`).

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts (the
  codebase has drifted since `59c1168`).
- `chromeReadyState` does not return one of `loading`/`interactive`/`complete`
  as a plain string (e.g. quoted/wrapped output) — the Phase logic depends on
  exact-string comparison.
- `chromeLocationHref` returns something other than the bare `location.href`
  string (e.g. quoted) — the URL-identity guard depends on exact comparison.
- A same-URL navigate (Test step 3) takes the full `timeout_ms` to return — the
  settle clamp isn't working; do not paper over it by raising `NAV_SETTLE_MS`.
- The different-URL regression (Test step 1) still returns the old page's `href`
  after the fix — the URL-identity guard is not wired; do not "fix" it by adding
  a client-side sleep.
- The 408 timeout path (Test step 5/6) returns HTTP 500 instead of 408 — the
  sentinel mapping is wrong; do not convert it to a bare `sendError(reply, 500, ...)`.
- An operational error (e.g. AppleScript `-1719` no window) is returned as a 408
  "timeout" instead of propagating to `fail()` (409) — the helper is catching
  errors it shouldn't.
- You discover `chromeNavigate` is *not* asynchronous on your Chrome version
  (i.e. `set URL` blocks until load) — the two-phase approach is then unnecessary;
  STOP so the approach can be reconsidered.
- The fix appears to require touching `/wait-for-ready`, `/back`, `/forward`,
  the response envelope, or adding a public `settle_ms` input — all out of scope.

## Maintenance notes

- **`POST /wait-for-ready` is intentionally not fixed here.** Issue #7 covers
  `POST /navigate {wait:true}` only. A follow-up issue should be filed for
  `/wait-for-ready`'s staleness (a caller can `/navigate` without `wait` then
  `/wait-for-ready` and still see the old page's `complete`). A future plan could
  add an optional "expect navigation/change" mode there, reusing
  `waitForNavigationReady`. Do not silently fix it in this plan.
- **`NAV_SETTLE_MS` (2000ms) is an internal constant.** It balances same-URL
  return latency against giving slow-starting different-URL navigations time to
  begin. Different-URL navigations are protected by the URL-identity guard
  regardless of settle, so raising it only affects same-URL latency; lowering it
  risks Phase 1 falling through before a slow-init navigation flips the URL
  (Phase 2's URL guard still prevents a stale return, but the wait may 408 if
  the nav begins after the total `timeout_ms`).
- **Concurrent writes to the same tab are unsupported.** Two simultaneous
  `/navigate` calls to the same tab can race the `beforeUrl` capture and produce
  undefined wait behavior. This server does not serialize tab writes; document,
  don't fix.
- **Known limitation — redirect back to `beforeUrl`.** A different-URL
  navigation that redirects back to the pre-navigation URL would never satisfy
  the different-URL guard and would 408. Pathological; documented, not handled.
- **Reviewer should scrutinize:** (1) `ensureWindow()` runs before the
  `beforeUrl` capture so `/navigate {wait:true}` still bootstraps a windowless
  Chrome (no -1719→409 regression); (2) `remaining()` bounds every `osa` call
  on the polling loop to a small per-call floor (bounded overrun documented;
  one-shot setup calls are not bounded); (3) only `result.timedOut` triggers
  `sendError(408)` — all operational errors propagate to `fail()` (409 for
  `-1719`); (4) the response shape is byte-identical for both success and 408;
  (5) no public `settle_ms` was added (`NAV_SETTLE_MS` is internal); (6)
  `urlsMatch` returns `false` (safe) for unparseable inputs; (7) the post-wait
  status probe is bounded at `Math.min(timeout_ms, 10_000)` and is documented as
  bounded overhead on top of the wait budget.
