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
      return Component({ plan, salary, today: plan.startDate, onSave(value) { saved = value; }, ...initialProps, ...props });
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

const accountSelect = (tree, label) => find(field(tree, label), (node) => node.type?.name === "FinanceAccountSelect");
const amountInput = (tree) => find(tree, (node) => node.type?.name === "FinanceNumberInput");
const cardAccounts = [
  { id: 34, name: "PHP savings", type: "savings", currency: "PHP", nativeCurrentBalance: 20000 },
  { id: 37, name: "PHP card", type: "credit", currency: "PHP", nativeCurrentBalance: 14930.79 },
  { id: 38, name: "Loan", type: "loan", currency: "PHP", nativeCurrentBalance: 1000 },
];

test("new one-time entries start today within plan bounds and stay planned until recorded", () => {
  for (const [today, expected] of [["2026-10-31", "2026-11-01"], ["2026-11-18", "2026-11-18"], ["2026-12-01", "2026-11-30"]]) {
    const form = harness({ today });
    const tree = form.render();
    assert.equal(input(tree, "Date", "input").props.value, expected);
    assert.equal(input(tree, "Status", "select").props.value, "planned");
    tree.props.onSubmit({ preventDefault() {} });
    assert.equal(form.saved().recordNow, false);
    assert.ok(!Object.hasOwn(form.saved(), "completedAt"));
  }
});

test("recording a one-time row requires its actual account and a date no later than today", () => {
  const entry = { id: "fill", date: "2026-11-18", description: "Fill", kind: "expense", amount: 50,
    currency: "PHP", recurrence: "once", accountId: null };
  const form = harness({ entry, today: "2026-11-18", accounts: cardAccounts });
  let tree = form.render();
  input(tree, "Status", "select").props.onChange({ target: { value: "recorded" } });
  tree = form.render();
  assert.equal(accountSelect(tree, "Pay from account").props.required, true);
  assert.equal(accountSelect(tree, "Pay from account").props.allowNone, false);
  tree.props.onSubmit({ preventDefault() {} });
  assert.equal(form.saved(), undefined);
  assert.ok(plain(renderToStaticMarkup(form.render())).includes("Choose the account for this recorded transaction"));
  accountSelect(tree, "Pay from account").props.onChange(37);
  tree = form.render();
  input(tree, "Date", "input").props.onChange({ target: { value: "2026-11-19" } });
  tree = form.render();
  assert.equal(find(input(tree, "Status", "select"), (node) => node.type === "option" && node.props.value === "recorded").props.disabled, true);
  tree.props.onSubmit({ preventDefault() {} });
  assert.equal(form.saved(), undefined);
  assert.ok(plain(renderToStaticMarkup(form.render())).includes("Future payments stay planned"));
  input(tree, "Date", "input").props.onChange({ target: { value: "2026-11-18" } });
  tree = form.render();
  tree.props.onSubmit({ preventDefault() {} });
  assert.deepEqual(form.saved(), { ...entry, accountId: 37, repeatUntil: null, recordNow: true });
});

test("recorded transfers require both accounts and an existing completed row can be reopened explicitly", () => {
  const entry = { id: "move", date: "2026-11-18", description: "Move savings", kind: "transfer", amount: 50,
    currency: "PHP", recurrence: "once", fromAccountId: 34, toAccountId: null };
  const form = harness({ entry, completed: true, today: "2026-11-18", accounts: cardAccounts });
  let tree = form.render();
  assert.equal(input(tree, "Status", "select").props.value, "recorded");
  tree.props.onSubmit({ preventDefault() {} });
  assert.equal(form.saved(), undefined);
  assert.ok(plain(renderToStaticMarkup(form.render())).includes("Choose the account for this recorded transaction"));
  input(tree, "Status", "select").props.onChange({ target: { value: "planned" } });
  tree = form.render();
  tree.props.onSubmit({ preventDefault() {} });
  assert.equal(form.saved().recordNow, false);
});

test("card payment schedules follow the selected native debt across account refreshes and accept a paid-off zero", () => {
  const form = harness({ today: "2026-11-18", accounts: cardAccounts });
  let tree = form.render();
  input(tree, "Entry type", "select").props.onChange({ target: { value: "cardPayment" } });
  tree = form.render();
  input(tree, "Currency", "select").props.onChange({ target: { value: "PHP" } });
  tree = form.render();
  accountSelect(tree, "From account").props.onChange(34);
  accountSelect(tree, "Credit card").props.onChange(37);
  input(tree, "Description", "input").props.onChange({ target: { value: "  RCBC JCB  " } });
  tree = form.render();
  assert.ok(accountSelect(tree, "From account").props.accounts.every((account) => !["credit", "loan"].includes(account.type)));
  assert.ok(accountSelect(tree, "Credit card").props.accounts.every((account) => account.type === "credit"));
  assert.equal(accountSelect(tree, "Credit card").props.currency, "PHP");
  assert.equal(input(tree, "Payment amount", "select").props.value, "cardBalance");
  assert.equal(amountInput(tree).props.readOnly, true);
  assert.equal(amountInput(tree).props.value, 14930.79);
  tree = form.render({ accounts: cardAccounts.map((account) => account.id === 37 ? { ...account, nativeCurrentBalance: 9000.25 } : account) });
  assert.equal(amountInput(tree).props.value, 9000.25);
  tree.props.onSubmit({ preventDefault() {} });
  assert.equal(form.saved().kind, "transfer");
  assert.equal(form.saved().amountMode, "cardBalance");
  assert.equal(form.saved().amount, 9000.25);
  assert.equal(form.saved().currency, "PHP");
  assert.equal(form.saved().description, "RCBC JCB");
  assert.equal(form.saved().fromAccountId, 34);
  assert.equal(form.saved().toAccountId, 37);
  assert.equal(form.saved().recordNow, false);
  tree = form.render({ accounts: cardAccounts.map((account) => account.id === 37 ? { ...account, nativeCurrentBalance: 0 } : account) });
  assert.equal(amountInput(tree).props.value, 0);
  assert.equal(amountInput(tree).props.min, "0");
  tree.props.onSubmit({ preventDefault() {} });
  assert.equal(form.saved().amount, 0);
});

test("actual card payments save the entered fixed amount rather than a refreshed card balance", () => {
  const entry = { id: "paid-card", date: "2026-11-18", description: "Early payment", kind: "transfer", amount: 500,
    amountMode: "cardBalance", currency: "PHP", recurrence: "once", fromAccountId: 34, toAccountId: 37 };
  const form = harness({ entry, completed: true, today: "2026-11-18", accounts: cardAccounts });
  let tree = form.render();
  assert.equal(input(tree, "Entry type", "select").props.value, "cardPayment");
  assert.equal(input(tree, "Status", "select").props.value, "recorded");
  assert.equal(field(tree, "Payment amount"), undefined);
  assert.equal(amountInput(tree).props.readOnly, false);
  amountInput(tree).props.onChange({ target: { value: "1250.75" } });
  tree = form.render({ accounts: cardAccounts.map((account) => account.id === 37 ? { ...account, nativeCurrentBalance: 5000 } : account) });
  assert.equal(amountInput(tree).props.value, "1250.75");
  tree.props.onSubmit({ preventDefault() {} });
  assert.equal(form.saved().amount, 1250.75);
  assert.equal(form.saved().amountMode, "fixed");
  assert.equal(form.saved().recordNow, true);
});

test("a live card payment cannot infer a missing card balance", () => {
  const form = harness({ today: "2026-11-18", accounts: cardAccounts.map((account) => ({ ...account, nativeCurrentBalance: null })),
    entry: { id: "card", date: "2026-11-20", description: "Card", kind: "transfer", amount: 500, amountMode: "cardBalance",
      currency: "PHP", recurrence: "once", fromAccountId: 34, toAccountId: 37 } });
  const tree = form.render();
  assert.equal(amountInput(tree).props.value, "");
  tree.props.onSubmit({ preventDefault() {} });
  assert.equal(form.saved(), undefined);
  assert.ok(plain(renderToStaticMarkup(form.render())).includes("Refresh the card balance or enter a fixed payment amount"));
});
