# Plan 002: Establish a verification baseline (node:test + node --check, pure-helper extraction)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. The plans index (`plans/README.md`) is maintained
> by the operator/reviewer, not by you — do not edit it.
>
> **Drift check (run first)**: `git diff --stat 3bb254c..HEAD -- server.js package.json`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (this plan unblocks 003 and 005)
- **Category**: tests
- **Planned at**: commit `3bb254c`, 2026-07-08

## Why this matters

This repo has **zero tests**, a no-op `test` script (`echo "Error: no test specified" && exit 1`), and no `lint`/`typecheck` step. Every refactor — including plans 003 and 005 — is currently verified only by hand-curling a live server. That makes any change risky and non-repeatable. A handful of the server's functions are **pure** (`urlsMatch`, `defaultPort`, `humanPath`, `tabRef`, `asString`) and trivially unit-testable with Node's built-in `node:test` — no new dependency, no build step, matching the repo's minimalism. Establishing this baseline de-risks every subsequent plan and gives a one-command green/red signal.

The blocker: `server.js` has **top-level side effects** (it reads `BRIDGE_TOKEN` and `process.exit(1)`s if missing, runs `await app.register(...)` for plugins, registers all routes, and calls `app.listen()` at module top level). So a test cannot `import './server.js'` without booting the server. The minimal fix is to **extract the pure helpers into a tiny `lib.js`** that `server.js` imports — a narrow, principled exception to the single-file convention (see "Why this is allowed" below).

## Current state

- `server.js` — the entire app, 1949 lines. The pure helpers (no I/O, no AppleScript, no Fastify) that should move:
  - `asString(s)` (~line 47) — escape `\` and `"` for AppleScript strings.
  - `tabRef(tab)` (~line 52) — `"tab N of window 1"` (clamped with `Math.max(1, Number(tab))`) or `"active tab of window 1"` when `tab` is falsy (undefined/0/null). **Note: `tabRef(0)` returns `"active tab of window 1"` because `0` is falsy** — the tests must reflect this.
  - `defaultPort(protocol)` (~line 85) — `'443'`/`'80'`/`''`.
  - `urlsMatch(a, b)` (~line 88) — URL-parser-based same-target check; **returns `false` on parse failure** (the safe default). **It normalizes only empty pathname to `/`; it does NOT strip trailing slashes**, so `/a` vs `/a/` → `false`. The tests must reflect the actual behavior.
  - `humanPath(x0, y0, x1, y1, steps)` (~line 239) — returns array of `[x, y]` waypoints (side-effect-free, but uses `Math.random` so not deterministic — see test plan).
- `package.json` scripts block (lines 7–10):
  ```json
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1",
    "start": "node server.js"
  },
  ```
- No `eslint`/`prettier`/`vitest`/`jest` config exists (confirmed: `ls -a` shows none).
- `node:test` is available (Node 18+ per `AGENTS.md`; verified `node -e "console.log(require('node:test'))"` works).

### Why this is allowed (convention tension)

`AGENTS.md` says: *"All server logic lives in `server.js`; don't split into modules without strong reason."* A test baseline is a strong reason, and `lib.js` will be **strictly side-effect-free** — no `import` of Fastify, no `child_process`, no `fs`, no `osascript`, no module-level side effects, no access to `process`/`Date`/`globalThis`/the network. It is a leaf of pure logic, not a junk-drawer module. `humanPath` uses `Math.random` — that is allowed (side-effect-free; just non-deterministic, which the tests accommodate by asserting structure not exact values). Everything that touches Chrome, the OS, or Fastify stays in `server.js`. If a future contributor wants to move impure helpers into `lib.js`, that is **out of scope** and should be a separate decision — `lib.js` stays side-effect-free-only (see Maintenance notes).

### Repo conventions to honor

- ES modules (`"type": "module"`), 2-space indent, double quotes, plain JS.
- No new runtime dependencies. `node:test` + `node:assert` are built-in.
- Style: helpers are module-level `function`s / `const`s. Match `server.js` style.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|----------------------|
| Syntax check | `node --check server.js && node --check lib.js` | exit 0 |
| Run tests | `pnpm test` (or `node --test`) | all pass |
| Start server | `pnpm start` | boots, logs listen line |

## Scope

**In scope**:
- `lib.js` — **create**; pure helpers only (`asString`, `tabRef`, `defaultPort`, `urlsMatch`, `humanPath`) with `export function` / `export const`.
- `server.js` — remove the 5 pure helper definitions and import them from `./lib.js` instead. No other changes to `server.js`.
- `test/lib.test.mjs` — **create**; `node:test` unit tests for the 5 helpers.
- `package.json` — replace the `test` script with `node --test` and add a `check` script (`node --check server.js && node --check lib.js`).
- `.env.example` — no change.

**Out of scope** (do NOT touch):
- Any route handler, any AppleScript/Swift helper, Fastify setup, auth, `/batch`.
- Moving impure helpers (`osa`, `chromeEval`, `chromeReadyState`, `waitForNavigationReady`, etc.) — `lib.js` stays side-effect-free-only.
- Adding any dependency (no `vitest`, `jest`, `chai`, `eslint`).
- The `AGENTS.md` "single file" convention note — do not edit it; the `lib.js` split is the narrow exception documented in this plan, not a convention change.

## Git workflow

- Branch: `test/verification-baseline`.
- Two commits: (1) "test: extract pure helpers to lib.js + add node:test baseline", (2) none needed beyond that unless the `package.json` change is split out.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Create `lib.js` with the pure helpers, exported

Create `lib.js` in the repo root. Copy the 5 functions' **bodies verbatim** from `server.js` (do not change any logic — `tabRef`'s falsy→active behavior, `urlsMatch`'s no-trailing-slash-strip behavior, etc. must be preserved exactly). Comments may be trimmed/relocated; the export keyword is added to each. Do NOT "fix" any behavior during the move — this is a mechanical extraction, and any behavior change would silently alter production routes. (If you believe a function's behavior is wrong, that's a separate finding — STOP and report it; do not change it here.)

The exports: `asString`, `tabRef`, `defaultPort`, `urlsMatch`, `humanPath`.

```js
// lib.js — pure helpers for chrome-bridge. No I/O, no AppleScript, no Fastify,
// no module-level side effects. Safe to import from tests.
// (Functions moved verbatim from server.js; see plans/002.)

export function asString(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function tabRef(tab) {
  return tab
    ? `tab ${Math.max(1, Number(tab))} of window 1`
    : `active tab of window 1`;
}

export function defaultPort(protocol) {
  return protocol === 'https:' ? '443' : protocol === 'http:' ? '80' : '';
}

export function urlsMatch(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    if (ua.protocol !== ub.protocol) return false;
    if (ua.hostname.toLowerCase() !== ub.hostname.toLowerCase()) return false;
    const portA = ua.port || defaultPort(ua.protocol);
    const portB = ub.port || defaultPort(ub.protocol);
    if (portA !== portB) return false;
    const norm = (p) => (p === '' ? '/' : p);
    if (norm(ua.pathname) !== norm(ub.pathname)) return false;
    if (ua.search !== ub.search) return false;
    return true;
  } catch {
    return false;
  }
}

export function humanPath(x0, y0, x1, y1, steps) {
  steps = Math.max(1, steps);
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  const perp = (Math.random() - 0.5) * len * 0.4;
  const nx = len > 0 ? -dy / len : 0;
  const ny = len > 0 ?  dx / len : 0;
  const cx = (x0 + x1) / 2 + nx * perp;
  const cy = (y0 + y1) / 2 + ny * perp;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const raw = i / steps;
    const t = raw < 0.5 ? 2 * raw * raw : 1 - 2 * (1 - raw) ** 2;
    const bx = (1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t ** 2 * x1;
    const by = (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t ** 2 * y1;
    const amp = Math.min(t, 1 - t) * Math.min(len * 0.05, 8);
    pts.push([
      Math.round(bx + (Math.random() + Math.random() - 1) * amp),
      Math.round(by + (Math.random() + Math.random() - 1) * amp),
    ]);
  }
  return pts;
}
```

**Verify**: `node --check lib.js` → exit 0.

### Step 2: Import the helpers in `server.js` and remove the local definitions

At the top of `server.js` (with the other imports, after the existing `import` block ~lines 1–12), add:

```js
import { asString, tabRef, defaultPort, urlsMatch, humanPath } from './lib.js';
```

Then **delete** the 5 local definitions from `server.js` (live post-#7 line numbers):
- `asString` (~line 47)
- `tabRef` (~line 52)
- `defaultPort` (~line 85)
- `urlsMatch` (~line 88)
- `humanPath` (~line 239)

Leave a one-line comment where each was removed is NOT required — the import line documents the move. Do not change any call sites; the names are identical so all callers keep working.

**Verify**:
- `node --check server.js` → exit 0.
- `grep -n "function asString\|function tabRef\|function defaultPort\|function urlsMatch\|function humanPath" server.js` → **no matches** (definitions removed).
- `grep -n "from './lib.js'" server.js` → one match (the import).
- `pnpm start` → server boots and logs a listen line (smoke check that the import didn't break the module).

### Step 3: Update `package.json` scripts

Replace the `test` script and add a `check` script:

```json
"scripts": {
  "test": "node --test",
  "check": "node --check server.js && node --check lib.js",
  "start": "node server.js"
},
```

**Verify**: `pnpm check` → exit 0. `pnpm test` → runs `node --test` (no test files yet → reports "0 tests" but exit 0; that's fine until Step 4).

### Step 4: Write `test/lib.test.mjs`

Create `test/lib.test.mjs` using `node:test` + `node:assert/strict`. Cover these cases (this is the regression net for the pure core):

- **`asString`**: backslash and double-quote are escaped; a clean string is unchanged; empty string returns empty.
- **`tabRef`**: `tabRef(2)` → `"tab 2 of window 1"`; `tabRef()` (undefined) → `"active tab of window 1"`; **`tabRef(0)` → `"active tab of window 1"`** (0 is falsy → active branch); `tabRef(-3)` → `"tab 1 of window 1"` (truthy -3, clamped to 1); `tabRef("5")` → `"tab 5 of window 1"` (coerced).
- **`defaultPort`**: `'https:'` → `'443'`; `'http:'` → `'80'`; anything else → `''`.
- **`urlsMatch`** (the highest-value tests — these guard the #7 fix's navigation-identity logic):
  - same URL → `true`
  - hash differs only → `true` (hash ignored)
  - **trailing slash differs (`/a` vs `/a/`) → `false`** (the function does NOT strip trailing slashes; it only normalizes empty pathname to `/` — this is the actual behavior, do not "fix" it)
  - host case differs (`Example.com` vs `example.com`) → `true`
  - default port explicit vs implicit (`https://a.com:443/x` vs `https://a.com/x`) → `true`
  - different path → `false`
  - different query → `false`
  - different host → `false`
  - different protocol → `false`
  - **non-parseable input → `false`** (the safe default that forces the different-URL guard): `urlsMatch('not a url', 'https://a.com')` → `false`; `urlsMatch('', '')` → `false`.
- **`humanPath`**: returns `steps + 1` points; endpoints are `[x0,y0]` and `[x1,y1]` (rounded); `steps=0` is clamped to 1 (returns 2 points); degenerate same-point input (`x0==x1 && y0==y1`) returns without throwing. (Does NOT assert exact intermediate coords — `Math.random` makes them non-deterministic; assert structural properties only.)

Pattern to follow (Node built-in test runner):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { asString, tabRef, defaultPort, urlsMatch, humanPath } from '../lib.js';

test('urlsMatch ignores hash, host case, default ports', () => {
  assert.equal(urlsMatch('https://a.com/x', 'https://a.com/x#frag'), true);
  assert.equal(urlsMatch('https://Example.COM/x', 'https://example.com/x'), true);
  assert.equal(urlsMatch('https://a.com:443/x', 'https://a.com/x'), true);
});
test('urlsMatch does NOT strip trailing slash (actual behavior)', () => {
  assert.equal(urlsMatch('https://a.com/x', 'https://a.com/x/'), false);
});
test('urlsMatch returns false (safe) for unparseable input', () => {
  assert.equal(urlsMatch('not a url', 'https://a.com'), false);
  assert.equal(urlsMatch('', ''), false);
});
// ... cover the rest per the list above
```

**Verify**: `pnpm test` → all tests pass, count ≥ ~15.

## Test plan

The tests ARE the deliverable (Step 4). Acceptance is `pnpm test` green. Additionally, after Step 2, run `pnpm start` and hit `/health` once with a bearer token to confirm the import didn't break the running server:

```bash
source .env 2>/dev/null
curl -s -H "Authorization: Bearer $BRIDGE_TOKEN" "http://127.0.0.1:${PORT:-8765}/health"
# → {"ok":true,"data":{"browser":"<configured BROWSER, e.g. Google Chrome>"}}
```

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `lib.js` exists and `node --check lib.js` exits 0.
- [ ] `grep -n "function asString\|function tabRef\|function defaultPort\|function urlsMatch\|function humanPath" server.js` returns **no matches**.
- [ ] `grep -n "from './lib.js'" server.js` returns one match importing all 5.
- [ ] `lib.js` contains **no** `import`/`require`, and (reviewer criterion) **no** access to `process`, `Date`, `globalThis`, no subprocess/file/network calls, and no module-scope side effects. `Math.random` in `humanPath` is the one allowed exception (side-effect-free, non-deterministic). A reviewer reads the file to confirm this; the grep is a guard, not the full check.
- [ ] `pnpm check` exits 0.
- [ ] `pnpm test` exits 0 with ≥ ~15 assertions across all 5 helpers (node:test reports `test()` blocks, not individual `assert` calls — count assertions in the test file; the `urlsMatch` safe-default case must be covered).
- [ ] `pnpm start` boots; `/health` returns `{"ok":true,...}`.
- [ ] `git status` shows changes only to `server.js`, `package.json`, and new files `lib.js`, `test/lib.test.mjs`; nothing else.

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the cited locations doesn't match the excerpts (drift since `3bb254c`).
- Any of the 5 functions is NOT actually side-effect-free (e.g. `humanPath` is found to write a global, or `urlsMatch` logs to console) — then moving it changes behavior; STOP and report rather than moving an impure function. (`humanPath` using `Math.random` is expected and allowed.)
- `server.js` fails to boot after the import swap (`pnpm start` errors) — do not paper over by re-inlining the helpers; report the import issue.
- You are tempted to move any impure helper (anything that calls `osa`, `exec`, `chromeEval`, `mkdtemp`, `swiftRun`, or touches `app`/`reply`) — those stay in `server.js`.
- `node:test` is not available in the target Node version (the repo requires Node 18+; if `node --test` errors with "bad option", STOP and report — a polyfill or dep is out of scope).

## Maintenance notes

- **`lib.js` stays side-effect-free-only.** Future plans (003, 005) may add MORE side-effect-free functions here (e.g. a `viewportOrigin` helper for 005) but must not move impure helpers in. `Math.random` is allowed (non-deterministic but side-effect-free); `process`/`Date`/I/O are not. If someone wants to move `waitForNavigationReady`'s logic here, that's a separate decision — it calls `chromeReadyState` (I/O) and doesn't belong.
- **003 (`/wait-for-ready`) depends on this plan** for the `pnpm check`/`pnpm test` scripts and the `lib.js` import layout (it reuses `urlsMatch` via the import). It does not necessarily add new unit tests (003's logic is impure and hand-tested); the dependency is on the baseline scripts and the extracted `lib.js`.
- **`humanPath` uses `Math.random`** — tests assert structure, not exact coordinates. If a future change makes the path deterministic, tighten the tests then; don't over-constrain now.
- **Reviewer should scrutinize:** (1) the 5 moved functions are byte-identical to their `server.js` originals (no behavior drift); (2) `lib.js` has zero non-stdlib imports; (3) the `test` script actually runs (not a no-op); (4) no route or impure helper was touched.
