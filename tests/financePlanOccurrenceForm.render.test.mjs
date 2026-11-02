import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as planner from "../app/lib/financePlanner.mjs";

const require = createRequire(import.meta.url);
const { transformSync } = require("next/dist/build/swc");
const modules = new Map();
function load(filename, reactOverride) {
  if (!reactOverride && modules.has(filename))
    return modules.get(filename).exports;
  const module = { exports: {} };
  if (!reactOverride) modules.set(filename, module);
  const { code } = transformSync(readFileSync(filename, "utf8"), {
    filename,
    jsc: {
      parser: { syntax: "ecmascript", jsx: true },
      transform: { react: { runtime: "automatic" } },
      target: "es2022",
    },
    module: { type: "commonjs" },
  });
  new Function("require", "module", "exports", code)(
    (specifier) => {
      if (specifier === "react" && reactOverride) return reactOverride;
      if (specifier === "../lib/financePlanner.mjs") return planner;
      if (specifier.startsWith("./"))
        return load(resolve(dirname(filename), `${specifier}.js`));
      return require(specifier);
    },
    module,
    module.exports,
  );
  return module.exports;
}
const filename = fileURLToPath(
  new URL("../app/finance/FinancePlanOccurrenceForm.js", import.meta.url),
);
const Form = load(filename).default;
const row = {
  id: "allocation:saving:2026-11-06",
  source: "allocation",
  allocationKind: "savings",
  description: "Savings · Savings",
  date: "2026-11-06",
  amount: 500,
  currency: "USD",
  originalDate: "2026-11-06",
  originalDescription: "Savings · Savings",
  originalAmount: 500,
};
const plan = {
  name: "November",
  startDate: "2026-11-06",
  endDate: "2026-11-30",
};
function find(node, predicate) {
  if (Array.isArray(node))
    return node.map((child) => find(child, predicate)).find(Boolean);
  if (node && typeof node === "object")
    return predicate(node) ? node : find(node.props?.children, predicate);
}

test("occurrence editor explains its limited scope and shows gross annual payment amount", () => {
  const html = renderToStaticMarkup(
    createElement(Form, {
      row: { ...row, annualPayment: true, amount: 295, grossAmount: 395 },
      plan,
      onSave() {},
    }),
  );
  assert.ok(html.includes("Changes apply only to this occurrence"));
  assert.ok(html.includes("recurring"));
  assert.ok(html.includes('value="395"'));
  assert.ok(html.includes("Full payment amount before using annual reserves."));
  assert.ok(html.includes('inputMode="decimal"'));
  assert.ok(!html.includes('type="number"'));
  assert.ok(!html.includes("Restore recurring default"));
});

test("editing and refreshing an occurrence preserves partial text and saves only its stable exception", () => {
  const state = [];
  let cursor = 0,
    saved;
  const Component = load(filename, {
    ...require("react"),
    useState(initial) {
      const index = cursor++;
      if (!(index in state))
        state[index] = typeof initial === "function" ? initial() : initial;
      return [state[index], (next) => {
        state[index] = typeof next === "function" ? next(state[index]) : next;
      }];
    },
  }).default;
  const render = (currentRow = row) => {
    cursor = 0;
    return Component({ row: currentRow, plan, onSave(value) { saved = value; } });
  };
  let tree = render();
  find(tree, (node) => node.type?.name === "FinanceNumberInput")
    .props.onChange({ target: { value: "275." } });
  find(tree, (node) => node.type === "input" && node.props.type === "date")
    .props.onChange({ target: { value: "2026-11-07" } });
  find(tree, (node) => node.type === "input" && node.props.maxLength === 160)
    .props.onChange({ target: { value: " November savings " } });
  tree = render({ ...row, amount: 600 });
  assert.equal(find(tree, (node) => node.type?.name === "FinanceNumberInput").props.value, "275.");
  tree.props.onSubmit({ preventDefault() {} });
  assert.deepEqual(saved, {
    rowId: "allocation:saving:2026-11-06",
    date: "2026-11-07",
    description: "November savings",
    amount: 275,
  });
});

test("restore button returns the overridden occurrence and respects saving state", () => {
  let reset;
  const Component = load(filename, { ...require("react"), useState: (initial) => [initial(), () => {}] }).default;
  const overridden = { ...row, amount: 250, isOverride: true };
  const tree = Component({ row: overridden, plan, onSave() {}, onReset(value) { reset = value; }, busy: true });
  const button = find(tree, (node) => node.type === "button" && node.props.type === "button");
  assert.equal(button.props.disabled, true);
  button.props.onClick();
  assert.equal(reset, overridden);
});
