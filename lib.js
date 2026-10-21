// Pure helpers for chrome-bridge. No I/O, no AppleScript, no Fastify,
// no module-level side effects. Safe to import from tests.

export function asString(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function tabRef(tab) {
  return tab
    ? `tab ${Math.max(1, Number(tab))} of window 1`
    : `active tab of window 1`;
}

export function defaultPort(protocol) {
  return protocol === 'https:' ? '443' : protocol === 'http:' ? '80' : '';
}

export function urlsMatch(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    if (ua.protocol !== ub.protocol) return false;
    if (ua.hostname.toLowerCase() !== ub.hostname.toLowerCase()) return false;
    const portA = ua.port || defaultPort(ua.protocol);
    const portB = ub.port || defaultPort(ub.protocol);
    if (portA !== portB) return false;
    // Ignore hash; normalize empty pathname to "/".
    const norm = (p) => (p === '' ? '/' : p);
    if (norm(ua.pathname) !== norm(ub.pathname)) return false;
    if (ua.search !== ub.search) return false;
    return true;
  } catch {
    return false;
  }
}

export function humanPath(x0, y0, x1, y1, steps) {
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

// Navigation pace tracking — feedback only, never blocks. In-memory sliding
// window; resets on restart (acceptable for a single-user bridge).
export const PACE_MIN_INTERVAL_S = 2;
export const PACE_WARN_PER_MINUTE = 10;
export const PACE_WARN_HOST_PER_MINUTE = 6;
export const PACE_WARN_WAIT_S = 30;
const PACE_WINDOW_MS = 10 * 60_000;

// Factory: returns a recordNavigation(url) closure holding its own navigation
// history. nowFn is injectable for tests.
export function createPaceTracker(nowFn = Date.now) {
  const history = []; // [{ t: epochMs, host: string|null }]
  return function recordNavigation(url) {
    const now = nowFn();
    let host = null;
    try {
      host = new URL(url).hostname;
    } catch {
      /* url is validated upstream; defensive only */
    }
    // prune entries outside the 10-minute window
    while (history.length && now - history[0].t > PACE_WINDOW_MS)
      history.shift();
    const prev = history.length ? history[history.length - 1] : null;
    history.push({ t: now, host });
    const lastMinute = history.filter((n) => now - n.t <= 60_000);
    const sameHost = host ? lastMinute.filter((n) => n.host === host).length : 0;
    const warn =
      lastMinute.length >= PACE_WARN_PER_MINUTE ||
      (host && sameHost >= PACE_WARN_HOST_PER_MINUTE);
    const suggested = warn ? PACE_WARN_WAIT_S : PACE_MIN_INTERVAL_S;
    const pace = {
      navigations_last_minute: lastMinute.length,
      navigations_last_10_minutes: history.length,
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
  };
}

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
