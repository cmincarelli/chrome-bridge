# Human Mouse Move — Design Spec

**Date:** 2026-05-17  
**Status:** Approved

## Summary

Add an optional `human_move` flag to `/hover` and `/click` that moves the real macOS cursor from its current position to the target element in a human-like curved path before performing the action. Implemented via AppleScript `System Events` — no external dependencies.

## API Changes

### `POST /hover`

New optional fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `human_move` | boolean | `false` | Move cursor to element before dispatching hover events |
| `move_ms` | integer | `800` | Total move duration in milliseconds |

### `POST /click`

Same two new optional fields with the same defaults. The cursor arrives at the element center, then the existing `el.click()` JS executes.

No new routes.

## Implementation

### Helper: `humanMouseMove(selector, tab, moveMsTotal)`

A new server.js helper function. Steps:

1. **Get target screen coordinates** via `chromeEval`:
   ```js
   const rect = el.getBoundingClientRect();
   const vx = window.screenX + (window.outerWidth - window.innerWidth) / 2;
   const vy = window.screenY + (window.outerHeight - window.innerHeight)
              - ((window.outerWidth - window.innerWidth) / 2);
   return JSON.stringify({ x: vx + rect.left + rect.width/2,
                           y: vy + rect.top + rect.height/2 });
   ```
   No DPR scaling — System Events uses logical (point) coordinates.

2. **Get current cursor position** via `osa`:
   ```applescript
   tell application "System Events" to get the position of the cursor
   ```
   Parse the `"x, y"` string response.

3. **Generate path in Node.js** (pure math, no deps):
   - Compute one random Bézier control point offset perpendicular to the straight line by a random fraction (0–40%) of the total distance.
   - Step count = `clamp(Math.round(move_ms / 16), 50, 120)` — ~60fps pacing, clamped so short moves aren't choppy and long moves don't generate huge scripts.
   - Interpolate that many steps along the quadratic Bézier curve with ease-in-out timing (`t = raw < 0.5 ? 2t² : 1 - 2(1-t)²`).
   - Add Gaussian-approximated noise (sum of two uniform randoms) scaled by `min(t, 1-t)` so endpoints are clean.
   - If start ≈ end (distance < 5px), skip path generation and return early.

4. **Move cursor via one AppleScript call**:
   Build a single AppleScript with all waypoints and a `delay` between each:
   ```applescript
   tell application "System Events"
     set the position of the cursor to {x1, y1}
     delay 0.016
     set the position of the cursor to {x2, y2}
     delay 0.016
     ...
   end tell
   ```
   `delay = move_ms / steps / 1000` seconds. `move_ms` clamped to 200–5000ms.

### Modified Routes

- `/hover`: if `human_move`, call `humanMouseMove(selector, tab, move_ms)` before dispatching DOM events.
- `/click`: if `human_move`, call `humanMouseMove(selector, tab, move_ms)` before `el.click()`.
- If `humanMouseMove` throws, propagate to `fail()` — don't silently skip, as the caller asked for it.

### Schema Updates

Both `/hover` and `/click` schemas gain:
```json
"human_move": { "type": "boolean", "default": false },
"move_ms":    { "type": "integer", "default": 800, "minimum": 200, "maximum": 5000 }
```

## Error Handling

- Element not found → existing `{ok: false, error: 'element not found'}` path (unchanged).
- `System Events` permission denied (Accessibility not granted) → `fail()` with 500; the error log will show the AppleScript `-1743` error code. No special casing needed beyond what `fail()` already does.
- If `human_move: false` (default), zero new code paths execute.

## Constraints

- Requires macOS Accessibility permissions for the terminal/process running the server (`System Preferences → Privacy & Security → Accessibility`).
- Only moves cursor to element center. Sub-element targeting (e.g., a specific corner) is out of scope.
- Multi-window tab targeting follows the existing convention (`window 1` only for writes).
