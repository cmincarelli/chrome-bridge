import 'dotenv/config';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import rateLimit from '@fastify/rate-limit';
import cors from '@fastify/cors';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';

const exec = promisify(execFile);

// ─── config ──────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '8765', 10);
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN = process.env.BRIDGE_TOKEN;
const BROWSER = process.env.BROWSER || 'Google Chrome';
const DEFAULT_TIMEOUT_MS = 30_000;

if (!TOKEN) {
  console.error('FATAL: BRIDGE_TOKEN env var is required');
  process.exit(1);
}

const TOKEN_BUF = Buffer.from(TOKEN);

function tokenMatches(provided) {
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

function asString(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Resolve tab target — optional 1-based tab index, defaults to active tab
function tabRef(tab) {
  return tab
    ? `tab ${Math.max(1, Number(tab))} of window 1`
    : `active tab of window 1`;
}

async function chromeNavigate(url, tab) {
  await ensureWindow();
  const safe = asString(url);
  return osa(
    `tell application "${BROWSER}" to set URL of ${tabRef(tab)} to "${safe}"`,
  );
}

async function chromeReadyState(tab) {
  return osa(
    `tell application "${BROWSER}" to execute ${tabRef(tab)} javascript "document.readyState"`,
  );
}

async function chromeInnerText(tab) {
  return osa(
    `tell application "${BROWSER}" to execute ${tabRef(tab)} javascript "document.body.innerText"`,
    60_000,
  );
}

async function screenshotViewport() {
  const boundsScript = `
    JSON.stringify({
      x: window.screenX + (window.outerWidth - window.innerWidth) / 2,
      y: window.screenY + (window.outerHeight - window.innerHeight) - ((window.outerWidth - window.innerWidth) / 2),
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: window.devicePixelRatio || 1
    })
  `;
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

// Returns array of [x, y] screen-coordinate waypoints following a curved,
// noisy path from (x0,y0) to (x1,y1). steps controls resolution.
function humanPath(x0, y0, x1, y1, steps) {
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
    const vx = window.screenX + (window.outerWidth - window.innerWidth) / 2;
    const vy = window.screenY + (window.outerHeight - window.innerHeight)
               - (window.outerWidth - window.innerWidth) / 2;
    return JSON.stringify({ x: Math.round(vx + r.left + r.width / 2),
                            y: Math.round(vy + r.top  + r.height / 2) });
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

async function osTypeText(text, { delayMs = 30, clear = false } = {}) {
  const delayUs = Math.max(0, Math.min(500_000, Math.round(delayMs * 1000)));
  const codepoints = [...text].map(c => c.codePointAt(0));
  const clearLines = clear
    ? [
        'let cmdA_d = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true)!',
        'cmdA_d.flags = .maskCommand',
        'cmdA_d.post(tap: .cghidEventTap)',
        'let cmdA_u = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)!',
        'cmdA_u.flags = .maskCommand',
        'cmdA_u.post(tap: .cghidEventTap)',
        'usleep(50000)',
        'let del_d = CGEvent(keyboardEventSource: src, virtualKey: 51, keyDown: true)!',
        'del_d.post(tap: .cghidEventTap)',
        'let del_u = CGEvent(keyboardEventSource: src, virtualKey: 51, keyDown: false)!',
        'del_u.post(tap: .cghidEventTap)',
        'usleep(50000)',
      ].join('\n')
    : '';
  const swift = `import CoreGraphics
let src = CGEventSource(stateID: .hidSystemState)
${clearLines}
let codepoints: [UInt32] = [${codepoints.join(', ')}]
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
  const keyCode = OS_KEY_MAP[key];
  if (keyCode === undefined) throw new Error(`unknown key: ${key}`);
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
const app = Fastify({ logger: true });

function fail(req, reply, err) {
  if (err.message?.includes('(-1719)')) {
    req.log.warn({ reqId: req.id }, 'no browser window open');
    return reply
      .code(409)
      .send({
        error:
          'no browser window open — call POST /ensure-window or POST /navigate first',
      });
  }
  req.log.error({ err: err.message, stack: err.stack }, 'request failed');
  return reply.code(500).send({ error: 'internal error' });
}

await app.register(cors, { origin: true, methods: ['GET', 'POST', 'OPTIONS'] });

await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

await app.register(swagger, {
  openapi: {
    info: {
      title: 'chrome-bridge',
      version: '1.0.0',
      description:
        'HTTP bridge for controlling Chrome on macOS via AppleScript',
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
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!tokenMatches(provided))
    return reply.code(401).send({ error: 'unauthorized' });
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
          properties: { ok: { type: 'boolean' }, browser: { type: 'string' } },
        },
      },
    },
  },
  async () => ({ ok: true, browser: BROWSER }),
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
            state: { type: 'string' },
            status: { type: 'integer' },
          },
        },
      },
    },
  },
  async (req, reply) => {
    const { url, tab, wait = false, timeout_ms = 30_000 } = req.body || {};
    if (typeof url !== 'string' || !/^https?:\/\//.test(url))
      return reply.code(400).send({ error: 'url must be http(s) string' });
    try {
      await chromeNavigate(url, tab);
      if (wait) {
        const deadline = Date.now() + timeout_ms;
        while (Date.now() < deadline) {
          const state = await chromeReadyState(tab);
          if (state === 'complete') {
            const raw = await chromeEval(
              `String(performance.getEntriesByType('navigation')[0]?.responseStatus ?? '')`,
              timeout_ms,
              tab,
            );
            const status = raw ? parseInt(raw, 10) : undefined;
            return { ok: true, state, ...(status ? { status } : {}) };
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        return reply.code(408).send({ error: 'timeout waiting for ready' });
      }
      return { ok: true };
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
    },
  },
  async (req, reply) => {
    const { tab } = req.body || {};
    try {
      await osa(`tell application "${BROWSER}" to go back of ${tabRef(tab)}`);
      return { ok: true };
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
    },
  },
  async (req, reply) => {
    const { tab } = req.body || {};
    try {
      await osa(`tell application "${BROWSER}" to go forward of ${tabRef(tab)}`);
      return { ok: true };
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
        200: { type: 'object', properties: { state: { type: 'string' } } },
      },
    },
  },
  async (req, reply) => {
    const { tab } = req.query || {};
    try {
      const state = await chromeReadyState(tab);
      return { state };
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// POST /wait-for-ready { tab?, timeout_ms?, interval_ms? }
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
        },
      },
      response: {
        200: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, state: { type: 'string' } },
        },
      },
    },
  },
  async (req, reply) => {
    const { tab, timeout_ms = 30_000, interval_ms = 500 } = req.body || {};
    const deadline = Date.now() + timeout_ms;
    try {
      while (Date.now() < deadline) {
        const state = await chromeReadyState(tab);
        if (state === 'complete') return { ok: true, state };
        await new Promise((r) => setTimeout(r, interval_ms));
      }
      return reply
        .code(408)
        .send({ error: 'timeout waiting for ready', state: 'timeout' });
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
        200: { type: 'object', properties: { url: { type: 'string' } } },
      },
    },
  },
  async (req, reply) => {
    const { tab } = req.query || {};
    try {
      const url = await osa(
        `tell application "${BROWSER}" to get URL of ${tabRef(tab)}`,
      );
      return { url };
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
      return {
        url,
        title,
        scrollY,
        scrollHeight,
        innerHeight,
        tab: tab ? Number(tab) : 'active',
      };
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
        200: { type: 'object', properties: { text: { type: 'string' } } },
      },
    },
  },
  async (req, reply) => {
    const { tab } = req.query || {};
    try {
      const text = await chromeInnerText(tab);
      return { text };
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// POST /eval { js, tab?, timeout_ms?, parse_json? }
app.post(
  '/eval',
  {
    schema: {
      summary: 'Evaluate arbitrary JavaScript in the tab',
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
            description: 'Attempt to JSON.parse the result',
          },
        },
      },
    },
  },
  async (req, reply) => {
    const { js, tab, timeout_ms, parse_json = true } = req.body || {};
    if (typeof js !== 'string' || js.length === 0)
      return reply.code(400).send({ error: 'js must be non-empty string' });
    try {
      if (parse_json) {
        const wrapped = `JSON.stringify(eval(${JSON.stringify(js)}))`;
        const raw = await chromeEval(wrapped, timeout_ms, tab);
        try {
          const parsed = JSON.parse(raw);
          reply.type('application/json');
          return parsed;
        } catch {}
        reply.type('application/json');
        return { result: raw };
      }
      const raw = await chromeEval(js, timeout_ms, tab);
      reply.type('application/json');
      return { result: raw };
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
    },
  },
  async (req, reply) => {
    const { selector, x, y, tab, human_move = false, move_ms = 800 } = req.body || {};
    const hasSelector = typeof selector === 'string' && selector.length > 0;
    const hasCoords = x !== undefined && y !== undefined;
    if (!hasSelector && !hasCoords)
      return reply.code(400).send({ error: 'selector or x+y coordinates required' });
    try {
      if (hasSelector) {
        if (human_move) await humanMouseMove(selector, tab, move_ms);
        const js = `(function(){
          const el=document.querySelector(${JSON.stringify(selector)});
          if(!el) return JSON.stringify({ok:false,error:'element not found'});
          el.scrollIntoView({block:'center'}); el.click();
          return JSON.stringify({ok:true,tag:el.tagName,text:el.innerText?.slice(0,80)});
        })()`;
        return JSON.parse(await chromeEval(js, DEFAULT_TIMEOUT_MS, tab));
      } else {
        const cx = Number(x), cy = Number(y);
        if (human_move) {
          const screenRaw = await chromeEval(`JSON.stringify({
            x: Math.round(window.screenX + (window.outerWidth - window.innerWidth) / 2 + ${cx}),
            y: Math.round(window.screenY + (window.outerHeight - window.innerHeight) - (window.outerWidth - window.innerWidth) / 2 + ${cy})
          })`, DEFAULT_TIMEOUT_MS, tab);
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
        return JSON.parse(await chromeEval(js, DEFAULT_TIMEOUT_MS, tab));
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
    },
  },
  async (req, reply) => {
    const { selector, tab } = req.body || {};
    if (typeof selector !== 'string' || selector.length === 0)
      return reply
        .code(400)
        .send({ error: 'selector must be non-empty string' });
    try {
      const js = `(function(){
      const el=document.querySelector(${JSON.stringify(selector)});
      if(!el) return JSON.stringify({ok:false,error:'element not found'});
      el.focus(); el.scrollIntoView({block:'center'});
      return JSON.stringify({ok:true,tag:el.tagName,type:el.type||null});
    })()`;
      return JSON.parse(await chromeEval(js, DEFAULT_TIMEOUT_MS, tab));
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// POST /type { text, selector?, clear?, delay_ms?, tab? }
app.post(
  '/type',
  {
    schema: {
      summary: 'Type text via OS-level keyboard events',
      body: {
        type: 'object',
        required: ['text'],
        properties: {
          text: { type: 'string' },
          selector: {
            type: 'string',
            description: 'CSS selector to focus before typing (optional)',
          },
          clear: {
            type: 'boolean',
            default: true,
            description: 'Select all and delete before typing (Cmd+A then Delete)',
          },
          delay_ms: {
            type: 'integer',
            default: 30,
            minimum: 0,
            maximum: 500,
            description: 'Delay between keystrokes in ms',
          },
          tab: { type: 'integer', minimum: 1 },
        },
      },
    },
  },
  async (req, reply) => {
    const { text, selector, clear = true, delay_ms = 30, tab } = req.body || {};
    if (typeof text !== 'string')
      return reply.code(400).send({ error: 'text must be a string' });
    try {
      if (selector) {
        const focusJs = `(function(){
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return JSON.stringify({ok:false,error:'element not found'});
          el.focus();
          return JSON.stringify({ok:true});
        })()`;
        const focusResult = JSON.parse(await chromeEval(focusJs, DEFAULT_TIMEOUT_MS, tab));
        if (!focusResult.ok) return focusResult;
      }
      await osTypeText(text, { delayMs: delay_ms, clear });
      return { ok: true, chars: text.length };
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
    },
  },
  async (req, reply) => {
    const { selector, value, tab } = req.body || {};
    if (typeof selector !== 'string' || selector.length === 0)
      return reply
        .code(400)
        .send({ error: 'selector must be non-empty string' });
    if (typeof value !== 'string')
      return reply.code(400).send({ error: 'value must be a string' });
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
      return JSON.parse(await chromeEval(js, DEFAULT_TIMEOUT_MS, tab));
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// POST /scroll { x?, y?, selector?, tab? }
app.post(
  '/scroll',
  {
    schema: {
      summary: 'Scroll to coordinates or scroll element into view',
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
    },
  },
  async (req, reply) => {
    const { x = 0, y = 0, selector, tab } = req.body || {};
    try {
      const js = selector
        ? `(function(){ const el=document.querySelector(${JSON.stringify(selector)}); if(!el) return JSON.stringify({ok:false,error:'element not found'}); el.scrollIntoView({behavior:'smooth',block:'center'}); return JSON.stringify({ok:true}); })()`
        : `(function(){ window.scrollTo(${Number(x)},${Number(y)}); return JSON.stringify({ok:true,x:window.scrollX,y:window.scrollY}); })()`;
      return JSON.parse(await chromeEval(js, DEFAULT_TIMEOUT_MS, tab));
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
      return { ok: true, steps, finalY: steps[steps.length - 1]?.y };
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
    },
  },
  async (req, reply) => {
    const { selector, x, y, tab, human_move = false, move_ms = 800 } = req.body || {};
    const hasSelector = typeof selector === 'string' && selector.length > 0;
    const hasCoords = x !== undefined && y !== undefined;
    if (!hasSelector && !hasCoords)
      return reply.code(400).send({ error: 'selector or x+y coordinates required' });
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
        return JSON.parse(await chromeEval(js, DEFAULT_TIMEOUT_MS, tab));
      } else {
        const cx = Number(x), cy = Number(y);
        if (human_move) {
          const screenRaw = await chromeEval(`JSON.stringify({
            x: Math.round(window.screenX + (window.outerWidth - window.innerWidth) / 2 + ${cx}),
            y: Math.round(window.screenY + (window.outerHeight - window.innerHeight) - (window.outerWidth - window.innerWidth) / 2 + ${cy})
          })`, DEFAULT_TIMEOUT_MS, tab);
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
        return JSON.parse(await chromeEval(js, DEFAULT_TIMEOUT_MS, tab));
      }
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// POST /key { key }
// Supported keys: Enter, Return, Tab, Space, Backspace, Delete, Escape,
// ArrowLeft, ArrowRight, ArrowDown, ArrowUp, Home, End, PageUp, PageDown,
// F1–F12
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
              'Key name: "Enter", "Tab", "Escape", "ArrowDown", "Backspace", "F5", etc.',
          },
        },
      },
    },
  },
  async (req, reply) => {
    const { key } = req.body || {};
    if (typeof key !== 'string' || key.length === 0)
      return reply.code(400).send({ error: 'key must be non-empty string' });
    try {
      await osKeyPress(key);
      return { ok: true, key };
    } catch (err) {
      if (err.message?.startsWith('unknown key:'))
        return reply
          .code(400)
          .send({ error: err.message, supported: Object.keys(OS_KEY_MAP) });
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
          properties: { html: { type: 'string', nullable: true } },
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
      return { html: raw };
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
      return reply
        .code(400)
        .send({ error: 'selector must be non-empty string' });
    const deadline = Date.now() + timeout_ms;
    try {
      while (Date.now() < deadline) {
        const js = `(function(){ const el=document.querySelector(${JSON.stringify(selector)}); return el ? JSON.stringify({found:true,tag:el.tagName,text:el.innerText?.slice(0,80)}) : 'null'; })()`;
        const raw = await chromeEval(js, DEFAULT_TIMEOUT_MS, tab);
        if (raw && raw !== 'null') return JSON.parse(raw);
        await new Promise((r) => setTimeout(r, interval_ms));
      }
      return reply
        .code(408)
        .send({ error: 'timeout waiting for selector', selector });
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
      return { tabs };
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
    },
  },
  async (req, reply) => {
    const { url } = req.body || {};
    try {
      await osa(
        `tell application "${BROWSER}" to tell window 1 to make new tab`,
      );
      if (url && /^https?:\/\//.test(url)) await chromeNavigate(url);
      return { ok: true };
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
    },
  },
  async (req, reply) => {
    const { index } = req.body || {};
    if (!Number.isInteger(Number(index)) || Number(index) < 1)
      return reply
        .code(400)
        .send({ error: 'index must be a positive integer' });
    try {
      await osa(
        `tell application "${BROWSER}" to set active tab index of window 1 to ${Number(index)}`,
      );
      return { ok: true };
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
    },
  },
  async (req, reply) => {
    try {
      await ensureWindow();
      return { ok: true };
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
  async (req, reply) => {
    try {
      const { base64, width, height, dpr } = await screenshotViewport();
      return { mime: 'image/png', width, height, dpr, image: base64 };
    } catch (err) {
      return fail(req, reply, err);
    }
  },
);

// POST /batch { pauseBetween?, batch: [{ func, method?, data? }, ...] }
// Runs a sequence of internal endpoint calls. Method defaults to POST if data
// is provided, GET otherwise. The caller's Authorization header is forwarded.
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
  async (req, reply) => {
    const { pauseBetween = 0, batch } = req.body || {};
    if (!Array.isArray(batch))
      return reply.code(400).send({ error: 'batch must be an array' });

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

    return { results };
  },
);

// ─── boot ────────────────────────────────────────────────────────────
app
  .listen({ port: PORT, host: HOST })
  .then(() => console.log(`chrome-bridge listening on http://${HOST}:${PORT}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
