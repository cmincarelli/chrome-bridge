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

### `/batch`

`POST /batch` runs a sequence of internal endpoint calls via `app.inject()`.
Each step goes through the full request lifecycle (auth, rate-limit, schema
validation, `fail()`), so don't add bypass logic — forwarding the caller's
`Authorization` header is sufficient. Method defaults to `POST` if `data` is
present, else `GET`. Recursive `/batch` calls are rejected.

## Conventions

- **All user input that lands in AppleScript must go through `asString()`,
  `Number()`, or `JSON.stringify()`.** AppleScript injection is the main attack
  surface; the helpers exist for this reason.
- **Errors return `{ error: 'internal error' }` via `fail()`.** Do not surface
  `err.message` to clients — it leaks stderr/paths/internal state.
- **Every route declares a `schema`.** This is what populates Swagger UI at
  `/docs`. New routes without schemas are visible but un-documented.
- **Chrome must have *View → Developer → Allow JavaScript from Apple Events*
  enabled.** Without it, `execute javascript` silently no-ops and `chromeEval`
  returns empty strings.

## Security notes

- `BRIDGE_TOKEN` is effectively a root password for the user's Chrome session
  (since `/eval` runs arbitrary JS there). Treat it accordingly.
- `HOST` is whatever the user sets in `.env`. `127.0.0.1` is the safe default;
  a Tailscale IP scopes access to the tailnet; `0.0.0.0` exposes on every
  interface including public Wi-Fi. Don't change the default for them.
