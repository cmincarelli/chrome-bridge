# chrome-bridge

A small HTTP server that drives Google Chrome on macOS via AppleScript. Lets you
navigate, evaluate JavaScript, click, type, scroll, screenshot, and inspect tabs
over a token-protected REST API.

Useful when you want scripted control of a real, signed-in Chrome session (with
your cookies, extensions, and profile) instead of an isolated Puppeteer/Playwright
browser.

## Requirements

- macOS
- Google Chrome (or another Chrome-compatible app — set `BROWSER` to its app name)
- Node 18+
- pnpm

In Chrome, enable **View → Developer → Allow JavaScript from Apple Events**.
Without it, the `execute javascript` AppleScript command silently fails.

## Setup

```sh
pnpm install
cp .env.example .env
# Generate a token:
openssl rand -hex 32
# Paste it into BRIDGE_TOKEN in .env, then:
pnpm start
```

## Configuration

All via `.env`:

| Var            | Default          | Notes                                                        |
| -------------- | ---------------- | ------------------------------------------------------------ |
| `PORT`         | `8765`           |                                                              |
| `HOST`         | `127.0.0.1`      | Bind address. See **Network exposure** below.                |
| `BROWSER`      | `Google Chrome`  | App name passed to AppleScript (`tell application "..."`).   |
| `BRIDGE_TOKEN` | *(required)*     | Bearer token. Generate with `openssl rand -hex 32`.          |

### Network exposure

`HOST` controls which network interfaces the server listens on:

- `127.0.0.1` — localhost only (safest).
- *(your Tailscale IP)* — reachable from your tailnet only.
- `0.0.0.0` — every interface, including public Wi-Fi. Don't.

Because `/eval` runs arbitrary JavaScript in your logged-in Chrome session,
treat the bearer token like a root password.

## API

Interactive docs at **`http://<host>:<port>/docs`** (Swagger UI, no auth required
for the docs themselves).

All other endpoints require `Authorization: Bearer <BRIDGE_TOKEN>`.

Quick reference:

| Method | Path                 | Purpose                                       |
| ------ | -------------------- | --------------------------------------------- |
| GET    | `/health`            | Liveness check                                |
| POST   | `/navigate`          | Navigate to URL (optionally wait for ready)   |
| GET    | `/ready-state`       | `document.readyState`                         |
| POST   | `/wait-for-ready`    | Poll until `readyState === 'complete'`        |
| GET    | `/url`               | Tab URL                                       |
| GET    | `/state`             | URL, title, scroll position, viewport         |
| GET    | `/inner-text`        | `document.body.innerText`                     |
| POST   | `/eval`              | Run arbitrary JS in the tab                   |
| POST   | `/click`             | Click by CSS selector                         |
| POST   | `/focus`             | Focus an element                              |
| POST   | `/type`              | Set value of input/textarea                   |
| POST   | `/select`            | Set `<select>` value                          |
| POST   | `/scroll`            | Scroll to coords or scroll element into view  |
| POST   | `/scroll-down`       | Scroll down N times (for infinite feeds)     |
| POST   | `/hover`             | Dispatch `mouseover`/`mouseenter`             |
| POST   | `/key`               | Dispatch `keydown`/`keyup`                    |
| POST   | `/get-html`          | `outerHTML` of selector, or `body.innerHTML` |
| POST   | `/wait-for-selector` | Poll until selector matches                   |
| GET    | `/tabs`              | List all tabs across all windows              |
| POST   | `/new-tab`           | Open a new tab                                |
| POST   | `/switch-tab`        | Activate a tab in window 1 by index           |
| POST   | `/ensure-window`     | Activate Chrome, create window/tab if needed |
| GET    | `/screenshot`        | PNG of the viewport, base64-encoded           |
| POST   | `/batch`             | Run a sequence of endpoint calls with pause   |

## Examples

```sh
TOKEN="$(grep ^BRIDGE_TOKEN .env | cut -d= -f2)"
HOST="$(grep ^HOST .env | cut -d= -f2)"
PORT="$(grep ^PORT .env | cut -d= -f2)"
URL="http://$HOST:$PORT"

# Navigate and wait for load
curl -sX POST "$URL/navigate" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","wait":true}'

# Collect every link on the page
curl -sX POST "$URL/eval" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"js":"JSON.stringify([...document.querySelectorAll(\"a\")].map(a=>a.href))"}'

# Screenshot the viewport
curl -s "$URL/screenshot" \
  -H "Authorization: Bearer $TOKEN" \
  | jq -r .image | base64 -d > /tmp/page.png

# Batch: navigate, wait, scroll, screenshot — with a 300ms pause between steps
curl -sX POST "$URL/batch" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "pauseBetween": 300,
    "batch": [
      { "func": "/navigate",   "data": { "url": "https://example.com", "wait": true } },
      { "func": "/scroll-down", "data": { "times": 2 } },
      { "func": "/screenshot",  "method": "GET" }
    ]
  }'
```

## Security

- Token is compared in constant time (`crypto.timingSafeEqual`).
- Rate-limited to 120 req/min per IP.
- Error responses don't leak internal messages; details are written to the server log.
- The token gates every endpoint except `/docs`.

If `BRIDGE_TOKEN` ever leaks, rotate it immediately and restart the server.

## Limitations

- macOS only. AppleScript-based; won't run on Linux or Windows.
- Some endpoints (`/new-tab`, `/switch-tab`) assume window 1. Multi-window
  workflows work for reads (`/tabs` walks every window) but writes target the
  frontmost window.
- `/screenshot` captures the OS-level viewport rectangle. The Chrome window
  must be visible; minimized or fully-occluded windows won't produce a useful image.
