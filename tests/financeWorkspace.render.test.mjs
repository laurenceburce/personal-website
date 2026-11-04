import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as planner from "../app/lib/financePlanner.mjs";
import * as insights from "../app/lib/financeInsights.mjs";
import * as accountPlan from "../app/lib/financeAccountPlan.mjs";

// Render the actual workspace and its child components with Next's JSX compiler.
// Stylesheets do not affect the financial values asserted here.
const require = createRequire(import.meta.url);
const { transformSync } = require("next/dist/build/swc");
const modules = new Map();
function loadComponent(filename, reactOverride) {
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
  const componentRequire = (specifier) => {
    if (specifier === "react" && reactOverride) return reactOverride;
    if (specifier.endsWith(".css")) return {};
    if (specifier === "../lib/financePlanner.mjs") return planner;
    if (specifier === "../lib/financeInsights.mjs") return insights;
    if (specifier === "../lib/financeAccountPlan.mjs") return accountPlan;
    if (specifier.startsWith("./")) {
      return loadComponent(resolve(dirname(filename), `${specifier}.js`));
    }
    return require(specifier);
  };
  new Function("require", "module", "exports", code)(
    componentRequire,
    module,
    module.exports,
  );
  return module.exports;
}
const Workspace = loadComponent(
  fileURLToPath(new URL("../app/finance/FinanceAppClient.js", import.meta.url)),
).default;

function fixture(
  tab,
  savedAmount,
  documentOverrides = {},
  activityOverrides = {},
) {
  const document = {
    salary: {
      amount: 2600,
      currency: "USD",
      payFrequency: "biweekly",
      firstPayDate: "2026-10-23",
    },
    bills: [
      {
        id: "venture",
        name: "Venture X",
        cadence: "annual",
        amount: 395,
        currency: "USD",
        savedAmount,
        dueDay: 28,
        dueMonths: [11],
      },
    ],
    allocations: [],
    plans: [
      {
        id: "november",
        name: "November",
        startDate: "2026-11-01",
        endDate: "2026-11-30",
        openingUsd: 750,
        openingPhp: 0,
        openingReserveUsd: 0,
        openingReservePhp: 0,
        includeIncome: false,
        includeTransactions: false,
        includeAnnualReserve: false,
        includeAllocations: false,
        entries: [],
      },
    ],
    ...documentOverrides,
  };
  return {
    today: "2026-11-02",
    snapshot: {
      configured: true,
      revision: 1,
      document,
      exchangeRate: { rate: 63, stale: false, date: "2026-11-02" },
    },
    initialTab: tab,
    initialActivity: {
      configured: true,
      month: "2026-11",
      accounts: [],
      transactions: [],
      ...activityOverrides,
    },
  };
}
function render(tab, savedAmount, documentOverrides, activityOverrides) {
  return renderToStaticMarkup(
    createElement(
      Workspace,
      fixture(tab, savedAmount, documentOverrides, activityOverrides),
    ),
  );
}
const plain = (html) => html.replace(/<[^>]*>/g, "");

test("budget plans automatically include full card statements on their due dates", () => {
  const html = render("plans", 0, { bills: [] }, {
    accounts: [{
      id: 7, name: "Travel card", type: "credit", isLinked: true,
      currency: "USD", nativeCurrentBalance: 650,
      creditCardDueStatus: "current",
      creditCardDue: { statementBalance: 300, minimumPayment: 25, dueDate: "2026-11-15" },
    }],
  });
  assert.match(plain(html), /Credit card statement due/);
  assert.match(plain(html), /Statement balance \$300\.00/);
  assert.match(plain(html), /Available funds · USD\$450\.00/);
  assert.match(html, /Nov 15/);
  assert.ok(!html.includes("Statement balance $25.00"));
});

test("plans flag unavailable and stale statements while retaining known dues", () => {
  const html = render("plans", 0, { bills: [] }, {
    accounts: [
      { id: 7, name: "Missing card", type: "credit", isLinked: true, currency: "USD", nativeCurrentBalance: 100 },
      {
        id: 8, name: "Cached card", type: "credit", isLinked: true, currency: "USD", nativeCurrentBalance: 500,
        creditCardDueStatus: "stale", creditCardDue: { statementBalance: 200, dueDate: "2026-11-20" },
      },
    ],
  });
  assert.match(plain(html), /Statement balances or due dates are unavailable for Missing card/);
  assert.match(plain(html), /Using last known statement details for Cached card/);
  assert.match(plain(html), /Available funds · USD\$550\.00/);
  assert.match(plain(html), /Review Bank accounts/);
});

test("statement-cycle payment history reduces future dues without adding earlier flows to the ledger", () => {
  const base = fixture("plans", 0).snapshot.document.plans[0];
  const props = fixture("plans", 0, { bills: [], plans: [{ ...base, startDate: "2026-11-15" }] }, {
    accounts: [{
      id: 7, name: "Travel card", type: "credit", isLinked: true, currency: "USD", nativeCurrentBalance: 500,
      creditCardDueStatus: "current", creditCardDue: { statementBalance: 300, dueDate: "2026-11-20", lastStatementDate: "2026-10-25" },
    }],
  });
  props.today = "2026-11-10";
  props.initialPlanActivity = {
    configured: true, from: "2026-11-15", to: base.endDate, transactions: [],
    creditCardPaymentTransactions: [
      { id: 8, date: "2026-11-02", kind: "income", amount: 50, currency: "USD", accountId: 7, category: "Transfer In" },
      { id: 9, date: "2026-11-07", kind: "income", amount: 70, currency: "USD", accountId: 7, category: "Transfer In" },
    ],
    creditCardPaymentWarning: "Some statement payment history could not be checked.",
  };
  const html = renderToStaticMarkup(createElement(Workspace, props));
  assert.match(plain(html), /Statement balance \$300\.00 · Paid \$120\.00 · Remaining \$180\.00/);
  assert.match(plain(html), /Available funds · USD\$570\.00/);
  assert.match(plain(html), /Some statement payment history could not be checked/);
  assert.ok(!html.includes("fpl-row-transaction"));
});

test("monthly bill reserves and commitment cards recalculate from saved balances", () => {
  for (const [saved, monthly, remaining] of [
    [0, "$427.92", "$395.00"],
    [100, "$319.58", "$295.00"],
    [395, "$0.00", "$0.00"],
    [100, "$319.58", "$295.00"],
  ]) {
    const html = render("bills", saved);
    assert.ok(html.includes("Annual bills reserve"));
    assert.ok(html.includes(monthly));
    if (saved === 395) {
      assert.ok(plain(html).includes("Your annual bills are fully funded."));
      assert.ok(!html.includes("$427.92"));
      assert.ok(html.includes("$2,600.00"));
    } else {
      assert.ok(plain(html).includes(`still to fund is ${remaining}`));
      assert.ok(!plain(html).includes("Your annual bills are fully funded."));
    }
  }
});

test("workspace spending totals recover funds as an annual bill is saved, then adjust when lowered", () => {
  for (const [saved, monthly, contribution, available] of [
    [0, "$427.92", "-$197.50", "$1,002.50"],
    [100, "$319.58", "-$147.50", "$1,052.50"],
    [395, "$0.00", "$0.00", "$1,200.00"],
    [100, "$319.58", "-$147.50", "$1,052.50"],
  ]) {
    const html = render("spending", saved);
    const annual = html.match(/fp-spending-annual[^>]*>([\s\S]*?)<\/b>/)?.[1];
    assert.ok(annual, "the annual funding row is rendered");
    assert.ok(plain(annual).includes(`${monthly} / month`));
    assert.ok(plain(annual).includes(`${contribution} per payday`));
    assert.ok(
      plain(html).includes(
        `Left to spendAfter bills &amp; your allocations${available}`,
      ),
    );
    assert.ok(html.includes("Monthly funding total for upcoming payments"));
  }
});

const screenshotAnnualBills = [
  {
    id: "microsoft",
    name: "Microsoft",
    amount: 100,
    savedAmount: 14.79,
    dueDay: 9,
    dueMonths: [9],
  },
  {
    id: "domain",
    name: "Namecheap",
    amount: 20,
    savedAmount: 8.27,
    dueDay: 4,
    dueMonths: [6],
  },
  {
    id: "venture",
    name: "Venture X",
    amount: 395,
    savedAmount: 395,
    dueDay: 28,
    dueMonths: [11],
  },
  {
    id: "car",
    name: "Car Maintenance",
    amount: 500,
    savedAmount: 85.64,
    dueDay: 1,
    dueMonths: [3, 9],
  },
].map((bill) => ({ ...bill, cadence: "annual", currency: "USD" }));

test("the spending, chart and dated plan use the same deadline contributions for on-track annual bills", () => {
  const overrides = { bills: screenshotAnnualBills };
  const spending = render("spending", 0, overrides);
  const annual = spending.match(/fp-spending-annual[^>]*>([\s\S]*?)<\/b>/)?.[1];
  assert.ok(plain(annual).includes("$49.60 / month"));
  assert.ok(plain(annual).includes("-$22.89 per payday"));
  const breakdown = spending.match(
    /fp-annual-funding-details[^>]*>([\s\S]*?)<\/details>/,
  )?.[1];
  const breakdownText = plain(breakdown);
  assert.ok(
    breakdownText.includes("22 paydays left · $85.21 to fund by Sep 9, 2027"),
  );
  assert.ok(
    breakdownText.includes("16 paydays left · $11.73 to fund by Jun 4, 2027"),
  );
  assert.ok(
    breakdownText.includes("9 paydays left · $164.36 to fund by Mar 1, 2027"),
  );
  assert.ok(breakdownText.includes("$18.27 / payday"));
  assert.ok(breakdownText.includes("$39.59 / month"));
  assert.ok(!spending.includes("$19.67"));
  const overview = render("home", 0, overrides);
  assert.ok(plain(overview).includes("Annual reserve$49.60"));
  const basePlan = fixture("plans", 0).snapshot.document.plans[0];
  const plans = render("plans", 0, {
    ...overrides,
    plans: [{ ...basePlan, includeAnnualReserve: true }],
  });
  assert.equal((plans.match(/class="fpl-row /g) || []).length, 3);
  assert.equal((plain(plans).match(/-\$22\.89/g) || []).length, 2);
  assert.ok(plain(plans).includes("Available funds · USD$704.22"));
  assert.ok(plain(plans).includes("Annual reserve · USD$154.48"));
  assert.ok(
    plain(plans).includes(
      "Total bill $395.00 · $395.00 from reserves · $0.00 additional cash",
    ),
  );
});

test("cash needed before the next payday is visible outside regular annual contributions", () => {
  const overrides = {
    bills: [
      {
        ...screenshotAnnualBills[0],
        amount: 100,
        savedAmount: 25,
        dueDay: 3,
        dueMonths: [11],
      },
    ],
  };
  const spending = plain(render("spending", 0, overrides));
  assert.ok(spending.includes("$75.00 needed before the next payday"));
  assert.ok(
    spending.includes(
      "Annual payments need $75.00 before the next eligible payday",
    ),
  );
  const overview = plain(render("home", 0, overrides));
  assert.ok(
    overview.includes(
      "Annual bills need $75.00 before the next eligible payday",
    ),
  );
  const tinyPhp = {
    bills: [
      { ...overrides.bills[0], currency: "PHP", amount: 0.01, savedAmount: 0 },
    ],
  };
  assert.ok(
    plain(render("spending", 0, tinyPhp)).includes(
      "Annual payments need ₱0.01 before the next eligible payday",
    ),
  );
  assert.ok(
    plain(render("home", 0, tinyPhp)).includes(
      "Annual bills need ₱0.01 before the next eligible payday",
    ),
  );
});

test("workspace budget balances and annual payment details use the edited item savings once", () => {
  for (const [saved, needed, ending] of [
    [0, "$395.00", "$355.00"],
    [100, "$295.00", "$455.00"],
    [395, "$0.00", "$750.00"],
    [100, "$295.00", "$455.00"],
  ]) {
    const html = render("plans", saved);
    const text = plain(html);
    assert.ok(
      text.includes(
        `Total bill $395.00 · ${planner.money(saved)} from reserves · ${needed} additional cash`,
      ),
    );
    assert.ok(text.includes(`Available funds · USD${ending}`));
    const opening = html.match(/fpl-opening-row[^>]*>([\s\S]*?)<\/tr>/)?.[1];
    assert.ok(plain(opening).includes(planner.money(saved)));
    assert.equal((html.match(/class="fpl-row /g) || []).length, 1);
  }
});

const paydayHouse = {
  id: "house",
  name: "House",
  cadence: "payday",
  amount: 19000,
  currency: "PHP",
  dueDay: null,
  dueDays: [],
  dueMonths: [],
  savedAmount: 0,
};

test("payday bills reconcile monthly averages, exact spending and actual dated plan payments", () => {
  const overrides = { bills: [paydayHouse] };
  const bills = plain(render("bills", 0, overrides));
  assert.ok(bills.includes("Every payday1"));
  assert.ok(bills.includes("Payday bills · monthly average"));
  assert.ok(bills.includes("₱41,166.67"));
  const spending = render("spending", 0, overrides);
  const phpRow = spending.match(/fp-spending-php[^>]*>([\s\S]*?)<\/b>/)?.[1];
  assert.ok(plain(phpRow).includes("₱19,000.00 per period"));
  assert.ok(plain(phpRow).includes("-$301.59"));
  assert.ok(plain(spending).includes("$898.41"));
  const plans = render("plans", 0, overrides);
  assert.equal((plans.match(/class="fpl-row /g) || []).length, 2);
  assert.ok(plans.includes("Nov 6, 2026"));
  assert.ok(plans.includes("Nov 20, 2026"));
  assert.ok(!plans.includes("needs a due date"));
  assert.ok(plain(plans).includes("Available funds · PHP-₱38,000.00"));
  const overview = render("home", 0, overrides);
  assert.equal((plain(overview).match(/HouseEvery payday/g) || []).length, 2);
  assert.ok(!overview.includes("a due date to appear in the schedule"));
});

function findElement(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
  } else if (node && typeof node === "object") {
    if (predicate(node)) return node;
    return findElement(node.props?.children, predicate);
  }
  return null;
}

function workspaceHarness(props) {
  const slots = [];
  let cursor = 0;
  const useState = (initial) => {
    const index = cursor++;
    if (!(index in slots))
      slots[index] = typeof initial === "function" ? initial() : initial;
    return [
      slots[index],
      (next) => {
        slots[index] = typeof next === "function" ? next(slots[index]) : next;
      },
    ];
  };
  const Component = loadComponent(
    fileURLToPath(
      new URL("../app/finance/FinanceAppClient.js", import.meta.url),
    ),
    {
      ...require("react"),
      useState,
      useMemo: (calculate) => calculate(),
      useEffect() {},
      useRef(initial) {
        return useState(() => ({ current: initial }))[0];
      },
    },
  ).default;
  return () => {
    cursor = 0;
    return Component(props);
  };
}

test("a savings withdrawal updates available funds, savings, and the ledger flow together", () => {
  const base = fixture("plans", 0).snapshot.document;
  const accounts = [
    { id: 1, name: "Checking", type: "checking", currency: "USD", nativeCurrentBalance: 921.4 },
    { id: 2, name: "Annual savings", type: "savings", currency: "USD", nativeCurrentBalance: 549.48 },
    { id: 28, name: "Smartly Savings", type: "savings", currency: "USD", nativeCurrentBalance: 246.73 },
  ];
  const props = fixture("plans", 0, {
    salary: { ...base.salary, accountId: 1 },
    bills: [{ ...base.bills[0], amount: 600, savedAmount: 549.48, dueMonths: [12], reserveAccountId: 2 }],
    allocations: [{ id: "saving", name: "Savings", kind: "savings", amount: 500, currency: "USD", accountId: 28, sourceAccountId: 1 }],
    plans: [{
      ...base.plans[0],
      startDate: "2026-11-27",
      endDate: "2026-11-27",
      openingUsd: 0,
      openingPhp: 0,
      startingAccounts: [{ accountId: 1, percentage: 100 }, { accountId: 2, percentage: 100 }],
      entries: [{ id: "withdraw", date: "2026-11-27", description: "Transfer", kind: "transfer", amount: 96.73, currency: "USD", fromAccountId: 28, toAccountId: 1 }],
    }],
  }, { accounts });
  const html = renderToStaticMarkup(createElement(Workspace, props));
  assert.ok(plain(html).includes("Available funds · USD$1,018.13"));
  assert.ok(plain(html).includes("Moved from savings to available funds."));
  const transfer = html.match(/class="fpl-row fpl-row-manual[^>]*>([\s\S]*?)<\/tr>/)?.[1];
  assert.ok(transfer);
  assert.ok(plain(transfer).includes("+$96.73"));
  assert.ok(plain(transfer).includes("$1,018.13"));
  assert.ok(plain(transfer).includes("$150.00"));
  assert.ok(plain(transfer).includes("$549.48"));
});

test("editing one payday savings row persists its exception and updates balances without changing recurrence", async () => {
  const base = fixture("plans", 0).snapshot.document;
  const allocation = {
    id: "saving",
    name: "Savings",
    kind: "savings",
    amount: 500,
    currency: "USD",
    accountId: 28,
    sourceAccountId: 1,
  };
  const accounts = [
    { id: 1, name: "Checking", type: "checking", currency: "USD", nativeCurrentBalance: 1000 },
    { id: 28, name: "Savings", type: "savings", currency: "USD", nativeCurrentBalance: 246.73 },
  ];
  const props = fixture("plans", 0, {
    salary: { ...base.salary, accountId: 1 },
    bills: [],
    allocations: [allocation],
    plans: [{
      ...base.plans[0],
      includeAllocations: true,
      completedRows: [{ rowId: "allocation:saving:2026-11-06", completedAt: "2026-11-02T12:00:00.000Z" }],
    }],
  }, { accounts });
  const renderWorkspace = workspaceHarness(props);
  const ledger = (tree) => findElement(tree, (node) => node.type?.name === "Ledger");
  let tree = renderWorkspace();
  let table = ledger(tree);
  const original = table.props.rows.find((row) => row.id === "allocation:saving:2026-11-06");
  assert.equal(original.amount, 500);
  assert.equal(table.props.openingSavings.usd, 246.73);
  table.props.onEditOccurrence(original);
  tree = renderWorkspace();
  const form = findElement(tree, (node) => node.type?.name === "FinancePlanOccurrenceForm");
  assert.ok(form);
  assert.equal(form.props.row.id, original.id);
  const originalFetch = globalThis.fetch;
  let saved;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/finance/planner");
    assert.equal(options.method, "PUT");
    saved = JSON.parse(options.body).document;
    return { ok: true, json: async () => ({ ...props.snapshot, revision: 2, document: saved }) };
  };
  try {
    await form.props.onSave({ rowId: original.id, date: "2026-11-07", description: "November 6 savings", amount: 275 });
    assert.deepEqual(saved.allocations, [allocation]);
    assert.deepEqual(saved.plans[0].rowOverrides, [{ rowId: original.id, date: "2026-11-07", description: "November 6 savings", amount: 275 }]);
    assert.deepEqual(saved.plans[0].completedRows, []);
    tree = renderWorkspace();
    assert.equal(findElement(tree, (node) => node.type?.name === "FinancePlanOccurrenceForm"), null);
    table = ledger(tree);
    const changed = table.props.rows.find((row) => row.id === original.id);
    assert.equal(changed.date, "2026-11-07");
    assert.equal(changed.amount, 275);
    assert.equal(changed.savingsUsd, 521.73);
    assert.equal(changed.completed, false);
    const following = table.props.rows.find((row) => row.id === "allocation:saving:2026-11-20");
    assert.equal(following.amount, 500);
    assert.equal(following.savingsUsd, 1021.73);
    assert.equal(following.isOverride, false);
    await table.props.onResetOccurrence(changed);
    assert.deepEqual(saved.plans[0].rowOverrides, []);
    const restored = ledger(renderWorkspace()).props.rows.find((row) => row.id === original.id);
    assert.equal(restored.amount, 500);
    assert.equal(restored.date, "2026-11-06");
    assert.equal(restored.savingsUsd, 746.73);
    assert.deepEqual(saved.allocations, [allocation]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("live percentages and flat starting amounts reach the ledger and summary after balances change", () => {
  const base = fixture("plans", 0).snapshot.document.plans[0];
  const overrides = {
    bills: [],
    plans: [
      {
        ...base,
        openingUsd: 100,
        startingAccounts: [{ accountId: 1, percentage: 80 }],
      },
    ],
  };
  for (const [balance, expected] of [
    [1000, "$900.00"],
    [2000, "$1,700.00"],
  ]) {
    const html = plain(
      render("plans", 0, overrides, {
        accounts: [
          {
            id: 1,
            name: "Checking",
            mask: "1001",
            type: "checking",
            currency: "USD",
            nativeCurrentBalance: balance,
          },
        ],
      }),
    );
    assert.ok(html.includes(`Available funds · USD${expected}`));
    assert.ok(html.includes("80%"));
    assert.ok(html.includes("Refresh bank data"));
  }
});

test("manual row completion persists its stable key without changing any forecast money", async () => {
  const base = fixture("plans", 0).snapshot.document.plans[0];
  const props = fixture("plans", 0, {
    bills: [
      {
        id: "fee",
        name: "Fee",
        amount: 25,
        currency: "USD",
        cadence: "monthly",
        dueDay: 6,
      },
    ],
    plans: [{ ...base, completedRows: [] }],
  });
  const renderWorkspace = workspaceHarness(props);
  const ledger = (tree) =>
    findElement(tree, (node) => node.type?.name === "Ledger");
  const initial = ledger(renderWorkspace());
  const money = (rows) =>
    rows.map((row) => [
      row.id,
      row.amount,
      row.usd,
      row.php,
      row.balanceUsd,
      row.balancePhp,
      row.reserveUsd,
      row.reservePhp,
    ]);
  const before = money(initial.props.rows);
  const originalFetch = globalThis.fetch;
  let saved;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/finance/planner");
    assert.equal(options.method, "PUT");
    saved = JSON.parse(options.body).document;
    return {
      ok: true,
      json: async () => ({ ...props.snapshot, document: saved, revision: 2 }),
    };
  };
  try {
    await initial.props.onToggleComplete(initial.props.rows[0]);
    const done = ledger(renderWorkspace());
    assert.equal(done.props.rows[0].completed, true);
    assert.equal(done.props.rows[0].completionSource, "manual");
    assert.equal(saved.plans[0].completedRows[0].rowId, "bill:fee:2026-11-06");
    assert.deepEqual(money(done.props.rows), before);
    await done.props.onToggleComplete(done.props.rows[0]);
    const reopened = ledger(renderWorkspace());
    assert.equal(reopened.props.rows[0].completed, false);
    assert.deepEqual(saved.plans[0].completedRows, []);
    assert.deepEqual(money(reopened.props.rows), before);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("posted matches mark forecast rows done even when recorded cashflow rows are hidden", () => {
  const base = fixture("plans", 0).snapshot.document.plans[0];
  const props = fixture("plans", 0, {
    bills: [
      {
        id: "fee",
        name: "Fee",
        amount: 25,
        currency: "USD",
        cadence: "monthly",
        dueDay: 1,
        accountId: 1,
      },
    ],
    plans: [{ ...base, includeTransactions: false }],
  });
  props.initialPlanActivity = {
    configured: true,
    from: base.startDate,
    to: base.endDate,
    transactions: [
      {
        id: 123,
        date: "2026-11-01",
        merchant: "Fee",
        amount: 25,
        currency: "USD",
        kind: "expense",
        accountId: 1,
        pending: false,
      },
    ],
  };
  const html = renderToStaticMarkup(createElement(Workspace, props));
  assert.ok(plain(html).includes("Done · matched transaction"));
  assert.ok(plain(html).includes("Available funds · USD$725.00"));
  assert.ok(!html.includes("fpl-row-transaction"));
});

test("a balance read failure keeps the plan popup and its last bank data available", async () => {
  const base = fixture("plans", 0).snapshot.document.plans[0];
  const account = {
    id: 1,
    name: "Checking",
    type: "checking",
    currency: "USD",
    nativeCurrentBalance: 1000,
  };
  const props = fixture(
    "plans",
    0,
    {
      bills: [],
      plans: [
        { ...base, startingAccounts: [{ accountId: 1, percentage: 80 }] },
      ],
    },
    { accounts: [account] },
  );
  const renderWorkspace = workspaceHarness(props);
  let tree = renderWorkspace();
  findElement(
    tree,
    (node) =>
      node.type?.name === "Button" && node.props.children === "Edit plan",
  ).props.onClick();
  tree = renderWorkspace();
  const form = findElement(
    tree,
    (node) => node.type?.name === "FinancePlanForm",
  );
  assert.ok(form);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === "/api/finance")
      return {
        ok: true,
        json: async () => ({
          result: {
            syncedConnections: [3],
            errors: [],
            refreshedAt: "2026-11-02T15:00:00.000Z",
          },
        }),
      };
    if (url.startsWith("/api/finance/activity"))
      return {
        ok: false,
        json: async () => ({ error: "Balance read failed" }),
      };
    if (url.startsWith("/api/finance/plan-activity"))
      return {
        ok: true,
        json: async () => ({
          configured: true,
          from: base.startDate,
          to: base.endDate,
          transactions: [],
        }),
      };
    throw new Error("Unexpected finance request");
  };
  try {
    await form.props.onRefreshAccounts();
  } finally {
    globalThis.fetch = originalFetch;
  }
  tree = renderWorkspace();
  const retained = findElement(
    tree,
    (node) => node.type?.name === "FinancePlanForm",
  );
  assert.ok(retained);
  assert.equal(retained.props.accounts[0].nativeCurrentBalance, 1000);
  assert.ok(retained.props.accountRefreshError.includes("could not be loaded"));
  assert.ok(
    plain(renderToStaticMarkup(tree)).includes(
      "Keeping the last available data",
    ),
  );
});

test("saving a monthly bill as payday switches to its new view and recomputes the workspace", async () => {
  const react = require("react");
  const state = [];
  let cursor = 0;
  const useState = (initial) => {
    const index = cursor++;
    if (!(index in state))
      state[index] = typeof initial === "function" ? initial() : initial;
    return [
      state[index],
      (next) => {
        state[index] = typeof next === "function" ? next(state[index]) : next;
      },
    ];
  };
  const InteractiveWorkspace = loadComponent(
    fileURLToPath(
      new URL("../app/finance/FinanceAppClient.js", import.meta.url),
    ),
    {
      ...react,
      useState,
      useMemo: (calculate) => calculate(),
      useEffect() {},
      useRef(initial) {
        return useState(() => ({ current: initial }))[0];
      },
    },
  ).default;
  const monthlyHouse = {
    ...paydayHouse,
    cadence: "monthly",
    amount: 38000,
    dueDay: 14,
    dueDays: [14, 28],
  };
  const props = fixture("bills", 0, { bills: [monthlyHouse] });
  const renderWorkspace = () => {
    cursor = 0;
    return InteractiveWorkspace(props);
  };
  let tree = renderWorkspace();
  const table = findElement(tree, (node) => node.type?.name === "BillsTable");
  table.props.onEdit(monthlyHouse);
  tree = renderWorkspace();
  const form = findElement(tree, (node) => node.type?.name === "BillForm");
  assert.equal(form.props.salary.firstPayDate, "2026-10-23");
  const originalFetch = globalThis.fetch;
  let submitted;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/finance/planner");
    assert.equal(options.method, "PUT");
    submitted = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        ...props.snapshot,
        document: submitted.document,
        revision: 2,
      }),
    };
  };
  try {
    await form.props.onSave(paydayHouse);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(submitted.document.bills[0].amount, 19000);
  assert.equal(submitted.document.bills[0].cadence, "payday");
  tree = renderWorkspace();
  const newTable = findElement(
    tree,
    (node) => node.type?.name === "BillsTable",
  );
  assert.equal(newTable.props.cadence, "payday");
  assert.equal(newTable.props.bills.length, 1);
  assert.equal(newTable.props.summary.billsPhpPerPeriod, 19000);
  assert.equal(newTable.props.summary.paydayMonthlyPhp, 41166.67);
  const html = renderToStaticMarkup(tree);
  assert.ok(html.includes("Total per payday"));
  assert.ok(html.includes("₱19,000.00"));
  assert.ok(!html.includes("₱38,000.00"));
});

test("salary, annual reserves and payday savings remain linked across the workspace and account forecasts", () => {
  const accounts = [
    {
      id: 1,
      name: "Checking",
      institutionName: "Test Bank",
      mask: "1001",
      type: "checking",
      currency: "USD",
      nativeCurrentBalance: 1000,
    },
    {
      id: 2,
      name: "Savings",
      institutionName: "Test Bank",
      mask: "1002",
      type: "savings",
      currency: "USD",
      nativeCurrentBalance: 503.7,
    },
    {
      id: 28,
      name: "Savings",
      institutionName: "Test Bank",
      mask: "1003",
      type: "savings",
      currency: "USD",
      nativeCurrentBalance: 246.73,
    },
  ];
  const base = fixture("plans", 0).snapshot.document;
  const planner = {
    salary: { ...base.salary, accountId: 1 },
    bills: screenshotAnnualBills.map((bill) => ({
      ...bill,
      accountId: 1,
      reserveAccountId: 2,
      sourceAccountId: 1,
    })),
    allocations: [
      {
        id: "saving",
        name: "Payday savings",
        kind: "savings",
        amount: 500,
        currency: "USD",
        accountId: 28,
        sourceAccountId: 1,
      },
    ],
    plans: [
      {
        ...base.plans[0],
        startDate: "2026-11-02",
        includeIncome: true,
        includeAllocations: true,
        includeAnnualReserve: true,
        accountOpeningBalances: accounts.map((account) => ({
          accountId: account.id,
          balance: account.nativeCurrentBalance,
        })),
      },
    ],
  };
  const activity = { accounts };
  const plans = plain(render("plans", 0, planner, activity));
  assert.ok(plans.includes("Projected balances by account"));
  assert.ok(
    plans.includes(
      "Checking · ••1001Starting balance$1,000.00Projected ending balance$2,354.22",
    ),
  );
  assert.ok(
    plans.includes(
      "Savings · ••1002Starting balance$503.70Projected ending balance$154.48Projected annual reserves$154.48",
    ),
  );
  assert.ok(
    plans.includes(
      "Savings · ••1003Starting balance$246.73Projected ending balance$1,246.73Payday savings in this plan$1,000.00",
    ),
  );
  assert.ok(plans.includes("Account movements"));
  const settings = render("settings", 0, planner, activity);
  assert.ok(settings.includes("Salary receiving account"));
  assert.match(settings, /value="1" selected=""/);
  const overview = plain(render("home", 0, planner, activity));
  assert.ok(overview.includes("Your money by account"));
  assert.ok(overview.includes("Saved for annual bills$503.70"));
  assert.ok(overview.includes("Savings each payday$500.00"));
  const spending = plain(render("spending", 0, planner, activity));
  assert.ok(spending.includes("Savings · ••1003 · Test Bank · savings · USD"));
});
