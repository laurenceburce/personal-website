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
import * as insights from "../app/lib/financeInsights.mjs";
import * as accountPlan from "../app/lib/financeAccountPlan.mjs";
import * as livePlanner from "../app/lib/financeLivePlanner.mjs";
import * as primaryPlanner from "../app/lib/financePrimaryPlanner.mjs";
import { financePlanPostingSpecs, financePlanTransactionMetadata } from "../app/lib/financePlanPostings.mjs";
import { mapFinanceActivityAccount } from "../app/lib/financeActivity.mjs";

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
    if (specifier === "../lib/financePlanPresentation.mjs") return presentation;
    if (specifier === "../lib/financeInsights.mjs") return insights;
    if (specifier === "../lib/financeAccountPlan.mjs") return accountPlan;
    if (specifier === "../lib/financeLivePlanner.mjs") return livePlanner;
    if (specifier === "../lib/financePrimaryPlanner.mjs") return primaryPlanner;
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
    legacyRange: true,
    initialPlannerRange: { startDate: document.plans[0]?.startDate || "2026-11-01", endDate: document.plans[0]?.endDate || "2026-11-30" },
    initialPlanActivity: { configured: true, from: document.plans[0]?.startDate || "2026-11-01", to: document.plans[0]?.endDate || "2026-11-30", transactions: [] },
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
function alignFixture(props) {
  if (!props.legacyRange || !props.snapshot.document.plans[0]) return props;
  const plan = props.snapshot.document.plans[0];
  props.initialPlannerRange = { startDate: plan.startDate, endDate: plan.endDate };
  const computation = livePlanner.getLivePlannerComputationRange(props.initialPlannerRange, props.today);
  props.initialPlanActivity = { ...props.initialPlanActivity, configured: true, from: computation.startDate, to: computation.endDate };
  return props;
}
const table = (props) => findElement(workspaceHarness(props)(), (node) => node.type?.name === "FinancePlannerTable")?.props;
const analytics = (props) => findElement(workspaceHarness(props)(), (node) => node.type?.name === "FinancePlannerAnalytics").props.analytics;
const rowsFor = (savedAmount, documentOverrides = {}, activityOverrides = {}) => table(fixture("plans", savedAmount, documentOverrides, activityOverrides)).rows;

test("budget plans automatically include full card statements on their due dates", () => {
  const base = fixture("plans", 0).snapshot.document.plans[0];
  const html = render("plans", 0, { bills: [], plans: [{ ...base, accountLinks: { availableUsdAccountId: 1 } }] }, {
    accounts: [{
      id: 7, name: "Travel card", type: "credit", isLinked: true,
      currency: "USD", nativeCurrentBalance: 650,
      creditCardDueStatus: "current",
      creditCardDue: { statementBalance: 300, minimumPayment: 25, dueDate: "2026-11-15" },
    }, { id: 1, name: "Checking", type: "checking", currency: "USD", nativeCurrentBalance: 750 }],
  });
  assert.match(plain(html), /Credit card statement due/);
  assert.match(plain(html), /Statement balance \$300\.00/);
  assert.match(plain(html), /Card &amp; loan balances\$650\.00 → \$350\.00/);
  assert.match(html, /Nov 15/);
  assert.ok(!html.includes("Statement balance $25.00"));
});

test("budget plans include saved autopay dates before the original bank due date and plan boundary", () => {
  for (const currency of ["USD", "PHP"]) {
    const props = fixture("plans", 0, { bills: [] }, { accounts: [{
      id: 7, name: "Travel card", type: "credit", isLinked: true, currency, nativeCurrentBalance: 200,
      creditCardAutopayEnabled: true, creditCardAutopayDaysBeforeDue: 7,
      creditCardDueStatus: "current", creditCardDue: { statementBalance: 200, dueDate: "2026-11-20" },
    }] });
    Object.assign(props.snapshot.document.plans[0], { endDate: "2026-11-15", openingUsd: currency === "USD" ? 750 : 0,
      openingPhp: currency === "PHP" ? 750 : 0 });
    const tree = workspaceHarness(props)();
    const payment = findElement(tree, (node) => node.type?.name === "FinancePlannerTable").props.rows.find((row) => row.source === "creditCardDue");
    assert.equal(payment.date, "2026-11-13");
    assert.equal(payment.dueDate, "2026-11-20");
    assert.equal(payment[currency === "USD" ? "balanceUsd" : "balancePhp"], 550);
    const html = renderToStaticMarkup(createElement(Workspace, alignFixture(props)));
    assert.match(plain(html), /Automatic payment Nov 13, 2026 · Due Nov 20, 2026/);
    assert.match(plain(html), /saved autopay schedule/);
  }
});

test("manual PHP card details flow into budget plans with full statements and entered provenance", () => {
  const props = fixture("plans", 0, { bills: [] }, { accounts: [{
    id: 7, name: "RCBC Gold JCB", type: "credit", isLinked: false, currency: "PHP", nativeCurrentBalance: 14930.79,
    creditCardDueStatus: "manual", creditCardAutopayEnabled: true, creditCardAutopayDaysBeforeDue: 7,
    creditCardDue: { statementBalance: 14930.79, minimumPayment: 750, dueDate: "2026-11-20", lastStatementDate: "2026-10-25" },
  }] });
  Object.assign(props.snapshot.document.plans[0], { openingUsd: 0, openingPhp: 20000 });
  props.snapshot.document.plans[0].accountLinks = { availablePhpAccountId: 34 };
  props.initialActivity.accounts.push({ id: 34, name: "PHP savings", type: "savings", currency: "PHP", nativeCurrentBalance: 20000 });
  const text = plain(renderToStaticMarkup(createElement(Workspace, alignFixture(props))));
  assert.match(text, /Manual credit card statementStatement balance ₱14,930\.79/);
  assert.match(text, /Automatic payment Nov 13, 2026 · Due Nov 20, 2026/);
  assert.equal(table(props).rows[0].balancePhp, 5069.21);
  assert.equal(analytics(props).debt.PHP.projected, 0);
  assert.doesNotMatch(text, /until the bank reports a statement|Statement balance ₱750\.00/);
});

test("missing manual card details direct users to their editor without claiming bank data is missing", () => {
  const text = plain(render("plans", 0, { bills: [] }, { accounts: [{
    id: 7, name: "RCBC Gold JCB", type: "credit", isLinked: false, currency: "PHP", nativeCurrentBalance: 14930.79,
    creditCardDueStatus: "unavailable", creditCardDue: null,
  }] }));
  assert.match(text, /Enter a statement balance and payment due date for RCBC Gold JCB.*under Bank accounts → Payment details/);
  assert.doesNotMatch(text, /until the bank reports a statement|Refresh bank data to check/);
});

test("payments before the visible window keep their bank cycle and still affect the ending projection", () => {
  for (const statementBalance of [null, 200]) {
    const props = fixture("plans", 0, { bills: [] }, { accounts: [{
      id: 7, name: "Travel card", type: "credit", isLinked: true, currency: "USD", nativeCurrentBalance: 200,
      creditCardAutopayEnabled: true, creditCardAutopayDaysBeforeDue: 7,
      creditCardDueStatus: "current", creditCardDue: { statementBalance, dueDate: "2026-11-20" },
    }] });
    Object.assign(props.snapshot.document.plans[0], { startDate: "2026-11-15", endDate: "2026-11-30" });
    props.snapshot.document.plans[0].accountLinks = { availableUsdAccountId: 1 };
    props.initialActivity.accounts.push({ id: 1, name: "Checking", type: "checking", currency: "USD", nativeCurrentBalance: 1000 });
    const text = plain(renderToStaticMarkup(createElement(Workspace, alignFixture(props))));
    assert.equal(table(props).rows.length, 0, "the earlier autopay is outside the visible date window");
    assert.equal(analytics(props).debt.USD.projected, 0, "hidden earlier future payments still affect the ending balance");
    assert.doesNotMatch(text, /automatic payments fall before the visible range/);
  }
});

function nextCycleCardFixture(endDate) {
  const props = fixture("plans", 0, { bills: [] }, {
    accounts: [{
      id: 32, name: "Venture X", type: "credit", isLinked: true,
      currency: "USD", nativeCurrentBalance: 1380.16,
      creditCardDueStatus: "current",
      creditCardDue: {
        statementBalance: 0, minimumPayment: 0, dueDate: "2026-12-18",
        lastStatementDate: null, lastPaymentDate: null, lastPaymentAmount: null,
      },
    }],
  });
  props.today = "2026-11-05";
  Object.assign(props.snapshot.document.plans[0], {
    startDate: "2026-11-06", endDate, openingUsd: 2000,
  });
  return props;
}

test("a future unbilled Venture X balance appears as an estimated payment within the plan", () => {
  const props = nextCycleCardFixture("2027-01-01");
  const html = renderToStaticMarkup(createElement(Workspace, alignFixture(props)));
  const text = plain(html);
  assert.match(text, /Estimated next card payment/);
  assert.match(text, /Unbilled balance \$1,380\.16/);
  assert.equal(table(props).rows[0].balanceUsd, 619.84);
  assert.match(html, /Dec 18/);
  assert.ok(!text.includes("fall after the visible range ends"));
  assert.ok(!text.includes("Statement balance $0.00"));
});

test("autopay moves an unbilled estimate inside the plan and its outside-plan notice keeps both dates", () => {
  for (const endDate of ["2026-12-10", "2026-12-12"]) {
    const props = nextCycleCardFixture(endDate);
    Object.assign(props.initialActivity.accounts[0], { creditCardAutopayEnabled: true, creditCardAutopayDaysBeforeDue: 7 });
    const text = plain(renderToStaticMarkup(createElement(Workspace, alignFixture(props))));
    if (endDate === "2026-12-12") {
      assert.equal(table(props).rows[0].balanceUsd, 619.84);
      assert.match(text, /Automatic payment Dec 11, 2026 · Due Dec 18, 2026/);
      assert.doesNotMatch(text, /fall after the visible range ends/);
    } else {
      assert.equal(table(props).rows.length, 0);
      assert.match(text, /Venture X: \$1,380\.16 estimated for Dec 11, 2026\. Automatic payment · Due Dec 18, 2026/);
      assert.match(text, /fall after the visible range ends on Dec 10, 2026/);
      assert.doesNotMatch(text, /Bank-reported payment date/);
    }
  }
});

test("short plans disclose next-cycle estimates without charging them before the payment date", () => {
  const props = nextCycleCardFixture("2026-12-04");
  const html = renderToStaticMarkup(createElement(Workspace, alignFixture(props)));
  const text = plain(html);
  assert.match(text, /Venture X: \$1,380\.16 estimated for Dec 18, 2026/);
  assert.match(text, /fall after the visible range ends on Dec 4, 2026/);
  assert.match(text, /not included in this projection/);
  assert.match(text, /Planned payments are not deducted from these amounts/);
  assert.equal(analytics(props).debt.USD.projected, 1380.16);
  assert.match(text, /Change the date range to include these payments/);
  const renderWorkspace = workspaceHarness(props);
  let tree = renderWorkspace();
  const notice = findElement(tree, (node) => node.type?.name === "FinanceCreditCardDuesNotice");
  assert.equal(findElement(tree, (node) => node.type?.name === "FinancePlannerTable").props.rows.length, 0);
  notice.props.onEditPlan();
  tree = renderWorkspace();
  assert.equal(findElement(tree, (node) => node.type?.name === "FinancePlanForm").props.plan.id, props.snapshot.document.plans[0].id);
});

test("missing statement amounts can use known current balances without a false unavailable-dues warning", () => {
  const props = nextCycleCardFixture("2027-01-01");
  props.initialActivity.accounts[0].creditCardDue.statementBalance = null;
  const text = plain(renderToStaticMarkup(createElement(Workspace, alignFixture(props))));
  assert.match(text, /Statement balances are unavailable for Venture X/);
  assert.match(text, /Using their current balances as estimates until the bank reports a statement/);
  assert.match(text, /Unbilled balance \$1,380\.16/);
  assert.ok(!text.includes("before dues can appear in this plan"));
});

test("unknown card balances and missing payment dates never create a payment estimate", () => {
  for (const missing of ["balance", "date"]) {
    const props = nextCycleCardFixture("2027-01-01");
    const card = props.initialActivity.accounts[0];
    card.creditCardDue.statementBalance = null;
    if (missing === "balance") card.nativeCurrentBalance = null;
    else card.creditCardDue.dueDate = null;
    const html = renderToStaticMarkup(createElement(Workspace, alignFixture(props)));
    const text = plain(html);
    assert.match(text, /Statement balances or due dates are unavailable for Venture X/);
    assert.equal(analytics(props).assets.USD.current, 0, "debt never becomes a cash balance");
    assert.ok(!text.includes("Unbilled balance $1,380.16"));
    assert.ok(!text.includes("$1,380.16 estimated for"));
    const tree = workspaceHarness(props)();
    assert.equal(findElement(tree, (node) => node.type?.name === "FinancePlannerTable").props.rows.length, 0);
    if (missing === "date") {
      assert.match(text, /A payment date could not be determined/);
      assert.match(text, /No unbilled estimate is included for these cards/);
    }
  }
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
  assert.match(plain(html), /Statement balance \$200\.00/);
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
  const html = renderToStaticMarkup(createElement(Workspace, alignFixture(props)));
  assert.match(plain(html), /Statement balance \$300\.00 · Paid \$120\.00 · Remaining \$180\.00/);
  assert.equal(table(props).rows[0].balanceUsd, 570);
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
  const projected = rowsFor(0, { ...overrides, plans: [{ ...basePlan, includeAnnualReserve: true }] });
  assert.equal(projected.length, 3);
  assert.deepEqual(projected.filter((row) => row.source === "reserve").map((row) => row.usd), [-22.89, -22.89]);
  assert.equal(projected.at(-1).balanceUsd, 704.22);
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
    const records = rowsFor(saved);
    assert.equal(planner.money(records.at(-1).balanceUsd), ending);
    assert.equal(records[0].reserveUsed, saved);
    assert.equal(records.length, 1);
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
  const scheduled = rowsFor(0, overrides);
  assert.equal(scheduled.length, 2);
  assert.ok(plans.includes("Nov 6, 2026"));
  assert.ok(plans.includes("Nov 20, 2026"));
  assert.ok(!plans.includes("needs a due date"));
  assert.equal(scheduled.at(-1).balancePhp, -38000);
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

function workspaceHarness(props, effects) {
  alignFixture(props);
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
      useEffect(run, dependencies) { effects?.push({ run, dependencies }); },
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

test("adding a recurring plan entry stores one series and expands independent dated ledger rows", async () => {
  const props = fixture("plans", 0, { bills: [] });
  const renderWorkspace = workspaceHarness(props);
  let tree = renderWorkspace();
  findElement(tree, (node) => node.type?.name === "Button" && node.props.children === "Add transaction").props.onClick();
  tree = renderWorkspace();
  const form = findElement(tree, (node) => node.type?.name === "FinancePlanEntryForm");
  assert.ok(form);
  assert.deepEqual(form.props.salary, props.snapshot.document.salary);
  const entry = { id: "coffee", date: "2026-11-01", description: "Coffee", kind: "expense", amount: 10,
    currency: "USD", recurrence: "daily", repeatUntil: "2026-11-03" };
  const originalFetch = globalThis.fetch;
  let saved;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/finance/planner");
    saved = JSON.parse(options.body).document;
    return { ok: true, json: async () => ({ ...props.snapshot, document: saved, revision: 2 }) };
  };
  try {
    await form.props.onSave(entry);
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(saved.plans[0].entries.length, 1);
  assert.deepEqual(saved.plans[0].entries[0], entry);
  const ledger = findElement(renderWorkspace(), (node) => node.type?.name === "FinancePlannerTable");
  assert.deepEqual(ledger.props.rows.map((row) => row.id), [
    "entry:coffee:2026-11-01", "entry:coffee:2026-11-02", "entry:coffee:2026-11-03",
  ]);
  assert.equal(ledger.props.rows.at(-1).balanceUsd, 730, "past unrecorded forecasts stay visible but do not alter today's live projection");
});

test("a recurring series stays manageable with no occurrences and deleting it clears only its plan metadata", async () => {
  const base = fixture("plans", 0).snapshot.document.plans[0];
  const entry = { id: "payday", date: "2026-11-01", description: "Payday fund", kind: "expense", amount: 25,
    currency: "USD", recurrence: "payday", repeatUntil: null };
  const props = fixture("plans", 0, { bills: [], plans: [{
    ...base, endDate: "2026-11-03", entries: [entry],
    rowOverrides: [{ rowId: "entry:payday:2026-11-02", date: "2026-11-02", amount: 20, description: "Earlier edit" }],
    completedRows: [
      { rowId: "entry:payday:2026-11-02", completedAt: "2026-11-02T12:00:00.000Z" },
      { rowId: "bill:retained:2026-11-02", completedAt: "2026-11-02T12:00:00.000Z" },
    ],
  }] });
  const renderWorkspace = workspaceHarness(props);
  let tree = renderWorkspace();
  assert.equal(findElement(tree, (node) => node.type?.name === "FinancePlannerTable").props.rows.length, 0);
  const edit = findElement(tree, (node) => node.props?.["aria-label"] === "Edit recurring entry: Payday fund");
  assert.ok(edit);
  edit.props.onClick();
  tree = renderWorkspace();
  assert.equal(findElement(tree, (node) => node.type?.name === "FinancePlanEntryForm").props.entry, entry);
  findElement(tree, (node) => node.type?.name === "FinanceModal").props.onClose();
  tree = renderWorkspace();
  findElement(tree, (node) => node.props?.["aria-label"] === "Delete recurring entry: Payday fund").props.onClick();
  tree = renderWorkspace();
  assert.match(plain(renderToStaticMarkup(tree)), /All occurrences of this recurring entry will be removed from this plan/);
  const originalFetch = globalThis.fetch;
  let saved;
  globalThis.fetch = async (url, options) => {
    saved = JSON.parse(options.body).document;
    return { ok: true, json: async () => ({ ...props.snapshot, document: saved, revision: 2 }) };
  };
  try {
    await findElement(tree, (node) => node.type?.name === "Button" && node.props.variant === "danger").props.onClick();
  } finally { globalThis.fetch = originalFetch; }
  assert.deepEqual(saved.plans[0].entries, []);
  assert.deepEqual(saved.plans[0].rowOverrides, []);
  assert.deepEqual(saved.plans[0].completedRows, [props.snapshot.document.plans[0].completedRows[1]]);
});

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
  const html = renderToStaticMarkup(createElement(Workspace, alignFixture(props)));
  const records = table(props).rows;
  const moved = records.find((row) => row.entryId === "withdraw");
  assert.equal(moved.balanceUsd, 1018.13);
  assert.ok(plain(html).includes("Moved from savings to available funds."));
  assert.equal(moved.savingsUsd, 150);
  assert.equal(moved.reserveUsd, 549.48);
  assert.equal(analytics(props).accounts.find((account) => account.id === 1).projected, 1018.13);
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
  const ledger = (tree) => findElement(tree, (node) => node.type?.name === "FinancePlannerTable");
  let tree = renderWorkspace();
  let table = ledger(tree);
  const original = table.props.rows.find((row) => row.id === "allocation:saving:2026-11-06");
  assert.equal(original.amount, 500);
  assert.equal(findElement(tree, (node) => node.type?.name === "FinancePlannerAnalytics").props.analytics.accounts.find((account) => account.id === 28).current, 246.73);
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

test("live analytics use real account balances independently of older percentage and flat planning amounts", () => {
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
    assert.ok(html.includes(`Current balance${planner.money(balance)}`));
    assert.ok(html.includes(`Projected balance${planner.money(balance)}`));
    assert.ok(!html.includes(`Projected balance${expected}`));
    assert.ok(html.includes("Planner settings"));
  }
});

test("the single live planner ignores older saved openings when accounts refresh", () => {
  const base = fixture("plans", 0).snapshot.document.plans[0];
  const overrides = { bills: [], plans: [{ ...base, balanceMode: "snapshot", openingUsd: 0,
    startingAccounts: [{ accountId: 1, percentage: 100 }],
    accountOpeningBalances: [{ accountId: 1, balance: 200 }],
  }] };
  for (const nativeCurrentBalance of [200, 150, 90]) {
    const html = plain(render("plans", 0, overrides, { accounts: [{
      id: 1, name: "Checking", type: "checking", currency: "USD", nativeCurrentBalance,
    }] }));
    assert.ok(html.includes(`Current balance${planner.money(nativeCurrentBalance)}`));
    assert.ok(html.includes(`Projected balance${planner.money(nativeCurrentBalance)}`));
    assert.ok(!html.includes("Saved starting balance"));
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
    findElement(tree, (node) => node.type?.name === "FinancePlannerTable");
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
  const html = renderToStaticMarkup(createElement(Workspace, alignFixture(props)));
  const matched = table(props).rows.find((row) => row.transactionId === 123);
  assert.equal(matched.completed, true);
  assert.equal(matched.completionSource, "transaction");
  assert.equal(table(props).rows.length, 1, "a bank match and its forecast share one visible row");
});

test("the Google monthly bill is automatically done for its posted card charge without a penny payment action", () => {
  for (const linked of [false, true]) {
    const base = fixture("plans", 0).snapshot.document.plans[0];
    const props = fixture("plans", 0, {
      bills: [{ id: "google", name: "Google", amount: 2, currency: "USD", cadence: "monthly", dueDay: 18, accountId: 3 }],
      plans: [{ ...base, continuous: true, balanceMode: "live", includeTransactions: true }],
    }, { balanceAsOf: "2026-11-20", accounts: [{ id: 3, name: "US Bank Credit", type: "credit", currency: "USD",
      isLinked: true, nativeCurrentBalance: 1.99 }] });
    props.today = "2026-11-20";
    const charge = { id: 123, date: "2026-11-18", merchant: "GOOGLE *Google One", amount: 1.99, currency: "USD",
      kind: "expense", accountId: 3, provider: "plaid", ...(linked ? { planId: base.id, planRowId: "entry:google-receipt",
        planScheduledRowId: "bill:google:2026-11-18", planGenerated: false } : {}) };
    props.initialPlanActivity = { ...props.initialPlanActivity, transactions: [charge], balanceTransactions: [charge],
      balanceHistoryFrom: base.startDate, balanceHistoryThrough: props.today, balanceHistoryComplete: true };
    const ledger = table(props);
    assert.equal(ledger.rows.length, 1, "the existing card charge replaces its monthly forecast once");
    const row = ledger.rows[0];
    assert.equal(row.transactionId, 123);
    assert.equal(row.completed, true);
    assert.equal(row.completionSource, "transaction");
    assert.equal(row.amount, 1.99);
    assert.equal(row.scheduledSource, "bill");
    assert.equal(row.accountBalanceSnapshot.find((account) => account.accountId === 3).balance, 1.99);
    const forecast = analytics(props);
    assert.equal(forecast.debt.USD.current, 1.99);
    assert.equal(forecast.debt.USD.projected, 1.99);
    const html = renderToStaticMarkup(createElement(Workspace, alignFixture(props)));
    assert.match(html, /fpt-status-done[^>]*>Done</);
    assert.doesNotMatch(html, /Record payment: Google|fpt-row-overdue/);
  }
});

test("a Google charge before the visible timeline completes its bill without replaying outside-window money", () => {
  const base = fixture("plans", 0).snapshot.document.plans[0];
  const props = fixture("plans", 0, {
    bills: [{ id: "google", name: "Google", amount: 2, currency: "USD", cadence: "monthly", dueDay: 18, accountId: 3 }],
    plans: [{ ...base, continuous: true, balanceMode: "live", startDate: "2026-11-18", includeTransactions: true }],
  }, { balanceAsOf: "2026-11-20", accounts: [{ id: 3, name: "US Bank Credit", type: "credit", currency: "USD",
    isLinked: true, nativeCurrentBalance: 1.99 }] });
  props.today = "2026-11-20";
  const charge = { id: 123, date: "2026-11-17", merchant: "GOOGLE *Google One", amount: 1.99, currency: "USD",
    kind: "expense", accountId: 3, provider: "plaid" };
  props.initialPlanActivity = { ...props.initialPlanActivity, transactions: [], matchingTransactions: [charge],
    balanceTransactions: [charge], balanceHistoryFrom: charge.date, balanceHistoryThrough: props.today, balanceHistoryComplete: true };
  const before = structuredClone(props);
  const rows = table(props).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, "2026-11-18");
  assert.equal(rows[0].completed, true);
  assert.equal(rows[0].amount, 1.99);
  assert.deepEqual(rows[0].matchedTransactionIds, [123]);
  assert.equal(rows[0].recordedTransactions[0].date, charge.date);
  assert.equal(rows[0].accountBalanceSnapshot.find((account) => account.accountId === 3).balance, 1.99);
  assert.equal(analytics(props).debt.USD.current, 1.99);
  assert.equal(analytics(props).debt.USD.projected, 1.99);
  const html = renderToStaticMarkup(createElement(Workspace, alignFixture(props)));
  assert.match(html, /fpt-status-done[^>]*>Done</);
  assert.doesNotMatch(html, /fpt-row-overdue|Record payment: Google/);
  assert.deepEqual(props, before);
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
      node.type?.name === "Button" && node.props.children === "Planner settings",
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
  const forecast = analytics(fixture("plans", 0, planner, activity));
  assert.ok(plans.includes("Balances by account"));
  assert.deepEqual(forecast.accounts.map((account) => [account.id, account.current, account.projected]), [
    [1, 1000, 2354.22], [2, 503.70, 154.48], [28, 246.73, 1246.73],
  ]);
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

test("linked checking, annual reserve and Smartly columns share reconciled balances with one row per bank transfer", () => {
  const accounts = [
    { id: 1, name: "Checking", mask: "5483", type: "checking", currency: "USD", nativeCurrentBalance: 854.23 },
    { id: 2, name: "Savings", mask: "5742", type: "savings", currency: "USD", nativeCurrentBalance: 526.59 },
    { id: 28, name: "Smartly Savings", mask: "0230", type: "savings", currency: "USD", nativeCurrentBalance: 500 },
  ];
  const base = fixture("plans", 0).snapshot.document;
  const plan = { ...base.plans[0], startDate: "2026-11-05", endDate: "2026-11-10", openingUsd: 160.72,
    includeIncome: true, includeTransactions: true, includeAnnualReserve: true, includeAllocations: true,
    accountLinks: { availableUsdAccountId: 1, annualReserveUsdAccountId: 2, savingsUsdAccountId: 28 },
    rowOverrides: [
      { rowId: "salary:2026-11-06", date: "2026-11-06", description: "Salary", amount: 969.67 },
      { rowId: "reserve:USD:2026-11-06", date: "2026-11-06", description: "Set aside for annual bills", amount: 22.89 },
    ],
  };
  const props = fixture("plans", 0, {
    salary: { ...base.salary, amount: 2300, accountId: 1 },
    bills: [{ id: "annual", name: "Annual bill", cadence: "annual", amount: 1000, savedAmount: 503.70,
      currency: "USD", dueMonths: [12], dueDay: null, sourceAccountId: 1, reserveAccountId: 2 }],
    allocations: [{ id: "saving", name: "Savings", kind: "savings", amount: 253.27, currency: "USD", sourceAccountId: 1, accountId: 28 }],
    plans: [plan],
  }, { accounts });
  props.today = "2026-11-06";
  props.initialPlanActivity = { configured: true, from: plan.startDate, to: plan.endDate, transactions: [
    { id: 2534, date: "2026-11-06", kind: "income", accountId: 1, amount: 969.67, currency: "USD", merchant: "Electronic Deposit 11/06 Maxx Potential", category: "Income" },
    ...[[2533, 1, "expense", 22.89], [2535, 2, "income", 22.89], [2532, 1, "expense", 253.27], [2536, 28, "income", 253.27]]
      .map(([id, accountId, kind, amount]) => ({ id, accountId, kind, amount, currency: "USD", date: "2026-11-06",
        merchant: `Mobile Banking Transfer ${kind === "income" ? "Deposit" : "Withdrawal"}`, category: kind === "income" ? "Transfer In" : "Transfer Out" })),
  ] };
  const tree = workspaceHarness(props)();
  const ledger = findElement(tree, (node) => node.type?.name === "FinancePlannerTable");
  assert.equal(ledger.props.rows.length, 3);
  const forecast = findElement(tree, (node) => node.type?.name === "FinancePlannerAnalytics").props.analytics;
  assert.deepEqual(forecast.accounts.map((account) => [account.id, account.current, account.projected]), [
    [1, 854.23, 854.23], [2, 526.59, 526.59], [28, 500, 500],
  ]);
  assert.ok(ledger.props.rows.every((row) => row.balanceUsd === 854.23 && row.reserveUsd === 526.59 && row.savingsUsd === 500));
  for (const source of ["reserve", "allocation"]) {
    const row = ledger.props.rows.find((row) => row.source === source);
    assert.equal(row.recordedTransactions.length, 2);
    assert.equal(row.completionSource, "transaction");
    assert.equal(row.reflectedInStartingBalance, true);
  }
  const html = renderToStaticMarkup(tree);
  assert.match(plain(html), /Current balance\$1,880\.82/);
  assert.match(plain(html), /Annual reserve · USD\$526\.59/);
  assert.match(plain(html), /Smartly Savings · •0230/);
});

test("a historical Venture X annual fee is funded once inside the December card payment", () => {
  for (const issued of [false, true]) {
    const props = nextCycleCardFixture("2026-12-18");
    props.today = issued ? "2026-11-18" : "2026-11-06";
    const card = props.initialActivity.accounts[0];
    card.nativeCurrentBalance = 1658.16;
    card.creditCardDue.statementBalance = issued ? 1658.16 : 0;
    card.creditCardDue.lastStatementDate = issued ? "2026-11-17" : null;
    props.initialActivity.accounts.push(
      { id: 1, name: "Checking", type: "checking", currency: "USD", nativeCurrentBalance: 2000 },
      { id: 2, name: "Savings", type: "savings", currency: "USD", nativeCurrentBalance: 395 },
      { id: 28, name: "Smartly Savings", type: "savings", currency: "USD", nativeCurrentBalance: 500 },
    );
    props.snapshot.document.bills = [{ id: "venture", name: "Venture X", cadence: "annual", amount: 395, savedAmount: 395,
      dueDay: 1, dueMonths: [11], currency: "USD", accountId: 32, reserveAccountId: 2, sourceAccountId: 1 }];
    const plan = props.snapshot.document.plans[0];
    plan.startDate = "2026-11-05";
    plan.includeTransactions = true;
    plan.accountLinks = { availableUsdAccountId: 1, annualReserveUsdAccountId: 2, savingsUsdAccountId: 28 };
    props.initialPlanActivity = { configured: true, from: plan.startDate, to: plan.endDate, transactions: [],
      creditCardPaymentTransactions: [{ id: 2506, date: "2026-11-01", kind: "expense", accountId: 32, amount: 395,
        currency: "USD", merchant: "CAPITAL ONE MEMBER FEE", category: "Bank Fees", pending: false }] };
    const tree = workspaceHarness(props)();
    const ledger = findElement(tree, (node) => node.type?.name === "FinancePlannerTable");
    assert.equal(ledger.props.rows.length, 1, `issued=${issued}`);
    const due = ledger.props.rows[0];
    assert.equal(due.source, "creditCardDue");
    assert.equal(due.date, "2026-12-18");
    assert.equal(due.amount, 1658.16);
    assert.equal(due.annualBillCoverage.length, 1);
    assert.equal(due.annualBillCoverage[0].chargeTransactionId, 2506);
    assert.equal(due.balanceUsd, 736.84);
    assert.equal(due.reserveUsd, 0);
    assert.equal(due.savingsUsd, 500);
    assert.equal(due.accountBalances[32], 0);
    const html = renderToStaticMarkup(tree);
    assert.match(html, /Annual bills included in this card payment/);
    assert.match(html, /\$395\.00 charged Nov 1, 2026/);
    assert.match(html, /\$395\.00 covered by its annual reserve/);
    const result = findElement(tree, (node) => node.type?.name === "FinancePlannerAnalytics").props.analytics;
    assert.equal(result.accounts.find((account) => account.id === 1).projected, 736.84);
    assert.equal(result.assets.USD.projected, 1236.84);
  }
});

test("recording an early scheduled payment opens an actual transaction and refreshes accounts after saving", async () => {
  const props = fixture("plans", 0, { bills: [{ id: "bill", name: "Internet", cadence: "monthly", amount: 25,
    currency: "USD", dueDay: 20, accountId: 1 }] }, { accounts: [{ id: 1, name: "Checking", type: "checking", currency: "USD", nativeCurrentBalance: 100 }] });
  const renderWorkspace = workspaceHarness(props);
  const ledger = findElement(renderWorkspace(), (node) => node.type?.name === "FinancePlannerTable");
  const scheduled = ledger.props.rows.find((row) => row.billId === "bill");
  ledger.props.onRecord(scheduled);
  const form = findElement(renderWorkspace(), (node) => node.type?.name === "FinancePlanEntryForm");
  assert.equal(form.props.completed, true);
  assert.equal(form.props.entry.date, props.today);
  assert.equal(form.props.entry.accountId, 1);
  assert.equal(form.props.entry.scheduledRowId, "bill:bill:2026-11-20");
  const calls = [];
  let saved;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push(url);
    if (options?.method === "PUT") {
      saved = JSON.parse(options.body).document;
      return { ok: true, json: async () => ({ ...props.snapshot, document: saved, revision: 2 }) };
    }
    if (url.startsWith("/api/finance/activity")) return { ok: true, json: async () => ({ ...props.initialActivity,
      accounts: [{ ...props.initialActivity.accounts[0], nativeCurrentBalance: 75 }] }) };
    return { ok: true, json: async () => ({ configured: true, from: "2026-11-01", to: "2026-11-30", transactions: [] }) };
  };
  try { await form.props.onSave({ ...form.props.entry, recordNow: true }); }
  finally { globalThis.fetch = originalFetch; }
  const entry = saved.plans[0].entries[0];
  assert.equal(Object.hasOwn(entry, "recordNow"), false);
  assert.equal(entry.scheduledRowId, scheduled.id);
  assert.deepEqual(saved.plans[0].completedRows.map((row) => row.rowId), [`entry:${entry.id}`]);
  assert.ok(calls.some((url) => url.startsWith("/api/finance/activity")));
  assert.ok(calls.some((url) => url.startsWith("/api/finance/plan-activity")));
});

test("live planner source entries refresh manual balances without a separate recording choice or duplicate projection", async () => {
  const card = { id: 37, name: "Manual PHP card", type: "credit", currency: "PHP", isLinked: false, nativeCurrentBalance: 25000 };
  const props = fixture("plans", 0, { bills: [] }, { accounts: [card] });
  const renderWorkspace = workspaceHarness(props);
  findElement(renderWorkspace(), (node) => node.type?.name === "Button" && node.props.children === "Add transaction").props.onClick();
  const form = findElement(renderWorkspace(), (node) => node.type?.name === "FinancePlanEntryForm");
  assert.equal(form.props.manualAccountsFromPlanner, true);
  assert.equal(form.props.today, props.today);
  assert.equal(form.props.entry, undefined);
  const expense = { id: "fill", date: props.today, description: "Fill", kind: "expense", amount: 10457.95,
    currency: "PHP", accountId: 37, recurrence: "once" };
  const calls = [];
  let saved;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push(url);
    if (options?.method === "PUT") {
      saved = JSON.parse(options.body).document;
      return { ok: true, json: async () => ({ ...props.snapshot, document: saved, revision: 2 }) };
    }
    if (url.startsWith("/api/finance/activity")) return { ok: true, json: async () => ({ ...props.initialActivity,
      accounts: [{ ...card, nativeCurrentBalance: 35457.95 }] }) };
    const query = new URL(url, "https://example.test").searchParams;
    return { ok: true, json: async () => ({ configured: true, from: query.get("start"), to: query.get("end"), transactions: [
      { ...expense, id: 91, merchant: "Fill", planId: saved.plans[0].id, planRowId: "entry:fill", planGenerated: true,
        recordedInAccounts: true, manualPlannerSource: true },
    ] }) };
  };
  try { await form.props.onSave({ ...expense, recordNow: false }); }
  finally { globalThis.fetch = originalFetch; }
  assert.deepEqual(saved.plans[0].entries, [expense]);
  assert.deepEqual(saved.plans[0].completedRows, []);
  assert.ok(calls.some((url) => url.startsWith("/api/finance/activity")));
  assert.ok(calls.some((url) => url.startsWith("/api/finance/plan-activity")));
  const tree = renderWorkspace();
  const ledger = findElement(tree, (node) => node.type?.name === "FinancePlannerTable");
  assert.equal(ledger.props.accounts[0].nativeCurrentBalance, 35457.95);
  const actual = findElement(tree, (node) => node.type?.name === "FinancePlannerAnalytics").props.analytics;
  assert.equal(actual.debt.PHP.current, 35457.95);
  assert.equal(actual.debt.PHP.projected, 35457.95);
  assert.equal(ledger.props.rows.filter((row) => row.description === "Fill").length, 1);
  assert.equal(ledger.props.rows.find((row) => row.description === "Fill").manualPlannerSource, true);
});

test("manual planner balances use the account snapshot date after the page's original day has passed", () => {
  const nextDay = "2026-11-03";
  const purchase = { id: "next-day", date: nextDay, description: "Next-day purchase", kind: "expense", amount: 20,
    currency: "PHP", accountId: 37, recurrence: "once" };
  const base = fixture("plans", 0).snapshot.document.plans[0];
  const props = fixture("plans", 0, { bills: [], plans: [{ ...base, entries: [purchase] }] }, {
    balanceAsOf: nextDay, accounts: [{ id: 37, name: "Manual card", type: "credit", currency: "PHP", nativeCurrentBalance: 25020 }],
  });
  props.initialPlanActivity.balanceHistoryThrough = nextDay;
  props.initialPlanActivity.transactions = [{ ...purchase, id: 92, merchant: purchase.description, planId: base.id,
    planRowId: "entry:next-day", planGenerated: true, recordedInAccounts: true, manualPlannerSource: true }];
  const renderWorkspace = workspaceHarness(props);
  let tree = renderWorkspace();
  const analytics = findElement(tree, (node) => node.type?.name === "FinancePlannerAnalytics").props.analytics;
  assert.equal(analytics.today, nextDay);
  assert.equal(analytics.debt.PHP.current, 25020);
  assert.equal(analytics.debt.PHP.projected, 25020, "the new day's already-applied movement is not projected again");
  findElement(tree, (node) => node.type?.name === "Button" && node.props.children === "Add transaction").props.onClick();
  tree = renderWorkspace();
  assert.equal(findElement(tree, (node) => node.type?.name === "FinancePlanEntryForm").props.today, nextDay);
});

test("manual balances wait for planner records from the same day, including failed refreshes", async () => {
  const nextDay = "2026-11-03";
  const base = fixture("plans", 0).snapshot.document.plans[0];
  const props = fixture("plans", 0, { bills: [], plans: [{ ...base, entries: [{ id: "daily", date: "2026-11-02",
    description: "Daily purchase", kind: "expense", amount: 20, currency: "PHP", accountId: 37, recurrence: "daily" }] }] }, {
    balanceAsOf: nextDay, accounts: [{ id: 37, name: "Manual card", type: "credit", currency: "PHP",
      nativeCurrentBalance: 25040, balanceSource: "livePlanner" }],
  });
  props.initialPlanActivity.balanceHistoryThrough = props.today;
  const renderWorkspace = workspaceHarness(props);
  let tree = renderWorkspace();
  assert.equal(findElement(tree, (node) => node.type?.name === "FinancePlannerTable"), null);
  assert.equal(findElement(tree, (node) => node.type?.name === "FinancePlannerAnalytics").props.loading, true);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({ ok: true, json: async () => url.startsWith("/api/finance/activity")
    ? props.initialActivity : url.startsWith("/api/finance/plan-activity")
      ? { ...props.initialPlanActivity, configured: false, balanceHistoryThrough: nextDay, warning: "Records unavailable" }
      : { refreshedAt: "2026-11-03T12:00:00.000Z" } });
  try {
    await findElement(tree, (node) => node.type?.name === "Button" && node.props.children === "Refresh").props.onClick();
  } finally { globalThis.fetch = originalFetch; }
  tree = renderWorkspace();
  assert.equal(findElement(tree, (node) => node.type?.name === "FinancePlannerTable"), null,
    "a failed records refresh must not add today's planner movement to an already updated balance");
  assert.equal(findElement(tree, (node) => node.type?.name === "FinancePlannerAnalytics").props.loading, true);
  assert.match(plain(renderToStaticMarkup(tree)), /Refresh transactions to show balances/);
});

test("manual account balances refresh on focus and periodically outside the planner", async () => {
  for (const tab of ["accounts", "home"]) {
    const account = { id: 1, name: "Manual cash", type: "checking", currency: "USD", nativeCurrentBalance: 100,
      balanceSource: "livePlanner" };
    const props = fixture(tab, 0, { bills: [] }, { balanceAsOf: "2026-11-02", accounts: [account] });
    const effects = [];
    const renderWorkspace = workspaceHarness(props, effects);
    renderWorkspace();
    const refreshEffect = effects.find(({ dependencies }) => dependencies?.length === 3 && dependencies[0] === tab && dependencies[2] === true);
    assert.ok(refreshEffect, `${tab} subscribes to live account refreshes`);
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    const originalInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const listeners = new Map();
    let periodic;
    let cleanup;
    let requests = 0;
    globalThis.window = { document: { visibilityState: "hidden",
      addEventListener(name, handler) { listeners.set(name, handler); },
      removeEventListener(name) { listeners.delete(name); } },
      addEventListener(name, handler) { listeners.set(name, handler); },
      removeEventListener(name) { listeners.delete(name); } };
    globalThis.setInterval = (handler, delay) => { assert.equal(delay, 5 * 60 * 1000); periodic = handler; return 81; };
    globalThis.clearInterval = (timer) => assert.equal(timer, 81);
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "/api/finance/activity?month=2026-11");
      assert.equal(options?.method, undefined, "refreshing manual balances does not require bank synchronization");
      requests++;
      return { ok: true, json: async () => ({ ...props.initialActivity, balanceAsOf: "2026-11-03",
        accounts: [{ ...account, nativeCurrentBalance: 100 + requests * 20 }] }) };
    };
    try {
      cleanup = refreshEffect.run();
      assert.equal(requests, 0, "hidden pages do not refresh");
      window.document.visibilityState = "visible";
      await listeners.get("focus")();
      let tree = renderWorkspace();
      const source = () => findElement(tree, (node) => node.type?.name === (tab === "accounts" ? "BankAccountsPanel" : "FinanceOverview"));
      assert.equal(source().props.activity.balanceAsOf, "2026-11-03");
      assert.equal(source().props.activity.accounts[0].nativeCurrentBalance, 120);
      await periodic();
      tree = renderWorkspace();
      assert.equal(source().props.activity.accounts[0].nativeCurrentBalance, 140);
      window.document.visibilityState = "hidden";
      await listeners.get("visibilitychange")();
      assert.equal(requests, 2);
      cleanup();
      cleanup = null;
      assert.equal(listeners.size, 0);
    } finally {
      cleanup?.();
      globalThis.window = originalWindow;
      globalThis.fetch = originalFetch;
      globalThis.setInterval = originalInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  }
});

test("workspace live projections follow refreshed accounts despite legacy captured openings", () => {
  const base = fixture("plans", 0).snapshot.document.plans[0];
  const overrides = { bills: [], plans: [{ ...base, openingUsd: 0, startingAccounts: [{ accountId: 1, percentage: 100 }],
    accountOpeningBalances: [{ accountId: 1, balance: 999 }] }] };
  for (const balance of [200, 175]) {
    const html = plain(render("plans", 0, overrides, { accounts: [{ id: 1, name: "Checking", type: "checking",
      currency: "USD", nativeCurrentBalance: balance }] }));
    assert.ok(html.includes(`Current balance${planner.money(balance)}`));
    assert.ok(html.includes(`Projected balance${planner.money(balance)}`));
    assert.ok(!html.includes("$999.00"));
  }
});

test("November 20 account balances follow each displayed transaction before the final JCB Fill expense", () => {
  const today = "2026-11-20";
  const base = fixture("plans", 0).snapshot.document.plans[0];
  const plan = { ...base, continuous: true, balanceMode: "live", includeTransactions: true,
    includeIncome: false, includeAllocations: true, includeAnnualReserve: false, completedRows: [], entries: [
      { id: "z-fill", date: today, description: "Fill", kind: "expense", amount: 26487.24, currency: "PHP", accountId: 37 },
      { id: "income", date: today, description: "Savings deposit", kind: "income", amount: 44576.70, currency: "PHP", accountId: 34 },
      { id: "y-payment", date: today, description: "JCB payment", kind: "transfer", amount: 20000, currency: "PHP", fromAccountId: 34, toAccountId: 37 },
    ] };
  const props = fixture("plans", 0, { plans: [plan], bills: [],
    salary: { amount: 0, currency: "PHP", payFrequency: "biweekly", firstPayDate: today },
    allocations: [1, 2, 3].map((id) => ({ id: `bill-${id}`, name: `Bill ${id}`, kind: "expense",
      amount: 1, currency: "PHP", accountId: 2 })) });
  props.today = today;
  const rawAccounts = [
    { id: 34, name: "RCBC", account_type: "checking", currency: "PHP", opening_balance: 42977.38 },
    { id: 37, name: "JCB", account_type: "credit", currency: "PHP", opening_balance: 4336.88 },
    { id: 2, name: "Cash", account_type: "cash", currency: "PHP", opening_balance: 100 },
  ];
  const specs = financePlanPostingSpecs(props.snapshot.document, rawAccounts, [], { today, rate: 58 });
  const receipts = specs.map((spec, index) => ({ id: 100 + index, transaction_date: spec.date, kind: spec.kind,
    account_id: spec.accountId, amount: spec.amount, currency: spec.currency, merchant: spec.description, category: spec.category,
    source_plan_id: spec.planId, source_plan_row_id: spec.rowId, source_plan_leg: spec.leg, plan_generated: 1,
    plan_record_json: JSON.stringify(spec) }));
  const transactions = receipts.map((receipt) => ({ ...financePlanTransactionMetadata(receipt), id: receipt.id,
    date: receipt.transaction_date, kind: receipt.kind, accountId: receipt.account_id, amount: receipt.amount,
    currency: receipt.currency, merchant: receipt.merchant, category: receipt.category }));
  props.initialActivity = { ...props.initialActivity, balanceAsOf: today, accounts: rawAccounts.map((account) =>
    mapFinanceActivityAccount({ ...account, native_movement: receipts.filter((receipt) => receipt.account_id === account.id)
      .reduce((total, receipt) => total + (receipt.kind === "income" ? 1 : -1) * receipt.amount, 0) })) };
  props.initialPlanActivity = { ...props.initialPlanActivity, transactions, balanceTransactions: transactions,
    balanceHistoryFrom: plan.startDate, balanceHistoryThrough: today, balanceHistoryComplete: true };
  const input = structuredClone(props);
  const rows = table(props).rows;
  assert.deepEqual(rows.map((row) => row.description), ["Savings deposit", "Expense allocation · Bill 1", "Expense allocation · Bill 2",
    "Expense allocation · Bill 3", "JCB payment", "Fill"]);
  const balances = (accountId) => rows.map((row) => row.accountBalanceSnapshot.find((account) => account.accountId === accountId).balance);
  assert.deepEqual(balances(37), [4336.88, 4336.88, 4336.88, 4336.88, -15663.12, 10824.12]);
  assert.deepEqual(balances(34), [87554.08, 87554.08, 87554.08, 87554.08, 67554.08, 67554.08]);
  assert.deepEqual(balances(2), [100, 99, 98, 97, 97, 97]);
  assert.ok(rows.every((row) => row.accountBalanceSnapshotKind === "recorded"));
  assert.equal(rows.at(-1).amount, 26487.24);
  assert.equal(props.initialActivity.accounts.find((account) => account.id === 37).nativeCurrentBalance, 10824.12);
  const html = renderToStaticMarkup(createElement(Workspace, props));
  assert.match(html, /-₱26,487\.24/);
  assert.deepEqual(props, input, "computing row balances cannot rewrite the account's current value or planner entries");
});

test("expanded November 20 rows before a recorded Fill exclude its later JCB expense even when those rows are unrecorded", () => {
  const today = "2026-11-20";
  const base = fixture("plans", 0).snapshot.document.plans[0];
  const plan = { ...base, continuous: true, balanceMode: "live", includeTransactions: true, includeIncome: false,
    includeAllocations: false, includeAnnualReserve: false, completedRows: [], entries: [
      { id: "a-start", date: today, description: "Start of day", kind: "income", amount: 0, currency: "PHP", accountId: 34 },
      { id: "b-income", date: today, description: "Savings deposit", kind: "income", amount: 44576.70, currency: "PHP", accountId: 34 },
      ...["c", "d"].map((id) => ({ id: `${id}-other`, date: today, description: `Other ${id}`, kind: "expense",
        amount: 0, currency: "PHP", accountId: 34 })),
      { id: "y-payment", date: today, description: "JCB payment", kind: "transfer", amount: 20000, currency: "PHP", fromAccountId: 34, toAccountId: 37 },
      { id: "z-fill", date: today, description: "Fill", kind: "expense", amount: 26487.24, currency: "PHP", accountId: 37 },
    ] };
  const props = fixture("plans", 0, { plans: [plan], bills: [] });
  props.today = today;
  const rawAccounts = [
    { id: 2, name: "USD savings", account_type: "savings", currency: "USD", opening_balance: 50 },
    { id: 3, name: "Card 1", account_type: "credit", currency: "USD", opening_balance: 1.99 },
    { id: 4, name: "Card 2", account_type: "credit", currency: "USD", opening_balance: 0 },
    { id: 5, name: "Card 3", account_type: "credit", currency: "USD", opening_balance: 1658.16 },
    { id: 34, name: "RCBC", account_type: "checking", currency: "PHP", opening_balance: 0, current_balance: 67554.08,
      external_provider: "plaid", external_account_id: "rcbc" },
    { id: 37, name: "JCB", account_type: "credit", currency: "PHP", opening_balance: 4336.88 },
    { id: 38, name: "PHP card", account_type: "credit", currency: "PHP", opening_balance: 0 },
  ];
  const specs = financePlanPostingSpecs(props.snapshot.document, rawAccounts, [], { today, rate: 58 });
  const transactions = specs.map((spec, index) => ({ ...financePlanTransactionMetadata({ source_plan_id: spec.planId,
    source_plan_row_id: spec.rowId, source_plan_leg: spec.leg, plan_generated: 1, plan_record_json: JSON.stringify(spec) }),
    id: 100 + index, date: spec.date, kind: spec.kind, accountId: spec.accountId, amount: spec.amount,
    currency: spec.currency, merchant: spec.description, category: spec.category }));
  assert.equal(transactions.length, 2, "only the manual payment leg and Fill have been recorded");
  props.initialActivity = { ...props.initialActivity, balanceAsOf: today, accounts: rawAccounts.map((account) =>
    mapFinanceActivityAccount({ ...account, native_movement: transactions.filter((transaction) => transaction.accountId === account.id)
      .reduce((total, transaction) => total + (transaction.kind === "income" ? 1 : -1) * transaction.amount, 0) })) };
  props.initialPlanActivity = { ...props.initialPlanActivity, transactions, balanceTransactions: transactions,
    balanceHistoryFrom: plan.startDate, balanceHistoryThrough: today, balanceHistoryComplete: true };
  const before = structuredClone(props);
  const tree = workspaceHarness(props)();
  const ledger = findElement(tree, (node) => node.type?.name === "FinancePlannerTable");
  const rows = ledger.props.rows;
  assert.deepEqual(rows.map((row) => row.description), ["Start of day", "Savings deposit", "Other c", "Other d", "JCB payment", "Fill"]);
  assert.ok(rows.slice(0, 4).every((row) => !row.completed && !row.recordedInAccounts));
  assert.equal(rows[4].completed, false, "the linked funding leg remains unrecorded");
  assert.equal(rows[4].recordedTransactions.length, 1, "the manual JCB payment leg is already recorded");
  const balances = (id) => rows.map((row) => row.accountBalanceSnapshot.find((account) => account.accountId === id).balance);
  assert.deepEqual(balances(37), [4336.88, 4336.88, 4336.88, 4336.88, -15663.12, 10824.12]);
  assert.deepEqual(balances(34), [67554.08, 112130.78, 112130.78, 112130.78, 92130.78, 92130.78]);
  assert.deepEqual(rows.map((row) => row.projectedBalancePhp), balances(34), "collapsed totals agree with expanded cash accounts");
  const analytics = findElement(tree, (node) => node.type?.name === "FinancePlannerAnalytics").props.analytics;
  assert.equal(analytics.assets.PHP.current, 67554.08);
  assert.equal(analytics.debt.PHP.current, 10824.12);
  assert.equal(analytics.assets.PHP.projected, balances(34).at(-1));
  assert.equal(analytics.debt.PHP.projected, balances(37).at(-1));
  const states = [];
  let cursor = 0;
  const useState = (initial) => {
    const index = cursor++;
    if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
    return [states[index], (value) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
  };
  const Table = loadComponent(fileURLToPath(new URL("../app/finance/FinancePlannerTable.js", import.meta.url)), {
    ...require("react"), useState, useEffect() {}, useRef: (initial) => useState(() => ({ current: initial }))[0],
  }).default;
  const renderTable = () => { cursor = 0; return Table(ledger.props); };
  const collapsedRows = [...renderToStaticMarkup(renderTable()).matchAll(/<tr\b[^>]*data-row-id="[^"]+"[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((match) => match[1]);
  const collapsedTotals = (label, currency) => collapsedRows.map((row) => {
    const section = row.match(new RegExp(`<dl\\b[^>]*aria-label="${label}"[^>]*>([\\s\\S]*?)<\\/dl>`))?.[1];
    assert.ok(section, `Missing ${label} in a collapsed November 20 row`);
    return section.match(new RegExp(`<dt>${currency}<\\/dt><dd\\b[^>]*>([\\s\\S]*?)<\\/dd>`))?.[1].replace(/<[^>]*>/g, "");
  });
  assert.deepEqual(collapsedTotals("Credit cards", "PHP"),
    ["₱4,336.88", "₱4,336.88", "₱4,336.88", "₱4,336.88", "-₱15,663.12", "₱10,824.12"]);
  assert.deepEqual(collapsedTotals("Credit cards", "USD"), Array(6).fill("$1,660.15"));
  assert.deepEqual(collapsedTotals("Account funds", "USD"), Array(6).fill("$50.00"));
  assert.deepEqual(collapsedTotals("Account funds", "PHP"),
    ["₱67,554.08", "₱112,130.78", "₱112,130.78", "₱112,130.78", "₱92,130.78", "₱92,130.78"]);
  findElement(renderTable(), (node) => node.type === "button" && node.props.children === "Expand accounts").props.onClick();
  const html = renderToStaticMarkup(renderTable());
  const renderedRows = [...html.matchAll(/<tr\b[^>]*data-row-id="[^"]+"[^>]*>([\s\S]*?)<\/tr>/g)].map((match) => match[1]);
  const cells = (id) => renderedRows.map((row) => row.match(new RegExp(`<td\\b[^>]*data-account-id="${id}"[^>]*>([\\s\\S]*?)<\\/td>`))?.[1]);
  assert.deepEqual(cells(37).map((cell) => cell.match(/<span>(.*?)<\/span>/)[1]),
    ["₱4,336.88", "₱4,336.88", "₱4,336.88", "₱4,336.88", "-₱15,663.12", "₱10,824.12"]);
  assert.match(cells(37).at(-1), />\+26,487\.24<|>26,487\.24</);
  assert.ok(cells(2).every((cell) => cell.includes("$50.00")));
  assert.ok(cells(3).every((cell) => cell.includes("$1.99")));
  assert.ok(cells(5).every((cell) => cell.includes("$1,658.16")));
  assert.equal((html.match(/aria-current="true"/g) || []).length, 1);
  assert.match(html, /data-row-id="transaction:100"[^>]*class="[^"]*fpt-row-current/);
  assert.deepEqual(props, before);
});

test("recording part of a live card payment retains the future balance target", async () => {
  const base = fixture("plans", 0).snapshot.document.plans[0];
  const scheduled = { id: "card-target", date: "2026-11-20", description: "Card payoff", kind: "transfer",
    fromAccountId: 34, toAccountId: 37, currency: "PHP", amount: 300, amountMode: "cardBalance", recurrence: "once" };
  const props = fixture("plans", 0, { bills: [], plans: [{ ...base, entries: [scheduled] }] }, { accounts: [
    { id: 34, name: "Savings", type: "savings", currency: "PHP", nativeCurrentBalance: 1000 },
    { id: 37, name: "Card", type: "credit", currency: "PHP", nativeCurrentBalance: 300 },
  ] });
  const renderWorkspace = workspaceHarness(props);
  const ledger = findElement(renderWorkspace(), (node) => node.type?.name === "FinancePlannerTable");
  const target = ledger.props.rows.find((row) => row.entryId === "card-target");
  ledger.props.onRecord(target);
  const form = findElement(renderWorkspace(), (node) => node.type?.name === "FinancePlanEntryForm");
  assert.notEqual(form.props.entry.id, scheduled.id);
  assert.equal(form.props.entry.scheduledRowId, "entry:card-target");
  assert.equal(form.props.entry.fromAccountId, 34);
  assert.equal(form.props.entry.toAccountId, 37);
  assert.equal(form.props.entry.amountMode, "fixed");
  assert.equal(form.props.completed, true);
  const originalFetch = globalThis.fetch;
  let saved;
  globalThis.fetch = async (url, options) => {
    if (options?.method === "PUT") { saved = JSON.parse(options.body).document;
      return { ok: true, json: async () => ({ ...props.snapshot, document: saved, revision: 2 }) }; }
    return { ok: true, json: async () => url.startsWith("/api/finance/activity") ? props.initialActivity
      : { configured: true, from: base.startDate, to: base.endDate, transactions: [] } };
  };
  try { await form.props.onSave({ ...form.props.entry, amount: 100, recordNow: true }); }
  finally { globalThis.fetch = originalFetch; }
  assert.deepEqual(saved.plans[0].entries[0], scheduled);
  assert.equal(saved.plans[0].entries[1].amount, 100);
  assert.equal(saved.plans[0].completedRows.length, 1);
  assert.equal(saved.plans[0].completedRows[0].rowId, `entry:${form.props.entry.id}`);
});



test("an empty workspace opens one continuous live planner without a creation step", () => {
  const props = fixture("plans", 0, { bills: [], plans: [] });
  const renderWorkspace = workspaceHarness(props);
  let tree = renderWorkspace();
  const transactions = findElement(tree, (node) => node.type?.name === "FinancePlannerTable");
  assert.ok(transactions);
  assert.equal(transactions.props.plan.id, "live-planner");
  assert.equal(transactions.props.plan.continuous, true);
  assert.equal(transactions.props.plan.balanceMode, "live");
  assert.deepEqual(transactions.props.plan.entries, []);
  const html = plain(renderToStaticMarkup(tree));
  assert.ok(html.includes("Your live planner"));
  assert.ok(!html.includes("Create a budget plan"));
  assert.ok(!html.includes("Delete plan"));
  assert.ok(!html.includes("Edit plan"));
  findElement(tree, (node) => node.type?.name === "Button" && node.props.children === "Add transaction").props.onClick();
  tree = renderWorkspace();
  const editor = findElement(tree, (node) => node.type?.name === "FinancePlanEntryForm");
  assert.equal(editor.props.plan.id, "live-planner");
});

test("changing the timeline changes only the view and GET range while saves retain transactions outside it", async () => {
  const base = fixture("plans", 0).snapshot.document.plans[0];
  const originalEntries = [
    { id: "early", date: "2026-11-05", description: "Earlier payment", kind: "expense", accountId: 1, amount: 10, currency: "USD" },
    { id: "late", date: "2026-11-25", description: "Later payment", kind: "expense", accountId: 1, amount: 20, currency: "USD" },
  ];
  const props = fixture("plans", 0, { bills: [], plans: [{ ...base, entries: originalEntries }] },
    { accounts: [{ id: 1, name: "Checking", type: "checking", currency: "USD", nativeCurrentBalance: 1000 }] });
  props.legacyRange = false;
  const renderWorkspace = workspaceHarness(props);
  let tree = renderWorkspace();
  const before = findElement(tree, (node) => node.type?.name === "FinancePlannerAnalytics").props.analytics;
  assert.equal(before.assets.USD.projected, 970);
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const requests = [];
  let saved;
  globalThis.window = { location: { href: "http://localhost/finance?tab=plans" }, history: { pushState(_state, _title, url) { globalThis.window.location.href = String(url); } } };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, method: options?.method || "GET" });
    if (options?.method === "PUT") { saved = JSON.parse(options.body).document;
      return { ok: true, json: async () => ({ ...props.snapshot, document: saved, revision: 2 }) }; }
    if (url === "/api/finance") return { ok: true, json: async () => ({ result: { errors: [], refreshedAt: "2026-11-02T13:00:00.000Z" } }) };
    if (url.startsWith("/api/finance/activity")) return { ok: true, json: async () => props.initialActivity };
    return { ok: true, json: async () => ({ configured: true, from: "2026-11-02", to: "2026-11-30", transactions: [] }) };
  };
  try {
    findElement(tree, (node) => node.type?.name === "FinancePlannerRange").props.onChange({ startDate: "2026-11-20", endDate: "2026-11-30" });
    assert.deepEqual(requests, [], "a view change cannot save a planner or create account transactions");
    tree = renderWorkspace();
    assert.ok(globalThis.window.location.href.includes("from=2026-11-20"));
    await findElement(tree, (node) => node.type?.name === "Button" && node.props.children === "Refresh").props.onClick();
    tree = renderWorkspace();
    const transactions = findElement(tree, (node) => node.type?.name === "FinancePlannerTable");
    assert.deepEqual(transactions.props.rows.map((row) => row.entryId), ["late"]);
    assert.deepEqual(transactions.props.plan.entries, originalEntries, "hidden rows remain in the canonical ongoing planner");
    assert.equal(findElement(tree, (node) => node.type?.name === "FinancePlannerAnalytics").props.analytics.assets.USD.projected, 970);
    const get = requests.find((request) => request.url.startsWith("/api/finance/plan-activity"));
    assert.equal(get.method, "GET");
    const query = new URL(get.url, "http://localhost").searchParams;
    assert.equal(query.get("start"), "2026-11-02", "earlier future movements remain in the projection query");
    assert.equal(query.get("end"), "2026-11-30");
    assert.ok(!requests.some((request) => request.method === "PUT"));
    findElement(tree, (node) => node.type?.name === "Button" && node.props.children === "Add transaction").props.onClick();
    const form = findElement(renderWorkspace(), (node) => node.type?.name === "FinancePlanEntryForm");
    await form.props.onSave({ id: "additional", date: "2026-11-10", description: "Outside the view", kind: "expense", accountId: 1,
      amount: 5, currency: "USD", recurrence: "once", recordNow: false });
    assert.deepEqual(saved.plans[0].entries.slice(0, 2), originalEntries);
    assert.equal(saved.plans[0].entries[2].date, "2026-11-10");
    assert.equal(saved.plans[0].id, base.id);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
  }
});

test("the same projection end stays unchanged when the history start moves, including live card payments", () => {
  const base = fixture("plans", 0).snapshot.document.plans[0];
  const entries = [
    { id: "old-charge", date: "2026-11-01", description: "Past unrecorded card charge", kind: "expense", accountId: 37, amount: 50, currency: "USD" },
    { id: "new-charge", date: "2026-11-10", description: "Future card charge", kind: "expense", accountId: 37, amount: 100, currency: "USD" },
    { id: "card-payment", date: "2026-11-25", description: "Pay card balance", kind: "transfer", fromAccountId: 1, toAccountId: 37,
      amount: 300, currency: "USD", amountMode: "cardBalance" },
  ];
  const props = fixture("plans", 0, { bills: [], plans: [{ ...base, entries }] }, { accounts: [
    { id: 1, name: "Checking", type: "checking", currency: "USD", nativeCurrentBalance: 1000 },
    { id: 37, name: "Card", type: "credit", currency: "USD", nativeCurrentBalance: 300 },
  ] });
  props.legacyRange = false;
  const renderWorkspace = workspaceHarness(props);
  let tree = renderWorkspace();
  const initial = findElement(tree, (node) => node.type?.name === "FinancePlannerAnalytics").props.analytics;
  const target = findElement(tree, (node) => node.type?.name === "FinancePlannerTable").props.rows.find((row) => row.entryId === "card-payment");
  assert.equal(target.amount, 400, "future purchases increase the live payment while past unrecorded forecasts do not");
  assert.equal(initial.assets.USD.projected, 600);
  assert.equal(initial.debt.USD.projected, 0);
  const originalWindow = globalThis.window;
  globalThis.window = { location: { href: "http://localhost/finance?tab=plans" }, history: { pushState() {} } };
  try {
    findElement(tree, (node) => node.type?.name === "FinancePlannerRange").props.onChange({ startDate: "2026-11-20", endDate: "2026-11-30" });
    tree = renderWorkspace();
    const narrowed = findElement(tree, (node) => node.type?.name === "FinancePlannerAnalytics").props.analytics;
    assert.deepEqual(narrowed.assets, initial.assets);
    assert.deepEqual(narrowed.debt, initial.debt);
    assert.equal(narrowed.upcomingCount, 1);
  } finally { if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow; }
});
