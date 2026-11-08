import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as planner from "../app/lib/financePlanner.mjs";
import {
  buildAccountPlan,
  getFinanceAccountAllocations,
} from "../app/lib/financeAccountPlan.mjs";

const require = createRequire(import.meta.url);
const { transformSync } = require("next/dist/build/swc");
async function compile(relative, dependencies = {}) {
  const url = new URL(relative, import.meta.url);
  const { code } = transformSync(await readFile(url, "utf8"), {
    filename: fileURLToPath(url),
    jsc: {
      parser: { syntax: "ecmascript", jsx: true },
      transform: { react: { runtime: "automatic" } },
      target: "es2022",
    },
    module: { type: "commonjs" },
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(
    (specifier) =>
      specifier.endsWith(".css")
        ? {}
        : dependencies[specifier] || require(specifier),
    module,
    module.exports,
  );
  return module.exports;
}
const selector = await compile("../app/finance/FinanceAccountSelect.js");
const components = await compile("../app/finance/FinanceAccountPlanView.js", {
  "../lib/financePlanner.mjs": planner,
  "./FinanceAccountSelect": selector,
});
const AccountPlanView = components.default;
const AllocationSummary = components.AccountAllocationSummary;
const render = (Component, props) =>
  renderToStaticMarkup(createElement(Component, props));
const plain = (html) => html.replace(/<[^>]*>/g, "");
const accounts = [
  {
    id: 1,
    name: "Checking",
    type: "checking",
    currency: "USD",
    mask: "1234",
    institutionName: "Example Bank",
    nativeCurrentBalance: 100,
  },
  {
    id: 2,
    name: "Savings",
    type: "savings",
    currency: "USD",
    mask: "2345",
    institutionName: "Example Bank",
    nativeCurrentBalance: 395,
  },
  {
    id: 3,
    name: "Savings",
    type: "savings",
    currency: "USD",
    mask: "3456",
    institutionName: "Example Bank",
    nativeCurrentBalance: 0,
  },
  {
    id: 4,
    name: "Credit card",
    type: "credit",
    currency: "USD",
    mask: "4567",
    institutionName: "Example Bank",
    nativeCurrentBalance: 50,
  },
];
const document = {
  salary: {
    amount: 2000,
    currency: "USD",
    payFrequency: "semimonthly",
    firstPayDate: "2026-11-06",
    accountId: 1,
  },
  bills: [
    {
      id: "venture",
      name: "Venture X",
      amount: 395,
      currency: "USD",
      cadence: "annual",
      dueDay: 28,
      dueMonths: [11],
      savedAmount: 395,
      accountId: 1,
      reserveAccountId: 2,
      sourceAccountId: 1,
    },
    {
      id: "monthly",
      name: "Subscription",
      amount: 10,
      currency: "USD",
      cadence: "monthly",
      dueDay: 10,
      dueDays: [10],
      dueMonths: [],
      accountId: 1,
    },
  ],
  allocations: [
    {
      id: "saving",
      name: "Payday savings",
      kind: "savings",
      amount: 500,
      currency: "USD",
      accountId: 3,
      sourceAccountId: 1,
    },
  ],
};
const plan = {
  startDate: "2026-11-02",
  endDate: "2026-11-30",
  openingUsd: 100,
  openingPhp: 0,
  openingReserveUsd: 0,
  openingReservePhp: 0,
  includeIncome: true,
  includeTransactions: false,
  includeAnnualReserve: true,
  includeAllocations: true,
  entries: [],
  accountOpeningBalances: accounts.map((account) => ({
    accountId: account.id,
    balance: account.nativeCurrentBalance,
  })),
};

test("account allocation cards distinguish annual reserves, payday savings and receiving salary", () => {
  const allocations = getFinanceAccountAllocations(
    document,
    accounts,
    63,
    "2026-11-02",
  );
  let navigation;
  const html = render(AllocationSummary, {
    allocations,
    accounts,
    onNavigate: (value) => {
      navigation = value;
    },
  });
  const text = plain(html);
  assert.match(text, /Savings · ••2345 · Example Bank · savings · USD/);
  assert.match(text, /Savings · ••3456 · Example Bank · savings · USD/);
  assert.match(text, /Salary received each payday\$1,000\.00/);
  assert.match(text, /Saved for annual bills\$395\.00/);
  assert.match(text, /Savings each payday\$500\.00/);
  assert.doesNotMatch(text, /Credit card/);
  const tree = AllocationSummary({
    allocations,
    accounts,
    onNavigate: (value) => {
      navigation = value;
    },
  });
  tree.props.children[0].props.children[1].props.onClick();
  assert.equal(navigation, "accounts");
});

test("projected account cards show ending reserves after payment and transferred payday savings", () => {
  const projection = buildAccountPlan(plan, document, 63, {
    accounts,
    today: "2026-11-02",
  });
  const html = render(AccountPlanView, { projection });
  const text = plain(html);
  assert.match(text, /Projected ending balance\$1,090\.00/);
  assert.match(text, /Payday savings in this plan\$1,000\.00/);
  assert.match(text, /Savings · ••2345/);
  assert.match(text, /Savings · ••3456/);
  assert.doesNotMatch(text, /Projected annual reserves\$395\.00/);
  assert.match(text, /Projected balance owed\$50\.00/);
  assert.match(text, /Uses the account starting balances set for this plan/);
  assert.match(text, /These are forecasts/);
  assert.doesNotMatch(html, /NaN|undefined|Infinity/);
});

test("bank-based projections skip recorded history while explicit plan openings preserve it", () => {
  const historical = {
    ...plan,
    startDate: "2026-11-01",
    accountOpeningBalances: [],
    includeIncome: false,
    includeAllocations: false,
    includeAnnualReserve: false,
    includeTransactions: true,
  };
  const projection = buildAccountPlan(
    historical,
    { salary: document.salary, bills: [], allocations: [] },
    63,
    {
      accounts: [accounts[0]],
      today: "2026-11-02",
      transactions: [
        {
          id: 99,
          date: "2026-11-01",
          accountId: 1,
          merchant: "Recorded bank debit",
          kind: "expense",
          amount: 20,
          currency: "USD",
          provider: "plaid",
        },
      ],
    },
  );
  const text = plain(render(AccountPlanView, { projection }));
  assert.match(text, /Starting from current synced balances/);
  assert.match(text, /Projected ending balance\$100\.00/);
  assert.match(
    text,
    /Set dated account opening balances to review a historical plan/,
  );
});

test("unknown bank balances stay unavailable and overallocated reserves remain visible", () => {
  const allocations = getFinanceAccountAllocations(
    document,
    [{ ...accounts[1], nativeCurrentBalance: 100 }],
    63,
    "2026-11-02",
  );
  const text = plain(render(AllocationSummary, { allocations, accounts }));
  assert.match(text, /Balance outside annual reserves-\$295\.00/);
  assert.match(text, /exceed this bank balance by \$295\.00/);
  const unknown = render(AccountPlanView, {
    projection: {
      openingSource: "bank",
      warnings: [],
      accounts: [
        {
          accountId: 5,
          name: "Unavailable bank balance",
          currency: "USD",
          type: "savings",
          openingBalance: null,
          endingBalance: null,
          annualReserved: 0,
          endingAnnualReserved: 0,
        },
      ],
    },
  });
  assert.match(plain(unknown), /Starting balance—Projected ending balance—/);
  assert.doesNotMatch(unknown, /\$0\.00/);
});

test("account warnings preserve native currencies, negative cash and safe missing-assignment copy", () => {
  const html = render(AccountPlanView, {
    projection: {
      openingSource: "plan",
      warnings: [
        "Choose both source and destination accounts.",
        { message: "Reserve account has been removed." },
      ],
      accounts: [
        {
          accountId: 9,
          name: "Peso account",
          mask: "9999",
          currency: "PHP",
          type: "checking",
          openingBalance: 100,
          endingBalance: -200,
          endingAnnualReserved: 50,
          savingsAllocated: 0,
        },
      ],
    },
  });
  assert.match(html, /role="status"/);
  assert.match(plain(html), /Reserve account has been removed/);
  assert.match(plain(html), /Projected ending balance-₱200\.00/);
  assert.match(plain(html), /Projected annual reserves₱50\.00/);
  assert.match(html, /class="fp-negative"/);
});

test("empty allocations and projections do not invent account cards", () => {
  assert.equal(
    render(AllocationSummary, { allocations: [], accounts: [] }),
    "",
  );
  assert.equal(
    render(AccountPlanView, { projection: { accounts: [], warnings: [] } }),
    "",
  );
});

test("live percentage account forecasts explain their current balance source and separate flat funds", () => {
  const projection = buildAccountPlan(
    {
      ...plan,
      includeIncome: false,
      includeAllocations: false,
      includeAnnualReserve: false,
      startingAccounts: [{ accountId: 1, percentage: 80 }],
      accountOpeningBalances: [],
    },
    { salary: {}, bills: [], allocations: [] },
    63,
    { accounts: [accounts[0]], today: "2026-11-02" },
  );
  const text = plain(render(AccountPlanView, { projection }));
  assert.match(text, /Selected account shares use current synced balances/);
  assert.match(text, /Flat starting amounts are tracked in the overall plan/);
  assert.match(text, /Starting balance\$80\.00/);
  assert.match(text, /Projected ending balance\$80\.00/);
  assert.doesNotMatch(text, /\$9,999\.00/);
});
