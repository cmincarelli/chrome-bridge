# Human Mouse Move Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `human_move: true` option to `/hover` and `/click` that moves the real macOS cursor along a curved, noisy Bézier path to the target element before acting.

**Architecture:** Two new functions added to `server.js` above the route definitions — `humanPath` (pure math, returns waypoints) and `humanMouseMove` (gets coordinates, builds one AppleScript, calls `osa()`). Both `/hover` and `/click` accept new optional schema fields and call `humanMouseMove` when `human_move` is true.

**Tech Stack:** Node.js, Fastify, AppleScript (`System Events`), existing `osa()` and `chromeEval()` helpers.

---

### Task 1: Add `humanPath` — Bézier path generator

**Files:**
- Modify: `server.js` — insert after `chromeEval` function (after line 149)

- [ ] **Step 1: Insert `humanPath` after `chromeEval`**

Add this block immediately after the closing brace of `chromeEval` (after line 149):

```js
// Returns array of [x, y] screen-coordinate waypoints following a curved,
// noisy path from (x0,y0) to (x1,y1). steps controls resolution.
function humanPath(x0, y0, x1, y1, steps) {
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

- [ ] **Step 2: Verify server still starts**

```bash
pnpm start
```

Expected: server starts on port 8765, no syntax errors. Ctrl-C to stop.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add humanPath Bezier waypoint generator"
```

---

### Task 2: Add `humanMouseMove` — OS cursor mover

**Files:**
- Modify: `server.js` — insert immediately after `humanPath`

- [ ] **Step 1: Insert `humanMouseMove` after `humanPath`**

```js
async function humanMouseMove(selector, tab, moveMs = 800) {
  const ms = Math.max(200, Math.min(5000, moveMs));

  // Get target element's center in screen (logical) coordinates
  const coordsRaw = await chromeEval(`(function(){
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'null';
    const r = el.getBoundingClientRect();
    const vx = window.screenX + (window.outerWidth - window.innerWidth) / 2;
    const vy = window.screenY + (window.outerHeight - window.innerHeight)
               - (window.outerWidth - window.innerWidth) / 2;
    return JSON.stringify({ x: Math.round(vx + r.left + r.width / 2),
                            y: Math.round(vy + r.top  + r.height / 2) });
  })()`, DEFAULT_TIMEOUT_MS, tab);

  if (!coordsRaw || coordsRaw === 'null') return; // element not found — caller handles
  const { x: tx, y: ty } = JSON.parse(coordsRaw);

  // Get current cursor position from System Events ("x, y" string)
  const posRaw = await osa(`tell application "System Events" to get the position of the cursor`);
  const [sx, sy] = posRaw.split(',').map(Number);

  if (Math.hypot(tx - sx, ty - sy) < 5) return; // already on target

  const steps = Math.max(50, Math.min(120, Math.round(ms / 16)));
  const pts = humanPath(sx, sy, tx, ty, steps);
  const delayS = (ms / steps / 1000).toFixed(4);

  const moves = pts
    .map(([x, y]) => `  set the position of the cursor to {${x}, ${y}}\n  delay ${delayS}`)
    .join('\n');

  await osa(`tell application "System Events"\n${moves}\nend tell`, DEFAULT_TIMEOUT_MS);
}
```

- [ ] **Step 2: Verify server still starts**

```bash
pnpm start
```

Expected: starts cleanly. Ctrl-C.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add humanMouseMove OS cursor helper"
```

---

### Task 3: Wire `human_move` into `/hover`

**Files:**
- Modify: `server.js` — `/hover` route (~line 746)

- [ ] **Step 1: Add `human_move` and `move_ms` to `/hover` schema**

In the `/hover` route's `body` schema, add two fields inside `properties`:

```js
          human_move: {
            type: 'boolean',
            default: false,
            description: 'Move cursor to element in a human-like path before hovering',
          },
          move_ms: {
            type: 'integer',
            default: 800,
            minimum: 200,
            maximum: 5000,
            description: 'Total cursor move duration in ms (requires human_move: true)',
          },
```

- [ ] **Step 2: Extract new fields and call `humanMouseMove` in the handler**

Replace the handler's destructuring line:

```js
    const { selector, tab } = req.body || {};
```

with:

```js
    const { selector, tab, human_move = false, move_ms = 800 } = req.body || {};
```

Then, inside the `try` block, add `humanMouseMove` call **before** the `js` const:

```js
    try {
      if (human_move) await humanMouseMove(selector, tab, move_ms);
      const js = `(function(){
```

- [ ] **Step 3: Smoke-test `/hover` without `human_move`**

Start the server (`pnpm start`), then:

```bash
curl -s -X POST http://localhost:8765/hover \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"selector":"body"}' | jq .
```

Expected: `{"ok":true,"tag":"BODY","text":"..."}` (same as before the change).

- [ ] **Step 4: Smoke-test `/hover` with `human_move: true`**

With Chrome open to any page:

```bash
curl -s -X POST http://localhost:8765/hover \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"selector":"body","human_move":true,"move_ms":800}' | jq .
```

Expected: cursor visibly moves to the center of the Chrome viewport over ~800ms, then response returns `{"ok":true,...}`.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: add human_move option to /hover"
```

---

### Task 4: Wire `human_move` into `/click`

**Files:**
- Modify: `server.js` — `/click` route (~line 505)

- [ ] **Step 1: Add `human_move` and `move_ms` to `/click` schema**

In the `/click` route's `body` schema, add inside `properties`:

```js
          human_move: {
            type: 'boolean',
            default: false,
            description: 'Move cursor to element in a human-like path before clicking',
          },
          move_ms: {
            type: 'integer',
            default: 800,
            minimum: 200,
            maximum: 5000,
            description: 'Total cursor move duration in ms (requires human_move: true)',
          },
```

- [ ] **Step 2: Extract new fields and call `humanMouseMove` in the handler**

Replace:

```js
    const { selector, tab } = req.body || {};
```

with:

```js
    const { selector, tab, human_move = false, move_ms = 800 } = req.body || {};
```

Add the `humanMouseMove` call inside the `try` block **before** the `js` const:

```js
    try {
      if (human_move) await humanMouseMove(selector, tab, move_ms);
      const js = `(function(){
```

- [ ] **Step 3: Smoke-test `/click` without `human_move`**

```bash
curl -s -X POST http://localhost:8765/click \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"selector":"body"}' | jq .
```

Expected: `{"ok":true,"tag":"BODY",...}` — unchanged behaviour.

- [ ] **Step 4: Smoke-test `/click` with `human_move: true`**

With Chrome open to a page that has a visible link or button (e.g. navigate to `https://example.com` first):

```bash
curl -s -X POST http://localhost:8765/click \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"selector":"a","human_move":true,"move_ms":600}' | jq .
```

Expected: cursor visibly moves to the first link, then the click fires.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: add human_move option to /click"
```

---

### Task 5: Verify Swagger docs

**Files:**
- Read-only check: `http://localhost:8765/docs`

- [ ] **Step 1: Check Swagger UI shows new fields**

Start server, open `http://localhost:8765/docs` in a browser. Expand `POST /hover` and `POST /click`. Confirm `human_move` (boolean, default false) and `move_ms` (integer, 200–5000, default 800) appear in the request body schema for both routes.

- [ ] **Step 2: Final commit if any doc-only fixups were needed**

If no changes were needed, skip. Otherwise:

```bash
git add server.js
git commit -m "fix: correct swagger schema descriptions for human_move"
```
