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
  if (!reactOverride && modules.has(filename)) return modules.get(filename).exports;
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
  new Function("require", "module", "exports", code)((specifier) => {
    if (specifier === "react" && reactOverride) return reactOverride;
    if (specifier === "../lib/financePlanner.mjs") return planner;
    if (specifier.startsWith("./")) return load(resolve(dirname(filename), `${specifier}.js`));
    return require(specifier);
  }, module, module.exports);
  return module.exports;
}
const filename = fileURLToPath(new URL("../app/finance/FinancePlanEntryForm.js", import.meta.url));
const Form = load(filename).default;
const plan = { id: "november", name: "November", startDate: "2026-11-01", endDate: "2026-11-30" };
const salary = { amount: 0, currency: "USD", payFrequency: "biweekly", firstPayDate: "2026-10-23" };
const plain = (html) => html.replace(/<[^>]*>/g, "");
function find(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (node && typeof node === "object") return predicate(node) ? node : find(node.props?.children, predicate);
}
const field = (tree, label) => find(tree, (node) => node.props?.label === label);
const input = (tree, label, type) => find(field(tree, label), (node) => node.type === type);
function harness(initialProps = {}) {
  const state = [];
  let cursor = 0;
  let saved;
  const Component = load(filename, {
    ...require("react"),
    useState(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
      return [state[index], (next) => { state[index] = typeof next === "function" ? next(state[index]) : next; }];
    },
  }).default;
  return {
    render(props = {}) {
      cursor = 0;
      return Component({ plan, salary, onSave(value) { saved = value; }, ...initialProps, ...props });
    },
    saved: () => saved,
  };
}

test("entry editor offers once, daily, monthly, and payday schedules with native money editing", () => {
  const html = renderToStaticMarkup(createElement(Form, { plan, salary, onSave() {} }));
  for (const label of ["Does not repeat", "Daily", "Monthly", "Every payday"]) assert.ok(plain(html).includes(label));
  assert.ok(!plain(html).includes("Repeat until"));
  assert.ok(html.includes('inputMode="decimal"'));
  assert.ok(!html.includes('type="number"'));
  assert.ok(html.includes('min="2026-11-01"'));
  assert.ok(html.includes('max="2026-11-30"'));
});

test("adding a daily entry saves one recurring rule and an optional stop date", () => {
  const form = harness();
  let tree = form.render();
  input(tree, "Description", "input").props.onChange({ target: { value: "  Daily lunch  " } });
  find(tree, (node) => node.type?.name === "FinanceNumberInput").props.onChange({ target: { value: "12.50" } });
  input(tree, "Repeat", "select").props.onChange({ target: { value: "daily" } });
  tree = form.render();
  input(tree, "Starts on", "input").props.onChange({ target: { value: "2026-11-05" } });
  input(tree, "Repeat until", "input").props.onChange({ target: { value: "2026-11-20" } });
  tree = form.render();
  assert.equal(input(tree, "Repeat until", "input").props.min, "2026-11-05");
  assert.ok(plain(renderToStaticMarkup(tree)).includes("Amount per occurrence"));
  assert.ok(plain(renderToStaticMarkup(tree)).includes("Add recurring entry"));
  tree.props.onSubmit({ preventDefault() {} });
  assert.deepEqual({ ...form.saved(), id: "generated" }, {
    id: "generated", date: "2026-11-05", description: "Daily lunch", kind: "expense",
    amount: 12.5, currency: "USD", recurrence: "daily", repeatUntil: "2026-11-20",
  });
  assert.ok(form.saved().id);
});

test("editing a monthly series keeps its rule and partially typed amount across prop refreshes", () => {
  const entry = { id: "saving", date: "2026-11-01", description: "Monthly savings", amount: 100,
    kind: "expense", currency: "PHP", recurrence: "monthly", repeatUntil: "2026-11-30", accountId: 3 };
  const form = harness({ entry });
  let tree = form.render();
  find(tree, (node) => node.type?.name === "FinanceNumberInput").props.onChange({ target: { value: "175." } });
  tree = form.render({ entry: { ...entry, amount: 200 } });
  assert.equal(find(tree, (node) => node.type?.name === "FinanceNumberInput").props.value, "175.");
  assert.equal(input(tree, "Repeat", "select").props.value, "monthly");
  assert.equal(input(tree, "Repeat until", "input").props.value, "2026-11-30");
  assert.ok(plain(renderToStaticMarkup(tree)).includes("Shorter months use their last day"));
  assert.ok(plain(renderToStaticMarkup(tree)).includes("Individually edited occurrences keep their changes"));
  tree.props.onSubmit({ preventDefault() {} });
  assert.deepEqual(form.saved(), { ...entry, amount: 175 });
});

test("payday entries use the saved salary schedule even with zero salary income", () => {
  const form = harness();
  let tree = form.render();
  input(tree, "Repeat", "select").props.onChange({ target: { value: "payday" } });
  tree = form.render();
  assert.ok(plain(renderToStaticMarkup(tree)).includes("Next occurrence: Nov 6, 2026"));
  assert.equal(find(tree, (node) => node.type === "button" && node.props.type === "submit").props.disabled, false);
  tree = form.render({ salary: { ...salary, payFrequency: "semimonthly", firstPayDate: "2026-11-10" } });
  assert.ok(plain(renderToStaticMarkup(tree)).includes("Next occurrence: Nov 10, 2026"));
  tree.props.onSubmit({ preventDefault() {} });
  assert.equal(form.saved().recurrence, "payday");
  assert.equal(form.saved().repeatUntil, null);
});

test("payday entries cannot save until the payday schedule is valid", () => {
  for (const invalidSalary of [{}, { ...salary, firstPayDate: "2026-02-30" }, { ...salary, payFrequency: "daily" }]) {
    const form = harness({ salary: invalidSalary, entry: { id: "pay", date: plan.startDate,
      description: "Every payday", amount: 20, currency: "USD", kind: "expense", recurrence: "payday" } });
    const tree = form.render();
    assert.ok(plain(renderToStaticMarkup(tree)).includes("Set a valid payday frequency"));
    assert.equal(find(tree, (node) => node.type === "button" && node.props.type === "submit").props.disabled, true);
    tree.props.onSubmit({ preventDefault() {} });
    assert.equal(form.saved(), undefined);
  }
});

test("invalid recurrence dates block saving, while changing back to once clears the stop date", () => {
  const form = harness({ entry: { id: "daily", date: "2026-11-15", description: "Daily", amount: 5,
    currency: "USD", kind: "expense", recurrence: "daily", repeatUntil: "2026-11-10" } });
  let tree = form.render();
  assert.equal(find(tree, (node) => node.type === "button" && node.props.type === "submit").props.disabled, true);
  tree.props.onSubmit({ preventDefault() {} });
  assert.equal(form.saved(), undefined);
  input(tree, "Repeat", "select").props.onChange({ target: { value: "once" } });
  tree = form.render();
  tree.props.onSubmit({ preventDefault() {} });
  assert.equal(form.saved().recurrence, "once");
  assert.equal(form.saved().repeatUntil, null);
});

test("entry saves respect busy and disabled guards", () => {
  for (const state of [{ busy: true }, { disabled: true }]) {
    const form = harness(state);
    const tree = form.render();
    tree.props.onSubmit({ preventDefault() {} });
    assert.equal(form.saved(), undefined);
  }
});

test("recurring transfers and conversions retain their account and currency controls", () => {
  const accounts = [
    { id: 1, name: "Checking", type: "checking", currency: "USD" },
    { id: 2, name: "Savings", type: "savings", currency: "USD" },
    { id: 3, name: "PHP Checking", type: "checking", currency: "PHP" },
  ];
  const form = harness({ accounts, entry: { id: "transfer", date: plan.startDate, description: "Save each payday",
    amount: 50, currency: "USD", kind: "transfer", recurrence: "payday", fromAccountId: 1, toAccountId: 2 } });
  let tree = form.render();
  const from = find(field(tree, "From account"), (node) => node.type?.name === "FinanceAccountSelect");
  const to = find(field(tree, "To account"), (node) => node.type?.name === "FinanceAccountSelect");
  assert.equal(from.props.required, true);
  assert.equal(to.props.required, true);
  assert.ok(!to.props.accounts.some((account) => account.id === 1));
  tree.props.onSubmit({ preventDefault() {} });
  assert.equal(form.saved().fromAccountId, 1);
  assert.equal(form.saved().toAccountId, 2);
  input(tree, "Entry type", "select").props.onChange({ target: { value: "conversion" } });
  tree = form.render();
  assert.equal(find(field(tree, "To account"), (node) => node.type?.name === "FinanceAccountSelect").props.currency, "PHP");
  input(tree, "Convert from", "select").props.onChange({ target: { value: "PHP" } });
  tree = form.render();
  tree.props.onSubmit({ preventDefault() {} });
  assert.equal(form.saved().currency, "PHP");
  assert.equal(form.saved().fromAccountId, null);
  assert.equal(form.saved().toAccountId, null);
});
