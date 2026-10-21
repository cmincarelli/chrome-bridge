# Navigation Pace Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an additive `pace` object to every `POST /navigate` response — rolling navigation counters (global + per-host), `suggested_wait_seconds`, and an imperative `warning` string when pace exceeds policy. Feedback only: nothing is rejected or delayed.

**Spec:** `docs/superpowers/specs/2026-10-21-navigate-pace-feedback-design.md` — read it first. It defines the field semantics, policy constants, and exact warning wording.

**Architecture:** A module-level in-memory sliding-window log (`navHistory`) plus a `recordNavigation(url)` helper that records the current navigation and returns the `pace` object. The `/navigate` handler calls it after `chromeNavigate` succeeds and merges the result into both success responses. `/batch` coverage is automatic (it re-injects through the full route lifecycle).

**Tech Stack:** Node.js, Fastify. No new dependencies.

---

### Task 1: Add pace-tracking state and `recordNavigation` helper

**Files:**
- Modify: `server.js` — insert after the `tabRef` helper (before the Chrome helpers block)

- [ ] **Step 1: Insert the pace tracker**

```js
// Navigation pace tracking — feedback only, never blocks. In-memory sliding
// window; resets on restart (acceptable for a single-user bridge).
const PACE_MIN_INTERVAL_S = 2;
const PACE_WARN_PER_MINUTE = 10;
const PACE_WARN_HOST_PER_MINUTE = 6;
const PACE_WARN_WAIT_S = 30;
const PACE_WINDOW_MS = 10 * 60_000;
const navHistory = []; // [{ t: epochMs, host: string|null }]

// Records a navigation and returns the pace report for the response.
function recordNavigation(url) {
  const now = Date.now();
  let host = null;
  try {
    host = new URL(url).hostname;
  } catch {
    /* url is validated upstream; defensive only */
  }
  // prune entries outside the 10-minute window
  while (navHistory.length && now - navHistory[0].t > PACE_WINDOW_MS)
    navHistory.shift();
  const prev = navHistory.length ? navHistory[navHistory.length - 1] : null;
  navHistory.push({ t: now, host });
  const lastMinute = navHistory.filter((n) => now - n.t <= 60_000);
  const sameHost = host ? lastMinute.filter((n) => n.host === host).length : 0;
  const warn =
    lastMinute.length >= PACE_WARN_PER_MINUTE ||
    (host && sameHost >= PACE_WARN_HOST_PER_MINUTE);
  const suggested = warn ? PACE_WARN_WAIT_S : PACE_MIN_INTERVAL_S;
  const pace = {
    navigations_last_minute: lastMinute.length,
    navigations_last_10_minutes: navHistory.length,
    same_host_last_minute: sameHost,
    seconds_since_last_navigation: prev
      ? Math.round((now - prev.t) / 1000)
      : null,
    suggested_wait_seconds: suggested,
  };
  if (warn) {
    pace.warning =
      `${lastMinute.length} navigations in the last minute` +
      (host ? ` (${sameHost} to ${host})` : '') +
      ` — this pace risks bot-blocking. Wait at least ${suggested} seconds ` +
      `before your next navigation, and prefer /wait-for-ready or ` +
      `/wait-for-selector over repeated navigation to poll for changes.`;
  }
  return pace;
}
```

- [ ] **Step 2: Verify the server starts**

```bash
node --check server.js && pnpm start
```

Expected: starts cleanly, no syntax errors. Ctrl-C to stop.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add navigation pace tracker (recordNavigation helper)"
```

---

### Task 2: Wire `pace` into `/navigate` (handler + response schema)

**Files:**
- Modify: `server.js` — the `/navigate` route (handler **and** schema, together)

**Important:** Fastify's response serializer strips response fields not declared
in the schema. The handler and schema changes MUST land together or `pace`
silently disappears from responses.

- [ ] **Step 1: Update the response schema**

In the `/navigate` route's `schema.response.200.properties.data.properties`,
add alongside the existing `state`/`status`:

```js
pace: {
  type: 'object',
  properties: {
    navigations_last_minute: { type: 'integer' },
    navigations_last_10_minutes: { type: 'integer' },
    same_host_last_minute: { type: 'integer' },
    seconds_since_last_navigation: { type: ['integer', 'null'] },
    suggested_wait_seconds: { type: 'integer' },
    warning: { type: 'string' },
  },
},
```

- [ ] **Step 2: Update the handler**

After `await chromeNavigate(url, tab);` add:

```js
const pace = recordNavigation(url);
```

Then include it in both success returns:

```js
return ok({ state: result.state, ...(status ? { status } : {}), pace });
```

and

```js
return ok({ pace });
```

Recording happens after `chromeNavigate` so 400-validation failures and
AppleScript errors don't count — only real navigations generate site traffic.

- [ ] **Step 3: Update the route summary/description**

Extend the schema `summary` to mention pacing feedback, e.g.:

```js
summary:
  'Navigate to URL. Responses include a pace object with recent-navigation ' +
  'counters and suggested_wait_seconds — honor it, and stop navigating when ' +
  'pace.warning is present (bot-block risk).',
```

- [ ] **Step 4: Manual verification**

Start the server, then:

```bash
TOKEN="$(grep ^BRIDGE_TOKEN .env | cut -d= -f2)"
# First navigation: seconds_since_last_navigation should be null, suggested 2
curl -sX POST http://127.0.0.1:8765/navigate \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","wait":true}'
# Second navigation immediately: seconds_since_last_navigation small, count 2
curl -sX POST http://127.0.0.1:8765/navigate \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","wait":true}'
# Confirm pace appears in the OpenAPI spec
curl -s http://127.0.0.1:8765/docs/json | python3 -c \
  "import json,sys; d=json.load(sys.stdin); print('pace' in json.dumps(d['paths']['/navigate']))"
```

Expected: `pace` present in both responses with correct counters; `True` from
the docs check.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: /navigate returns pace feedback (counters, suggested wait, warning)"
```

---

### Task 3: Verify `/batch` coverage and warning trigger

**Files:** none (verification only)

- [ ] **Step 1: Confirm batched navigations are counted**

With the server running:

```bash
TOKEN="$(grep ^BRIDGE_TOKEN .env | cut -d= -f2)"
curl -sX POST http://127.0.0.1:8765/batch \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"batch":[{"func":"/navigate","data":{"url":"https://example.com"}},{"func":"/navigate","data":{"url":"https://example.org"}}]}'
```

Expected: each step's inner `body.data.pace` is present, and the second step's
`navigations_last_minute` includes the first step's navigation (proving
`/batch` steps flow through the counted handler).

- [ ] **Step 2: Confirm the warning path**

Fire 10 rapid navigations to the same host (a tight shell loop is fine here —
this is a local test against example.com, not a real target). On the 10th,
expect `pace.warning` present and `suggested_wait_seconds: 30`.

---

### Task 4: README sync

**Files:**
- Modify: `README.md` — endpoint table

- [ ] **Step 1: Update the `/navigate` row**

Append to its Purpose cell: "response includes `pace` feedback (counters,
`suggested_wait_seconds`, `warning`) — honor it to avoid bot-blocking".

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document /navigate pace feedback in endpoint table"
```
