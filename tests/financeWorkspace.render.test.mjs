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

function fixture(tab, savedAmount, documentOverrides = {}) {
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
    },
  };
}
function render(tab, savedAmount, documentOverrides) {
  return renderToStaticMarkup(
    createElement(Workspace, fixture(tab, savedAmount, documentOverrides)),
  );
}
const plain = (html) => html.replace(/<[^>]*>/g, "");

test("monthly bill reserves and commitment cards recalculate from saved balances", () => {
  for (const [saved, monthly, remaining] of [
    [0, "$32.92", "$395.00"],
    [100, "$24.58", "$295.00"],
    [395, "$0.00", "$0.00"],
    [100, "$24.58", "$295.00"],
  ]) {
    const html = render("bills", saved);
    assert.ok(html.includes("Annual bills reserve"));
    assert.ok(html.includes(monthly));
    if (saved === 395) {
      assert.ok(plain(html).includes("Your annual bills are fully funded."));
      assert.ok(!html.includes("$32.92"));
      assert.ok(html.includes("$2,600.00"));
    } else {
      assert.ok(plain(html).includes(`${remaining} still to fund`));
      assert.ok(!plain(html).includes("Your annual bills are fully funded."));
    }
  }
});

test("workspace spending totals recover funds as an annual bill is saved, then adjust when lowered", () => {
  for (const [saved, contribution, available] of [
    [0, "-$15.19", "$1,184.81"],
    [100, "-$11.35", "$1,188.65"],
    [395, "$0.00", "$1,200.00"],
    [100, "-$11.35", "$1,188.65"],
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
      html.includes("Based on the amount still to fund after saved balances"),
    );
  }
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
