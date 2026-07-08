# Plan 003: Fix `POST /wait-for-ready` returning the old page's `complete`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. The plans index (`plans/README.md`) is maintained
> by the operator/reviewer, not by you — do not edit it.
>
> **Drift check (run first)**: this plan depends on 002. After 002 lands, the
> baseline is the post-002 HEAD (not `3bb254c`). Run:
> `git rev-parse --short HEAD` and compare the in-scope excerpts below against
> the live code. Specifically confirm `waitForNavigationReady` (~line 115) and
> `POST /wait-for-ready` (~line 661) still match. The expected 002 changes
> (`lib.js`, `test/`, `package.json`, and the import line in `server.js`) are
> **not** a STOP trigger — only a mismatch in `waitForNavigationReady` or the
> `/wait-for-ready` handler is. If those differ from the excerpts, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/002-verification-baseline.md (needs `node:test` + `lib.js` in place)
- **Category**: bug
- **Planned at**: commit `3bb254c`, 2026-07-08
- **Related**: the #7 fix (commit `3bb254c`) shipped the same fix for `POST /navigate`; this is the promised follow-up noted in the #7 closing comment.

## Why this matters

`POST /wait-for-ready` polls `document.readyState` until `'complete'`. But when called right after a navigation, the **old** page is still displayed at `readyState='complete'`, so the **first poll succeeds immediately** and returns the previous page's state — exactly the bug fixed for `/navigate` in issue #7. The documented usage pattern is "navigate (without `wait`) → `/wait-for-ready`", which is the pattern that triggers the bug. This makes `/wait-for-ready` a silent footgun: it returns success while the new page hasn't begun loading. This plan reuses the navigation-identity approach from the #7 fix.

## Current state

- `server.js`, `POST /wait-for-ready` handler (~lines 659–690):

```js
async (req, reply) => {
  const { tab, timeout_ms = 30_000, interval_ms = 500 } = req.body || {};
  const deadline = Date.now() + timeout_ms;
  try {
    while (Date.now() < deadline) {
      const state = await chromeReadyState(tab);
      if (state === 'complete') return ok({ state });   // ← BUG: old page is already 'complete'
      await new Promise((r) => setTimeout(r, interval_ms));
    }
    return sendError(reply, 408, 'timeout waiting for ready');
  } catch (err) {
    return fail(req, reply, err);
  }
},
```

- The #7 fix's helper `waitForNavigationReady(tab, timeoutMs, beforeUrl, requestedUrl)` (~lines 112–160, added in commit `3bb254c`) implements the two-phase wait with a URL-identity guard. It is currently called **only** from `POST /navigate`. Its key logic:
  - **Phase 1**: wait for `readyState` to leave `'complete'` OR (for different-URL) `location.href` to change from `beforeUrl`, bounded by `NAV_SETTLE_MS`.
  - **Phase 2**: wait for `readyState === 'complete'`; for different-URL, require `location.href !== beforeUrl`.
  - Returns `{ state, timedOut: false }` on success or `{ state, timedOut: true }` on timeout; operational errors propagate.
  - `isSameUrl = beforeUrl != null && requestedUrl != null && urlsMatch(requestedUrl, beforeUrl)`. When `requestedUrl` is `null`, `isSameUrl` is `false` → "require a URL change" (the strict/different-URL path). **This plan needs a "no target URL, accept after settle if nothing changes" mode** — see Step 1.

- `urlsMatch` now lives in `lib.js` (after plan 002) and is unit-tested.

### Repo conventions to honor (from `AGENTS.md`)

- Single file for server logic; helpers are module-level `async function`s.
- Uniform response envelope: `ok()` / `sendError()` / `fail()`. The 408 timeout and the `-1719`→409 path are preserved exactly.
- `sendError(reply, 408, 'timeout waiting for ready')` is the existing 408 message — keep it byte-identical.
- No `err.message` leakage; operational errors propagate to `fail()`.
- 2-space indent, double quotes, ES modules.

### Design: optional `expected_url` + three modes

`/wait-for-ready` has, by default, **no target URL** — the caller is just "wait until ready", not "wait for navigation to X." That creates a fundamental ambiguity: it cannot distinguish "page already loaded" from "navigation hasn't started yet but the old page is still `complete`." The settle bound is only a heuristic, and there is an **unavoidable stale-accept window**: if Chrome does not begin a new navigation within `NAV_SETTLE_MS` (2s), no-target mode accepts the old page as "already ready."

This plan therefore adds an **optional `expected_url`** body field to `/wait-for-ready`:
- **With `expected_url`**: behaves like `/navigate`'s strict mode — `waitForNavigationReady(tab, timeout_ms, beforeUrl, expected_url)` is called with a real URL, so `noTarget` is false and the URL-identity guard requires `location.href !== beforeUrl` before accepting `complete` (redirect-tolerant). This is the **correct** way to wait after a navigation when you know where you're going.
- **Without `expected_url`**: best-effort no-target mode (settle heuristic), with the stale-accept limitation **documented** (see Maintenance notes). Fine for polling an already-loaded page; unsafe for post-navigation waiting.

The `expected_url` addition is additive and backward-compatible (existing callers who omit it get the heuristic; callers who want strictness pass it).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|----------------------|
| Syntax check | `pnpm check` (`node --check server.js && node --check lib.js`) | exit 0 |
| Tests | `pnpm test` | all pass (incl. new tests) |
| Start server | `pnpm start` | boots, logs listen line |

(These commands exist after plan 002 lands. If 002 is not yet DONE, STOP — this plan depends on it.)

Set vars (from `.env`):

```bash
source .env 2>/dev/null
B="http://127.0.0.1:${PORT:-8765}"
T="Authorization: Bearer $BRIDGE_TOKEN"
CT="Content-Type: application/json"
page(){ curl -s -H "$T" -H "$CT" -d '{"js":"JSON.stringify({href:location.href,rs:document.readyState})","parse_json":true}' "$B/eval"; }
```

## Scope

**In scope**:
- `server.js` — generalize `waitForNavigationReady` to support `requestedUrl == null` (no-target mode) **without altering the `/navigate` call path**, add the optional `expected_url` to the `/wait-for-ready` schema, and rewire the handler to capture `beforeUrl` and call the helper.
- `README.md` — update the `/wait-for-ready` endpoint-table row to mention `expected_url` (one-line hunk).
- `test/lib.test.mjs` — no change needed unless a pure helper is extracted (Step 4 escape hatch). The new branch logic is impure (calls `chromeReadyState`/`chromeLocationHref`) and is hand-tested via the Test plan.

**Out of scope** (do NOT touch):
- `POST /navigate` — already fixed; do not change its call.
- `POST /back`, `POST /forward` — navigation triggers with no wait param.
- The public response shape of `/wait-for-ready` (`{ ok, data:{ state } }`) — must not change.
- Auth, rate-limit, `/batch`, schemas other than the optional additions noted.
- `lib.js` (unless extracting a pure helper — see Step 1 escape hatch).

## Git workflow

- Branch: `fix/wait-for-ready-stale-state`.
- Commit message (match repo): `fix: /wait-for-ready waits for the new page, not the old page's complete (#7 follow-up)`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Generalize `waitForNavigationReady` for the no-target case (without breaking `/navigate`)

The goal: preserve `/navigate`'s behavior **byte-identically** for both same-URL and different-URL (those call paths pass a real `url`), and add a **no-target** mode only when `requestedUrl == null`. Do NOT introduce a `settled` flag that conflates "observed a change" with "settle elapsed" — that was a broken earlier attempt. Instead, the no-target acceptance is a single explicit condition in Phase 2.

In `server.js`, replace `waitForNavigationReady` (~line 115) with this. **The only behavioral change from the live function is the no-target mode: a new `noTarget` const, a `requireChange` const used in Phase 1 (equivalent to the existing `!isSameUrl` for `/navigate`), and the one `noTarget && Date.now() >= settleDeadline` line in Phase 2.** Every other line is identical to the live (post-#7) code, which is what makes `/navigate` safe.

```js
async function waitForNavigationReady(tab, timeoutMs, beforeUrl, requestedUrl) {
  const deadline = Date.now() + timeoutMs;
  const settleDeadline = Date.now() + Math.min(NAV_SETTLE_MS, timeoutMs);
  const poll = (ms) => new Promise((r) => setTimeout(r, ms));
  const remaining = () => Math.max(500, deadline - Date.now());
  const isSameUrl = beforeUrl != null && requestedUrl != null && urlsMatch(requestedUrl, beforeUrl);
  // No target URL (/wait-for-ready without expected_url): watch for a change,
  // but if nothing changes during settle and the page is complete, accept it
  // as already-ready (best-effort; has a stale-accept window — see Maintenance).
  const noTarget = requestedUrl == null && beforeUrl != null;
  const requireChange = !isSameUrl; // true for different-URL AND no-target

  // Phase 1: wait for readyState to leave 'complete', OR (requireChange)
  // location.href to change away from beforeUrl. Bounded by settleDeadline.
  while (Date.now() < settleDeadline && Date.now() < deadline) {
    const s = await chromeReadyState(tab, remaining());
    if (s !== 'complete') break;
    if (requireChange) {
      if (Date.now() >= deadline) break;
      const cur = await chromeLocationHref(tab, remaining());
      if (cur !== beforeUrl) break; // nav began
    }
    await poll(100); // same-URL: polls until settleDeadline (unchanged from #7)
  }

  // Phase 2: wait for readyState 'complete', with the URL-identity guard.
  let lastState = 'loading';
  while (Date.now() < deadline) {
    const s = await chromeReadyState(tab, remaining());
    lastState = s;
    if (s === 'complete') {
      if (isSameUrl) return { state: s, timedOut: false }; // same-URL: accept
      if (Date.now() >= deadline) break;
      const cur = await chromeLocationHref(tab, remaining());
      if (cur !== beforeUrl) return { state: s, timedOut: false }; // change proven
      if (noTarget && Date.now() >= settleDeadline)
        return { state: s, timedOut: false }; // settle elapsed, no change → already ready
      // different-URL but URL hasn't changed yet → nav not begun/slow; keep waiting
    }
    await poll(200);
  }
  return { state: lastState, timedOut: true };
}
```

**Why `/navigate` is preserved byte-identically** (the critical invariant — trace it):
- `/navigate` always calls with a real `url`, so `noTarget = (requestedUrl == null ...)` is **false**. The `noTarget && ...` line in Phase 2 is **dead code** for `/navigate`.
- **Same-URL `/navigate`** (`isSameUrl` true): `requireChange = !isSameUrl = false`, so Phase 1's `if (requireChange)` is skipped — it just polls `readyState` and `poll(100)` until `settleDeadline` (identical to #7). Phase 2 hits `if (isSameUrl) return` immediately on `complete` (identical to #7). ✓
- **Different-URL `/navigate`** (`isSameUrl` false, `noTarget` false): Phase 1 watches for leave/URL-change (identical to #7). Phase 2 requires `cur !== beforeUrl` (identical to #7); the `noTarget` line is dead. ✓

**Important — do NOT break the `/navigate` caller.** After this change, re-run the `/navigate` regression from the Test plan (Test 5, inlined below) — both same-URL and different-URL must still pass. **If any `/navigate` test result changes, STOP.**

Note: `interval_ms` is now unused by the wait logic (the helper uses its own 100/200ms polls). **Keep `interval_ms` in the schema** (backward compat), but it no longer affects behavior. Do not remove it.

**Verify**: `pnpm check` → exit 0. Then re-run `/navigate` regression Test 5 (inlined below) — must still pass.

### Step 2: Rewire `POST /wait-for-ready` to use the helper (with optional `expected_url`)

Replace the handler body (~lines 678–690). Capture `beforeUrl` before the loop; read the optional `expected_url`; call the helper with `expected_url ?? null`; map the sentinel to `ok`/408 exactly as `/navigate` does. Keep the response shape `{ ok, data:{ state } }` (no `status` — preserve that).

First, add `expected_url` to the `body` schema `properties` (~line 668):
```js
          expected_url: {
            type: 'string',
            description: 'If set, strictly wait until this URL is loaded (requires location.href to change from the pre-call URL; redirect-tolerant). Omit for best-effort polling of an already-loaded page.',
          },
```

Then the handler:
```js
async (req, reply) => {
  const { tab, timeout_ms = 30_000, interval_ms = 500, expected_url } = req.body || {};
  try {
    // Capture pre-call URL so we can prove a navigation happened before
    // accepting 'complete' (avoids returning the old page's readyState).
    const beforeUrl = await chromeLocationHref(tab, timeout_ms);
    const result = await waitForNavigationReady(tab, timeout_ms, beforeUrl, expected_url ?? null);
    if (result.timedOut) return sendError(reply, 408, 'timeout waiting for ready');
    return ok({ state: result.state });
  } catch (err) {
    return fail(req, reply, err);
  }
},
```

Notes:
- `expected_url ?? null`: with `expected_url` set → strict different-URL/same-URL mode (identical to `/navigate`). Without → no-target heuristic. **Recommend `expected_url` in docs for the post-navigation case.**
- `interval_ms` is kept in the schema but is now a no-op (see Maintenance).
- If there's no window/tab, `chromeLocationHref` throws `-1719` → `fail()` → HTTP 409. Do not special-case.
- The `try`/`catch (err)` remains; only `result.timedOut` → `sendError(408)`. No inner try/catch.

**Verify**: `pnpm check` → exit 0. `pnpm start`, then run the Test plan.

### Step 3: Update README for `/wait-for-ready` `expected_url` + limitation

In `README.md`, find the `/wait-for-ready` row in the endpoint table (~line 86, currently `Poll until readyState === 'complete'`). Update its description to mention `expected_url` and the limitation, keeping it terse (one cell):

```
| POST   | `/wait-for-ready`    | Poll until `readyState === 'complete'`; pass `expected_url` to strictly wait for a navigation (recommended after `/navigate`) | |
```

(Adjust column alignment to match the existing table; keep it one row.) Do not add a long prose section — the schema `expected_url` description (added in Step 2) carries the detail.

**Verify**: `grep -n "expected_url" README.md` shows the updated cell; `git diff README.md` is a one-line hunk; the rest of the table is unchanged.

### Step 4: (If a pure helper was extracted) add a unit test

Skip this step by default — Step 1's logic stays inline (it's impure due to the osa calls). The behavior is covered by the hand-run Test plan. Only if you extracted a pure decision function into `lib.js` (escape hatch: prefer NOT to, to avoid moving impure code into `lib.js`) add `node:test` cases for it in `test/lib.test.mjs` covering: same-URL, different-URL, no-target. Do not extract the `waitForNavigationReady` body itself — it calls `chromeReadyState`/`chromeLocationHref` (I/O) and belongs in `server.js`.

## Test plan

There is no test runner for the route; verify by hand against a running server with Chrome's `View → Developer → Allow JavaScript from Apple Events` enabled.

1. **Regression with `expected_url` (strict mode) — must NOT reproduce.** Navigate (no `wait`) to B, then `/wait-for-ready` with `expected_url`, then read identity:

   ```bash
   curl -s -H "$T" -H "$CT" -d '{"url":"https://example.com","wait":true}' "$B/navigate" >/dev/null
   sleep 3
   curl -s -H "$T" -H "$CT" -d '{"url":"https://www.iana.org/help/example-domains"}' "$B/navigate"   # no wait
   curl -s -H "$T" -H "$CT" -d '{"tab":1,"expected_url":"https://www.iana.org/help/example-domains"}' "$B/wait-for-ready"
   page
   ```

   **Expected**: `/wait-for-ready` returns `{"ok":true,"data":{"state":"complete"}}` AND `page` reports `href` = `https://www.iana.org/help/example-domains` (the **target**), not `https://example.com`. (Before the fix, it returned `complete` immediately while still showing `example.com`.) Record the observed `href`. **This is the strict path and must never return the old page.**

2. **Legitimate already-loaded polling, no `expected_url` (must NOT 408).** With the page already loaded and no navigation pending, `/wait-for-ready` (no `expected_url`) should return `complete` quickly (within ~settle, not 30s):

   ```bash
   curl -s -H "$T" -H "$CT" -d '{"url":"https://example.com","wait":true}' "$B/navigate" >/dev/null
   sleep 3
   ms(){ python3 -c 'import time;print(int(time.time()*1000))'; }
   t0=$(ms); curl -s -H "$T" -H "$CT" -d '{"tab":1}' "$B/wait-for-ready"; t1=$(ms); echo "elapsed_ms=$((t1 - t0))"
   ```

   **Expected**: returns `{"ok":true,"data":{"state":"complete"}}` within ~2–3s (NAV_SETTLE_MS + small poll), NOT 30s, and NOT 408.

3. **In-flight navigation (the original good case still works).** Navigate to a page WITHOUT wait, then immediately `/wait-for-ready` (no `expected_url`) while it's still `loading`:

   ```bash
   curl -s -H "$T" -H "$CT" -d '{"url":"https://example.com"}' "$B/navigate" >/dev/null; sleep 3
   curl -s -H "$T" -H "$CT" -d '{"url":"https://www.iana.org/help/example-domains"}' "$B/navigate"   # no wait
   curl -s -H "$T" -H "$CT" -d '{"tab":1,"timeout_ms":10000}' "$B/wait-for-ready"
   page
   ```

   **Expected**: returns `complete` once the target loads; `page` reports the target `href`. (Confirms the polling-while-loading case isn't broken by the beforeUrl capture.)

4. **Already-loaded + tiny timeout returns 200 quickly (concrete).** With the page already loaded, a `timeout_ms` smaller than settle must return 200 fast (the page is already ready — no-target accepts after settle clamp):

   ```bash
   curl -s -H "$T" -H "$CT" -d '{"url":"https://example.com","wait":true}' "$B/navigate" >/dev/null; sleep 3
   ms(){ python3 -c 'import time;print(int(time.time()*1000))'; }
   t0=$(ms); curl -s -i -H "$T" -H "$CT" -d '{"tab":1,"timeout_ms":500}' "$B/wait-for-ready" | head -1; t1=$(ms); echo "elapsed_ms=$((t1 - t0))"
   ```

   **Expected**: HTTP `200` and `elapsed_ms` well under 30000ms (≈ `timeout_ms` + small overrun). This is a single concrete assertion (200, fast) — NOT "200 or 408." (A genuine 408 case is not practically forceable for `/wait-for-ready` without an unreachable tab state; the 408 path is exercised in plan 001's `/navigate` timeout tests and shares the same `sendError(408)` line.)

5. **`/navigate {wait:true}` regression — both same-URL and different-URL (inlined from plan 001, must still pass).** The Step 1 generalization must NOT alter `/navigate`:

   ```bash
   # different-URL: target page reports complete immediately
   curl -s -H "$T" -H "$CT" -d '{"url":"https://example.com","wait":true}' "$B/navigate" >/dev/null; sleep 3
   curl -s -H "$T" -H "$CT" -d '{"url":"https://www.iana.org/help/example-domains","wait":true}' "$B/navigate"
   curl -s -H "$T" -H "$CT" -d '{"js":"JSON.stringify({href:location.href,rs:document.readyState})","parse_json":true}' "$B/eval"
   # Expected: navigate returns {"ok":true,"data":{"state":"complete",...}} and eval reports
   #   href=https://www.iana.org/help/example-domains, rs=complete (NOT example.com)

   # same-URL: returns complete within ~settle, not 30s, no 408
   curl -s -H "$T" -H "$CT" -d '{"url":"https://example.com","wait":true}' "$B/navigate" >/dev/null; sleep 3
   ms(){ python3 -c 'import time;print(int(time.time()*1000))'; }
   t0=$(ms); curl -s -H "$T" -H "$CT" -d '{"url":"https://example.com","wait":true}' "$B/navigate"; t1=$(ms); echo "elapsed_ms=$((t1 - t0))"
   # Expected: {"ok":true,"data":{"state":"complete",...}}, elapsed_ms ~2–3s (NOT 30s, NOT 408)
   ```

If tests 1, 2, 3, and 5 pass, the fix is correct. Test 4 is a fast-200 sanity check.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm check` exits 0.
- [ ] `pnpm test` exits 0 (existing tests from 002 still pass; no new unit tests required unless a pure helper was extracted).
- [ ] `pnpm start` boots.
- [ ] Test 1: with `expected_url`, `page` after `/wait-for-ready` reports the **target** `href`, not the old page.
- [ ] Test 2: already-loaded `/wait-for-ready` (no `expected_url`) returns `complete` within ~2–3s, not 30s, no 408.
- [ ] Test 3: in-flight navigation `/wait-for-ready` returns `complete` with the target `href`.
- [ ] Test 5: `/navigate {wait:true}` regression (both same-URL and different-URL, inlined) still passes — no behavior change.
- [ ] `grep -n "waitForNavigationReady" server.js` shows the definition plus **two** call sites (`/navigate` and `/wait-for-ready`).
- [ ] `grep -n "expected_url" server.js` shows the schema property and the `expected_url ?? null` call-site usage.
- [ ] `git status` shows changes only to `server.js` and `README.md` (and `test/lib.test.mjs` only if Step 4 applied); nothing else.
- [ ] Response shape unchanged: `/wait-for-ready` returns `{ ok, data:{ state } }` (no `status` field).

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 002 is not DONE (`pnpm test` / `pnpm check` don't exist) — this plan depends on it.
- The code at the cited locations doesn't match the excerpts (drift — compare against the post-002 HEAD, not `3bb254c`).
- The Step 1 generalization changes **any** `/navigate` test result (Test 5). The `noTarget && Date.now() >= settleDeadline` line must be dead code for `/navigate`, which always passes a real `url` (so `noTarget` is false). Trace and confirm before proceeding.
- The no-target path accepts the **old** page in a way Test 1 (with `expected_url`) catches — Test 1 uses the strict path and must never return the old page. (The no-target path's stale-accept window is a documented limitation, NOT a STOP — see Maintenance.)
- The 408 timeout path returns 500, or an operational `-1719` is returned as 408 — the sentinel/error propagation is wrong.
- The fix appears to require changing `/navigate`'s call, the response envelope, or removing `interval_ms` from the schema — all out of scope. (Adding the optional `expected_url` schema field and `?? null` call-site usage IS in scope.)

## Maintenance notes

- **`interval_ms` is now a no-op** for `/wait-for-ready` (the helper uses fixed 100/200ms polls). It's kept in the schema for backward compat. A future plan could either wire it through to the helper's poll interval or deprecate it with a schema `description` note; do not silently remove it.

- **`waitForNavigationReady` now has three modes**: same-URL (`isSameUrl`), different-URL (`requireChange` + strict guard), and no-target (`noTarget` + settle-then-accept). Any future caller must choose the right mode by passing `requestedUrl` (a real URL) or `null`. Document at the call site.

- **KNOWN LIMITATION — no-target stale-accept window.** `/wait-for-ready` **without** `expected_url` cannot prove a navigation happened: if a caller does `/navigate` (no `wait`) to page B and then `/wait-for-ready` (no `expected_url`) while Chrome has not yet begun loading B (the old page A is still `complete`), and B begins loading **after** `NAV_SETTLE_MS` (2s), the no-target mode accepts A's `complete` as "already ready" and returns stale state. This is fundamental: with no target URL the endpoint cannot distinguish "page already loaded" from "navigation hasn't started." **Callers who need robust post-navigation waiting must pass `expected_url`** (strict mode, which requires `location.href` to change and is immune to this). This is documented in the schema `expected_url` description and the README; it is a known trade-off, not a bug. (If a future caller needs strict waiting without knowing the target, a separate `wait_for_change: true` mode could require any URL change — out of scope here.)

- **KNOWN LIMITATION — `timeout_ms < NAV_SETTLE_MS` in no-target mode: FIXED.** Previously, with no `expected_url` and `timeout_ms` smaller than the settle bound (2000ms), Phase 1 consumed the entire budget polling, so Phase 2 never reached the no-target acceptance line and an already-loaded page 408'd. **Fixed in `d3ab236`:** Phase 1 now tracks a `navStarted` flag, and a post-Phase-1 block accepts when `noTarget && !navStarted && Date.now() >= settleDeadline` and the page is `complete` — reachable even when `timeout_ms <= settle`. Verified: `timeout_ms:500` on `example.com` now returns 200 in ~850ms (was 408). Dead code for `/navigate` (which always passes a real `url`, so `noTarget` is false). Reviewer (GPT-5.5) re-traced all paths and approved.
- **`/back` and `/forward` still have no `wait`.** A future plan could add a `wait` option to them by calling this helper with the tab's pre-nav URL and an `expected_url`/`null`, but that requires capturing the URL before `go back`/`go forward` — out of scope here.

- **Reviewer should scrutinize:** (1) `/navigate` behavior is byte-identical — the `noTarget && Date.now() >= settleDeadline` line is dead for `/navigate` (which always passes a real `url`, so `noTarget` is false); (2) the 408 message is unchanged; (3) `interval_ms` remains in the schema and the optional `expected_url` was added; (4) no `err.message` leakage; (5) Test 1 (with `expected_url`) shows the target `href`, proving the strict path never returns the stale old page; (6) Test 5 confirms both same-URL and different-URL `/navigate` are unchanged.
