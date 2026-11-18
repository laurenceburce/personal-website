import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as planner from "../app/lib/financePlanner.mjs";
import * as livePlanner from "../app/lib/financeLivePlanner.mjs";

const require = createRequire(import.meta.url);
const { transformSync } = require("next/dist/build/swc");
const filename = fileURLToPath(new URL("../app/finance/FinancePlannerRange.js", import.meta.url));
const { code } = transformSync(readFileSync(filename, "utf8"), { filename,
  jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
  module: { type: "commonjs" } });
function load(react) {
  const module = { exports: {} };
  new Function("require", "module", "exports", code)((specifier) => {
    if (specifier === "react" && react) return react;
    if (specifier === "../lib/financePlanner.mjs") return planner;
    if (specifier === "../lib/financeLivePlanner.mjs") return livePlanner;
    return require(specifier);
  }, module, module.exports);
  return module.exports.default;
}
const Range = load();
const today = "2026-11-18";
const initial = { startDate: "2026-11-04", endDate: "2027-02-16" };
const plain = (value) => value.replace(/<[^>]*>/g, "");
function find(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (node && typeof node === "object") return predicate(node) ? node : find(node.props?.children, predicate);
}
const input = (tree, label) => find(find(tree, (node) => node.type === "label" && node.props.children?.[0]?.props?.children === label),
  (node) => node.type === "input");
const button = (tree, label) => find(tree, (node) => node.type === "button" && node.props.children === label);
function harness() {
  const slots = [];
  let cursor = 0;
  let effects = [];
  const calls = [];
  let props = { range: initial, today, onChange: (value) => calls.push(value) };
  const Component = load({ ...require("react"),
    useState(initialValue) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initialValue === "function" ? initialValue() : initialValue;
      return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useEffect(callback, dependencies) {
      const index = cursor++;
      if (!slots[index] || dependencies.some((value, i) => value !== slots[index][i])) effects.push(callback);
      slots[index] = dependencies;
    },
  });
  return { calls, render(next = {}) {
    props = { ...props, ...next }; cursor = 0; effects = [];
    const tree = Component(props); effects.forEach((effect) => effect()); return tree;
  } };
}

test("date range presents the viewing window with simple past and future presets", () => {
  const html = renderToStaticMarkup(createElement(Range, { range: initial, today, onChange() {} }));
  for (const label of ["Your timeline", "Past &amp; upcoming", "Past 30 days", "Next 30 days", "Next 90 days", "Apply dates"])
    assert.ok(html.includes(label));
  assert.match(html, /value="2026-11-04"/);
  assert.match(html, /value="2027-02-16"/);
  assert.match(plain(html), /Changes the view. Your saved transactions stay in place./);
});

test("editing date drafts leaves the range untouched until Apply dates", () => {
  const before = structuredClone(initial);
  const form = harness();
  let tree = form.render();
  input(tree, "From").props.onChange({ target: { value: "2026-11-01" } });
  tree = form.render();
  input(tree, "Through").props.onChange({ target: { value: "2026-12-31" } });
  tree = form.render();
  assert.deepEqual(form.calls, []);
  find(tree, (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.deepEqual(form.calls, [{ startDate: "2026-11-01", endDate: "2026-12-31" }]);
  assert.deepEqual(initial, before);
});

test("invalid dates and unsupported ranges keep drafts open without changing the view", () => {
  for (const [startDate, endDate] of [["", "2026-12-01"], ["2026-02-30", "2026-12-01"],
    ["2026-12-31", "2026-11-01"], ["2026-11-18", "2029-11-18"]]) {
    const form = harness();
    input(form.render(), "From").props.onChange({ target: { value: startDate } });
    input(form.render(), "Through").props.onChange({ target: { value: endDate } });
    find(form.render(), (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
    const tree = form.render();
    assert.deepEqual(form.calls, []);
    assert.ok(find(tree, (node) => node.props?.role === "alert"));
    assert.equal(input(tree, "From").props.value, startDate);
    assert.equal(input(tree, "Through").props.value, endDate);
  }
});

test("presets reset an invalid draft and only call the viewing callback", () => {
  const form = harness();
  input(form.render(), "From").props.onChange({ target: { value: "bad" } });
  find(form.render(), (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.ok(find(form.render(), (node) => node.props?.role === "alert"));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = () => { requests++; throw new Error("Date viewing must not save anything"); };
  try {
    button(form.render(), "Past & upcoming").props.onClick();
    assert.deepEqual(form.calls.at(-1), initial);
    assert.equal(find(form.render(), (node) => node.props?.role === "alert"), undefined);
    button(form.render(), "Past 30 days").props.onClick();
    assert.deepEqual(form.calls.at(-1), { startDate: "2026-10-20", endDate: today });
    button(form.render(), "Next 30 days").props.onClick();
    assert.deepEqual(form.calls.at(-1), { startDate: today, endDate: "2026-12-18" });
    button(form.render(), "Next 90 days").props.onClick();
    assert.deepEqual(form.calls.at(-1), { startDate: today, endDate: "2027-02-16" });
    assert.equal(requests, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("controlled range updates reset old draft errors and update preset selection", () => {
  const form = harness();
  input(form.render(), "From").props.onChange({ target: { value: "bad" } });
  find(form.render(), (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  const next = { startDate: today, endDate: "2026-12-18" };
  form.render({ range: next });
  const tree = form.render();
  assert.equal(input(tree, "From").props.value, today);
  assert.equal(input(tree, "Through").props.value, "2026-12-18");
  assert.equal(find(tree, (node) => node.props?.role === "alert"), undefined);
  assert.equal(button(tree, "Next 30 days").props["aria-pressed"], true);
  assert.deepEqual(form.calls, []);
});

test("loading feedback explains the timeline refresh while preserving the viewing controls", () => {
  const html = renderToStaticMarkup(createElement(Range, { range: initial, today, loading: true, onChange() {} }));
  assert.match(html, /role="status">Updating timeline/);
  assert.match(html, /Apply dates/);
});
