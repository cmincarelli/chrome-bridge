# Plan 005: Deduplicate the viewport→screen-coordinate math into one helper

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. The plans index (`plans/README.md`) is maintained
> by the operator/reviewer, not by you — do not edit it.
>
> **Drift check (run first)**: `git diff --stat 89f594c..HEAD -- server.js lib.js test/lib.test.mjs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/002-verification-baseline.md (reuses `lib.js` for the pure helper + `pnpm test`)
- **Category**: tech-debt
- **Planned at**: commit `89f594c`, 2026-07-08 (line numbers refreshed post-002/003/006; originally `3bb254c`)

## Why this matters

The math that converts a Chrome viewport coordinate to an OS screen coordinate is duplicated **four times** in `server.js`, copy-pasted with slight variations. If Chrome's chrome-vs-window metric changes (or a bug is found in the offset formula), a fix must be applied in four places in lockstep — easy to miss one (e.g. `screenshotViewport` computes the origin, while `/click` and `/hover` compute origin+target, and `humanMouseMove` computes origin+target differently). Consolidating into one pure helper (a JS expression string injected into `chromeEval` scripts) makes the formula single-sourced and unit-testable. Low effort, low risk, and it pays down the duplication flagged in the audit.

## Current state

The four duplicated sites in `server.js`:

1. **`screenshotViewport()`** (~lines 179–180) — computes the viewport **origin** (no +target):
   ```js
   const boundsScript = `
     JSON.stringify({
       x: window.screenX + (window.outerWidth - window.innerWidth) / 2,
       y: window.screenY + (window.outerHeight - window.innerHeight) - ((window.outerWidth - window.innerWidth) / 2),
       w: window.innerWidth,
       h: window.innerHeight,
       dpr: window.devicePixelRatio || 1
     })
   `;
   ```

2. **`humanMouseMove(selector, ...)`** (~lines 296–300) — computes origin + element center (`r.left + r.width/2`):
   ```js
   const vx = window.screenX + (window.outerWidth - window.innerWidth) / 2;
   const vy = window.screenY + (window.outerHeight - window.innerHeight)
              - (window.outerWidth - window.innerWidth) / 2;
   return JSON.stringify({ x: Math.round(vx + r.left + r.width / 2),
                           y: Math.round(vy + r.top  + r.height / 2) });
   ```

3. **`/click` coordinate branch** (~lines 957–958) — origin + `cx`/`cy`:
   ```js
   x: Math.round(window.screenX + (window.outerWidth - window.innerWidth) / 2 + ${cx}),
   y: Math.round(window.screenY + (window.outerHeight - window.innerHeight) - (window.outerWidth - window.innerWidth) / 2 + ${cy})
   ```

4. **`/hover` coordinate branch** (~lines 1337–1338) — identical to #3.

The shared formula (the **viewport origin** in screen coordinates):
```
originX = window.screenX + (window.outerWidth - window.innerWidth) / 2
originY = window.screenY + (window.outerHeight - window.innerHeight) - (window.outerWidth - window.innerWidth) / 2
```
Sites 2–4 add a viewport point (`cx`/`cy` or element-center) to the origin.

### Repo conventions to honor

- The dedup helper is a **JS expression string** injected into `chromeEval` scripts (the code runs in the page, so it must be a string, not a Node function). Keep it as a `const` in `lib.js` (it's pure data — a string literal with no Node I/O).
- `lib.js` stays side-effect-free-only (per plan 002's maintenance note); a string constant is side-effect-free.
- ES modules, 2-space indent, double quotes. Template literals for the JS string.
- Do not change the formula — this is a mechanical dedup, not a fix. The numbers must stay identical.

### Design: a `VIEWPORT_ORIGIN_FIELDS_JS` object-expression constant

The code runs **in the page**, so the helper is a **JS expression string** injected into `chromeEval` scripts — not a Node function. Define one constant for the **origin fields** (a JS object-expression, not stringified) so callers can spread it (`screenshotViewport`) or read its `.x`/`.y` (`humanMouseMove`), plus a small pure Node helper `viewportToScreenExpr(cx, cy)` that builds the "origin + point" JS string for the two coordinate routes. The Node helper is pure and unit-testable. Do **not** make the constant JSON-stringify — that forces the fragile string-splice in `screenshotViewport` (see Step 2).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|----------------------|
| Syntax check | `pnpm check` | exit 0 |
| Tests | `pnpm test` | all pass (incl. new helper tests) |
| Start server | `pnpm start` | boots, logs listen line |

## Scope

**In scope**:
- `lib.js` — add `VIEWPORT_ORIGIN_FIELDS_JS` (string constant) and `viewportToScreenExpr(cx, cy)` (side-effect-free string-builder).
- `server.js` — replace the 4 duplicated math sites with uses of the helpers. No other changes.
- `test/lib.test.mjs` — add unit tests for `viewportToScreenExpr`.

**Out of scope** (do NOT touch):
- The offset **formula** itself — this is dedup, not a fix. If the formula is wrong, that's a separate finding/plan.
- `screenshotViewport`'s `w`/`h`/`dpr` fields (those aren't part of the dedup).
- Any route logic, auth, `/batch`.
- Moving impure helpers into `lib.js`.

## Git workflow

- Branch: `refactor/viewport-screen-helper`.
- Commit message (match repo): `refactor: single-source the viewport→screen offset math`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the helpers to `lib.js`

Append to `lib.js` (these are the ONLY two exports this plan adds):

```js
// JS object expression (runs in the page) for the viewport top-left in screen
// coords. Single source of truth for the Chrome viewport→screen offset; injected
// into chromeEval scripts by screenshotViewport (spread), humanMouseMove (.x/.y),
// and via viewportToScreenExpr by /click and /hover. NOT a JSON string — it's an
// object-expression so callers can spread or read fields.
export const VIEWPORT_ORIGIN_FIELDS_JS = `{
  x: window.screenX + (window.outerWidth - window.innerWidth) / 2,
  y: window.screenY + (window.outerHeight - window.innerHeight) - ((window.outerWidth - window.innerWidth) / 2)
}`;

// Build the page JS for "origin + (cx, cy)" → { x, y } in screen coords.
// cx/cy are viewport coordinates (Node-side numbers). Returns a JS expression
// string that JSON.stringify's the result (so chromeEval gets a string back).
export function viewportToScreenExpr(cx, cy) {
  return `JSON.stringify({ x: Math.round((${VIEWPORT_ORIGIN_FIELDS_JS}).x + ${Number(cx)}), y: Math.round((${VIEWPORT_ORIGIN_FIELDS_JS}).y + ${Number(cy)}) })`;
}
```

Notes:
- `VIEWPORT_ORIGIN_FIELDS_JS` is an **object-expression** (`{ x: ..., y: ... }`), so `screenshotViewport` spreads it and `humanMouseMove` reads `(${...}).x`.
- `viewportToScreenExpr` reuses the same constant, so the formula is single-sourced in ONE place.
- `Number(cx)`/`Number(cy)` preserves numeric coercion (the routes already `Number(x)` before this; harmless on already-numbers).
- Do NOT create a `VIEWPORT_ORIGIN_JS` (JSON-stringifying) constant — it forces a fragile string-splice in `screenshotViewport`.

**Verify**: `node --check lib.js` → exit 0.

### Step 2: Use `VIEWPORT_ORIGIN_FIELDS_JS` in `screenshotViewport`

First, **update the existing `server.js` import from `./lib.js`** (~line 14) to include BOTH new exports alongside the existing five:
```js
import { asString, tabRef, defaultPort, urlsMatch, humanPath,
         VIEWPORT_ORIGIN_FIELDS_JS, viewportToScreenExpr } from './lib.js';
```
(Do not add a second import line — modify the existing one.)

In `server.js` `screenshotViewport` (~line 176, the math is at lines 179–180), replace the inline origin `x`/`y` in `boundsScript` by spreading the constant. The `w`/`h`/`dpr` fields stay inline (not part of the dedup):

```js
const boundsScript = `JSON.stringify({
  ...${VIEWPORT_ORIGIN_FIELDS_JS},
  w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1
})`;
```

(The import was updated in the Step 2 instructions above to include both `VIEWPORT_ORIGIN_FIELDS_JS` and `viewportToScreenExpr`.)

**Verify**: `node --check server.js && node --check lib.js` → exit 0. `pnpm start`, then `/screenshot` (Test plan) — must still return base64 PNG with the same width/height as before.

### Step 3: Use `viewportToScreenExpr` in `humanMouseMove`, `/click`, `/hover`

- **`humanMouseMove`** (~line 296): this site computes origin + **element center** (`r.left + r.width/2`), not `cx`/`cy`. **Do NOT use `viewportToScreenExpr` here** — the element center is computed in-page from `r` (the element rect), not a Node-side number. Instead, keep this site's in-page center computation but source the **origin** from the constant:
  ```js
  const coordsRaw = await chromeEval(`(function(){
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'null';
    const r = el.getBoundingClientRect();
    const o = ${VIEWPORT_ORIGIN_FIELDS_JS};
    return JSON.stringify({ x: Math.round(o.x + r.left + r.width / 2),
                            y: Math.round(o.y + r.top  + r.height / 2) });
  })()`, DEFAULT_TIMEOUT_MS, tab);
  ```
  This dedups the origin formula while keeping the in-page `r` math. (Do NOT force this site through `viewportToScreenExpr` — the center is in-page, not a Node-side number.)

- **`/click` coordinate branch** (~line 957) and **`/hover` coordinate branch** (~line 1337): these have Node-side `cx`/`cy`. Replace the inline `x: Math.round(window.screenX + ... + ${cx})` with:
  ```js
  const screenRaw = await chromeEval(viewportToScreenExpr(cx, cy), DEFAULT_TIMEOUT_MS, tab);
  ```
  (Remove the surrounding `JSON.stringify({...})` template since `viewportToScreenExpr` already returns a `JSON.stringify(...)` expression.)

**Verify**: `pnpm check` → exit 0. `pnpm start`, then run the Test plan (click/hover/screenshot).

### Step 4: Add unit tests for `viewportToScreenExpr`

In `test/lib.test.mjs`, add:

- `viewportToScreenExpr(100, 200)` returns a string containing `Math.round(`, `window.screenX`, `window.outerWidth`, `+ 100`, `+ 200` — i.e. it's a self-contained JS expression with the origin formula and the passed coords.
- `viewportToScreenExpr(0, 0)` contains `+ 0` for both axes.
- Non-numeric input is coerced: `viewportToScreenExpr("50", "60")` contains `+ 50` and `+ 60` (via `Number()`).
- `VIEWPORT_ORIGIN_FIELDS_JS` contains `window.screenX`, `window.outerWidth - window.innerWidth`, and the `y` formula with `outerHeight`.
- `VIEWPORT_ORIGIN_FIELDS_JS` is an object-expression (not JSON): it does NOT contain `JSON.stringify`.

(These assert the **shape** of the generated JS, since evaluating it needs a browser. The route-level Test plan covers actual execution.)

**Verify**: `pnpm test` → all pass, incl. the new tests.

## Test plan

Run against a live server (Chrome with `Allow JavaScript from Apple Events`):

1. **`/screenshot` unchanged.**
   ```bash
   source .env 2>/dev/null; B="http://127.0.0.1:${PORT:-8765}"; T="Authorization: Bearer $BRIDGE_TOKEN"; CT="Content-Type: application/json"
   curl -s -H "$T" "$B/screenshot" | python3 -c 'import sys,json; d=json.load(sys.stdin)["data"]; print("w",d["width"],"h",d["height"],"len",len(d["image"]))'
   ```
   **Expected**: a valid base64 PNG (non-empty `image`), sensible `width`/`height`. Compare to the pre-change output — should be identical for the same window size.

2. **`/click {x,y, human_move:true}` still clicks the right element** (the deduped `viewportToScreenExpr` only runs in the coord branch when `human_move` is true — without it, the route uses `document.elementFromPoint` and skips the screen math). On `https://example.com`:
   ```bash
   curl -s -H "$T" -H "$CT" -d '{"url":"https://example.com","wait":true}' "$B/navigate" >/dev/null
   curl -s -H "$T" -H "$CT" -d '{"x":400,"y":300,"human_move":true,"move_ms":300}' "$B/click"
   ```
   **Expected**: `{"ok":true,"data":{"tag":"A","text":"More information..."}}` (or similar); the OS cursor visibly moved to the link. (Adjust coords if layout differs; the assertion is the click hits the element at the intended viewport location via the deduped path.)

3. **`/hover {x,y, human_move:true}` still hovers** (same `human_move` requirement — the coord screen-math only runs with it):
   ```bash
   curl -s -H "$T" -H "$CT" -d '{"x":400,"y":300,"human_move":true,"move_ms":300}' "$B/hover"
   ```
   **Expected**: `{"ok":true,...}` with a `tag` matching the element at those coords.

4. **`/click {selector, human_move:true}` still moves and clicks** (exercises `humanMouseMove` — the constant-spread path).
   ```bash
   curl -s -H "$T" -H "$CT" -d '{"selector":"a","human_move":true,"move_ms":300}' "$B/click"
   ```
   **Expected**: `{"ok":true,"data":{"tag":"A",...}}`; the OS cursor visibly moved to the link.

5. **Tests pass.** `pnpm test` → green.

If tests 1–4 match pre-change behavior and 5 is green, the dedup is correct.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm check` exits 0.
- [ ] `pnpm test` exits 0; new tests for `viewportToScreenExpr` and `VIEWPORT_ORIGIN_FIELDS_JS` exist and pass.
- [ ] `grep -nE "window.screenX \+ \(window.outerWidth - window.innerWidth\)" server.js` returns **no matches** (the formula no longer appears inline in server.js — it lives in `lib.js`).
- [ ] `grep -n "VIEWPORT_ORIGIN_FIELDS_JS\|viewportToScreenExpr" server.js` shows usages in `screenshotViewport`, `humanMouseMove`, `/click`, `/hover` (4 sites, or 3 if `humanMouseMove` uses the constant and the other two use the function — both are fine).
- [ ] `grep -n "VIEWPORT_ORIGIN_FIELDS_JS\|viewportToScreenExpr" lib.js` shows the definitions.
- [ ] Test plan: `/screenshot` returns a valid PNG; `/click`/`/hover` by coords hit the right element; `/click` with `human_move` works.
- [ ] `git status` shows changes only to `lib.js`, `server.js`, `test/lib.test.mjs`.

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 002 is not DONE (`lib.js`/`pnpm test` don't exist) — this plan depends on it.
- The code at the four cited sites doesn't match the excerpts (drift since `89f594c`), or a 5th duplicated site is found — report so scope can be adjusted.
- The formula is actually **different** at one of the sites (e.g. a sign flip) — then this isn't pure dedup and a behavior change would result; STOP and report (the plan is dedup-only, not a formula fix).
- `screenshotViewport` can't cleanly use the object-expression form (e.g. JSON nesting issues) — report rather than inventing an alternate string-splice approach.
- A route's behavior changes in the Test plan (click/hover hits the wrong element, screenshot dims change) — the dedup altered the formula; revert and report.

## Maintenance notes

- **The offset formula is now single-sourced** in `VIEWPORT_ORIGIN_FIELDS_JS`. If Chrome's chrome-metric changes, update one constant. If a future route needs the origin, import it instead of re-deriving.
- **`viewportToScreenExpr` is a string-builder, not a function that runs the math** — the math runs in the page. Don't be tempted to "simplify" by computing coords in Node; the page's `window.*` values are only available in-page.
- **`humanMouseMove` keeps in-page center math** (`r.left + r.width/2`) because the element rect is only available in-page. This is the right boundary — only the **origin** is deduped there, not the center.
- **A 5th site or a formula divergence** would be a new finding — record it; don't expand this plan's scope.
- **Reviewer should scrutinize:** (1) the formula is byte-identical (no sign flips, no `outerWidth`/`outerHeight` mix-ups); (2) `screenshotViewport`'s `w`/`h`/`dpr` are untouched; (3) all 4 sites are updated (no orphaned inline copy); (4) tests assert the generated JS shape; (5) no route logic changed.
