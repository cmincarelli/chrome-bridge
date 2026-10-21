# Design: Navigation Pace Feedback (`pace` on `/navigate`)

**Date:** 2026-10-21
**Status:** Proposed

## Summary

Add an additive `pace` object to every `POST /navigate` response that reports
recent navigation activity (global and per-target-host), a suggested wait time
before the next navigation, and — when pace exceeds a conservative policy — an
imperative `warning` string that agents will read and heed.

This is a **feedback mechanism, not a throttle.** Nothing is rejected, delayed,
or rate-limited beyond the existing global 120 req/min HTTP limit. Well-behaved
agents self-regulate using the feedback; badly-behaved agents are unaffected
(no breakage).

## Motivation

The bridge drives a real, signed-in Chrome session. Websites bot-block per
*site*, based on the pace of requests hitting *them* — not on how fast HTTP
calls arrive at the bridge. The existing `@fastify/rate-limit` (120 req/min per
IP) throttles calls to the bridge and is meaningless here (all callers are
loopback/Tailscale, effectively one IP). `/navigate` is the heaviest
site-facing action and the natural place to surface pacing feedback.

## API Changes

### `POST /navigate`

Response `data` gains a `pace` object (present on both the `wait:true` and
fire-and-forget success paths):

```json
{
  "ok": true,
  "data": {
    "state": "complete",
    "status": 200,
    "pace": {
      "navigations_last_minute": 4,
      "navigations_last_10_minutes": 21,
      "same_host_last_minute": 2,
      "seconds_since_last_navigation": 7,
      "suggested_wait_seconds": 2
    }
  }
}
```

When the pace policy is exceeded, a `warning` string is added:

```json
{
  "ok": true,
  "data": {
    "pace": {
      "navigations_last_minute": 12,
      "navigations_last_10_minutes": 40,
      "same_host_last_minute": 8,
      "seconds_since_last_navigation": 1,
      "suggested_wait_seconds": 30,
      "warning": "12 navigations in the last minute (8 to example.com) — this pace risks bot-blocking. Wait at least 30 seconds before your next navigation, and prefer /wait-for-ready or /wait-for-selector over repeated navigation to poll for changes."
    }
  }
}
```

### Field semantics

| Field | Type | Description |
|-------|------|-------------|
| `navigations_last_minute` | integer | All navigations in the trailing 60s, **including this one** |
| `navigations_last_10_minutes` | integer | All navigations in the trailing 600s, including this one |
| `same_host_last_minute` | integer | Navigations to this URL's hostname in the trailing 60s, including this one |
| `seconds_since_last_navigation` | integer \| null | Gap between this navigation and the most recent *prior* one; `null` on the first navigation since server start |
| `suggested_wait_seconds` | integer | Minimum time the caller should wait before its next `/navigate` (see policy) |
| `warning` | string | **Optional.** Present only when the pace policy is exceeded. Imperative wording for agent consumers |

`/batch` steps that call `/navigate` automatically embed `pace` in each step's
inner response body — no `/batch` changes needed.

## Pace policy

Module-level constants:

| Constant | Value | Rationale |
|----------|-------|-----------|
| `PACE_MIN_INTERVAL_S` | `2` | Matches the "2–5s between actions" guidance in the OpenAPI description |
| `PACE_WARN_PER_MINUTE` | `10` | >10 navs/min globally is bot-like |
| `PACE_WARN_HOST_PER_MINUTE` | `6` | >6 navs/min to one host is the strongest block trigger |
| `PACE_WARN_WAIT_S` | `30` | Cooldown suggested while warning is active |

Rules, evaluated **after** recording the current navigation:

- `suggested_wait_seconds = PACE_MIN_INTERVAL_S` (2) in the normal case — the
  response returns ~0s after the navigation, so this is simply "wait at least
  the minimum interval before navigating again."
- If `navigations_last_minute >= PACE_WARN_PER_MINUTE` **or**
  `same_host_last_minute >= PACE_WARN_HOST_PER_MINUTE`:
  - `suggested_wait_seconds = PACE_WARN_WAIT_S` (30)
  - `warning` is included, naming the actual counts (global and, when relevant,
    per-host) and the suggested wait.

## Implementation

All in `server.js`.

### Helpers (module level, near the other Chrome helpers)

```js
// Navigation pace tracking — feedback only, never blocks. In-memory sliding
// window; resets on restart (acceptable for a single-user bridge).
const PACE_MIN_INTERVAL_S = 2;
const PACE_WARN_PER_MINUTE = 10;
const PACE_WARN_HOST_PER_MINUTE = 6;
const PACE_WARN_WAIT_S = 30;
const PACE_WINDOW_MS = 10 * 60_000;
const navHistory = []; // [{ t: epochMs, host: string|null }]

function recordNavigation(url) {
  const now = Date.now();
  let host = null;
  try { host = new URL(url).hostname; } catch { /* validated upstream; defensive */ }
  // prune entries outside the 10-minute window
  while (navHistory.length && now - navHistory[0].t > PACE_WINDOW_MS) navHistory.shift();
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
    seconds_since_last_navigation: prev ? Math.round((now - prev.t) / 1000) : null,
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

### `/navigate` handler

- After `await chromeNavigate(url, tab)` succeeds, call
  `const pace = recordNavigation(url);` and merge it into both success
  responses: `ok({ state, status?, pace })` and `ok({ pace })`.
- Recording after `chromeNavigate` (not before) means validation failures
  (400s) and AppleScript failures don't count — only actual navigations
  generate site traffic.
- Handler-level placement means `/batch` steps are counted automatically
  (`/batch` re-injects through the full route lifecycle via `app.inject()`).

### Schema

The `/navigate` response schema **must** gain the `pace` definition — Fastify's
response serializer strips fields not declared in the schema:

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

The route's `summary`/`description` should mention that responses include
pacing feedback and that agents should honor `suggested_wait_seconds` and stop
when `warning` is present.

## Error handling

- No new failure modes. `recordNavigation` is pure in-memory JS; it never
  throws into the request path (hostname parsing is defensively try/caught).
- A `pace` report is advisory only — it must never change the HTTP status or
  turn a successful navigation into an error.

## Constraints & non-goals

- **No hard throttling.** No 429s, no delayed/held requests. Rejection
  encourages agent retry loops — the opposite of the goal. If feedback proves
  insufficient later, the follow-up is per-host 429s with an agent-parseable
  `retry_after_seconds`, not silent delay.
- **In-memory only.** No persistence, no cross-process state. Counters reset on
  restart — acceptable; the window is 10 minutes and the bridge is
  single-user/single-process.
- **`/navigate` only, for now.** `/click`, `/type`, and `/eval` also generate
  site traffic, but navigation is the dominant block trigger and the endpoint
  agents already treat as "the expensive one." Extending `pace` to other
  endpoints is a possible follow-up.
- **Backwards compatible.** Additive field; existing clients ignore it.

## Docs to update

- `server.js` — route schema + summary/description (feeds `/docs` and
  `/docs/json` automatically).
- `README.md` — `/navigate` row in the endpoint table: note the `pace`
  feedback object.
