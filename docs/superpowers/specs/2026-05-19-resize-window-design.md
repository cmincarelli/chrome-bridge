# Design: POST /resize-window

**Date:** 2026-05-19

## Summary

Add a `POST /resize-window` route that resizes Chrome's frontmost window (window 1) to the specified dimensions while preserving its current screen position.

## Route

`POST /resize-window`

### Request body

| Field    | Type    | Required | Description                    |
|----------|---------|----------|--------------------------------|
| `width`  | integer | yes      | Target window width in pixels  |
| `height` | integer | yes      | Target window height in pixels |

### Response

```json
{ "ok": true, "width": 1280, "height": 800 }
```

### Errors

- `400` — `width` or `height` missing or not a positive integer
- `500` — AppleScript failure (no window open, etc.)

## Implementation

Two AppleScript calls via `osa()`:

1. Read current bounds: `get bounds of window 1` → returns `{left, top, right, bottom}`
2. Set new bounds: `set bounds of window 1 to {left, top, left+width, top+height}`

No JS / `chromeEval` needed — this is pure window management with no tab involvement.

## Constraints

- Targets window 1 only (consistent with all other write operations in the codebase).
- AppleScript will clamp to screen bounds naturally if dimensions exceed the display.
- No repositioning — top-left position is preserved from the current bounds.
