"""
Sample Ollama tool-calling client for chrome-bridge.

Reference implementation showing how to wrap the chrome-bridge HTTP API as
Ollama tool definitions. Each method returns a JSON string (as Ollama tools
expect) and the response body from the server always uses the uniform envelope:

    {"ok": true, "data": <endpoint-specific>}      # success (HTTP 200)
    {"ok": false, "error": "...", ...extras}        # failure (4xx/5xx)

Set CHROME_BRIDGE_URL and CHROME_BRIDGE_TOKEN in the environment before use.

These signatures mirror the current server routes (see server.js / /docs/json).
The /type and /key helpers type/press into whatever element has focus — they
use OS-level keyboard events and do not take a CSS selector.

Parameter metadata uses pydantic v2's Annotated[...] = default idiom so the
Field description is exposed to Ollama's tool schema while a real default value
is bound at runtime (using Field(...) directly as a default leaks a FieldInfo
object into the call and breaks JSON serialization).
"""

import os
import json
from typing import Annotated

import requests
from pydantic import Field


class Tools:
    def __init__(self):
        self.base_url = os.getenv("CHROME_BRIDGE_URL").rstrip("/")
        self.token = os.getenv("CHROME_BRIDGE_TOKEN")
        self.timeout = 90

    def _request(self, method: str, path: str, **kwargs) -> dict:
        if not self.token:
            return {"ok": False, "error": "CHROME_BRIDGE_TOKEN env var is not set"}
        headers = kwargs.pop("headers", {})
        headers["Authorization"] = f"Bearer {self.token}"
        try:
            response = requests.request(
                method,
                f"{self.base_url}{path}",
                headers=headers,
                timeout=self.timeout,
                **kwargs,
            )
            try:
                return response.json()
            except ValueError:
                return {
                    "ok": False,
                    "error": "non-JSON response",
                    "status": response.status_code,
                    "text": response.text,
                }
        except requests.RequestException as e:
            return {"ok": False, "error": f"request failed: {e}"}

    # ── navigation ────────────────────────────────────────────────────

    def navigate(
        self,
        url: Annotated[str, Field(description="The http(s) URL to navigate to.")],
        wait: Annotated[
            bool, Field(description="If true, block until the page finishes loading.")
        ] = True,
    ) -> str:
        """
        Navigate the active Chrome tab to a URL. With wait=true, returns the
        final readyState and the page's HTTP status code.
        """
        return json.dumps(
            self._request("POST", "/navigate", json={"url": url, "wait": wait})
        )

    def back(self) -> str:
        """Navigate back in the active tab's browser history."""
        return json.dumps(self._request("POST", "/back", json={}))

    def forward(self) -> str:
        """Navigate forward in the active tab's browser history."""
        return json.dumps(self._request("POST", "/forward", json={}))

    # ── reads ─────────────────────────────────────────────────────────

    def ready_state(self) -> str:
        """Get document.readyState of the active tab ('loading'|'interactive'|'complete')."""
        return json.dumps(self._request("GET", "/ready-state"))

    def wait_for_ready(
        self,
        timeout_ms: Annotated[
            int, Field(description="Maximum time to wait in milliseconds.")
        ] = 30000,
        interval_ms: Annotated[
            int, Field(description="Polling interval in milliseconds.")
        ] = 500,
    ) -> str:
        """Poll until document.readyState === 'complete' or time out."""
        return json.dumps(
            self._request(
                "POST",
                "/wait-for-ready",
                json={"timeout_ms": timeout_ms, "interval_ms": interval_ms},
            )
        )

    def get_url(self) -> str:
        """Get the active tab's current URL."""
        return json.dumps(self._request("GET", "/url"))

    def get_state(self) -> str:
        """Get the active tab's URL, title, and scroll position/viewport."""
        return json.dumps(self._request("GET", "/state"))

    def get_inner_text(self) -> str:
        """Get the rendered text (document.body.innerText) of the active tab."""
        return json.dumps(self._request("GET", "/inner-text"))

    def get_html(
        self,
        selector: Annotated[
            str,
            Field(
                description="CSS selector to return outerHTML for. Empty for full body.innerHTML."
            ),
        ] = "",
    ) -> str:
        """Get the outerHTML of an element matching a CSS selector, or document.body.innerHTML."""
        body = {"selector": selector} if selector else {}
        return json.dumps(self._request("POST", "/get-html", json=body))

    def eval_js(
        self,
        js: Annotated[
            str, Field(description="JavaScript source to evaluate inside the active tab.")
        ],
        parse_json: Annotated[
            bool,
            Field(
                description="If true (default), data is the JSON-parsed JS return value (any type). "
                "If false, data is the raw string result."
            ),
        ] = True,
    ) -> str:
        """
        Evaluate arbitrary JavaScript inside the active tab and return the result
        (any JSON type) in `data`. Escape hatch for anything the other tools do
        not cover.
        """
        return json.dumps(
            self._request("POST", "/eval", json={"js": js, "parse_json": parse_json})
        )

    # ── interaction ──────────────────────────────────────────────────

    def click(
        self,
        selector: Annotated[
            str,
            Field(
                description="CSS selector for the element to click. Required unless x+y are given."
            ),
        ] = "",
        x: Annotated[
            int,
            Field(description="Viewport x coordinate to click (alternative to selector)."),
        ] = None,
        y: Annotated[
            int,
            Field(description="Viewport y coordinate to click (alternative to selector)."),
        ] = None,
        human_move: Annotated[
            bool,
            Field(
                description="Move the cursor to the target in a human-like path before clicking."
            ),
        ] = False,
    ) -> str:
        """Click by CSS selector or viewport coordinates. Provide selector OR both x and y."""
        body = {"human_move": human_move}
        if selector:
            body["selector"] = selector
        if x is not None and y is not None:
            body["x"], body["y"] = x, y
        return json.dumps(self._request("POST", "/click", json=body))

    def focus(
        self,
        selector: Annotated[
            str, Field(description="CSS selector for the element to focus.")
        ],
    ) -> str:
        """Focus the first element matching a CSS selector."""
        return json.dumps(
            self._request("POST", "/focus", json={"selector": selector})
        )

    def hover(
        self,
        selector: Annotated[
            str,
            Field(description="CSS selector to hover. Required unless x+y are given."),
        ] = "",
        x: Annotated[
            int, Field(description="Viewport x coordinate (alternative to selector).")
        ] = None,
        y: Annotated[
            int, Field(description="Viewport y coordinate (alternative to selector).")
        ] = None,
        human_move: Annotated[
            bool,
            Field(description="Move the cursor in a human-like path before hovering."),
        ] = False,
    ) -> str:
        """Dispatch mouseover/mouseenter by CSS selector or viewport coordinates."""
        body = {"human_move": human_move}
        if selector:
            body["selector"] = selector
        if x is not None and y is not None:
            body["x"], body["y"] = x, y
        return json.dumps(self._request("POST", "/hover", json=body))

    def type_text(
        self,
        text: Annotated[str, Field(description="The text to type.")],
        delay_ms: Annotated[
            int, Field(description="Delay between keystrokes in milliseconds (0–500).")
        ] = 30,
    ) -> str:
        """
        Type text via OS-level keyboard events into whatever element currently has
        focus. Use focus() first to target a specific input. Does NOT clear the
        field first (the OS-level Cmd+A used to do so interfered with Chrome);
        call press_key("SelectAll") then press_key("Delete") if you need to clear.
        """
        return json.dumps(
            self._request("POST", "/type", json={"text": text, "delay_ms": delay_ms})
        )

    def press_key(
        self,
        key: Annotated[
            str,
            Field(
                description='Key name: "Enter", "Tab", "Escape", "ArrowDown", "Backspace", "F5", '
                '"SelectAll", "Copy", "Paste", etc.'
            ),
        ],
    ) -> str:
        """
        Send an OS-level key press to the frontmost Chrome window. Acts on the
        focused element. Supported keys include Enter, Tab, Space, Backspace,
        Delete, Escape, Arrow*, Home/End/PageUp/PageDown, F1–F12, SelectAll,
        Copy, Paste.
        """
        return json.dumps(self._request("POST", "/key", json={"key": key}))

    def select_option(
        self,
        selector: Annotated[
            str, Field(description="CSS selector for the <select> element.")
        ],
        value: Annotated[
            str, Field(description="Option value or visible text to select.")
        ],
    ) -> str:
        """Set a <select> dropdown value by option value or visible text."""
        return json.dumps(
            self._request(
                "POST", "/select", json={"selector": selector, "value": value}
            )
        )

    # ── scrolling ────────────────────────────────────────────────────

    def scroll_to(
        self,
        x: Annotated[int, Field(description="Absolute X coordinate to scroll to.")] = 0,
        y: Annotated[int, Field(description="Absolute Y coordinate to scroll to.")] = 0,
    ) -> str:
        """
        Scroll the page to absolute coordinates. Returns requested-vs-actual
        position and a `clamped` flag (true when the page could not reach the
        requested coordinates, e.g. target y exceeds scrollHeight).
        """
        return json.dumps(self._request("POST", "/scroll", json={"x": x, "y": y}))

    def scroll_into_view(
        self,
        selector: Annotated[
            str, Field(description="CSS selector for the element to scroll into view.")
        ],
    ) -> str:
        """Smoothly scroll the element matching a CSS selector into view."""
        return json.dumps(self._request("POST", "/scroll", json={"selector": selector}))

    def scroll_down(
        self,
        pixels: Annotated[int, Field(description="Pixels to scroll per step.")] = 800,
        times: Annotated[
            int,
            Field(description="Number of scroll steps (max 20). Useful for infinite feeds."),
        ] = 3,
        delay_ms: Annotated[
            int, Field(description="Delay between steps in milliseconds.")
        ] = 800,
    ) -> str:
        """Scroll down repeatedly. Useful for loading more content in infinite-scroll pages."""
        return json.dumps(
            self._request(
                "POST",
                "/scroll-down",
                json={"pixels": pixels, "times": times, "delay_ms": delay_ms},
            )
        )

    # ── waiting ───────────────────────────────────────────────────────

    def wait_for_selector(
        self,
        selector: Annotated[str, Field(description="CSS selector to wait for.")],
        timeout_ms: Annotated[
            int, Field(description="Maximum time to wait in milliseconds.")
        ] = 15000,
        interval_ms: Annotated[
            int, Field(description="Polling interval in milliseconds.")
        ] = 500,
    ) -> str:
        """Block until a CSS selector matches an element in the page, or time out."""
        return json.dumps(
            self._request(
                "POST",
                "/wait-for-selector",
                json={"selector": selector, "timeout_ms": timeout_ms, "interval_ms": interval_ms},
            )
        )

    # ── tabs / windows ───────────────────────────────────────────────

    def list_tabs(self) -> str:
        """List all open browser tabs across every window, with their URLs and titles."""
        return json.dumps(self._request("GET", "/tabs"))

    def new_tab(
        self,
        url: Annotated[
            str, Field(description="Optional http(s) URL to load in the new tab.")
        ] = "",
    ) -> str:
        """Open a new browser tab, optionally navigating it to a URL."""
        body = {"url": url} if url else {}
        return json.dumps(self._request("POST", "/new-tab", json=body))

    def switch_tab(
        self,
        index: Annotated[
            int, Field(description="1-based index of the tab to activate in window 1.")
        ],
    ) -> str:
        """Activate (focus) a tab in the frontmost window by its 1-based index."""
        return json.dumps(
            self._request("POST", "/switch-tab", json={"index": index})
        )

    def ensure_window(self) -> str:
        """Activate Chrome and ensure at least one window/tab exists."""
        return json.dumps(self._request("POST", "/ensure-window"))

    def resize_window(
        self,
        width: Annotated[int, Field(description="Target window width in pixels.")],
        height: Annotated[int, Field(description="Target window height in pixels.")],
    ) -> str:
        """Resize the frontmost browser window (preserves its top-left position)."""
        return json.dumps(
            self._request("POST", "/resize-window", json={"width": width, "height": height})
        )

    # ── capture / batching ───────────────────────────────────────────

    def screenshot(self) -> str:
        """Capture the visible viewport of the frontmost browser window as a base64 PNG."""
        return json.dumps(self._request("GET", "/screenshot"))

    def batch(
        self,
        steps: Annotated[
            list,
            Field(
                description='List of step objects: {"func":"/path","method?":"GET|POST","data":{...}}.'
            ),
        ],
        pause_between: Annotated[
            int, Field(description="Milliseconds to pause between steps.")
        ] = 0,
    ) -> str:
        """
        Run a sequence of internal endpoint calls. Each step re-runs auth/rate-limit/
        validation. Returns one result per step: {ok, status, body}. Recursive
        /batch calls are rejected.
        """
        return json.dumps(
            self._request(
                "POST",
                "/batch",
                json={"batch": steps, "pauseBetween": pause_between},
            )
        )
