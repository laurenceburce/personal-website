import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as planner from "../app/lib/financePlanner.mjs";
import * as presentation from "../app/lib/financePlanPresentation.mjs";

const require = createRequire(import.meta.url);
const { transformSync } = require("next/dist/build/swc");
const file = fileURLToPath(new URL("../app/finance/FinancePlannerTable.js", import.meta.url));
function load(filename, react) {
  const module = { exports: {} };
  const { code } = transformSync(readFileSync(filename, "utf8"), {
    filename,
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
    module: { type: "commonjs" },
  });
  new Function("require", "module", "exports", code)((specifier) => {
    if (specifier === "react" && react) return react;
    if (specifier.endsWith(".css")) return {};
    if (specifier === "../lib/financePlanner.mjs") return planner;
    if (specifier === "../lib/financePlanPresentation.mjs") return presentation;
    if (specifier.startsWith("./")) return load(resolve(dirname(filename), `${specifier}.js`), react);
    return require(specifier);
  }, module, module.exports);
  return module.exports;
}
const Table = load(file).default;
const today = "2026-11-18";
const plan = { id: "live", startDate: "2026-11-01", endDate: "2027-01-01", balanceMode: "live", entries: [
  { id: "coffee", description: "Coffee", date: today, kind: "expense", amount: 5, currency: "USD", accountId: 1 },
] };
const accounts = [
  { id: 1, name: "Daily checking", mask: "1234", type: "checking", currency: "USD" },
  { id: 34, name: "Peso savings", type: "savings", currency: "PHP" },
  { id: 37, name: "RCBC JCB", type: "credit", currency: "PHP" },
];
const row = (extra = {}) => ({ id: "bill:internet:2026-11-20", date: "2026-11-20", description: "Internet", kind: "expense",
  source: "bill", amount: 25, currency: "USD", accountId: 1, usd: -25, php: 0, balanceUsd: 175, balancePhp: 2000,
  ...extra });
const render = (rows, extra = {}) => renderToStaticMarkup(createElement(Table, { plan, rows, accounts, today, ...extra }));
const plain = (html) => html.replace(/<[^>]*>/g, "");
function find(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (node && typeof node === "object") return predicate(node) ? node : find(node.props?.children, predicate);
}
function harness(props) {
  const states = [];
  let cursor = 0;
  const Component = load(file, { ...require("react"), useState(initial) {
    const index = cursor++;
    if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
    return [states[index], (value) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
  } }).default;
  return () => { cursor = 0; return Component({ plan, accounts, today, ...props }); };
}
const button = (tree, text) => find(tree, (node) => node.type === "button" && node.props.children === text);

test("planner table uses six clear columns, account identities and native amounts", () => {
  const html = render([row()]);
  assert.equal((html.match(/<th scope="col">/g) || []).length, 6);
  for (const label of ["Date", "Transaction", "Account", "Amount", "Projected balance", "Status"]) assert.ok(html.includes(label));
  assert.match(html, /Daily checking · ••1234/);
  assert.match(html, /-\$25\.00/);
  assert.match(html, /\$175\.00/);
  assert.match(html, /₱2,000\.00/);
  assert.match(html, /aria-label="Details for Internet"/);
  assert.doesNotMatch(html, /Starting balances|Scroll budget columns|Show columns/);
});

test("transfer rows show source and card destination rather than a misleading zero cash amount", () => {
  const html = render([row({ id: "entry:card", source: "manual", kind: "transfer", currency: "PHP", amount: 300,
    fromAccountId: 34, toAccountId: 37, accountId: null, creditCardPaymentFor: 37, usd: 0, php: -300 })]);
  assert.match(plain(html), /Peso savingsto RCBC JCB/);
  assert.match(html, /-₱300\.00/);
  assert.match(html, /Card payment/);
});

test("recorded history identifies its current anchor and retains financial details", () => {
  const html = render([row({ date: today, source: "transaction", completed: true, completionSource: "plan", planGenerated: true,
    entryId: "coffee", recordedInAccounts: true, awaitingBankSync: true, reserveUsd: 75, savingsPhp: 300,
    cardCreditActivity: true, recordedTransactions: [{ id: 3, date: today, kind: "expense", amount: 25,
      currency: "USD", description: "Bank receipt", accountName: "Daily checking" }] })], { onToggleComplete() {}, onEdit() {}, onDelete() {} });
  assert.match(html, /Included in current balance/);
  assert.match(html, /Awaiting bank match/);
  assert.match(html, /Bank receipt/);
  assert.match(html, /Annual reserve · USD/);
  assert.match(html, /Savings · PHP/);
  assert.match(html, /aria-label="Reopen Internet"/);
  const snapshot = render([row({ date: today, completed: true })], { plan: { ...plan, balanceMode: "snapshot" } });
  assert.doesNotMatch(snapshot, /Included in current balance/);
  assert.match(snapshot, /\$175\.00/);
});

test("status and search filters preserve precomputed balances and source rows", () => {
  const rows = [row({ id: "old", date: "2026-11-17", description: "Overdue rent", balanceUsd: 500 }),
    row({ id: "recorded", date: today, description: "Paid coffee", completed: true, recordedInAccounts: true, balanceUsd: 450 }),
    row({ id: "future", description: "Future internet", balanceUsd: 425 })];
  const before = structuredClone(rows);
  const get = harness({ rows });
  button(get(), "Upcoming").props.onClick();
  let html = renderToStaticMarkup(get());
  assert.match(html, /Future internet/);
  assert.doesNotMatch(html, /Overdue rent|Paid coffee/);
  assert.match(html, /\$425\.00/);
  button(get(), "Recorded").props.onClick();
  html = renderToStaticMarkup(get());
  assert.match(html, /Paid coffee/);
  assert.doesNotMatch(html, /Future internet|Overdue rent/);
  button(get(), "Overdue").props.onClick();
  assert.match(renderToStaticMarkup(get()), /Overdue rent/);
  button(get(), "All").props.onClick();
  find(get(), (node) => node.type === "input" && node.props.type === "search").props.onChange({ target: { value: "1234" } });
  assert.match(renderToStaticMarkup(get()), /3 of 3 transactions/);
  find(get(), (node) => node.type === "input" && node.props.type === "search").props.onChange({ target: { value: "missing" } });
  html = renderToStaticMarkup(get());
  assert.match(html, /No transactions match your filters/);
  button(get(), "Clear filters").props.onClick();
  assert.match(renderToStaticMarkup(get()), /3 transactions/);
  assert.deepEqual(rows, before);
});

test("record and editable recurring actions pass the original row and entry without mutating finances", () => {
  const recurring = { ...plan.entries[0], recurrence: "monthly" };
  const planned = row({ id: "entry:coffee:2026-11-20", source: "manual", recurring: true, editable: true, entryId: "coffee" });
  const calls = [];
  const get = harness({ rows: [planned], plan: { ...plan, entries: [recurring] },
    onEdit: (value) => calls.push(["series", value]), onEditOccurrence: (value) => calls.push(["occurrence", value]),
    onDelete: (value) => calls.push(["delete", value]), onToggleComplete: (value) => calls.push(["done", value]) });
  find(get(), (node) => node.props?.["aria-label"] === "Edit this occurrence: Internet").props.onClick();
  button(get(), "Edit recurring entry").props.onClick();
  find(get(), (node) => node.props?.["aria-label"] === "Delete Internet").props.onClick();
  button(get(), "Mark done").props.onClick();
  assert.deepEqual(calls, [["occurrence", planned], ["series", recurring], ["delete", recurring], ["done", planned]]);
  const payCalls = [];
  const payment = row();
  const pay = harness({ rows: [payment], onRecord: (value) => payCalls.push(value) });
  find(pay(), (node) => node.props?.["aria-label"] === "Record payment: Internet").props.onClick();
  assert.deepEqual(payCalls, [payment]);
});

test("bank matched rows cannot reopen and busy financial controls cannot invoke handlers", () => {
  const calls = [];
  const actual = row({ source: "transaction", completed: true, completionSource: "transaction" });
  const get = harness({ rows: [actual], onToggleComplete: () => calls.push("toggle") });
  assert.equal(button(get(), "Reopen"), undefined);
  const busy = harness({ rows: [row()], busy: true, onRecord: () => calls.push("record"), onToggleComplete: () => calls.push("toggle") });
  const record = find(busy(), (node) => node.props?.["aria-label"] === "Record payment: Internet");
  assert.equal(record.props.disabled, true);
  record.props.onClick();
  button(busy(), "Mark done").props.onClick();
  assert.deepEqual(calls, []);
});

test("empty date ranges and loading states remain useful without an oversized empty table", () => {
  assert.match(render([]), /No transactions in this date range/);
  const html = render([], { loading: true });
  assert.match(html, /Loading transactions/);
  assert.match(html, /aria-busy="true"/);
  assert.doesNotMatch(html, /<table/);
});

test("continuous planner rows use aggregate projected balances and keep past due history distinct", () => {
  const html = render([row({ balanceUsd: 175, projectedBalanceUsd: 1200, projectedBalancePhp: 42000 })],
    { plan: { ...plan, continuous: true } });
  assert.match(html, /\$1,200\.00/);
  assert.match(html, /₱42,000\.00/);
  assert.doesNotMatch(html, /\$175\.00/);
  const past = render([row({ date: "2026-11-17", projectedBalanceUsd: 1200, projectedBalancePhp: 42000 })],
    { plan: { ...plan, continuous: true } });
  assert.match(past, /Past due · review payment/);
  assert.doesNotMatch(past, /\$1,200\.00/);
});
