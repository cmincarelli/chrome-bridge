# Project Agent

**Workspace Path:** `/Users/chrism/Projects/github/cmincarelli/chrome-bridge`
*(Note to Pi: Your file write/edit tools run in a different directory by default. You MUST use absolute paths starting with the Workspace Path above for ALL file operations!)*

<!-- Pi: before writing anything, explore this project:
  1. Read package.json / pyproject.toml / Cargo.toml / go.mod — identify stack and versions
  2. Scan directory structure: rg --files | head -60
  3. Read 3-5 key source files to understand patterns and conventions
  4. Check for .cursorrules, CLAUDE.md, .eslintrc, prettier.config — existing AI/style config
  Then fill in each section below based on what you actually find.
  Adapt or add sections if the project has unique needs.
-->

**Generated:** 2026-07-07

## Stack
- **Runtime:** Node.js 18+ (ES modules — `"type": "module"`), pnpm 10.33.0 as package manager.
- **HTTP framework:** Fastify 5.8.5 with plugins `@fastify/cors` (11.2), `@fastify/rate-limit` (10.3, 120 req/min per IP), `@fastify/swagger` (9.7) + `@fastify/swagger-ui` (5.2.6, served at `/docs`).
- **Config:** `dotenv` 17.4 (`.env` → `PORT`, `HOST`, `BROWSER`, `BRIDGE_TOKEN`).
- **Native execution surface:** `osascript` (AppleScript → Chrome), `swift` (CoreGraphics CGEvents for OS-level cursor/keyboard — avoids Accessibility-permission needs of System Events), `screencapture` (viewport PNG capture). macOS-only by design.
- **Python:** `sample-ollama-tool.py` is a standalone reference client (Ollama tool wrapper), not part of the server.

## Structure
- `server.js` — **the entire application.** Single-file Fastify app: config, helpers, all routes, boot. ~1400 lines. No build step, no test runner.
- `package.json` / `pnpm-lock.yaml` — deps and lockfile; only `start` script (`node server.js`).
- `.env` / `.env.example` — runtime config (committed example only; real `.env` is gitignored).
- `README.md` — full user-facing docs (setup, config, endpoint table, examples, security).
- `CLAUDE.md` — prior agent guidance (architecture + security conventions); read it, it's accurate.
- `NOTES.md` — scratchbook of useful `/eval` JS snippets (link/image scraping, social filtering).
- `sample-ollama-tool.py` — example Ollama tool-calling client exercising the API.
- `docs/superpowers/specs/` and `docs/superpowers/plans/` — design specs + implementation plans for larger features (human mouse-move, resize-window). Treat these as the canonical reference for the OS-level input features.
- `.claude/settings.local.json` — pre-approved Claude Code bash permissions only; no style rules.

## Commands
| Action  | Command |
|---------|---------|
| Install | `pnpm install` |
| Build   | *(none — no build step)* |
| Test    | *(none — `pnpm test` is the default no-op stub)* |
| Run     | `pnpm start` (reads `.env`, listens on `http://$HOST:$PORT`, Swagger at `/docs`) |

Generate a token before first run: `openssl rand -hex 32`.

## Conventions
- **Single file.** All server logic lives in `server.js`; don't split into modules without strong reason.
- **Three execution helpers, each with a specific job:**
  - `osa(script, timeoutMs)` — inline AppleScript via `osascript -e`. For short Chrome commands. Any user string interpolated into the script **must** go through `asString()` (escapes `\` and `"`).
  - `chromeEval(js, timeoutMs, tab)` — arbitrary JS inside a Chrome tab. Writes JS to a tempfile and reads it back via AppleScript to dodge nested-quote hell. Use this whenever the JS contains user input or is non-trivial.
  - `swiftRun(code, timeoutMs)` — runs Swift/CoreGraphics from a tempfile for OS-level cursor movement and keypresses (CGEvents). Avoids the Accessibility permission that System Events requires.
- **Uniform response envelope** (`ok()` / `sendError()` / `jsResult()` helpers): every route returns `{ ok: true, data: ... }` on success (200) and `{ ok: false, error: '...', ...extra }` on failure (4xx/5xx). `fail()` is the catch-all for thrown errors. JS-computed endpoints (`/click`, `/focus`, `/select`, `/scroll`, `/hover`, `/wait-for-selector`) return `{ ok, ...fields }` from the page; `jsResult()` maps an inner `ok:false` (e.g. "element not found") to 422. `/eval` puts the JS return value (any type) directly in `data`, so responses are always valid JSON. Don't return bare values or ad-hoc shapes from handlers.
- **Tab targeting:** `tabRef(tab)` → `"tab N of window 1"` (numeric, clamped with `Math.max(1, Number(tab))` to block AppleScript injection) or `"active tab of window 1"` when omitted. **All writes target window 1.** `/tabs` is the only multi-window reader.
- **Every route declares a `schema`** (summary + body/response JSON schema). These populate Swagger UI at `/docs`. New undocumented routes show up but are un-described.
- **Errors go through `fail(req, reply, err)`** (now returns `{ ok:false, error:'internal error' }`). It logs the real error server-side (`req.log.error`) and returns `{ ok: false, error: 'internal error' }` (HTTP 500) to clients — **never** leak `err.message`. Special-case: AppleScript error `-1719` (no window) returns 409 with a hint to call `/ensure-window` or `/navigate` first.
- **Auth:** `preHandler` hook checks `Authorization: Bearer <BRIDGE_TOKEN>` with `crypto.timingSafeEqual` (length-checked first). `/docs` and `/docs/*` are exempt. Runs after rate-limit.
- **`/batch`** runs a sequence of internal calls via `app.inject()`, forwarding the caller's `Authorization` header so each step re-runs auth/rate-limit/schema/validation. Method defaults to POST when `data` is present, else GET. Recursive `/batch` is rejected. Don't add bypass logic.
- **Style:** plain JS, no TypeScript, no linter/formatter config. 2-space indent, double quotes, ES module syntax. Helpers are module-level `async function`s; routes are `app.get`/`app.post` with the schema object as the second arg.

## Key Files
- `server.js` — the app. Sections: config → `osa`/`asString`/`tabRef` helpers → Chrome helpers (`chromeNavigate`, `chromeEval`, `chromeReadyState`, `chromeInnerText`, `screenshotViewport`, `ensureWindow`) → OS-input helpers (`humanPath`, `humanMouseMoveToScreen`, `humanMouseMove`, `osTypeText`, `osKeyPress`, key maps) → Fastify setup (cors, rate-limit, swagger, auth hook) → routes → boot.
- `README.md` — authoritative endpoint table and security notes; keep it in sync when adding routes.
- `CLAUDE.md` — concise architecture/convention summary that predates this file; consistent with current code.
- `.env.example` — documents all config vars and the `HOST` exposure tradeoffs.
- `docs/superpowers/specs/2026-05-17-human-mouse-move-design.md` + `docs/superpowers/plans/2026-05-17-human-mouse-move.md` — design/plan for the human-like mouse-move (`humanPath`, `humanMouseMove`, `swiftRun`/CGEvent) feature.
- `docs/superpowers/specs/2026-05-19-resize-window-design.md` — spec for `POST /resize-window`.
- `sample-ollama-tool.py` — reference client showing the call patterns (auth header, batch, eval).
- `NOTES.md` — reusable `/eval` snippets for scraping links/images/socials.

## What to Avoid
- **Don't interpolate user input into AppleScript without `asString()`, `Number()`, or `JSON.stringify()`.** AppleScript injection is the primary attack surface; the helpers exist for this. `tabRef` clamps with `Number()`/`Math.max` on purpose — preserve that.
- **Don't return `err.message` to clients** or add per-route try/catch that surfaces detail. Route errors should propagate to `fail()`. Only add a new special-case branch (like the `-1719` → 409 mapping) if there's a genuinely distinct, client-actionable condition.
- **Don't add a route without a `schema`.** Undocumented routes are visible-but-raw in `/docs` and skip the validation that the rest of the API relies on.
- **Don't bypass auth/rate-limit for `/batch`.** It works by re-injecting through the full lifecycle on purpose; "optimize" it by skipping checks and you open a hole.
- **Don't add multi-window write support casually.** Every write targets window 1 by convention; changing that ripples through `tabRef`, `/navigate`, `/new-tab`, `/switch-tab`, screenshots, etc.
- **`HOST=0.0.0.0` is the intended default** so the bridge is reachable over Tailscale and other local machines. Don't change it to `127.0.0.1` to "be safe" — but remember that `/eval` runs arbitrary JS in the signed-in Chrome session, so the token is effectively a root password for that session. Treat `BRIDGE_TOKEN` accordingly and rotate it if it leaks.
- **No build/test/lint to lean on.** There's no compiler or test suite to catch mistakes — verify changes by running the server and hitting endpoints (or `/docs`).
- **Chrome prerequisite:** `View → Developer → Allow JavaScript from Apple Events` must be enabled, or `execute javascript` silently no-ops and `chromeEval` returns empty strings.

## Notes
- **Existing AI config:** `CLAUDE.md` (Claude Code) is accurate and worth reading first; `.claude/settings.local.json` only whitelists `git add *` / `git commit`. There is no `.cursorrules`, `.eslintrc`, or prettier config.
- **`HOST` default is intentional:** `server.js` defaults to `0.0.0.0` when `HOST` is unset (chosen over `127.0.0.1` deliberately so the bridge is reachable via Tailscale and other local machines). README.md/`.env.example`/`CLAUDE.md` describe `127.0.0.1` as the safe default — that framing is more conservative than the owner's actual preference. Treat `0.0.0.0` as correct and don't change it.
- **OS-level input lives outside Chrome.** `/type` and `/key` use Swift CGEvents at the OS level (not `chromeEval`), so they type into whatever has focus — recent commits deliberately removed selector/`clear` params from `/type` because `Cmd+A` at the OS level interfered with Chrome. The human mouse-move (`humanMouseMove`, `humanMouseMoveToScreen`) also uses CoreGraphics, not AppleScript clicks.
- **Screenshot geometry:** `screenshotViewport` computes the viewport rect from `window.screenX/outerWidth/innerWidth` etc. and calls `screencapture -R`. The Chrome window must be visible (minimized/occluded → useless image). Returns base64 PNG + width/height/dpr.
- **No tests, no CI.** Verify by hand: `pnpm start`, then `curl` against `http://$HOST:$PORT` with the bearer token, or browse `/docs`.
- **Secrets hygiene:** `.env` is gitignored and contains the live `BRIDGE_TOKEN`. Never print it or commit it. If it leaks, rotate (`openssl rand -hex 32`) and restart.
