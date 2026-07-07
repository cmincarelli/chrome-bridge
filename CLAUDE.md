# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `pnpm install` — install dependencies
- `pnpm start` — run the server (reads `.env`)
- API docs at `http://<HOST>:<PORT>/docs` once running (Swagger UI)

There is no build step, linter, or test runner configured.

## Architecture

Everything lives in `server.js`. It's a single-file Fastify app that turns HTTP
requests into AppleScript commands aimed at Google Chrome on macOS.

### Request flow

1. Fastify receives the request.
2. `@fastify/rate-limit` enforces 120 req/min per IP (runs before auth).
3. `preHandler` hook checks `Authorization: Bearer <BRIDGE_TOKEN>` using
   `crypto.timingSafeEqual`. `/docs` and `/docs/*` are exempt; everything else
   requires the token.
4. Route handler runs, typically dispatching to one of two helpers.
5. On error, `fail(req, reply, err)` logs the real error server-side and
   returns `{ error: 'internal error' }` — never leak `err.message` to clients.

### The two AppleScript helpers

- **`osa(script, timeoutMs)`** — runs an inline AppleScript via
  `execFile('osascript', ['-e', script])`. Used for short commands like
  `tell application "Google Chrome" to set URL of ...`. User-supplied strings
  must be escaped with `asString()` (escapes `\` and `"`).
- **`chromeEval(js, timeoutMs, tab)`** — runs arbitrary JavaScript inside a
  tab. Writes the JS to a tempfile and has AppleScript read it back, sidestepping
  AppleScript's nested-quoting nightmare. This is the right tool whenever the
  JS contains user input or anything non-trivial.

### Tab targeting

`tabRef(tab)` returns `"tab N of window 1"` for a numeric tab index, or
`"active tab of window 1"` when no tab is given. `Number(tab)` + `Math.max(1, ...)`
prevents AppleScript injection through this path. Multi-window writes are not
supported — `/new-tab`, `/switch-tab`, etc. always target window 1. `/tabs`
walks every window for reads.

### Response envelope

Every route returns a uniform envelope via the `ok(data)` / `sendError()` /
`jsResult()` helpers: `{ ok: true, data: ... }` on success (200),
`{ ok: false, error: '...', ...extra }` on failure (4xx/5xx). `fail()` is the
catch-all for thrown errors and always returns `{ ok: false, error: 'internal error' }`
(with a 409 special-case for the AppleScript `-1719` "no window" error). Don't
surface `err.message` to clients.

JS-computed endpoints (`/click`, `/focus`, `/select`, `/scroll`, `/hover`,
`/wait-for-selector`) return `{ ok, ...fields }` from the page; `jsResult()` turns
an inner `ok:false` (e.g. "element not found") into a 422 and wraps the rest in
`data`. `/eval` is special: `data` is the JS return value itself (any type), so
the response is always valid JSON regardless of return type.

### `/batch`

`POST /batch` runs a sequence of internal endpoint calls via `app.inject()`.
Each step goes through the full request lifecycle (auth, rate-limit, schema
validation, `fail()`), so don't add bypass logic — forwarding the caller's
`Authorization` header is sufficient. Method defaults to `POST` if `data` is
present, else `GET`. Recursive `/batch` calls are rejected. The response is
`{ ok: true, data: { results: [...] } }`; each result's `ok` reflects HTTP
success (status < 400) and its `body` is the inner endpoint's enveloped response.

## Conventions

- **All user input that lands in AppleScript must go through `asString()`,
  `Number()`, or `JSON.stringify()`.** AppleScript injection is the main attack
  surface; the helpers exist for this reason.
- **Every response uses the uniform envelope** `{ ok: bool, data?|error? }` via
  the `ok()` / `sendError()` / `jsResult()` helpers. Don't return bare values or
  ad-hoc shapes from route handlers.
- **Errors return `{ ok: false, error: 'internal error' }` via `fail()`.** Do not surface
  `err.message` to clients — it leaks stderr/paths/internal state.
- **Every route declares a `schema`.** This is what populates Swagger UI at
  `/docs`. New routes without schemas are visible but un-documented.
- **Chrome must have *View → Developer → Allow JavaScript from Apple Events*
  enabled.** Without it, `execute javascript` silently no-ops and `chromeEval`
  returns empty strings.

## Security notes

- `BRIDGE_TOKEN` is effectively a root password for the user's Chrome session
  (since `/eval` runs arbitrary JS there). Treat it accordingly.
- `HOST` defaults to `0.0.0.0` when unset (in `server.js`), chosen so the bridge is reachable over Tailscale and other local machines — don't change this. `127.0.0.1` scopes to localhost; a specific Tailscale IP scopes to the tailnet. Since `/eval` runs arbitrary JS in the logged-in Chrome session, treat the token as a root password and rotate it if it ever leaks.
