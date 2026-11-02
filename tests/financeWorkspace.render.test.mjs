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
  for (const [saved, contribution, available] of [
    [0, "-$197.50", "$1,002.50"],
    [100, "-$147.50", "$1,052.50"],
    [395, "$0.00", "$1,200.00"],
    [100, "-$147.50", "$1,052.50"],
  ]) {
    const html = render("spending", saved);
    const annual = html.match(/fp-spending-annual[^>]*>([\s\S]*?)<\/b>/)?.[1];
    assert.ok(annual, "the annual funding row is rendered");
    assert.ok(plain(annual).includes(contribution));
    assert.ok(
      plain(html).includes(
        `Left to spendAfter bills &amp; your allocations${available}`,
      ),
    );
    assert.ok(
      html.includes(
        "Next payments, funded across the paydays left before each due date",
      ),
    );
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
  assert.ok(plain(annual).includes("-$22.89"));
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
