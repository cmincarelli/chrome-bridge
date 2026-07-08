import test from "node:test";
import assert from "node:assert/strict";

import {
  VIEWPORT_ORIGIN_FIELDS_JS,
  asString,
  defaultPort,
  humanPath,
  tabRef,
  urlsMatch,
  viewportToScreenExpr,
} from "../lib.js";

test("asString escapes AppleScript-sensitive characters", () => {
  assert.equal(asString('a\\b"c'), 'a\\\\b\\"c');
  assert.equal(asString("clean string"), "clean string");
  assert.equal(asString(""), "");
});

test("tabRef targets active tab or clamps numeric tab references", () => {
  assert.equal(tabRef(2), "tab 2 of window 1");
  assert.equal(tabRef(), "active tab of window 1");
  assert.equal(tabRef(0), "active tab of window 1");
  assert.equal(tabRef(-3), "tab 1 of window 1");
  assert.equal(tabRef("5"), "tab 5 of window 1");
});

test("defaultPort returns protocol defaults", () => {
  assert.equal(defaultPort("https:"), "443");
  assert.equal(defaultPort("http:"), "80");
  assert.equal(defaultPort("foo:"), "");
});

test("urlsMatch compares normalized URLs without ignoring meaningful differences", () => {
  assert.equal(urlsMatch("https://a.com/x?y=1#one", "https://a.com/x?y=1#one"), true);
  assert.equal(urlsMatch("https://a.com/x#one", "https://a.com/x#two"), true);
  assert.equal(urlsMatch("https://a.com/a", "https://a.com/a/"), false);
  assert.equal(urlsMatch("https://A.COM/x", "https://a.com/x"), true);
  assert.equal(urlsMatch("https://a.com:443/x", "https://a.com/x"), true);
  assert.equal(urlsMatch("https://a.com/x", "https://a.com/y"), false);
  assert.equal(urlsMatch("https://a.com/x?a=1", "https://a.com/x?a=2"), false);
  assert.equal(urlsMatch("https://a.com/x", "https://b.com/x"), false);
  assert.equal(urlsMatch("https://a.com/x", "http://a.com/x"), false);
  assert.equal(urlsMatch("not a url", "https://a.com"), false);
  assert.equal(urlsMatch("", ""), false);
});

test("humanPath returns structured point arrays with stable endpoints", () => {
  const path = humanPath(1.2, 2.6, 9.7, 10.1, 4);
  assert.equal(path.length, 5);
  assert.deepEqual(path[0], [1, 3]);
  assert.deepEqual(path.at(-1), [10, 10]);
  for (const point of path) {
    assert.equal(Array.isArray(point), true);
    assert.equal(point.length, 2);
    assert.equal(Number.isInteger(point[0]), true);
    assert.equal(Number.isInteger(point[1]), true);
  }

  const clamped = humanPath(0, 0, 3, 4, 0);
  assert.equal(clamped.length, 2);
  assert.deepEqual(clamped[0], [0, 0]);
  assert.deepEqual(clamped[1], [3, 4]);

  const samePoint = humanPath(5, 5, 5, 5, 3);
  assert.equal(samePoint.length, 4);
  assert.deepEqual(samePoint[0], [5, 5]);
  assert.deepEqual(samePoint.at(-1), [5, 5]);
});

test("viewportToScreenExpr builds a self-contained screen coordinate expression", () => {
  const expr = viewportToScreenExpr(100, 200);
  assert.match(expr, /Math\.round\(/);
  assert.match(expr, /window\.screenX/);
  assert.match(expr, /window\.outerWidth/);
  assert.match(expr, /\+ 100/);
  assert.match(expr, /\+ 200/);
});

test("viewportToScreenExpr preserves zero coordinates", () => {
  const expr = viewportToScreenExpr(0, 0);
  assert.match(expr, /\+ 0/);
  assert.equal((expr.match(/\+ 0/g) || []).length, 2);
});

test("viewportToScreenExpr coerces numeric strings", () => {
  const expr = viewportToScreenExpr("50", "60");
  assert.match(expr, /\+ 50/);
  assert.match(expr, /\+ 60/);
});

test("VIEWPORT_ORIGIN_FIELDS_JS contains the viewport origin formula", () => {
  assert.match(VIEWPORT_ORIGIN_FIELDS_JS, /window\.screenX/);
  assert.match(VIEWPORT_ORIGIN_FIELDS_JS, /window\.outerWidth - window\.innerWidth/);
  assert.match(VIEWPORT_ORIGIN_FIELDS_JS, /window\.outerHeight - window\.innerHeight/);
});

test("VIEWPORT_ORIGIN_FIELDS_JS is an object expression", () => {
  assert.doesNotMatch(VIEWPORT_ORIGIN_FIELDS_JS, /JSON\.stringify/);
});
