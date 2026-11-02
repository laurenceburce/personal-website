import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as planner from "../app/lib/financePlanner.mjs";
import * as insights from "../app/lib/financeInsights.mjs";

// Render real JSX with Next's compiler. Effects never run in these server
// renders, so no bank windows, provider calls, or personal records are touched.
const require = createRequire(import.meta.url);
const swc = require("next/dist/build/swc");
await swc.loadBindings();
const url = new URL("../app/finance/FinanceActivity.js", import.meta.url);
const { code } = await swc.transform(await readFile(url, "utf8"), {
  filename: fileURLToPath(url),
  jsc: {
    parser: { syntax: "ecmascript", jsx: true },
    transform: { react: { runtime: "automatic" } },
    target: "es2022",
  },
  module: { type: "commonjs" },
});
const componentModule = { exports: {} };
new Function("require", "module", "exports", code)(
  (specifier) => {
    if (specifier.endsWith(".css")) return {};
    if (specifier === "../lib/financePlanner.mjs") return planner;
    if (specifier === "../lib/financeInsights.mjs") return insights;
    return require(specifier);
  },
  componentModule,
  componentModule.exports,
);
const { QuickTransactionForm, TransactionsPanel, BankAccountsPanel } =
  componentModule.exports;
const account = {
  id: 1,
  name: "PHP cash",
  type: "cash",
  currency: "PHP",
  nativeCurrentBalance: 6300,
  nativeAvailableBalance: null,
  isLinked: false,
};
const transactions = [
  {
    id: 1,
    date: "2024-01-06",
    kind: "income",
    amount: 500,
    currency: "USD",
    merchant: "Freelance",
    category: "Income",
    provider: "",
    pending: false,
  },
  {
    id: 2,
    date: "2024-01-07",
    kind: "expense",
    amount: 126,
    currency: "PHP",
    merchant: "Lunch",
    category: "Dining",
    provider: "",
    pending: false,
  },
  {
    id: 3,
    date: "2024-01-08",
    kind: "expense",
    amount: 50,
    currency: "USD",
    merchant: "Bank purchase",
    category: "Shopping",
    provider: "plaid",
    pending: false,
  },
  {
    id: 4,
    date: "2024-01-09",
    kind: "income",
    amount: 9000,
    currency: "USD",
    merchant: "Transfer between accounts",
    category: "Transfer In",
    provider: "plaid",
    pending: false,
  },
  {
    id: 5,
    date: "2024-01-10",
    kind: "expense",
    amount: 8000,
    currency: "USD",
    merchant: "Transfer to savings",
    category: "Transfer Out",
    provider: "plaid",
    pending: false,
  },
  {
    id: 6,
    date: "2024-01-11",
    kind: "expense",
    amount: 7000,
    currency: "USD",
    merchant: "Loan repayment",
    category: "Loan Payments",
    provider: "plaid",
    pending: false,
  },
  {
    id: 7,
    date: "2024-01-12",
    kind: "expense",
    amount: 6000,
    currency: "USD",
    merchant: "Pending flight",
    category: "Travel",
    provider: "plaid",
    pending: true,
  },
];
const activity = {
  configured: true,
  month: "2024-01",
  accounts: [account],
  transactions,
  categories: ["Other", "Income", "Dining"],
  connections: [],
  providers: {
    plaid: { configured: true, environment: "production" },
    brankas: { configured: false, syncSupported: false },
  },
  limitHit: false,
};
const render = (Component, props) =>
  renderToStaticMarkup(createElement(Component, props));
const tableProps = {
  activity,
  month: "2024-01",
  currency: "USD",
  rate: 63,
  onAdd() {},
  onEdit() {},
  onDelete() {},
};

test("quick add puts amount and description before optional details and retains manual-cash fallback", () => {
  const html = render(QuickTransactionForm, {
    accounts: [account],
    categories: activity.categories,
    rate: 63,
    onSave() {},
  });
  assert.ok(html.indexOf("Transaction amount") < html.indexOf("Description"));
  assert.ok(html.indexOf("Description") < html.indexOf("Date, account"));
  assert.match(html, /Unassigned \/ cash/);
  assert.match(html, /without changing a tracked bank balance/);
  assert.match(html, /won’t create a recurring bill or move money/);
  assert.match(html, /min="0.01"/);
  assert.match(html, /name|aria-label="Transaction amount"/);
});

test("editing an assigned PHP entry preserves its native currency and locks the currency picker", () => {
  const html = render(QuickTransactionForm, {
    accounts: [account],
    categories: activity.categories,
    rate: 63,
    transaction: { ...transactions[1], accountId: 1 },
    onSave() {},
  });
  assert.match(html, /option value="PHP" selected=""/);
  assert.match(html, /<select disabled="">/);
  assert.match(html, /option value="1" selected=""/);
  assert.match(html, /About \$2\.00/);
});

test("activity totals agree with the overview and keep transfers, loans and pending records visible", () => {
  const html = render(TransactionsPanel, tableProps);
  const summary =
    html.match(/class="fa-activity-summary"[\s\S]*?<\/div><\/div>/)?.[0] || "";
  assert.match(summary, /Posted income[\s\S]*?\$500\.00/);
  assert.match(summary, /Posted spending[\s\S]*?\$52\.00/);
  assert.match(html, /Transfer between accounts/);
  assert.match(html, /Transfer to savings/);
  assert.match(html, /Loan repayment/);
  assert.match(html, /Pending flight/);
  assert.match(html, /Edit Lunch/);
  assert.doesNotMatch(html, /Edit Bank purchase|Delete Bank purchase/);
  assert.match(html, /Bank import, read only/);
  assert.match(html, /transfers, and loan/);
});

test("PHP totals and selected-month history switch together", () => {
  const html = render(TransactionsPanel, { ...tableProps, currency: "PHP" });
  const summary =
    html.match(/class="fa-activity-summary"[\s\S]*?<\/div><\/div>/)?.[0] || "";
  assert.ok(summary.includes(planner.money(31500, "PHP")));
  assert.ok(summary.includes(planner.money(3276, "PHP")));
  const empty = render(TransactionsPanel, { ...tableProps, month: "2024-02" });
  assert.doesNotMatch(empty, /Lunch|Bank purchase/);
  assert.match(empty, /A clearer picture starts here/);
});

test("bank cards preserve liability sign and do not offer unsupported Brankas sync", () => {
  const html = render(BankAccountsPanel, {
    activity: {
      ...activity,
      accounts: [
        {
          ...account,
          id: 2,
          name: "Credit card",
          type: "credit",
          currency: "USD",
          nativeCurrentBalance: -25,
          nativeAvailableBalance: 1025,
          isLinked: true,
          provider: "plaid",
        },
      ],
      connections: [
        {
          id: 3,
          provider: "brankas",
          institutionName: "PH authorization",
          status: "linked",
          lastSyncedAt: null,
        },
      ],
    },
    currency: "USD",
    rate: 63,
    onAction: async () => {},
    onRefresh: async () => {},
  });
  assert.match(html, /Credit balance/);
  assert.match(html, /\$25\.00/);
  assert.match(html, /Available credit/);
  assert.match(html, /Authorization only/);
  assert.match(html, /imports aren’t available/);
  assert.doesNotMatch(html, /Sync now|fa-sandbox-badge/);
});

test("sandbox connections are visibly marked and disabled provider setup cannot launch a link", () => {
  const html = render(BankAccountsPanel, {
    activity: {
      ...activity,
      providers: {
        plaid: { configured: false, environment: "sandbox" },
        brankas: { configured: false, syncSupported: false },
      },
    },
    rate: 63,
    onAction: async () => {},
    onRefresh: async () => {},
  });
  assert.match(html, /fa-sandbox-badge/);
  assert.match(html, /Plaid isn’t enabled for this app yet/);
  assert.match(html, /disabled=""[\s\S]*?Connect US bank/);
});
