import os
import json
import requests
from pydantic import Field


class Tools:
    def __init__(self):
        self.base_url = os.getenv("CHROME_BRIDGE_URL").rstrip("/")
        self.token = os.getenv("CHROME_BRIDGE_TOKEN")
        self.timeout = 90

    def _request(self, method: str, path: str, **kwargs) -> dict:
        if not self.token:
            return {"error": "BRIDGE_TOKEN env var is not set"}
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
                return {"status": response.status_code, "text": response.text}
        except requests.RequestException as e:
            return {"error": f"request failed: {e}"}

    def navigate(
        self,
        url: str = Field(..., description="The http(s) URL to navigate to."),
        wait: bool = Field(
            True, description="If true, block until the page finishes loading."
        ),
    ) -> str:
        """
        Navigate the active Chrome tab to a URL.
        """
        return json.dumps(
            self._request("POST", "/navigate", json={"url": url, "wait": wait})
        )

    def get_state(self) -> str:
        """
        Get the active tab's URL, title, and scroll position.
        """
        return json.dumps(self._request("GET", "/state"))

    def get_inner_text(self) -> str:
        """
        Get the rendered text (document.body.innerText) of the active tab.
        Useful for reading the visible content of a page.
        """
        return json.dumps(self._request("GET", "/inner-text"))

    def get_html(
        self,
        selector: str = Field(
            "",
            description="CSS selector to return outerHTML for. Empty for full body.innerHTML.",
        ),
    ) -> str:
        """
        Get the outerHTML of an element matching a CSS selector, or the entire
        document body HTML if no selector is given.
        """
        body = {"selector": selector} if selector else {}
        return json.dumps(self._request("POST", "/get-html", json=body))

    def click(
        self,
        selector: str = Field(
            ..., description="CSS selector for the element to click."
        ),
    ) -> str:
        """
        Click the first element matching a CSS selector.
        """
        return json.dumps(
            self._request("POST", "/click", json={"selector": selector})
        )

    def type_text(
        self,
        selector: str = Field(
            ..., description="CSS selector for the input or textarea to type into."
        ),
        text: str = Field(..., description="The text to enter into the element."),
        clear: bool = Field(
            True, description="Clear the existing value before typing."
        ),
    ) -> str:
        """
        Set the value of an input or textarea, firing input and change events.
        """
        return json.dumps(
            self._request(
                "POST",
                "/type",
                json={"selector": selector, "text": text, "clear": clear},
            )
        )

    def press_key(
        self,
        key: str = Field(
            ...,
            description='Key name to press, e.g. "Enter", "Tab", "Escape", "ArrowDown".',
        ),
        selector: str = Field(
            "",
            description="Optional CSS selector to dispatch the key on; defaults to the focused element.",
        ),
    ) -> str:
        """
        Dispatch a keydown/keyup event for a named key.
        """
        body = {"key": key}
        if selector:
            body["selector"] = selector
        return json.dumps(self._request("POST", "/key", json=body))

    def scroll_to(
        self,
        y: int = Field(0, description="Absolute Y coordinate to scroll to."),
    ) -> str:
        """
        Scroll the page to an absolute Y coordinate.
        """
        return json.dumps(self._request("POST", "/scroll", json={"y": y}))

    def scroll_into_view(
        self,
        selector: str = Field(
            ..., description="CSS selector for the element to scroll into view."
        ),
    ) -> str:
        """
        Smoothly scroll the element matching a CSS selector into view.
        """
        return json.dumps(
            self._request("POST", "/scroll", json={"selector": selector})
        )

    def scroll_down(
        self,
        pixels: int = Field(800, description="Pixels to scroll per step."),
        times: int = Field(
            3, description="Number of scroll steps (max 20). Useful for infinite feeds."
        ),
    ) -> str:
        """
        Scroll down repeatedly. Useful for loading more content in infinite-scroll pages.
        """
        return json.dumps(
            self._request(
                "POST", "/scroll-down", json={"pixels": pixels, "times": times}
            )
        )

    def wait_for_selector(
        self,
        selector: str = Field(..., description="CSS selector to wait for."),
        timeout_ms: int = Field(
            15000, description="Maximum time to wait in milliseconds."
        ),
    ) -> str:
        """
        Block until a CSS selector matches an element in the page, or time out.
        """
        return json.dumps(
            self._request(
                "POST",
                "/wait-for-selector",
                json={"selector": selector, "timeout_ms": timeout_ms},
            )
        )

    def list_tabs(self) -> str:
        """
        List all open browser tabs across every window, with their URLs and titles.
        """
        return json.dumps(self._request("GET", "/tabs"))

    def new_tab(
        self,
        url: str = Field(
            "", description="Optional http(s) URL to load in the new tab."
        ),
    ) -> str:
        """
        Open a new browser tab, optionally navigating it to a URL.
        """
        body = {"url": url} if url else {}
        return json.dumps(self._request("POST", "/new-tab", json=body))

    def switch_tab(
        self,
        index: int = Field(
            ..., description="1-based index of the tab to activate in window 1."
        ),
    ) -> str:
        """
        Activate (focus) a tab in the frontmost window by its 1-based index.
        """
        return json.dumps(
            self._request("POST", "/switch-tab", json={"index": index})
        )

    def screenshot(self) -> str:
        """
        Capture the visible viewport of the frontmost browser window as a base64 PNG.
        """
        return json.dumps(self._request("GET", "/screenshot"))

    def eval_js(
        self,
        js: str = Field(
            ..., description="JavaScript source to evaluate inside the active tab."
        ),
    ) -> str:
        """
        Evaluate arbitrary JavaScript inside the active tab and return the result.
        Escape hatch for anything the other tools do not cover.
        """
        return json.dumps(self._request("POST", "/eval", json={"js": js}))
