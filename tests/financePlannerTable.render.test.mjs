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
const { default: Table, selectCurrentPlannerRow } = load(file);
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
  accountBalanceSnapshotKind: "projected", accountBalanceSnapshot: [
    { accountId: 1, currency: "USD", balance: extra.balanceUsd ?? 175 },
    { accountId: 34, currency: "PHP", balance: extra.balancePhp ?? 2000 },
    { accountId: 37, currency: "PHP", balance: 600, isDebt: true },
  ],
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
  }, useEffect() {}, useRef(initial) {
    const index = cursor++;
    if (!(index in states)) states[index] = { current: initial };
    return states[index];
  } }).default;
  return () => { cursor = 0; return Component({ plan, accounts, today, ...props }); };
}
const button = (tree, text) => find(tree, (node) => node.type === "button" && node.props.children === text);
const accountColumns = (html) => [...new Set([...html.matchAll(/<div\b[^>]*data-account-id="([^"]+)"/g)].map((match) => match[1]))];
const accountCell = (html, id) => html.match(new RegExp(`<div\\b[^>]*data-account-id="${id}"[^>]*>([\\s\\S]*?)<\\/div>`))?.[1];
const renderExpanded = (rows, extra = {}) => {
  const get = harness({ rows, ...extra });
  button(get(), "Expand accounts").props.onClick();
  return renderToStaticMarkup(get());
};

test("planner table defaults to its compact summary and expands the account list beneath running totals", () => {
  const html = render([row()]);
  assert.equal((html.match(/<th\b/g) || []).length, 5);
  assert.deepEqual(accountColumns(html), []);
  assert.match(html, /Running balance/);
  assert.match(html, /Expand accounts/);
  assert.match(html, /\$175\.00/);
  assert.match(html, /₱2,000\.00/);
  assert.doesNotMatch(html, /fpt-accounts-expanded|fpt-balances-row/);
  const get = harness({ rows: [row()] });
  const expand = button(get(), "Expand accounts");
  assert.equal(expand.props["aria-expanded"], false);
  expand.props.onClick();
  const expanded = renderToStaticMarkup(get());
  assert.equal((expanded.match(/<th\b/g) || []).length, 5);
  assert.match(expanded, /fpt-accounts-expanded/);
  assert.match(expanded, /fpt-account-list/);
  assert.match(expanded, /Account balances for Internet/);
  for (const label of ["Date", "Description", "USD", "PHP", "Recorded", "Balance owed"]) assert.ok(expanded.includes(label));
  assert.deepEqual(accountColumns(expanded), ["1", "34", "37"]);
  assert.match(expanded, /Daily checking · ••1234/);
  assert.match(expanded, /-\$25\.00/);
  assert.match(accountCell(expanded, 1), /\$175\.00/);
  assert.match(accountCell(expanded, 34), /₱2,000\.00/);
  assert.match(accountCell(expanded, 37), /₱600\.00/);
  assert.match(expanded, /aria-label="Details for Internet"/);
  assert.doesNotMatch(expanded, /Starting balances|Show columns|fpt-balances-row/);
  const collapse = button(get(), "Collapse accounts");
  assert.equal(collapse.props["aria-expanded"], true);
  collapse.props.onClick();
  const restored = renderToStaticMarkup(get());
  assert.deepEqual(accountColumns(restored), []);
  assert.equal((restored.match(/<th\b/g) || []).length, 5);
  assert.match(restored, /Running balance/);
  assert.match(restored, /\$175\.00/);
});

test("planner keeps the compact balance summary when no supported active accounts can expand", () => {
  for (const inactive of [[], [
    { id: 90, name: "Archived", currency: "USD", type: "checking", isArchived: true },
    { id: 91, name: "Merged", currency: "PHP", type: "savings", mergedIntoAccountId: 34 },
    { id: 92, name: "Other currency", currency: "EUR", type: "checking" },
  ]]) {
    const get = harness({ accounts: inactive, rows: [row()] });
    const expand = button(get(), "Expand accounts");
    assert.equal(expand.props.disabled, true);
    assert.equal(expand.props["aria-expanded"], false);
    const html = renderToStaticMarkup(get());
    assert.equal((html.match(/<th\b/g) || []).length, 5);
    assert.deepEqual(accountColumns(html), []);
    assert.match(html, /Running balance/);
    assert.match(html, /\$175\.00/);
    assert.doesNotMatch(html, /colSpan="0"|Collapse accounts/);
  }
});

test("transfer rows show source and card destination rather than a misleading zero cash amount", () => {
  const html = render([row({ id: "entry:card", source: "manual", kind: "transfer", currency: "PHP", amount: 300,
    fromAccountId: 34, toAccountId: 37, accountId: null, creditCardPaymentFor: 37, usd: 0, php: -300 })]);
  assert.match(plain(html), /Peso savingsto RCBC JCB/);
  assert.match(html, /-₱300\.00/);
  assert.match(html, /Card payment/);
});

test("recorded history displays its per-account balances and retains financial details", () => {
  const html = renderExpanded([row({ date: today, source: "transaction", completed: true, completionSource: "plan", planGenerated: true,
    entryId: "coffee", recordedInAccounts: true, awaitingBankSync: true, reserveUsd: 75, savingsPhp: 300,
    accountBalanceSnapshotKind: "recorded", accountBalanceSnapshotNote: "Reconstructed after recorded payment.",
    cardCreditActivity: true, recordedTransactions: [{ id: 3, date: today, kind: "expense", amount: 25,
      currency: "USD", description: "Bank receipt", accountName: "Daily checking" }] })], { onToggleComplete() {}, onEdit() {}, onDelete() {} });
  assert.match(accountCell(html, 1), /\$175\.00/);
  assert.match(html, /Awaiting bank match/);
  assert.match(html, /Bank receipt/);
  assert.match(html, /Annual reserve · USD/);
  assert.match(html, /Savings · PHP/);
  assert.match(html, /aria-label="Reopen Internet"/);

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

test("account columns use row snapshots instead of aggregate totals or current account fallbacks", () => {
  const html = renderExpanded([row({ balanceUsd: 9999, projectedBalanceUsd: 8888, projectedBalancePhp: 7777,
    accountBalanceSnapshot: [{ accountId: 37, balance: 600 }, { accountId: "1", balance: 0 }, { accountId: 34, balance: 42000 }] })],
    { plan: { ...plan, continuous: true } });
  assert.match(accountCell(html, 1), /\$0\.00/);
  assert.match(accountCell(html, 34), /₱42,000\.00/);
  assert.match(accountCell(html, 37), /₱600\.00/);
  assert.doesNotMatch(accountCell(html, 1), /\$9,999\.00|\$8,888\.00/);
});

test("current row is the last transaction today, then nearest past or first upcoming activity", () => {
  const rows = [row({ id: "older", date: "2026-11-16" }), row({ id: "first-today", date: today }),
    row({ id: "latest-today", date: today }), row({ id: "future", date: "2026-11-20" })];
  assert.equal(selectCurrentPlannerRow(rows, today).id, "latest-today");
  assert.equal(selectCurrentPlannerRow(rows.filter((entry) => entry.date !== today), today).id, "older");
  assert.equal(selectCurrentPlannerRow([row({ id: "later", date: "2026-12-01" }), row({ id: "soon", date: "2026-11-20" })], today).id, "soon");
  assert.equal(selectCurrentPlannerRow([], today), null);
  const html = render(rows);
  assert.equal((html.match(/aria-current="true"/g) || []).length, 1);
  assert.equal((html.match(/fpt-row-today/g) || []).length, 2);
  assert.match(html, /Latest today/);
  assert.match(html, /Jump to current/);
  assert.match(html, /role="region" aria-label="Scrollable transaction table"/);
});

test("expanded account columns show zero, card credits and unavailable values without row panels", () => {
  const snapshot = [
    { accountId: 1, name: "Daily checking", mask: "1234", type: "checking", currency: "USD", balance: 0 },
    { accountId: 34, name: "Peso savings", type: "savings", currency: "PHP", balance: 12000 },
    { accountId: 37, name: "RCBC JCB", type: "credit", currency: "PHP", balance: -125, isDebt: true },
    { accountId: 50, name: "Unreported account", type: "checking", currency: "USD", balance: null },
  ];
  const rows = [row({ accountBalanceSnapshot: snapshot, accountBalanceSnapshotKind: "projected" })];
  const before = structuredClone(rows);
  const html = renderExpanded(rows, { accounts: [...accounts, { id: 50, name: "Unreported account", type: "checking", currency: "USD", nativeCurrentBalance: 99999 }] });
  assert.deepEqual(accountColumns(html), ["1", "34", "37", "50"]);
  for (const label of ["Daily checking · ••1234", "Peso savings", "RCBC JCB", "Unreported account"]) assert.ok(html.includes(label));
  assert.match(accountCell(html, 1), /\$0\.00/);
  assert.match(accountCell(html, 34), /₱12,000\.00/);
  assert.match(accountCell(html, 37), /-₱125\.00/);
  assert.match(accountCell(html, 37), /Credit/);
  assert.match(accountCell(html, 50), /—/);
  assert.doesNotMatch(html, /\$99,999\.00|Hide account balances|fpt-balances-row/);
  assert.deepEqual(rows, before);
});

test("historical balance columns distinguish recorded snapshots from unavailable coverage", () => {
  for (const kind of ["recorded", "unavailable"]) {
    const html = renderExpanded([row({ date: "2026-11-17", accountBalanceSnapshotKind: kind,
      accountBalanceSnapshotNote: kind === "unavailable" ? "Later transaction history is incomplete." : "Balances after the recorded transaction.",
      accountBalanceSnapshot: kind === "recorded" ? [{ accountId: 1, name: "Checking", type: "checking", currency: "USD", balance: 175 }] : [],
    })], { accounts: accounts.map((account) => ({ ...account, nativeCurrentBalance: 99999 })) });
    assert.deepEqual(accountColumns(html), ["1", "34", "37"]);
    assert.match(accountCell(html, 1), kind === "recorded" ? /\$175\.00/ : /—/);
    if (kind === "unavailable") {
      assert.match(html, /Later transaction history is incomplete/);
      assert.doesNotMatch(accountCell(html, 1), /\$99,999\.00|\$175\.00/);
    }
  }
});

test("account list order is stable through filters and excludes inactive or unsupported accounts", () => {
  const extra = [
    { id: 90, name: "Archived", currency: "USD", type: "checking", isArchived: true },
    { id: 91, name: "Merged", currency: "PHP", type: "savings", mergedIntoAccountId: 34 },
    { id: 92, name: "Other currency", currency: "EUR", type: "checking" },
  ];
  const get = harness({ accounts: [...accounts, ...extra], rows: [row({ id: "paid", date: today, completed: true, recordedInAccounts: true }), row()] });
  button(get(), "Expand accounts").props.onClick();
  const before = accountColumns(renderToStaticMarkup(get()));
  assert.deepEqual(before, ["1", "34", "37"]);
  button(get(), "Upcoming").props.onClick();
  assert.deepEqual(accountColumns(renderToStaticMarkup(get())), before);
  button(get(), "Recorded").props.onClick();
  assert.deepEqual(accountColumns(renderToStaticMarkup(get())), before);
});

function effectHarness(initialProps, geometry = {}) {
  const slots = [];
  let cursor = 0;
  let effects = [];
  let previousRows = [];
  let props = initialProps;
  let expanded = false;
  const useState = (initial) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
  };
  const Component = load(file, { ...require("react"), useState,
    useRef(initial) { return useState(() => ({ current: initial }))[0]; },
    useEffect(callback, dependencies) {
      const index = cursor++;
      if (!slots[index] || dependencies.some((value, i) => !Object.is(value, slots[index][i]))) effects.push(callback);
      slots[index] = dependencies;
    },
  }).default;
  const calls = [];
  const scroller = { scrollTop: 0, scrollLeft: 0,
    querySelector() { return { getBoundingClientRect: () => ({ height: geometry.headerHeight?.(expanded) ?? 40 }) }; },
    getBoundingClientRect() { return { top: 100 }; },
    scrollTo(value) { calls.push(value); this.scrollTop = value.top; if (value.left != null) this.scrollLeft = value.left; },
  };
  const all = (node, predicate) => Array.isArray(node) ? node.flatMap((child) => all(child, predicate))
    : node && typeof node === "object" ? [...(predicate(node) ? [node] : []), ...all(node.props?.children, predicate)] : [];
  return {
    calls, scroller,
    render(next = {}) {
      props = { ...props, ...next }; cursor = 0; effects = [];
      const tree = Component({ plan, accounts, today, ...props });
      expanded = tree.props.className.includes("fpt-accounts-expanded");
      for (const previous of previousRows) previous.props.ref(null);
      previousRows = all(tree, (node) => node.type === "tr" && node.props["data-row-id"]);
      const viewport = find(tree, (node) => node.props?.className === "fpt-table-wrap");
      if (viewport) viewport.props.ref.current = scroller;
      previousRows.forEach((node) => {
        const index = props.rows.findIndex((entry) => entry.id === node.props["data-row-id"]);
        node.props.ref({ getBoundingClientRect: () => geometry.rowRect?.({ index, expanded, scrollTop: scroller.scrollTop })
          ?? { top: 100 + index * 200 - scroller.scrollTop, bottom: 300 + index * 200 - scroller.scrollTop } });
      });
      for (const effect of effects) effect();
      return tree;
    },
  };
}

test("table scrolls its own viewport once per range and preserves manual position through column expansion and filters", () => {
  const rows = [row({ id: "old", date: "2026-11-17" }), row({ id: "today-one", date: today }),
    row({ id: "today-two", date: today }), row({ id: "future", date: "2026-11-20" })];
  const get = effectHarness({ rows, viewKey: "november" });
  let tree = get.render();
  assert.deepEqual(get.calls, [{ top: 344, behavior: "auto" }]);
  get.scroller.scrollTop = 50;
  tree = get.render({ rows: rows.map((entry) => ({ ...entry })) });
  assert.equal(get.calls.length, 1, "refresh cannot override the user's scroll");
  button(tree, "Expand accounts").props.onClick();
  tree = get.render();
  assert.equal(get.calls.length, 2);
  assert.equal(get.calls.at(-1).top, 50, "expanding columns preserves the visible row rather than jumping to current");
  assert.equal(get.scroller.scrollTop, 50);
  assert.deepEqual(accountColumns(renderToStaticMarkup(tree)), ["1", "34", "37"]);
  tree = get.render({ rows: rows.map((entry) => ({ ...entry })) });
  assert.deepEqual(accountColumns(renderToStaticMarkup(tree)), ["1", "34", "37"], "refresh keeps expanded columns open");
  button(tree, "Upcoming").props.onClick();
  tree = get.render();
  assert.equal(get.scroller.scrollTop, 50);
  assert.equal(get.calls.length, 2, "filtering account columns cannot re-anchor the table");
  assert.deepEqual(accountColumns(renderToStaticMarkup(tree)), ["1", "34", "37"]);
  button(tree, "Collapse accounts").props.onClick();
  tree = get.render();
  assert.equal(get.calls.length, 3);
  assert.equal(get.calls.at(-1).top, 50, "collapsing columns preserves the visible row rather than jumping to current");
  assert.equal(get.scroller.scrollTop, 50);
  assert.deepEqual(accountColumns(renderToStaticMarkup(tree)), []);
  button(tree, "Jump to current").props.onClick();
  tree = get.render();
  assert.equal(get.calls.length, 4);
  assert.equal(get.calls.at(-1).top, 344);
  assert.match(renderToStaticMarkup(tree), /4 transactions/);
  get.scroller.scrollTop = 25;
  get.render({ viewKey: "new-window" });
  assert.equal(get.calls.length, 5, "a new date window positions current activity again");
  assert.equal(get.calls.at(-1).top, 344);
});

test("changing column layouts preserves the first fully visible row rather than the clipped row above it", () => {
  const rows = [row({ id: "partly-visible", date: "2026-11-17" }), row({ id: "fully-visible", date: today })];
  const get = effectHarness({ rows }, {
    headerHeight: (expanded) => expanded ? 80 : 40,
    rowRect: ({ index, expanded, scrollTop }) => {
      const height = expanded ? 60 : 100;
      const top = 100 + (expanded ? 80 : 40) + index * height - scrollTop;
      return { top, bottom: top + height };
    },
  });
  let tree = get.render();
  get.scroller.scrollTop = 50;
  tree = get.render();
  button(tree, "Expand accounts").props.onClick();
  tree = get.render();
  assert.equal(get.scroller.scrollTop, 10,
    "the second row remains 50px below the expanded header; anchoring the clipped first row would leave scrollTop at 50");
  assert.deepEqual(get.calls.at(-1), { top: 10, left: 0 });
  button(tree, "Collapse accounts").props.onClick();
  get.render();
  assert.equal(get.scroller.scrollTop, 50, "collapsing restores that same fully visible row's offset");
});
