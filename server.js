import 'dotenv/config';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import rateLimit from '@fastify/rate-limit';
import cors from '@fastify/cors';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { asString, tabRef, defaultPort, urlsMatch, humanPath,
         VIEWPORT_ORIGIN_FIELDS_JS, viewportToScreenExpr } from './lib.js';

const exec = promisify(execFile);

// ─── config ──────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '8765', 10);
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN = process.env.BRIDGE_TOKEN;
const BROWSER = process.env.BROWSER || 'Google Chrome';
const DEFAULT_TIMEOUT_MS = 30_000;
const TLS_CERT = process.env.TLS_CERT; // path to PEM cert file
const TLS_KEY = process.env.TLS_KEY;   // path to PEM key file
const USE_TLS = Boolean(TLS_CERT && TLS_KEY);
// Fail fast if only one of TLS_CERT/TLS_KEY is set (otherwise USE_TLS would
// silently be false and the server would serve cleartext HTTP while the
// operator thinks TLS is on).
if (Boolean(TLS_CERT) !== Boolean(TLS_KEY)) {
  console.error('FATAL: TLS_CERT and TLS_KEY must be set together (both PEM file paths, or neither)');
  process.exit(1);
}

// Auth is required on any non-loopback bind (the default 0.0.0.0 exposes LAN
// + Tailscale). On a loopback bind it is skipped for local DX (any local
// process can already reach loopback). REQUIRE_AUTH=true|false overrides.
// NOTE: new URL().hostname returns IPv6 literals WITH brackets (e.g. "[::1]"),
// so normalize brackets before comparing.
const isLoopbackHost = (h) => {
  if (!h) return false;
  const n = h.replace(/^\[|\]$/g, '').toLowerCase();
  return ['127.0.0.1', 'localhost', '::1'].includes(n);
};
const AUTH_REQUIRED =
  process.env.REQUIRE_AUTH === 'true' ? true
  : process.env.REQUIRE_AUTH === 'false' ? false
  : !isLoopbackHost(HOST);

if (AUTH_REQUIRED && !TOKEN) {
  console.error('FATAL: BRIDGE_TOKEN env var is required (auth required on bind ' + HOST + ')');
  process.exit(1);
}

const TOKEN_BUF = TOKEN ? Buffer.from(TOKEN) : null;

// Reject cross-origin browser requests when auth is off (browser-CSRF guard).
// Local scripts/curl send no Origin; same-machine browser dev tools on
// localhost/127.0.0.1 are allowed. Returns true if Origin is absent or loopback.
function isLoopbackOrigin(origin) {
  if (!origin) return true;
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false; // malformed Origin → reject
  }
}

function tokenMatches(provided) {
  if (!TOKEN_BUF) return false;
  if (!provided) return false;
  const buf = Buffer.from(provided);
  if (buf.length !== TOKEN_BUF.length) return false;
  return timingSafeEqual(buf, TOKEN_BUF);
}

// ─── osascript helpers ───────────────────────────────────────────────
async function osa(script, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const { stdout } = await exec('osascript', ['-e', script], {
    timeout: timeoutMs,
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout.trimEnd();
}

async function chromeNavigate(url, tab) {
  await ensureWindow();
  const safe = asString(url);
  return osa(
    `tell application "${BROWSER}" to set URL of ${tabRef(tab)} to "${safe}"`,
  );
}

async function chromeReadyState(tab, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return osa(
    `tell application "${BROWSER}" to execute ${tabRef(tab)} javascript "document.readyState"`,
    timeoutMs,
  );
}

// Read location.href via AppleScript (mirrors chromeReadyState's style — no tempfile).
async function chromeLocationHref(tab, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return osa(
    `tell application "${BROWSER}" to execute ${tabRef(tab)} javascript "location.href"`,
    timeoutMs,
  );
}

// Compare two URLs for "same navigation target" ignoring fragments and trivial
// normalization (trailing slash, host case, default ports) via the URL parser.
// Returns false when either value is not a parseable absolute http(s) URL —
// the safe default is "different", which forces the URL-change guard.
// After chromeNavigate, the old page's readyState is still 'complete' until the
// new navigation begins. Wait for evidence that THIS navigation happened, then
// for readyState to return to 'complete'. beforeUrl is the pre-navigation
// location.href; requestedUrl is the url passed to /navigate. SETTLE_MS bounds
// Phase 1 (covers same-URL / bfcache where readyState/URL may never change).
// Returns { state, timedOut:false } on success or { state, timedOut:true } on
// timeout. Operational errors propagate (not caught) → fail().
const NAV_SETTLE_MS = 2000;
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
  // navStarted records whether we observed a navigation begin (drop or URL
  // change) — used below to distinguish "page was already ready" from "nav
  // began, wait for its complete" in no-target mode.
  let navStarted = false;
  while (Date.now() < settleDeadline && Date.now() < deadline) {
    const s = await chromeReadyState(tab, remaining());
    if (s !== 'complete') { navStarted = true; break; }
    if (requireChange) {
      if (Date.now() >= deadline) break;
      const cur = await chromeLocationHref(tab, remaining());
      if (cur !== beforeUrl) { navStarted = true; break; } // nav began
    }
    await poll(100); // same-URL: polls until settleDeadline (unchanged from #7)
  }

  // No-target, nothing changed during settle, and settle has elapsed: treat
  // the page as already-ready. This is reachable even when timeout_ms <= settle
  // (where Phase 2's deadline gate would skip the loop entirely and 408). It is
  // the documented stale-accept window — callers needing strictness must pass
  // expected_url. Dead code for /navigate (noTarget is false there).
  if (noTarget && !navStarted && Date.now() >= settleDeadline) {
    const s = await chromeReadyState(tab, remaining());
    if (s === 'complete') return { state: s, timedOut: false };
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

async function chromeInnerText(tab) {
  return osa(
    `tell application "${BROWSER}" to execute ${tabRef(tab)} javascript "document.body.innerText"`,
    60_000,
  );
}

async function screenshotViewport() {
  const boundsScript = `JSON.stringify({
    ...${VIEWPORT_ORIGIN_FIELDS_JS},
    w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1
  })`;
  const boundsRaw = await chromeEval(boundsScript);
  const { x, y, w, h, dpr } = JSON.parse(boundsRaw);

  const dir = await mkdtemp(join(tmpdir(), 'chrome-bridge-shot-'));
  const file = join(dir, 'shot.png');
  try {
    await exec(
      'screencapture',
      [
        '-x',
        '-t',
        'png',
        '-R',
        `${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)}`,
        file,
      ],
      { timeout: 10_000 },
    );
    const bytes = await readFile(file);
    return {
      base64: bytes.toString('base64'),
      width: Math.round(w * dpr),
      height: Math.round(h * dpr),
      dpr,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function ensureWindow() {
  return osa(`
    tell application "${BROWSER}"
      activate
      if (count of windows) = 0 then
        make new window
      else if (count of tabs of window 1) = 0 then
        tell window 1 to make new tab
      end if
    end tell
  `);
}

// Eval arbitrary JS via tempfile (avoids AppleScript quote-escaping hell)
async function chromeEval(js, timeoutMs, tab) {
  const dir = await mkdtemp(join(tmpdir(), 'chrome-bridge-'));
  const file = join(dir, 'eval.js');
  try {
    await writeFile(file, js, 'utf8');
    const result = await osa(
      `tell application "${BROWSER}"
        set js to (read POSIX file "${asString(file)}")
        execute ${tabRef(tab)} javascript js
      end tell`,
      timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Runs Swift code from a tempfile — avoids Accessibility permission requirement
// that System Events needs for cursor control.
async function swiftRun(code, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const dir = await mkdtemp(join(tmpdir(), 'chrome-bridge-swift-'));
  const file = join(dir, 'run.swift');
  try {
    await writeFile(file, code, 'utf8');
    const { stdout } = await exec('swift', [file], {
      timeout: timeoutMs,
      maxBuffer: 50 * 1024 * 1024,
    });
    return stdout.trimEnd();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Move the OS cursor to screen coordinates (tx, ty) along a human-like path.
async function humanMouseMoveToScreen(tx, ty, moveMs = 800) {
  const ms = Math.max(200, Math.min(5000, moveMs));

  const posRaw = await swiftRun(
    'import CoreGraphics\nlet p = CGEvent(source: nil)!.location\nprint("\\(Int(p.x)),\\(Int(p.y))")\n',
    10_000,
  );
  const [sx, sy] = posRaw.split(',').map(Number);
  if (isNaN(sx) || isNaN(sy)) throw new Error('Could not read cursor position');

  if (Math.hypot(tx - sx, ty - sy) < 5) return; // already on target

  const steps = Math.max(50, Math.min(120, Math.round(ms / 16)));
  const pts = humanPath(sx, sy, tx, ty, steps);
  const delayUs = Math.round((ms / steps) * 1000);

  const moves = pts
    .map(([x, y]) => `CGWarpMouseCursorPosition(CGPoint(x:${x},y:${y}))\nusleep(${delayUs})`)
    .join('\n');
  await swiftRun(`import CoreGraphics\n${moves}\n`, DEFAULT_TIMEOUT_MS);
}

// Resolve a CSS selector to screen coordinates then move the cursor.
async function humanMouseMove(selector, tab, moveMs = 800) {
  const ms = Math.max(200, Math.min(5000, moveMs));

  const coordsRaw = await chromeEval(`(function(){
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'null';
    const r = el.getBoundingClientRect();
    const o = ${VIEWPORT_ORIGIN_FIELDS_JS};
    return JSON.stringify({ x: Math.round(o.x + r.left + r.width / 2),
                            y: Math.round(o.y + r.top  + r.height / 2) });
  })()`, DEFAULT_TIMEOUT_MS, tab);

  if (!coordsRaw || coordsRaw === 'null') return; // element not found — caller handles
  let tx, ty;
  try {
    ({ x: tx, y: ty } = JSON.parse(coordsRaw));
  } catch {
    throw new Error('Could not parse element coordinates from Chrome');
  }

  await humanMouseMoveToScreen(tx, ty, ms);
}

const OS_KEY_MAP = {
  Return: 36, Enter: 36,
  Tab: 48,
  Space: 49,
  Backspace: 51, Delete: 51,
  Escape: 53,
  ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126,
  Home: 115, End: 119, PageUp: 116, PageDown: 121,
  F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97,
  F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
};

// Cmd+key shortcuts: key code for the letter, Command modifier applied
const OS_CMD_KEY_MAP = {
  SelectAll: 0,  // Cmd+A
  Copy: 8,       // Cmd+C
  Paste: 9,      // Cmd+V
};

async function osTypeText(text, delayMs = 30) {
  const delayUs = Math.max(0, Math.min(500_000, Math.round(delayMs * 1000)));
  const codepoints = [...text].map(c => c.codePointAt(0));
  const swift = `import CoreGraphics
let codepoints: [UInt32] = [${codepoints.join(', ')}]
let src = CGEventSource(stateID: .hidSystemState)
for cp in codepoints {
    guard let scalar = Unicode.Scalar(cp) else { continue }
    let utf16 = Array(String(scalar).utf16)
    let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true)!
    down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
    down.post(tap: .cghidEventTap)
    let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)!
    up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
    up.post(tap: .cghidEventTap)
    if ${delayUs} > 0 { usleep(${delayUs}) }
}
`;
  await swiftRun(swift, DEFAULT_TIMEOUT_MS + text.length * delayMs + 5000);
}

async function osKeyPress(key) {
  if (key in OS_CMD_KEY_MAP) {
    const keyCode = OS_CMD_KEY_MAP[key];
    const swift = `import CoreGraphics
let src = CGEventSource(stateID: .hidSystemState)
let down = CGEvent(keyboardEventSource: src, virtualKey: ${keyCode}, keyDown: true)!
down.flags = .maskCommand
down.post(tap: .cghidEventTap)
let up = CGEvent(keyboardEventSource: src, virtualKey: ${keyCode}, keyDown: false)!
up.flags = .maskCommand
up.post(tap: .cghidEventTap)
`;
    return swiftRun(swift, 10_000);
  }
  const keyCode = OS_KEY_MAP[key];
  if (keyCode === undefined)
    throw new Error(`unknown key: ${key}`);
  const swift = `import CoreGraphics
let src = CGEventSource(stateID: .hidSystemState)
let down = CGEvent(keyboardEventSource: src, virtualKey: ${keyCode}, keyDown: true)!
down.post(tap: .cghidEventTap)
let up = CGEvent(keyboardEventSource: src, virtualKey: ${keyCode}, keyDown: false)!
up.post(tap: .cghidEventTap)
`;
  await swiftRun(swift, 10_000);
}

// ─── server ──────────────────────────────────────────────────────────
const app = Fastify({
  logger: true,
  ...(USE_TLS
    ? { https: { key: readFileSync(TLS_KEY), cert: readFileSync(TLS_CERT) } }
    : {}),
});

// Uniform response envelope. Every route returns { ok: true, data: ... } on
// success and { ok: false, error: '...', ...extra } on failure. This is the
// single parse rule for the whole API (see issue #4) and is what makes /eval
// always return valid JSON regardless of the JS return type (issue #1).
function ok(data) {
  return { ok: true, data };
}

function sendError(reply, status, message, extra) {
  return reply
    .code(status)
    .send({ ok: false, error: message, ...(extra || {}) });
}

// Convert a JS-computed result ({ ok: bool, ...fields }) into the envelope.
// ok:false (e.g. "element not found") becomes a 422; ok:true wraps the rest.
function jsResult(reply, r) {
  if (r && r.ok === false) {
    const { ok: _ok, ...extra } = r;
    return reply.code(422).send({ ok: false, ...extra });
  }
  const { ok: _ok, ...data } = r || {};
  return { ok: true, data };
}

function fail(req, reply, err) {
  if (err.message?.includes('(-1719)')) {
    req.log.warn({ reqId: req.id }, 'no browser window open');
    return reply.code(409).send({
      ok: false,
      error: 'no browser window open — call POST /ensure-window or POST /navigate first',
    });
  }
  req.log.error({ err: err.message, stack: err.stack }, 'request failed');
  return reply.code(500).send({ ok: false, error: 'internal error' });
}

await app.register(cors, { origin: true, methods: ['GET', 'POST', 'OPTIONS'] });

await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

await app.register(swagger, {
  openapi: {
    info: {
      title: 'chrome-bridge',
      version: '1.0.0',
      description:
        'HTTP bridge for controlling Chrome on macOS via AppleScript. Every response uses a uniform envelope: { ok: bool, data?: ..., error?: string }.',
    },
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    },
    security: [{ bearerAuth: [] }],
  },
});

await app.register(swaggerUi, {
  routePrefix: '/docs',
  uiConfig: { docExpansion: 'list' },
});

app.addHook('preHandler', async (req, reply) => {
  if (req.url === '/docs' || req.url.startsWith('/docs/')) return;
  if (!AUTH_REQUIRED) {
    // Auth skipped (loopback bind). Still block browser CSRF from cross-origin pages.
    if (!isLoopbackOrigin(req.headers.origin))
      return reply.code(403).send({ ok: false, error: 'cross-origin requests not allowed when auth is disabled' });
    return; // no token check
  }
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!tokenMatches(provided))
    return reply.code(401).send({ ok: false, error: 'unauthorized' });
});

// GET /health
app.get(
  '/health',
  {
    schema: {
      summary: 'Health check',
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: {
              type: 'object',
              properties: { browser: { type: 'string' } },
            },
          },
        },
      },
    },
  },
  async () => ok({ browser: BROWSER }),
);

// POST /navigate { url, tab?, wait?, timeout_ms? }
// wait=true: blocks until readyState=complete before returning
app.post(
  '/navigate',
  {
    schema: {
      summary: 'Navigate to URL',
      body: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string', description: 'http(s) URL to navigate to' },
          tab: {
            type: 'integer',
            minimum: 1,
            description: '1-based tab index (default: active tab)',
          },
          wait: {
            type: 'boolean',
            default: false,
            description: 'Block until readyState=complete',
          },
          timeout_ms: { type: 'integer', default: 30000 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                state: { type: 'string' },
                status: { type: 'integer' },
              },
            },
          },
        },
      },
    },
  },
  async (req, reply) => {
    const { url, tab, wait = false, timeout_ms = 30_000 } = req.body || {};
    if (typeof url !== 'string' || !/^https?:\/\//.test(url))
      return sendError(reply, 400, 'url must be http(s) string');
    try {
      // For waited navigations, ensure a window/tab exists and capture the
      // pre-navigation URL before chromeNavigate so the wait can prove the
      // observed 'complete' belongs to THIS navigation (not the old page).
      if (wait) await ensureWindow();
      let beforeUrl = null;
      if (wait) beforeUrl = await chromeLocationHref(tab, timeout_ms);
      await chromeNavigate(url, tab);
      if (wait) {
        const result = await waitForNavigationReady(tab, timeout_ms, beforeUrl, url);
        if (result.timedOut) return sendError(reply, 408, 'timeout waiting for ready');
        // Post-wait status probe: bounded overhead (see Maintenance notes). Not
        // on the polling deadline — the page is already loaded when it runs.
        const raw = await chromeEval(
          `String(performance.getEntriesByType('navigation')[0]?.responseStatus ?? '')`,
          Math.min(timeout_ms, 10_000),
          tab,
        );
        const status = raw ? parseInt(raw, 10) : undefined;
        return ok({ state: result.state, ...(status ? { status } : {}) });
      }
      return ok({});
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// POST /back { tab? }
app.post(
  '/back',
  {
    schema: {
      summary: 'Navigate back in browser history',
      body: {
        type: 'object',
        properties: { tab: { type: 'integer', minimum: 1 } },
      },
      response: {
        200: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, data: { type: 'object' } },
        },
      },
    },
  },
  async (req, reply) => {
    const { tab } = req.body || {};
    try {
      await osa(`tell application "${BROWSER}" to go back of ${tabRef(tab)}`);
      return ok({});
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// POST /forward { tab? }
app.post(
  '/forward',
  {
    schema: {
      summary: 'Navigate forward in browser history',
      body: {
        type: 'object',
        properties: { tab: { type: 'integer', minimum: 1 } },
      },
      response: {
        200: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, data: { type: 'object' } },
        },
      },
    },
  },
  async (req, reply) => {
    const { tab } = req.body || {};
    try {
      await osa(`tell application "${BROWSER}" to go forward of ${tabRef(tab)}`);
      return ok({});
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// GET /ready-state?tab=
app.get(
  '/ready-state',
  {
    schema: {
      summary: 'Get document.readyState',
      querystring: {
        type: 'object',
        properties: { tab: { type: 'integer', minimum: 1 } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: {
              type: 'object',
              properties: { state: { type: 'string' } },
            },
          },
        },
      },
    },
  },
  async (req, reply) => {
    const { tab } = req.query || {};
    try {
      const state = await chromeReadyState(tab);
      return ok({ state });
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// POST /wait-for-ready { tab?, timeout_ms?, interval_ms?, expected_url? }
app.post(
  '/wait-for-ready',
  {
    schema: {
      summary: 'Poll until readyState=complete',
      body: {
        type: 'object',
        properties: {
          tab: { type: 'integer', minimum: 1 },
          timeout_ms: { type: 'integer', default: 30000 },
          interval_ms: { type: 'integer', default: 500 },
          expected_url: {
            type: 'string',
            description: 'If set, strictly wait until this URL is loaded (requires location.href to change from the pre-call URL; redirect-tolerant). Omit for best-effort polling of an already-loaded page.',
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: {
              type: 'object',
              properties: { state: { type: 'string' } },
            },
          },
        },
      },
    },
  },
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
);

// GET /url?tab=
app.get(
  '/url',
  {
    schema: {
      summary: 'Get tab URL',
      querystring: {
        type: 'object',
        properties: { tab: { type: 'integer', minimum: 1 } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: {
              type: 'object',
              properties: { url: { type: 'string' } },
            },
          },
        },
      },
    },
  },
  async (req, reply) => {
    const { tab } = req.query || {};
    try {
      const url = await osa(
        `tell application "${BROWSER}" to get URL of ${tabRef(tab)}`,
      );
      return ok({ url });
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// GET /state?tab= — url, title, scrollY, scrollHeight, innerHeight
app.get(
  '/state',
  {
    schema: {
      summary: 'Get tab state (url, title, scroll position, viewport)',
      querystring: {
        type: 'object',
        properties: { tab: { type: 'integer', minimum: 1 } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                title: { type: 'string' },
                scrollY: { type: 'number' },
                scrollHeight: { type: 'number' },
                innerHeight: { type: 'number' },
                tab: {},
              },
            },
          },
        },
      },
    },
  },
  async (req, reply) => {
    const { tab } = req.query || {};
    try {
      const url = await osa(
        `tell application "${BROWSER}" to get URL of ${tabRef(tab)}`,
      );
      const title = await osa(
        `tell application "${BROWSER}" to get name of ${tabRef(tab)}`,
      );
      const raw = await chromeEval(
        `JSON.stringify({ scrollY: window.scrollY, scrollHeight: document.body.scrollHeight, innerHeight: window.innerHeight })`,
        DEFAULT_TIMEOUT_MS,
        tab,
      );
      const { scrollY, scrollHeight, innerHeight } = JSON.parse(raw);
      return ok({
        url,
        title,
        scrollY,
        scrollHeight,
        innerHeight,
        tab: tab ? Number(tab) : 'active',
      });
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// GET /inner-text?tab=
app.get(
  '/inner-text',
  {
    schema: {
      summary: 'Get document.body.innerText',
      querystring: {
        type: 'object',
        properties: { tab: { type: 'integer', minimum: 1 } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: {
              type: 'object',
              properties: { text: { type: 'string' } },
            },
          },
        },
      },
    },
  },
  async (req, reply) => {
    const { tab } = req.query || {};
    try {
      const text = await chromeInnerText(tab);
      return ok({ text });
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// POST /eval { js, tab?, timeout_ms?, parse_json? }
// Response is ALWAYS a JSON object: { ok: true, data: <value> }.
//   parse_json:true  → data is the JSON.parse'd JS return value
//                     (string/number/array/object — always valid JSON, see #1)
//   parse_json:false → data is the raw string result from Chrome
app.post(
  '/eval',
  {
    schema: {
      summary: 'Evaluate arbitrary JavaScript in the tab',
      description:
        'Always returns { ok: true, data: <value> }. With parse_json:true (default), data is the JSON-parsed JS return value (any type). With parse_json:false, data is the raw string result.',
      body: {
        type: 'object',
        required: ['js'],
        properties: {
          js: { type: 'string', description: 'JavaScript source to evaluate' },
          tab: { type: 'integer', minimum: 1 },
          timeout_ms: { type: 'integer' },
          parse_json: {
            type: 'boolean',
            default: true,
            description:
              'Attempt to JSON.parse the result. true → data is the parsed value; false → data is the raw string.',
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: {
              description:
                'The eval result. Any JSON type when parse_json:true; a string when parse_json:false.',
            },
          },
        },
      },
    },
  },
  async (req, reply) => {
    const { js, tab, timeout_ms, parse_json = true } = req.body || {};
    if (typeof js !== 'string' || js.length === 0)
      return sendError(reply, 400, 'js must be non-empty string');
    try {
      const raw = parse_json
        ? await chromeEval(`JSON.stringify(eval(${JSON.stringify(js)}))`, timeout_ms, tab)
        : await chromeEval(js, timeout_ms, tab);
      if (parse_json) {
        try {
          return ok(JSON.parse(raw));
        } catch {
          // raw wasn't valid JSON — surface it as a string value
          return ok(raw);
        }
      }
      return ok(raw);
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// POST /click { selector?, x?, y?, tab?, human_move?, move_ms? }
// Requires either selector or both x+y (viewport coordinates).
app.post(
  '/click',
  {
    schema: {
      summary: 'Click element by CSS selector or viewport coordinates',
      body: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector to click' },
          x: { type: 'number', description: 'Viewport x coordinate to click' },
          y: { type: 'number', description: 'Viewport y coordinate to click' },
          tab: { type: 'integer', minimum: 1 },
          human_move: {
            type: 'boolean',
            default: false,
            description: 'Move cursor to target in a human-like path before clicking',
          },
          move_ms: {
            type: 'integer',
            default: 800,
            minimum: 200,
            maximum: 5000,
            description: 'Total cursor move duration in ms (requires human_move: true)',
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                tag: { type: 'string' },
                text: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
  async (req, reply) => {
    const { selector, x, y, tab, human_move = false, move_ms = 800 } = req.body || {};
    const hasSelector = typeof selector === 'string' && selector.length > 0;
    const hasCoords = x !== undefined && y !== undefined;
    if (!hasSelector && !hasCoords)
      return sendError(reply, 400, 'selector or x+y coordinates required');
    try {
      if (hasSelector) {
        if (human_move) await humanMouseMove(selector, tab, move_ms);
        const js = `(function(){
          const el=document.querySelector(${JSON.stringify(selector)});
          if(!el) return JSON.stringify({ok:false,error:'element not found'});
          el.scrollIntoView({block:'center'}); el.click();
          return JSON.stringify({ok:true,tag:el.tagName,text:el.innerText?.slice(0,80)});
        })()`;
        return jsResult(reply, JSON.parse(await chromeEval(js, DEFAULT_TIMEOUT_MS, tab)));
      } else {
        const cx = Number(x), cy = Number(y);
        if (human_move) {
          const screenRaw = await chromeEval(viewportToScreenExpr(cx, cy), DEFAULT_TIMEOUT_MS, tab);
          const { x: stx, y: sty } = JSON.parse(screenRaw);
          await humanMouseMoveToScreen(stx, sty, move_ms);
        }
        const js = `(function(){
          const el=document.elementFromPoint(${cx},${cy});
          if(!el) return JSON.stringify({ok:false,error:'no element at coordinates'});
          const target=el.closest('a,button,[onclick],[role="button"]')||el;
          target.click();
          return JSON.stringify({ok:true,tag:target.tagName,text:target.innerText?.slice(0,80)});
        })()`;
        return jsResult(reply, JSON.parse(await chromeEval(js, DEFAULT_TIMEOUT_MS, tab)));
      }
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// POST /focus { selector, tab? }
app.post(
  '/focus',
  {
    schema: {
      summary: 'Focus element matching CSS selector',
      body: {
        type: 'object',
        required: ['selector'],
        properties: {
          selector: { type: 'string' },
          tab: { type: 'integer', minimum: 1 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                tag: { type: 'string' },
                type: { type: 'string', nullable: true },
              },
            },
          },
        },
      },
    },
  },
  async (req, reply) => {
    const { selector, tab } = req.body || {};
    if (typeof selector !== 'string' || selector.length === 0)
      return sendError(reply, 400, 'selector must be non-empty string');
    try {
      const js = `(function(){
      const el=document.querySelector(${JSON.stringify(selector)});
      if(!el) return JSON.stringify({ok:false,error:'element not found'});
      el.focus(); el.scrollIntoView({block:'center'});
      return JSON.stringify({ok:true,tag:el.tagName,type:el.type||null});
    })()`;
      return jsResult(reply, JSON.parse(await chromeEval(js, DEFAULT_TIMEOUT_MS, tab)));
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// POST /type { text, delay_ms? }
app.post(
  '/type',
  {
    schema: {
      summary: 'Type text via OS-level keyboard events into the focused element',
      body: {
        type: 'object',
        required: ['text'],
        properties: {
          text: { type: 'string' },
          delay_ms: {
            type: 'integer',
            default: 30,
            minimum: 0,
            maximum: 500,
            description: 'Delay between keystrokes in ms',
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: {
              type: 'object',
              properties: { chars: { type: 'integer' } },
            },
          },
        },
      },
    },
  },
  async (req, reply) => {
    const { text, delay_ms = 30 } = req.body || {};
    if (typeof text !== 'string')
      return sendError(reply, 400, 'text must be a string');
    try {
      await osTypeText(text, delay_ms);
      return ok({ chars: text.length });
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// POST /select { selector, value, tab? }
// Sets a <select> dropdown value by option value or visible text.
app.post(
  '/select',
  {
    schema: {
      summary: 'Set <select> value by option value or visible text',
      body: {
        type: 'object',
        required: ['selector', 'value'],
        properties: {
          selector: { type: 'string' },
          value: {
            type: 'string',
            description: 'Option value or visible text',
          },
          tab: { type: 'integer', minimum: 1 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                selected: { type: 'string' },
                value: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
  async (req, reply) => {
    const { selector, value, tab } = req.body || {};
    if (typeof selector !== 'string' || selector.length === 0)
      return sendError(reply, 400, 'selector must be non-empty string');
    if (typeof value !== 'string')
      return sendError(reply, 400, 'value must be a string');
    try {
      const js = `(function(){
      const el=document.querySelector(${JSON.stringify(selector)});
      if(!el) return JSON.stringify({ok:false,error:'element not found'});
      if(el.tagName!=='SELECT') return JSON.stringify({ok:false,error:'not a select: '+el.tagName});
      const opt=Array.from(el.options).find(o=>o.value===${JSON.stringify(value)}||o.text.trim()===${JSON.stringify(value)});
      if(!opt) return JSON.stringify({ok:false,error:'option not found',available:Array.from(el.options).map(o=>o.value)});
      el.value=opt.value;
      el.dispatchEvent(new Event('change',{bubbles:true}));
      return JSON.stringify({ok:true,selected:opt.text.trim(),value:opt.value});
    })()`;
      return jsResult(reply, JSON.parse(await chromeEval(js, DEFAULT_TIMEOUT_MS, tab)));
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// POST /scroll { x?, y?, selector?, tab? }
// Coordinate path reports requested-vs-actual position and a `clamped` flag so
// callers can detect no-op scrolls beyond scrollHeight (issue #3). Selector
// path reports the actual scroll position snapshot after scrollIntoView.
app.post(
  '/scroll',
  {
    schema: {
      summary: 'Scroll to coordinates or scroll element into view',
      description:
        'Coordinate mode: window.scrollTo(x,y) then returns requested vs actual position with a `clamped` flag (true when the page could not reach the requested coordinates, e.g. target y exceeds scrollHeight). Selector mode: scrolls the element into view and returns the resulting scroll position snapshot.',
      body: {
        type: 'object',
        properties: {
          x: { type: 'number', default: 0 },
          y: { type: 'number', default: 0 },
          selector: {
            type: 'string',
            description: 'If provided, scrolls element into view instead',
          },
          tab: { type: 'integer', minimum: 1 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                requested: {
                  type: 'object',
                  properties: {
                    x: { type: 'number' },
                    y: { type: 'number' },
                  },
                  description: 'Requested target (coordinate mode only)',
                },
                actual: {
                  type: 'object',
                  properties: {
                    x: { type: 'number' },
                    y: { type: 'number' },
                  },
                  description: 'Actual scroll position after the call',
                },
                clamped: {
                  type: 'boolean',
                  description: 'True when actual != requested (coordinate mode only)',
                },
              },
            },
          },
        },
      },
    },
  },
  async (req, reply) => {
    const { x = 0, y = 0, selector, tab } = req.body || {};
    try {
      const js = selector
        ? `(function(){ const el=document.querySelector(${JSON.stringify(selector)}); if(!el) return JSON.stringify({ok:false,error:'element not found'}); el.scrollIntoView({behavior:'smooth',block:'center'}); return JSON.stringify({ok:true,actual:{x:window.scrollX,y:window.scrollY}}); })()`
        : `(function(){ const rx=${Number(x)},ry=${Number(y)}; window.scrollTo(rx,ry); const ax=window.scrollX,ay=window.scrollY; return JSON.stringify({ok:true,requested:{x:rx,y:ry},actual:{x:ax,y:ay},clamped:(ax!==rx||ay!==ry)}); })()`;
      return jsResult(reply, JSON.parse(await chromeEval(js, DEFAULT_TIMEOUT_MS, tab)));
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// POST /scroll-down { pixels?, times?, delay_ms?, tab? }
app.post(
  '/scroll-down',
  {
    schema: {
      summary: 'Scroll down repeatedly (useful for infinite scroll feeds)',
      body: {
        type: 'object',
        properties: {
          pixels: { type: 'integer', default: 800 },
          times: { type: 'integer', default: 3, maximum: 20 },
          delay_ms: { type: 'integer', default: 800 },
          tab: { type: 'integer', minimum: 1 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                steps: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      step: { type: 'integer' },
                      y: { type: 'number' },
                    },
                  },
                },
                finalY: { type: 'number' },
              },
            },
          },
        },
      },
    },
  },
  async (req, reply) => {
    const { pixels = 800, times = 3, delay_ms = 800, tab } = req.body || {};
    const count = Math.min(Number(times), 20);
    const delay = Number(delay_ms);
    const px = Number(pixels);
    try {
      const steps = [];
      for (let i = 0; i < count; i++) {
        const raw = await chromeEval(
          `JSON.stringify({ y: (window.scrollBy(0, ${px}), window.scrollY) })`,
          DEFAULT_TIMEOUT_MS,
          tab,
        );
        const { y } = JSON.parse(raw);
        steps.push({ step: i + 1, y });
        if (i < count - 1) await new Promise((r) => setTimeout(r, delay));
      }
      return ok({ steps, finalY: steps[steps.length - 1]?.y });
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// POST /hover { selector?, x?, y?, tab?, human_move?, move_ms? }
// Requires either selector or both x+y (viewport coordinates).
app.post(
  '/hover',
  {
    schema: {
      summary: 'Dispatch mouseover/mouseenter by CSS selector or viewport coordinates',
      body: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector to hover' },
          x: { type: 'number', description: 'Viewport x coordinate' },
          y: { type: 'number', description: 'Viewport y coordinate' },
          tab: { type: 'integer', minimum: 1 },
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
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                tag: { type: 'string' },
                text: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
  async (req, reply) => {
    const { selector, x, y, tab, human_move = false, move_ms = 800 } = req.body || {};
    const hasSelector = typeof selector === 'string' && selector.length > 0;
    const hasCoords = x !== undefined && y !== undefined;
    if (!hasSelector && !hasCoords)
      return sendError(reply, 400, 'selector or x+y coordinates required');
    try {
      if (hasSelector) {
        if (human_move) await humanMouseMove(selector, tab, move_ms);
        const js = `(function(){
          const el=document.querySelector(${JSON.stringify(selector)});
          if(!el) return JSON.stringify({ok:false,error:'element not found'});
          el.scrollIntoView({block:'center'});
          el.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
          el.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}));
          return JSON.stringify({ok:true,tag:el.tagName,text:el.innerText?.slice(0,80)});
        })()`;
        return jsResult(reply, JSON.parse(await chromeEval(js, DEFAULT_TIMEOUT_MS, tab)));
      } else {
        const cx = Number(x), cy = Number(y);
        if (human_move) {
          const screenRaw = await chromeEval(viewportToScreenExpr(cx, cy), DEFAULT_TIMEOUT_MS, tab);
          const { x: stx, y: sty } = JSON.parse(screenRaw);
          await humanMouseMoveToScreen(stx, sty, move_ms);
        }
        const js = `(function(){
          const el=document.elementFromPoint(${cx},${cy});
          if(!el) return JSON.stringify({ok:false,error:'no element at coordinates'});
          el.scrollIntoView({block:'center'});
          el.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
          el.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}));
          return JSON.stringify({ok:true,tag:el.tagName,text:el.innerText?.slice(0,80)});
        })()`;
        return jsResult(reply, JSON.parse(await chromeEval(js, DEFAULT_TIMEOUT_MS, tab)));
      }
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// POST /key { key }
// Supported keys: Enter, Return, Tab, Space, Backspace, Delete, Escape,
// ArrowLeft, ArrowRight, ArrowDown, ArrowUp, Home, End, PageUp, PageDown,
// F1–F12, SelectAll, Copy, Paste
app.post(
  '/key',
  {
    schema: {
      summary: 'Send OS-level key press to frontmost Chrome window',
      body: {
        type: 'object',
        required: ['key'],
        properties: {
          key: {
            type: 'string',
            description:
              'Key name: "Enter", "Tab", "Escape", "ArrowDown", "Backspace", "F5", "SelectAll", "Copy", "Paste", etc.',
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: {
              type: 'object',
              properties: { key: { type: 'string' } },
            },
          },
        },
      },
    },
  },
  async (req, reply) => {
    const { key } = req.body || {};
    if (typeof key !== 'string' || key.length === 0)
      return sendError(reply, 400, 'key must be non-empty string');
    try {
      await osKeyPress(key);
      return ok({ key });
    } catch (err) {
      if (err.message?.startsWith('unknown key:'))
        return sendError(reply, 400, err.message, {
          supported: [...Object.keys(OS_KEY_MAP), ...Object.keys(OS_CMD_KEY_MAP)],
        });
      return fail(req, reply, err);
    }
  },
);

// POST /get-html { selector?, tab? }
app.post(
  '/get-html',
  {
    schema: {
      summary: 'Get outerHTML of selector or document.body.innerHTML',
      body: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'Returns outerHTML of match; omit for body.innerHTML',
          },
          tab: { type: 'integer', minimum: 1 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: {
              type: 'object',
              properties: { html: { type: 'string', nullable: true } },
            },
          },
        },
      },
    },
  },
  async (req, reply) => {
    const { selector, tab } = req.body || {};
    try {
      const js = selector
        ? `(function(){ const el=document.querySelector(${JSON.stringify(selector)}); return el ? el.outerHTML : null; })()`
        : `document.body.innerHTML`;
      const raw = await chromeEval(js, 60_000, tab);
      return ok({ html: raw });
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// POST /wait-for-selector { selector, tab?, timeout_ms?, interval_ms? }
app.post(
  '/wait-for-selector',
  {
    schema: {
      summary: 'Poll until selector matches an element',
      body: {
        type: 'object',
        required: ['selector'],
        properties: {
          selector: { type: 'string' },
          tab: { type: 'integer', minimum: 1 },
          timeout_ms: { type: 'integer', default: 15000 },
          interval_ms: { type: 'integer', default: 500 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                tag: { type: 'string' },
                text: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
  async (req, reply) => {
    const {
      selector,
      tab,
      timeout_ms = 15_000,
      interval_ms = 500,
    } = req.body || {};
    if (typeof selector !== 'string' || selector.length === 0)
      return sendError(reply, 400, 'selector must be non-empty string');
    const deadline = Date.now() + timeout_ms;
    try {
      while (Date.now() < deadline) {
        const js = `(function(){ const el=document.querySelector(${JSON.stringify(selector)}); return el ? JSON.stringify({ok:true,tag:el.tagName,text:el.innerText?.slice(0,80)}) : 'null'; })()`;
        const raw = await chromeEval(js, DEFAULT_TIMEOUT_MS, tab);
        if (raw && raw !== 'null') return jsResult(reply, JSON.parse(raw));
        await new Promise((r) => setTimeout(r, interval_ms));
      }
      return sendError(reply, 408, 'timeout waiting for selector', { selector });
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// GET /tabs — list all open tabs
app.get(
  '/tabs',
  {
    schema: {
      summary: 'List all open tabs across windows',
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                tabs: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      window: { type: 'integer' },
                      tab: { type: 'integer' },
                      url: { type: 'string' },
                      title: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  async (req, reply) => {
    try {
      // Use JSON via eval to avoid AppleScript delimiter hell
      const winCount = Number(
        await osa(`tell application "${BROWSER}" to count of windows`),
      );
      const tabs = [];
      for (let w = 1; w <= winCount; w++) {
        const tabCount = Number(
          await osa(
            `tell application "${BROWSER}" to count of tabs of window ${w}`,
          ),
        );
        for (let t = 1; t <= tabCount; t++) {
          const url = await osa(
            `tell application "${BROWSER}" to get URL of tab ${t} of window ${w}`,
          );
          const title = await osa(
            `tell application "${BROWSER}" to get name of tab ${t} of window ${w}`,
          );
          tabs.push({ window: w, tab: t, url, title });
        }
      }
      return ok({ tabs });
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// POST /new-tab { url? }
app.post(
  '/new-tab',
  {
    schema: {
      summary: 'Open a new tab, optionally navigating to URL',
      body: { type: 'object', properties: { url: { type: 'string' } } },
      response: {
        200: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, data: { type: 'object' } },
        },
      },
    },
  },
  async (req, reply) => {
    const { url } = req.body || {};
    try {
      await osa(
        `tell application "${BROWSER}" to tell window 1 to make new tab`,
      );
      if (url && /^https?:\/\//.test(url)) await chromeNavigate(url);
      return ok({});
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// POST /switch-tab { index }
app.post(
  '/switch-tab',
  {
    schema: {
      summary: 'Activate tab in window 1 by 1-based index',
      body: {
        type: 'object',
        required: ['index'],
        properties: { index: { type: 'integer', minimum: 1 } },
      },
      response: {
        200: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, data: { type: 'object' } },
        },
      },
    },
  },
  async (req, reply) => {
    const { index } = req.body || {};
    if (!Number.isInteger(Number(index)) || Number(index) < 1)
      return sendError(reply, 400, 'index must be a positive integer');
    try {
      await osa(
        `tell application "${BROWSER}" to set active tab index of window 1 to ${Number(index)}`,
      );
      return ok({});
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// POST /close-tab { tab? }
// Closes a tab in window 1 by 1-based index (default: active tab). Closing the
// last tab of a window also closes the window (Chrome's default behavior).
//
// Chrome throws the same AppleScript error (-1719) for "no window" and for a
// bad tab index, so for an explicit index we validate against the live tab
// count first to distinguish 422 (tab not found) from 409 (no window).
app.post(
  '/close-tab',
  {
    schema: {
      summary: 'Close a tab in window 1 by 1-based index (default: active tab)',
      body: {
        type: 'object',
        properties: {
          tab: {
            type: 'integer',
            minimum: 1,
            description: '1-based tab index in window 1 (default: active tab)',
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, data: { type: 'object' } },
        },
      },
    },
  },
  async (req, reply) => {
    const { tab } = req.body || {};
    try {
      if (tab !== undefined) {
        const idx = Number(tab);
        const count = Number(
          await osa(`tell application "${BROWSER}" to count of tabs of window 1`),
        );
        if (idx > count)
          return sendError(reply, 422, 'tab not found', { tab: idx, tabs: count });
      }
      await osa(`tell application "${BROWSER}" to close ${tabRef(tab)}`);
      return ok({});
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// POST /ensure-window
app.post(
  '/ensure-window',
  {
    schema: {
      summary: 'Activate browser and ensure at least one window/tab exists',
      response: {
        200: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, data: { type: 'object' } },
        },
      },
    },
  },
  async (req, reply) => {
    try {
      await ensureWindow();
      return ok({});
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// POST /resize-window { width, height }
app.post(
  '/resize-window',
  {
    schema: {
      summary: 'Resize the frontmost browser window (window 1)',
      body: {
        type: 'object',
        required: ['width', 'height'],
        properties: {
          width: { type: 'integer', minimum: 1, description: 'Target window width in pixels' },
          height: { type: 'integer', minimum: 1, description: 'Target window height in pixels' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                width: { type: 'integer' },
                height: { type: 'integer' },
              },
            },
          },
        },
      },
    },
  },
  async (req, reply) => {
    const { width, height } = req.body || {};
    const w = Number(width);
    const h = Number(height);
    if (!Number.isInteger(w) || w < 1 || !Number.isInteger(h) || h < 1)
      return sendError(reply, 400, 'width and height must be positive integers');
    try {
      const boundsRaw = await osa(
        `tell application "${BROWSER}" to get bounds of window 1`,
      );
      // AppleScript returns: "left, top, right, bottom"
      const [left, top] = boundsRaw.split(',').map(Number);
      await osa(
        `tell application "${BROWSER}" to set bounds of window 1 to {${left}, ${top}, ${left + w}, ${top + h}}`,
      );
      return ok({ width: w, height: h });
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// GET /screenshot
app.get(
  '/screenshot',
  {
    schema: {
      summary: 'Capture viewport of frontmost browser window as PNG (base64)',
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                mime: { type: 'string' },
                width: { type: 'integer' },
                height: { type: 'integer' },
                dpr: { type: 'number' },
                image: { type: 'string', description: 'Base64-encoded PNG' },
              },
            },
          },
        },
      },
    },
  },
  async (req, reply) => {
    try {
      const { base64, width, height, dpr } = await screenshotViewport();
      return ok({ mime: 'image/png', width, height, dpr, image: base64 });
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// POST /batch { pauseBetween?, batch: [{ func, method?, data? }, ...] }
// Runs a sequence of internal endpoint calls. Method defaults to POST if data
// is provided, GET otherwise. The caller's Authorization header is forwarded.
//
// Response: { ok: true, data: { results: [...] } }. Each result describes one
// step: { ok: <http success>, status, body } on success, or { ok: false,
// error } on internal failure. Note the result's `ok` reflects whether the
// internal HTTP call succeeded (status < 400); the inner `body` is itself an
// enveloped response ({ ok, data } or { ok:false, error }).
app.post(
  '/batch',
  {
    schema: {
      summary:
        'Run a sequence of internal endpoint calls with optional pause between them',
      body: {
        type: 'object',
        required: ['batch'],
        properties: {
          pauseBetween: {
            type: 'integer',
            minimum: 0,
            default: 0,
            description: 'ms to pause between requests',
          },
          batch: {
            type: 'array',
            items: {
              type: 'object',
              required: ['func'],
              properties: {
                func: {
                  type: 'string',
                  description: 'Path to call, e.g. "/navigate"',
                },
                method: {
                  type: 'string',
                  enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
                  description: 'Defaults to POST if data is set, else GET',
                },
                data: {
                  description:
                    'Body for POST/PUT/PATCH, or query params object for GET',
                },
              },
            },
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                results: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      status: { type: 'integer' },
                      body: {},
                      error: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  async (req, reply) => {
    const { pauseBetween = 0, batch } = req.body || {};
    if (!Array.isArray(batch))
      return sendError(reply, 400, 'batch must be an array');

    const results = [];
    const auth = req.headers.authorization;

    for (let i = 0; i < batch.length; i++) {
      if (i > 0 && pauseBetween > 0)
        await new Promise((r) => setTimeout(r, pauseBetween));

      const { func, method, data } = batch[i] || {};
      if (typeof func !== 'string' || !func.startsWith('/')) {
        results.push({
          ok: false,
          error: 'func must be a path starting with /',
        });
        continue;
      }
      if (func === '/batch') {
        results.push({ ok: false, error: 'recursive /batch not allowed' });
        continue;
      }

      const m = method || (data !== undefined ? 'POST' : 'GET');
      const opts = { method: m, url: func, headers: { authorization: auth } };
      if (m === 'GET') {
        if (data && typeof data === 'object') opts.query = data;
      } else if (data !== undefined) {
        opts.payload = data;
        opts.headers['content-type'] = 'application/json';
      }

      try {
        const res = await app.inject(opts);
        let body;
        try {
          body = JSON.parse(res.body);
        } catch {
          body = res.body;
        }
        results.push({
          ok: res.statusCode < 400,
          status: res.statusCode,
          body,
        });
      } catch (err) {
        req.log.error(
          { err: err.message, func, method: m },
          'batch step failed',
        );
        results.push({ ok: false, error: 'internal error' });
      }
    }

    return ok({ results });
  },
);

// ─── boot ────────────────────────────────────────────────────────────
const SCHEME = USE_TLS ? 'https' : 'http';
app
  .listen({ port: PORT, host: HOST })
  .then(() => {
    console.log(`chrome-bridge listening on ${SCHEME}://${HOST}:${PORT}`);
    // cleartext warning (004) — only when exposed (non-loopback) and not using TLS
    if (!USE_TLS && !isLoopbackHost(HOST)) {
      console.warn(
        `WARNING: serving cleartext HTTP on non-loopback bind (${HOST}). ` +
          `Requests (including any bearer token, when auth is on) are sniffable on this network — ` +
          `and BRIDGE_TOKEN is a root password for your Chrome session. ` +
          `Use Tailscale, bind 127.0.0.1, or set TLS_CERT/TLS_KEY.`,
      );
    }
    if (!AUTH_REQUIRED) {
      if (isLoopbackHost(HOST)) {
        console.warn(
          `NOTE: auth disabled (loopback bind ${HOST}). Any local process can drive Chrome. ` +
          `Set REQUIRE_AUTH=true to force the bearer token.`,
        );
      } else {
        console.warn(
          `WARNING: auth disabled by REQUIRE_AUTH=false on non-loopback bind ${HOST} — the bridge is open to the network with no token.`,
        );
      }
    } else {
      console.log('auth: bearer token required');
    }
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
