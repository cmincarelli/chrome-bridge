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
