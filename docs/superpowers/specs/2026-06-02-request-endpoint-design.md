# `/request` endpoint spec

Low-level browser-request primitive for Chrome Bridge.

## Goal

Allow callers to initiate HTTP-style requests from the selected Chrome tab with explicit control over whether the operation is:

1. a JavaScript-context request whose response is captured and returned, or
2. a browser/form-context navigation that behaves like a user-submitted form.

This fills the current gap where `/navigate` can only perform URL navigations, effectively `GET`.

## Endpoint

```http
POST /request
Authorization: Bearer <BRIDGE_TOKEN>
Content-Type: application/json
```

## Common request body

```json
{
  "tab": 1,
  "mode": "javascript",
  "method": "POST",
  "url": "https://example.com/path",
  "headers": {},
  "body": {},
  "body_type": "json",
  "credentials": "include",
  "wait": true,
  "timeout_ms": 30000,
  "response_type": "json"
}
```

## Modes

### `mode: "javascript"`

Runs a request from the page's JavaScript context. This is a structured wrapper around JavaScript executed with `chromeEval()`.

Use this when the caller wants:

- `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, or `OPTIONS`
- custom request headers
- JSON/text request bodies
- response status, response headers, and response body returned to the API caller
- no tab navigation

Browser rules still apply:

- CORS applies.
- Cookie/session behavior follows `credentials`.
- The request originates from the selected tab's current page context.

### `mode: "browser"`

Performs a browser/form-context navigation by creating and submitting a temporary form in the selected tab.

Use this when the caller wants:

- the tab to navigate to the submitted response page
- behavior similar to a user submitting an HTML form
- `GET` or `POST` form submission
- framework-style method overrides for logical `PUT`, `PATCH`, or `DELETE`

Native HTML forms submit only `GET` and `POST`. To support logical `PUT`, `PATCH`, or `DELETE`, callers must provide `method_override`, e.g. `"_method"`. The bridge will submit a `POST` form containing the override field.

## Fields

| Field | Type | Modes | Default | Description |
|---|---:|---|---:|---|
| `mode` | string | both | `javascript` | `javascript` or `browser` |
| `url` | string | both | — | Required `http(s)` URL |
| `method` | string | both | `GET` | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, or `OPTIONS` |
| `tab` | integer | both | active tab | 1-based tab index in window 1 |
| `headers` | object | javascript | `{}` | Request headers for JS request mode |
| `body` | string/object/null | both | omitted | Request body. Ignored for `GET`/`HEAD` in JS mode. Form fields in browser mode |
| `body_type` | string | javascript | inferred | `json`, `form`, or `text`; only `form` changes encoding. Object bodies otherwise serialize as JSON. Browser mode always treats `body` as form fields. |
| `credentials` | string | javascript | `same-origin` | `omit`, `same-origin`, or `include` |
| `response_type` | string | javascript | `text` | `text`, `json`, `base64`, or `none` |
| `wait` | boolean | both | `true` for javascript, `false` for browser | Wait for request completion/page load |
| `timeout_ms` | integer | both | `30000` | Timeout |
| `max_body_chars` | integer | javascript | `1000000` | Maximum returned response text chars |
| `method_override` | string | browser | omitted | Hidden form field name used for logical `PUT`/`PATCH`/`DELETE`, commonly `_method` |

## Body handling

### JavaScript mode

- `GET` and `HEAD` omit the body even if `body` is provided.
- String `body` values are sent as-is.
- Object `body` + `body_type: "form"` serializes with `URLSearchParams` and sets `content-type: application/x-www-form-urlencoded;charset=UTF-8` unless the caller already supplied a content type.
- Object `body` with any other/missing `body_type` serializes with `JSON.stringify` and sets `content-type: application/json` unless the caller already supplied a content type.
- `body_type: "text"` currently behaves like JSON for non-string object bodies; use a string `body` when exact text is required.

### Browser mode

- `body` must be an object of form fields.
- Array field values become repeated form inputs with the same name.
- Nested objects are stringified with JavaScript `String(value)`, which usually becomes `[object Object]`; callers should flatten fields first.
- Custom headers are rejected.
- `body_type`, `credentials`, `response_type`, and `max_body_chars` do not apply.

## JavaScript mode response

When `wait: true`:

```json
{
  "ok": true,
  "mode": "javascript",
  "status": 200,
  "statusText": "OK",
  "url": "https://example.com/path",
  "redirected": false,
  "headers": {
    "content-type": "application/json"
  },
  "body": {}
}
```

`ok` means the browser request completed. HTTP errors like `404` still return `ok: true` with `status: 404`.

When `wait: false`:

```json
{
  "ok": true,
  "mode": "javascript",
  "id": "request-id",
  "dispatched": true
}
```

Planned behavior: `wait:false` would be fire-and-forget — the request is dispatched and its response is **not** captured. Storing request state in the page and a retrieval endpoint are **out of scope** for an initial implementation; if async retrieval is needed later, it should be a separate plan. *(No implementation of `/request` exists today; this note describes intent, not current code.)*

## Browser mode response

When `wait: true`:

```json
{
  "ok": true,
  "mode": "browser",
  "state": "complete",
  "url": "https://example.com/result",
  "title": "Result"
}
```

When `wait: false`:

```json
{
  "ok": true,
  "mode": "browser",
  "submitted": true
}
```

## Validation notes

- `url` must be an `http(s)` string.
- `mode` must be `javascript` or `browser`.
- `method` must be one of the supported methods.
- `browser` mode rejects custom `headers`; native form submission cannot set arbitrary headers.
- `browser` mode accepts native `GET` and `POST` directly.
- `browser` mode accepts logical `PUT`, `PATCH`, and `DELETE` only with `method_override`.
- `browser` mode rejects `HEAD` and `OPTIONS`.
- `browser` mode requires `document.body` to exist in the selected tab because it appends the temporary form there.
- Internal Node/AppleScript failures must use existing `fail(req, reply, err)` behavior and avoid leaking internal error messages.

## Examples

### JavaScript JSON POST and parse JSON response

```sh
curl -sX POST "$URL/request" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "mode": "javascript",
    "method": "POST",
    "url": "https://example.com/api",
    "body": {"hello":"world"},
    "response_type": "json",
    "credentials": "include"
  }'
```

### Browser form POST that navigates the tab

```sh
curl -sX POST "$URL/request" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "mode": "browser",
    "method": "POST",
    "url": "https://example.com/form-submit",
    "body": {"name":"Chris"},
    "wait": true
  }'
```

### Browser form method override

```sh
curl -sX POST "$URL/request" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "mode": "browser",
    "method": "DELETE",
    "method_override": "_method",
    "url": "https://example.com/items/123",
    "body": {},
    "wait": true
  }'
```
