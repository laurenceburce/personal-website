import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as planner from "../app/lib/financePlanner.mjs";
import * as insights from "../app/lib/financeInsights.mjs";
import * as cardContext from "../app/lib/financeCreditCardContext.mjs";
import { mapFinanceActivityAccount } from "../app/lib/financeActivity.mjs";

// Render real JSX with Next's compiler. Effects never run in these server
// renders, so no bank windows, provider calls, or personal records are touched.
const require = createRequire(import.meta.url);
const swc = require("next/dist/build/swc");
await swc.loadBindings();
const numberUrl = new URL(
  "../app/finance/FinanceNumberInput.js",
  import.meta.url,
);
const numberCode = (
  await swc.transform(await readFile(numberUrl, "utf8"), {
    filename: fileURLToPath(numberUrl),
    jsc: {
      parser: { syntax: "ecmascript", jsx: true },
      transform: { react: { runtime: "automatic" } },
      target: "es2022",
    },
    module: { type: "commonjs" },
  })
).code;
const numberModule = { exports: {} };
new Function("require", "module", "exports", numberCode)(
  require,
  numberModule,
  numberModule.exports,
);
const selectUrl = new URL(
  "../app/finance/FinanceAccountSelect.js",
  import.meta.url,
);
const selectCode = (
  await swc.transform(await readFile(selectUrl, "utf8"), {
    filename: fileURLToPath(selectUrl),
    jsc: {
      parser: { syntax: "ecmascript", jsx: true },
      transform: { react: { runtime: "automatic" } },
      target: "es2022",
    },
    module: { type: "commonjs" },
  })
).code;
const selectModule = { exports: {} };
new Function("require", "module", "exports", selectCode)(
  require,
  selectModule,
  selectModule.exports,
);
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
function loadComponents(reactOverride) {
  const componentModule = { exports: {} };
  new Function("require", "module", "exports", code)(
    (specifier) => {
      if (specifier === "react" && reactOverride) return reactOverride;
      if (specifier.endsWith(".css")) return {};
      if (specifier === "../lib/financePlanner.mjs") return planner;
      if (specifier === "../lib/financeInsights.mjs") return insights;
      if (specifier === "../lib/financeCreditCardContext.mjs") return cardContext;
      if (specifier === "./FinanceAccountSelect") return selectModule.exports;
      if (specifier === "./FinanceNumberInput") return numberModule.exports;
      return require(specifier);
    },
    componentModule,
    componentModule.exports,
  );
  return componentModule.exports;
}
const { QuickTransactionForm, TransactionsPanel, BankAccountsPanel, CreditCardAutopayForm, ManualCreditCardDetailsForm } =
  loadComponents();
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

const bankAccounts = [
  {
    id: 11,
    name: "Checking",
    type: "checking",
    currency: "USD",
    mask: "1234",
    institutionName: "Example Bank",
    provider: "plaid",
    isLinked: true,
    nativeCurrentBalance: 1000,
    nativeAvailableBalance: 1000,
  },
  {
    id: 12,
    name: "Savings",
    type: "savings",
    currency: "USD",
    mask: "2345",
    institutionName: "Example Bank",
    provider: "plaid",
    isLinked: true,
    nativeCurrentBalance: 503.7,
    nativeAvailableBalance: 503.7,
  },
  {
    id: 13,
    name: "Savings",
    type: "savings",
    currency: "USD",
    mask: "3456",
    institutionName: "Example Bank",
    provider: "plaid",
    isLinked: true,
    nativeCurrentBalance: 246.73,
    nativeAvailableBalance: 246.73,
  },
];
const bankActivity = {
  ...activity,
  accounts: bankAccounts,
  connections: [
    {
      id: 7,
      provider: "plaid",
      institutionName: "Example Bank",
      status: "active",
    },
  ],
};

test("account categories keep linked checking, savings and credit cards separate from other account types", () => {
  const html = render(BankAccountsPanel, {
    activity: {
      ...bankActivity,
      accounts: [
        { ...bankAccounts[0], name: "Main checking" },
        { ...bankAccounts[1], name: "Emergency savings" },
        { ...bankAccounts[0], id: 21, type: "credit", name: "Rewards card" },
        { ...bankAccounts[0], id: 22, type: "investment", name: "Brokerage" },
        { ...bankAccounts[0], id: 23, type: "loan", name: "Auto loan" },
        { ...account, id: 24, name: "Pocket cash" },
      ],
    },
    rate: 63,
  });
  const group = (id) => html.match(
    new RegExp(`<section class="fa-account-group" aria-labelledby="fa-account-group-${id}">([\\s\\S]*?)</section>`),
  )?.[1];
  assert.match(group("checking"), /Main checking/);
  assert.match(group("savings"), /Emergency savings/);
  assert.match(group("credit"), /Credit cards[\s\S]*Rewards card/);
  assert.match(group("other"), /Others[\s\S]*Brokerage[\s\S]*Auto loan[\s\S]*Pocket cash/);
  assert.doesNotMatch(group("checking"), /Emergency savings|Rewards card|Brokerage/);
  assert.match(group("other"), /fa-count">3</);
});

test("manual account cards show Live planner balances and native starting balances while linked accounts retain bank provenance", () => {
  const manual = mapFinanceActivityAccount({ id: 34, name: "PHP savings", account_type: "savings", currency: "PHP",
    opening_balance: 100000, native_movement: -10457.95 });
  const card = mapFinanceActivityAccount({ id: 37, name: "PHP card", account_type: "credit", currency: "PHP",
    opening_balance: 25000, native_movement: -10457.95 });
  const html = render(BankAccountsPanel, { activity: { ...bankActivity, accounts: [manual, card, bankAccounts[0]] }, rate: 63 });
  const articles = [...html.matchAll(/<article class="fa-account-card[^"]*"[^>]*>([\s\S]*?)<\/article>/g)].map((match) => match[1]);
  const savings = articles.find((article) => article.includes("PHP savings"));
  assert.match(savings, /Live planner balance[\s\S]*?₱89,542\.05/);
  assert.match(savings, /fa-account-source[^>]*>Live planner</);
  assert.match(savings, /Starting balance ₱100,000\.00/);
  const debt = articles.find((article) => article.includes("PHP card"));
  assert.match(debt, /Balance owed[\s\S]*?₱35,457\.95/);
  assert.match(debt, /Starting balance ₱25,000\.00/);
  const linked = articles.find((article) => article.includes("Example Bank"));
  assert.match(linked, /Current balance[\s\S]*?\$1,000\.00/);
  assert.match(linked, /Bank synced/);
  assert.doesNotMatch(linked, /Live planner balance|Starting balance/);
});

test("credit cards show full statement amounts and dated dues separately from current balances", () => {
  const html = render(BankAccountsPanel, {
    activity: {
      ...bankActivity,
      accounts: [{
        ...bankAccounts[0],
        name: "Rewards card",
        type: "credit",
        nativeCurrentBalance: 990,
        creditCardDueStatus: "current",
        creditCardDue: {
          statementBalance: 472.35,
          minimumPayment: 25,
          dueDate: "2026-11-20",
        },
      }],
    },
    rate: 63,
  });
  assert.match(html, /Balance owed[\s\S]*\$990\.00/);
  assert.match(html, /Statement balance[\s\S]*\$472\.35/);
  assert.match(html, /Payment due[\s\S]*Nov 20, 2026/);
  assert.match(html, /Minimum payment[\s\S]*\$25\.00/);
  assert.match(html, /No accounts in this category/);
});

test("missing statement data stays unavailable and stale statement data is labeled", () => {
  const renderCard = (extra) => render(BankAccountsPanel, {
    activity: {
      ...bankActivity,
      accounts: [{ ...bankAccounts[0], type: "credit", nativeCurrentBalance: 990, ...extra }],
    },
    rate: 63,
  });
  const missing = renderCard({ creditCardDue: null, creditCardDueStatus: "unavailable" });
  const missingDetails = missing.match(/<div class="fa-credit-card-due">([\s\S]*?)<\/dl>/)?.[1];
  assert.match(missingDetails, /Statement balance<\/dt><dd>Not entered/);
  assert.match(missingDetails, /Payment due<\/dt><dd>Date needed/);
  assert.doesNotMatch(missingDetails, /\$990\.00|\$0\.00/);
  assert.match(missing, /has not supplied complete statement details/);
  const stale = renderCard({
    creditCardDueStatus: "stale",
    creditCardDue: { statementBalance: 0, dueDate: "2026-11-20" },
  });
  assert.match(stale, /Statement balance[\s\S]*\$0\.00/);
  assert.match(stale, /Last known statement details/);
});

test("credit card automatic payment display keeps the bank due date and statement balance intact", () => {
  const card = { ...bankAccounts[0], type: "credit", name: "Rewards card", nativeCurrentBalance: 990,
    creditCardAutopayEnabled: true, creditCardAutopayDaysBeforeDue: 7,
    creditCardDue: { statementBalance: 472.35, dueDate: "2026-11-20" } };
  const before = structuredClone(card);
  const html = render(BankAccountsPanel, { activity: { ...bankActivity, accounts: [card] }, rate: 63 });
  assert.match(html, /Payment due<\/dt><dd>Nov 20, 2026/);
  assert.match(html, /Automatic payment<\/dt><dd>Nov 13, 2026/);
  assert.match(html, /Statement balance[\s\S]*\$472\.35/);
  assert.match(html, /does not enroll the card in bank autopay or send a payment/);
  assert.deepEqual(card, before);
  assert.doesNotMatch(html, /type="number"/);
});

function autopayHarness(props = {}) {
  const slots = [];
  let cursor = 0;
  const saved = [];
  const components = loadComponents({ ...require("react"), useState(initial) {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
  } });
  return { saved, render() {
    cursor = 0;
    return components.CreditCardAutopayForm({ account: { id: 10, creditCardDue: { dueDate: "2026-11-20" } },
      onSave: (settings) => saved.push(settings), ...props });
  } };
}

function manualDetailsHarness(props = {}) {
  const slots = [];
  let cursor = 0;
  const saved = [];
  const components = loadComponents({ ...require("react"), useState(initial) {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
  } });
  const harness = { saved, render() {
    cursor = 0;
    return components.ManualCreditCardDetailsForm({ account: { id: 10, name: "Manual PHP card", type: "credit", currency: "PHP", isLinked: false },
      onSave: (details) => saved.push(details), ...props });
  }, set(field, value) {
    const amount = ["statementBalance", "minimumPayment"].includes(field);
    const required = ["statementBalance", "dueDate"].includes(field);
    const input = findElement(harness.render(), (node) => Boolean(node.props?.required) === required &&
      (amount ? node.type === numberModule.exports.default : node.type === "input" && node.props.type === "date"));
    input.props.onChange({ target: { value } });
  }, submit() {
    return findElement(harness.render(), (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  } };
  return harness;
}

test("manual credit cards keep a collapsed statement editor without inferring statement debt from current balances", () => {
  const card = { ...account, id: 41, name: "RCBC Gold JCB", type: "credit", nativeCurrentBalance: 14930.79,
    creditCardAutopayEnabled: true, creditCardAutopayDaysBeforeDue: 7 };
  const html = render(BankAccountsPanel, { activity: { ...bankActivity, accounts: [card] }, rate: 63 });
  assert.doesNotMatch(html, /fa-card-payment-details" open=/);
  assert.match(html, /<summary>Add statement<\/summary>/);
  assert.match(html, /Statement balance · PHP/);
  assert.match(html, /Minimum payment · PHP \(optional\)/);
  assert.match(html, /Statement date \(optional\)/);
  assert.match(html, /Charges already update this card/);
  assert.match(html, /Save statement/);
  assert.doesNotMatch(html, /value="14930\.79"|Statement details are imported|type="number"/);
  const linked = render(BankAccountsPanel, { activity: { ...bankActivity, accounts: [{ ...card, isLinked: true, provider: "plaid" }] }, rate: 63 });
  assert.doesNotMatch(linked, /Save statement|fa-card-payment-details/);
});

test("manual card details save native statement values and optional dates without touching autopay or current debt", () => {
  const card = { ...account, id: 41, name: "RCBC Gold JCB", type: "credit", nativeCurrentBalance: 14930.79,
    creditCardAutopayEnabled: true, creditCardAutopayDaysBeforeDue: 7 };
  const before = structuredClone(card);
  const harness = manualDetailsHarness({ account: card });
  harness.set("statementBalance", "4723.50");
  harness.set("dueDate", "2026-11-20");
  harness.set("minimumPayment", "250.00");
  harness.set("lastStatementDate", "2026-10-25");
  assert.equal(harness.saved.length, 0);
  harness.submit();
  assert.deepEqual(harness.saved, [{ statementBalance: 4723.5, dueDate: "2026-11-20", minimumPayment: 250, lastStatementDate: "2026-10-25" }]);
  assert.deepEqual(card, before);
  const savedCard = { ...card, creditCardDueStatus: "manual", creditCardDue: harness.saved[0] };
  const html = render(BankAccountsPanel, { activity: { ...bankActivity, accounts: [savedCard] }, rate: 63 });
  assert.match(html, /Statement balance[\s\S]*₱4,723\.50/);
  assert.match(html, /Automatic payment<\/dt><dd>Nov 13, 2026/);
  assert.match(html, /<summary>Edit statement<\/summary>/);
  assert.match(html, /value="4723\.5"/);
  assert.doesNotMatch(html, /Last known statement details/);
});

test("manual statement drafts use current debt only after an explicit choice and never invent a due date", () => {
  const card = { ...account, id: 41, name: "RCBC Gold Visa", type: "credit", nativeCurrentBalance: 2240.01 };
  const before = structuredClone(card);
  const harness = manualDetailsHarness({ account: card });
  const statementInput = (tree) => findElement(tree, (node) => node.type === numberModule.exports.default && node.props.required);
  assert.equal(statementInput(harness.render()).props.value, "");
  const useBalance = findElement(harness.render(), (node) => node.type === "button" && node.props.className === "fa-use-balance");
  assert.ok(useBalance);
  assert.equal(Boolean(useBalance.props.disabled), false);
  useBalance.props.onClick();
  const tree = harness.render();
  assert.equal(Number(statementInput(tree).props.value), 2240.01);
  assert.equal(findElement(tree, (node) => node.type === "input" && node.props.type === "date" && node.props.required).props.value, "");
  assert.deepEqual(harness.saved, []);
  assert.deepEqual(card, before);
  for (const balance of [null, -20, NaN]) {
    const unavailable = manualDetailsHarness({ account: { ...card, nativeCurrentBalance: balance } });
    const button = findElement(unavailable.render(), (node) => node.type === "button" && node.props.className === "fa-use-balance");
    assert.ok(!button || button.props.disabled, "unknown or credit balances cannot become a statement amount");
  }
});

test("saved manual statements keep zero amounts and all known fields prefilled in their collapsed editor", () => {
  const card = { ...account, id: 41, name: "RCBC Gold Visa", type: "credit", nativeCurrentBalance: 2240.01,
    creditCardDueStatus: "manual", creditCardDue: { statementBalance: 0, dueDate: "2026-12-15", minimumPayment: 0, lastStatementDate: "2026-11-20" } };
  const html = render(ManualCreditCardDetailsForm, { account: card, onSave() {} });
  assert.match(html, /<summary>Edit statement<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]*\sopen=/);
  assert.match(html, /value="0"/);
  assert.match(html, /value="2026-12-15"/);
  assert.match(html, /value="2026-11-20"/);
  assert.doesNotMatch(html, /value="2240\.01"/);
});

test("a saved manual statement displays its exact issued amount, minimum and dates separately from total debt", () => {
  const card = { ...account, id: 41, name: "Manual PHP card", type: "credit", nativeCurrentBalance: 2240.01,
    creditCardAutopayEnabled: true, creditCardAutopayDaysBeforeDue: 7, creditCardDueStatus: "manual",
    creditCardDue: { statementBalance: 169, minimumPayment: 169, dueDate: "2026-12-01", lastStatementDate: "2026-11-03" } };
  const before = structuredClone(card);
  const html = render(BankAccountsPanel, { activity: { ...bankActivity, accounts: [card] }, today: "2026-11-22", rate: 63 });
  assert.match(html, /Balance owed[\s\S]*₱2,240\.01/);
  assert.match(html, /Statement balance<\/dt><dd>₱169\.00/);
  assert.match(html, /Minimum payment<\/dt><dd>₱169\.00/);
  assert.match(html, /Payment due<\/dt><dd>Dec 1, 2026/);
  assert.match(html, /Statement closed<\/dt><dd>Nov 3, 2026/);
  assert.match(html, /Automatic payment<\/dt><dd>Nov 24, 2026/);
  assert.match(html, /<summary>Edit statement<\/summary>/);
  assert.match(html, /value="169"/);
  assert.match(html, /value="2026-12-01"/);
  assert.match(html, /value="2026-11-03"/);
  assert.doesNotMatch(html, /value="2240\.01"/);
  assert.deepEqual(card, before);
});

test("card summaries show exact assigned charges separately from unknown statement dates and distinct card debt", () => {
  const visa = { ...account, id: 41, name: "RCBC Gold Visa", type: "credit", nativeCurrentBalance: 2240.01,
    creditCardAutopayEnabled: true, creditCardAutopayDaysBeforeDue: 7 };
  const jcb = { ...visa, id: 42, name: "RCBC Gold JCB", nativeCurrentBalance: 13696.72 };
  const document = { salary: {}, allocations: [], bills: [
    { id: "spotify", name: "Spotify", amount: 169, currency: "PHP", cadence: "monthly", dueDay: 28, accountId: 41 },
    { id: "globe", name: "Globe", amount: 1500, currency: "PHP", cadence: "monthly", dueDay: 11, accountId: 41 },
    { id: "converge", name: "Converge", amount: 2500, currency: "PHP", cadence: "monthly", dueDay: 28, accountId: 41 },
    { id: "jcb-charge", name: "JCB only charge", amount: 80, currency: "PHP", cadence: "monthly", dueDay: 25, accountId: 42 },
    { id: "wrong-currency", name: "Wrong currency", amount: 999, currency: "USD", cadence: "monthly", dueDay: 25, accountId: 41 },
  ] };
  const before = structuredClone({ visa, jcb, document });
  const html = render(BankAccountsPanel, { activity: { ...bankActivity, accounts: [visa, jcb] }, document,
    today: "2026-11-22", rate: 63 });
  const visaHtml = html.match(/<article[^>]*data-account-id="41"[^>]*>([\s\S]*?)<\/article>/)?.[1];
  const jcbHtml = html.match(/<article[^>]*data-account-id="42"[^>]*>([\s\S]*?)<\/article>/)?.[1];
  assert.ok(visaHtml && jcbHtml);
  assert.match(visaHtml, /Balance owed[\s\S]*₱2,240\.01/);
  assert.match(visaHtml, /Statement balance<\/dt><dd>Not entered/);
  assert.match(visaHtml, /Payment due<\/dt><dd>Date needed/);
  assert.match(visaHtml, /7 days before due · date needed/);
  assert.match(visaHtml, /Charges to this card/);
  for (const [name, amount, date] of [["Spotify", "₱169.00", "Nov 28"], ["Globe", "₱1,500.00", "Dec 11"], ["Converge", "₱2,500.00", "Nov 28"]]) {
    const chargeHtml = visaHtml.match(new RegExp(`<li[^>]*>(?:(?!<li)[\\s\\S])*?<strong>${name}<\\/strong>([\\s\\S]*?)<\\/li>`))?.[1];
    assert.ok(chargeHtml, `${name} is shown as an assigned charge`);
    assert.ok(chargeHtml.includes(amount));
    assert.ok(chargeHtml.includes(date));
  }
  assert.doesNotMatch(visaHtml, /JCB only charge|Wrong currency|₱13,696\.72|value="2240\.01"/);
  assert.match(jcbHtml, /₱13,696\.72/);
  assert.match(jcbHtml, /JCB only charge/);
  assert.doesNotMatch(jcbHtml, /Spotify|Globe|Converge/);
  assert.deepEqual({ visa, jcb, document }, before);
});

test("planning a full card payment selects that account and stays disabled when it cannot be planned", () => {
  const card = { ...account, id: 41, name: "RCBC Gold Visa", type: "credit", nativeCurrentBalance: 2240.01 };
  const selected = [];
  const paymentButton = (tree) => {
    const planning = findElement(tree, (node) => node.type?.name === "CreditCardPlanning");
    return findElement(planning.type(planning.props), (node) => node.props?.children === "Plan full payment");
  };
  const harness = bankHarness({ props: { activity: { ...bankActivity, accounts: [card] }, onPlanCardPayment: (value) => selected.push(value) } });
  const button = paymentButton(harness.render());
  assert.ok(button);
  assert.equal(Boolean(button.props.disabled), false);
  button.props.onClick();
  assert.deepEqual(selected, [card]);
  assert.deepEqual(harness.actions, [], "planning opens an editor without saving an actual payment");
  for (const props of [
    { busy: true, activity: { ...bankActivity, accounts: [card] } },
    { activity: { ...bankActivity, configured: false, accounts: [card] } },
    { activity: { ...bankActivity, accounts: [{ ...card, nativeCurrentBalance: null }] } },
    { activity: { ...bankActivity, accounts: [{ ...card, currency: "EUR" }] } },
  ]) {
    const disabled = bankHarness({ props: { ...props, onPlanCardPayment() {} } });
    assert.equal(paymentButton(disabled.render()).props.disabled, true);
  }
});

test("the next card charge shows its saved effective date, amount and description", () => {
  const card = { ...account, id: 41, name: "Manual PHP card", type: "credit", nativeCurrentBalance: 2240.01 };
  const document = { salary: {}, allocations: [],
    bills: [{ id: "subscription", name: "Original subscription", amount: 169, currency: "PHP", cadence: "monthly", dueDay: 28, accountId: 41 }],
    plans: [{ id: "live", continuous: true, startDate: "2026-11-01", entries: [],
      rowOverrides: [{ rowId: "bill:subscription:2026-11-28", date: "2026-12-04", amount: 99, description: "Adjusted subscription" }] }] };
  const before = structuredClone({ card, document });
  const html = render(BankAccountsPanel, { activity: { ...bankActivity, accounts: [card] }, document,
    today: "2026-11-22", rate: 63 });
  const charges = html.match(/<ul class="fa-card-charges">([\s\S]*?)<\/ul>/)?.[1];
  assert.ok(charges);
  assert.match(charges, /Adjusted subscription/);
  assert.match(charges, /Dec 4, 2026/);
  assert.match(charges, /₱99\.00/);
  assert.doesNotMatch(charges, /Original subscription|Nov 28|₱169\.00/);
  assert.match(html, /Statement balance<\/dt><dd>Not entered/);
  assert.deepEqual({ card, document }, before);
});

test("an existing card payment opens the planner instead of adding a second payment", () => {
  const card = { ...account, id: 41, name: "Manual PHP card", type: "credit", nativeCurrentBalance: 2240.01 };
  const payment = { id: "card-payment", date: "2026-11-28", kind: "transfer", currency: "PHP",
    fromAccountId: 34, toAccountId: 41, amount: 2240.01, amountMode: "cardBalance", recurrence: "once" };
  let reviews = 0;
  const calls = [];
  const harness = bankHarness({ props: { activity: { ...bankActivity, accounts: [card] }, today: "2026-11-22",
    document: { bills: [], plans: [{ id: "live", continuous: true, startDate: "2026-11-01", entries: [payment] }] },
    onPlanCardPayment: (selected) => calls.push(selected), onReviewPlan: () => { reviews++; } } });
  const planning = findElement(harness.render(), (node) => node.type?.name === "CreditCardPlanning");
  const tree = planning.type(planning.props);
  const html = renderToStaticMarkup(tree);
  assert.match(html, /Planned payment · Nov 28, 2026/);
  assert.match(html, /Full balance remaining on the payment date/);
  assert.doesNotMatch(html, /Plan full payment/);
  findElement(tree, (node) => node.props?.children === "View in planner").props.onClick();
  assert.equal(reviews, 1);
  assert.deepEqual(calls, []);
  assert.deepEqual(harness.actions, []);
});

test("manual card details reject incomplete money and invalid dates while retaining zero and blank optional fields", () => {
  const harness = manualDetailsHarness();
  for (const amount of ["", "-1", "0.001", "1000000000", "NaN"]) {
    harness.set("statementBalance", amount);
    harness.set("dueDate", "2026-11-20");
    harness.submit();
    assert.equal(harness.saved.length, 0);
    assert.match(renderToStaticMarkup(harness.render()), /non-negative statement balance/);
  }
  harness.set("statementBalance", "200");
  for (const date of ["", "2026-02-29", "2026-11-31", "1899-12-31", "2201-01-01"]) {
    harness.set("dueDate", date);
    harness.submit();
    assert.equal(harness.saved.length, 0);
    assert.match(renderToStaticMarkup(harness.render()), /valid payment due date/);
  }
  harness.set("dueDate", "2026-11-20");
  for (const amount of ["201", "-1", "0.001"]) {
    harness.set("minimumPayment", amount);
    harness.submit();
    assert.equal(harness.saved.length, 0);
    assert.match(renderToStaticMarkup(harness.render()), /Minimum payment must/);
  }
  harness.set("minimumPayment", "");
  for (const date of ["2026-11-21", "2026-02-29", "1899-12-31"]) {
    harness.set("lastStatementDate", date);
    harness.submit();
    assert.equal(harness.saved.length, 0);
    assert.match(renderToStaticMarkup(harness.render()), /valid statement date on or before/);
  }
  harness.set("lastStatementDate", "");
  harness.set("statementBalance", "0");
  assert.doesNotMatch(renderToStaticMarkup(harness.render()), /role="alert"/);
  harness.submit();
  assert.deepEqual(harness.saved, [{ statementBalance: 0, dueDate: "2026-11-20", minimumPayment: null, lastStatementDate: null }]);
});

test("manual card payment details stay disabled while saving or the workspace is unavailable", () => {
  for (const props of [{ disabled: true }, { saving: true }]) {
    const harness = manualDetailsHarness(props);
    harness.set("statementBalance", "200");
    harness.set("dueDate", "2026-11-20");
    assert.equal(findElement(harness.render(), (node) => node.type === "fieldset").props.disabled, true);
    harness.submit();
    assert.equal(harness.saved.length, 0);
  }
  const harness = bankHarness({ props: { activity: { ...bankActivity, configured: false,
    accounts: [{ ...account, type: "credit" }] } } });
  assert.equal(findElement(harness.render(), (node) => node.type?.name === "ManualCreditCardDetailsForm").props.disabled, true);
});

test("automatic payment settings default to one week early and save only after explicit submission", () => {
  const harness = autopayHarness();
  let tree = harness.render();
  const checkbox = findElement(tree, (node) => node.type === "input" && node.props.type === "checkbox");
  assert.equal(checkbox.props.checked, false);
  checkbox.props.onChange({ target: { checked: true } });
  tree = harness.render();
  const days = findElement(tree, (node) => node.type === numberModule.exports.default);
  assert.equal(days.props.value, "7");
  assert.match(renderToStaticMarkup(tree), /Planned payment: Nov 13, 2026/);
  assert.equal(harness.saved.length, 0);
  findElement(tree, (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.deepEqual(harness.saved, [{ enabled: true, daysBeforeDue: 7 }]);
});

test("automatic payment settings require bounded whole days and allow payment on the due date", () => {
  const harness = autopayHarness({ account: { id: 10, creditCardAutopayEnabled: true,
    creditCardAutopayDaysBeforeDue: 7, creditCardDue: { dueDate: "2026-11-20" } } });
  for (const value of ["", "-1", "32", "1.5", "abc"]) {
    const tree = harness.render();
    findElement(tree, (node) => node.type === numberModule.exports.default).props.onChange({ target: { value } });
    findElement(harness.render(), (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
    assert.equal(harness.saved.length, 0);
    assert.match(renderToStaticMarkup(harness.render()), /whole number of days from 0 to 31/);
  }
  findElement(harness.render(), (node) => node.type === numberModule.exports.default).props.onChange({ target: { value: "0" } });
  assert.match(renderToStaticMarkup(harness.render()), /Planned payment: Nov 20, 2026/);
  findElement(harness.render(), (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.deepEqual(harness.saved, [{ enabled: true, daysBeforeDue: 0 }]);
});

test("automatic payment preferences are disabled while saving or finance is unavailable", () => {
  for (const props of [{ disabled: true }, { saving: true }]) {
    const harness = autopayHarness(props);
    const tree = harness.render();
    assert.equal(findElement(tree, (node) => node.type === "fieldset").props.disabled, true);
    findElement(tree, (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
    assert.equal(harness.saved.length, 0);
  }
  const harness = bankHarness({ props: { activity: { ...bankActivity, configured: false,
    accounts: [{ ...bankAccounts[0], type: "credit" }] } } });
  assert.equal(findElement(harness.render(), (node) => node.type?.name === "CreditCardAutopayForm").props.disabled, true);
});

test("bank cards distinguish savings accounts and show their annual and payday allocations", () => {
  const html = render(BankAccountsPanel, {
    activity: bankActivity,
    accountAllocations: [
      { accountId: 11, salaryPerPayday: 1000, roles: [{ name: "Salary" }] },
      {
        accountId: 12,
        bankBalance: 503.7,
        annualReserved: 503.7,
        annualPerPayday: 22.89,
        unallocatedBalance: 0,
        overassigned: 0,
        roles: [{ name: "Annual bills" }],
      },
      {
        accountId: 13,
        bankBalance: 246.73,
        annualReserved: 300,
        annualPerPayday: 0,
        savingsPerPayday: 500,
        unallocatedBalance: -53.27,
        overassigned: 53.27,
        roles: [{ name: "Payday savings" }],
      },
    ],
    rate: 63,
    onAction: async () => {},
    onRefresh: async () => {},
  });
  assert.match(html, /Account ending 2345/);
  assert.match(html, /Account ending 3456/);
  assert.match(html, /Allocated to annual bills[\s\S]*?\$503\.70/);
  assert.match(html, /Annual bills each payday[\s\S]*?\$22\.89/);
  assert.match(html, /Savings each payday[\s\S]*?\$500\.00/);
  assert.match(html, /Receives salary each payday[\s\S]*?\$1,000\.00/);
  assert.match(html, /exceed this bank balance by \$53\.27/);
  assert.match(html, /Find duplicate accounts/);
  assert.match(html, /Update accounts/);
  assert.match(html, /Unlink Example Bank connection/);
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
function bankHarness(extra = {}) {
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
  const components = loadComponents({
    ...require("react"),
    useState,
    useEffect() {},
    useRef(initial) {
      return useState(() => ({ current: initial }))[0];
    },
  });
  const actions = [];
  let refreshes = 0;
  const props = {
    activity: bankActivity,
    rate: 63,
    onAction: async (action, data) => {
      actions.push({ action, data });
      return extra.result?.(action, data) || {};
    },
    onRefresh: async () => {
      refreshes++;
    },
    ...extra.props,
  };
  const renderTree = () => {
    cursor = 0;
    return components.BankAccountsPanel(props);
  };
  return { render: renderTree, actions, refreshes: () => refreshes };
}
const actionButton = (tree, label) =>
  findElement(
    tree,
    (node) =>
      node.type?.name === "ActionButton" && node.props.children === label,
  );

test("saving a credit card automatic payment preference sends only settings and refreshes the workspace", async () => {
  const card = { ...bankAccounts[0], id: 99, type: "credit", name: "Rewards card",
    creditCardDue: { statementBalance: 472.35, dueDate: "2026-11-20" }, nativeCurrentBalance: 990 };
  const before = structuredClone(card);
  const harness = bankHarness({ props: { activity: { ...bankActivity, accounts: [card] } } });
  const form = findElement(harness.render(), (node) => node.type?.name === "CreditCardAutopayForm");
  assert.equal(form.props.disabled, false);
  await form.props.onSave({ enabled: true, daysBeforeDue: 7 });
  assert.deepEqual(harness.actions, [{ action: "updateCreditCardAutopay", data: { accountId: 99, enabled: true, daysBeforeDue: 7 } }]);
  assert.equal(harness.refreshes(), 1);
  assert.deepEqual(card, before);
  const busy = bankHarness({ props: { activity: { ...bankActivity, accounts: [card] }, busy: true } });
  assert.equal(findElement(busy.render(), (node) => node.type?.name === "CreditCardAutopayForm").props.disabled, true);
});

test("automatic payment save failures display the action error without claiming a refresh", async () => {
  const errors = [];
  const harness = bankHarness({ result() { throw new Error("The settings could not be saved."); },
    props: { activity: { ...bankActivity, accounts: [{ ...bankAccounts[0], type: "credit" }] },
      onError: (message) => errors.push(message) } });
  const form = findElement(harness.render(), (node) => node.type?.name === "CreditCardAutopayForm");
  await form.props.onSave({ enabled: true, daysBeforeDue: 7 });
  assert.deepEqual(errors, ["The settings could not be saved."]);
  assert.equal(harness.refreshes(), 0);
});

test("manual payment details send only entered statement data and refresh the workspace after saving", async () => {
  const card = { ...account, id: 41, name: "RCBC Gold JCB", type: "credit", nativeCurrentBalance: 14930.79,
    creditCardAutopayEnabled: true, creditCardAutopayDaysBeforeDue: 7 };
  const before = structuredClone(card);
  const harness = bankHarness({ props: { activity: { ...bankActivity, accounts: [card] } } });
  const details = { statementBalance: 4723.5, dueDate: "2026-11-20", minimumPayment: null, lastStatementDate: "2026-10-25" };
  const form = findElement(harness.render(), (node) => node.type?.name === "ManualCreditCardDetailsForm");
  await form.props.onSave(details);
  assert.deepEqual(harness.actions, [{ action: "updateManualCreditCardDetails", data: { accountId: 41, ...details } }]);
  assert.equal(harness.refreshes(), 1);
  assert.deepEqual(card, before);
});

test("manual payment detail failures display the action error and preserve entered details for retry", async () => {
  const errors = [];
  const harness = bankHarness({ result() { throw new Error("Payment details could not be saved."); },
    props: { activity: { ...bankActivity, accounts: [{ ...account, type: "credit" }] }, onError: (message) => errors.push(message) } });
  const form = findElement(harness.render(), (node) => node.type?.name === "ManualCreditCardDetailsForm");
  await form.props.onSave({ statementBalance: 200, dueDate: "2026-11-20", minimumPayment: null, lastStatementDate: null });
  assert.deepEqual(errors, ["Payment details could not be saved."]);
  assert.equal(harness.refreshes(), 0);
});

test("removing one account and unlinking a connection require their own concrete confirmation", async () => {
  const harness = bankHarness();
  let tree = harness.render();
  const remove = findElement(
    tree,
    (node) =>
      node.type?.name === "ActionButton" &&
      String(node.props["aria-label"] || "").startsWith(
        "Remove Savings · ••2345",
      ),
  );
  remove.props.onClick();
  tree = harness.render();
  assert.match(renderToStaticMarkup(tree), /syncing will not add it back/);
  assert.equal(harness.actions.length, 0);
  actionButton(tree, "Keep it").props.onClick();
  assert.equal(harness.actions.length, 0);
  tree = harness.render();
  findElement(
    tree,
    (node) =>
      node.type?.name === "ActionButton" &&
      String(node.props["aria-label"] || "").startsWith(
        "Remove Savings · ••2345",
      ),
  ).props.onClick();
  await actionButton(harness.render(), "Remove account").props.onClick();
  assert.deepEqual(harness.actions, [
    { action: "removeAccount", data: { id: 12 } },
  ]);
  assert.equal(harness.refreshes(), 1);
  tree = harness.render();
  findElement(
    tree,
    (node) =>
      node.type?.name === "ActionButton" &&
      node.props["aria-label"] === "Unlink Example Bank connection",
  ).props.onClick();
  assert.match(
    renderToStaticMarkup(harness.render()),
    /Syncing stops and its accounts leave the active view/,
  );
  await actionButton(harness.render(), "Unlink connection").props.onClick();
  assert.deepEqual(harness.actions.at(-1), {
    action: "unlinkConnection",
    data: { id: 7 },
  });
});

test("duplicate repair previews confirmed identities before applying the merge", async () => {
  const harness = bankHarness({
    result: (action, data) =>
      action === "repairDuplicateAccounts"
        ? data.preview
          ? {
              duplicateAccounts: 2,
              groups: [
                {
                  canonicalId: 12,
                  duplicateIds: [14, 15],
                  name: "Savings",
                  mask: "2345",
                  currency: "USD",
                },
              ],
              warnings: [],
            }
          : { mergedAccounts: 2 }
        : {},
  });
  await actionButton(
    harness.render(),
    "Find duplicate accounts",
  ).props.onClick();
  const html = renderToStaticMarkup(harness.render());
  assert.match(html, /2 duplicate accounts found/);
  assert.match(html, /Distinct savings accounts stay separate/);
  assert.match(html, /••2345/);
  assert.deepEqual(harness.actions, [
    { action: "repairDuplicateAccounts", data: { preview: true } },
  ]);
  await actionButton(
    harness.render(),
    "Merge confirmed duplicates",
  ).props.onClick();
  assert.deepEqual(harness.actions.at(-1), {
    action: "repairDuplicateAccounts",
    data: { preview: false },
  });
  assert.equal(harness.refreshes(), 1);
});

test("updating a connection reuses its item and syncs without exchanging a new public token", async () => {
  const previousWindow = globalThis.window;
  let linkOptions;
  let stored;
  const harness = bankHarness({
    result: (action) =>
      action === "createPlaidLinkToken"
        ? { linkToken: "synthetic-update-token", connectionId: 7 }
        : {},
  });
  globalThis.window = {
    location: { href: "https://example.test/finance?tab=accounts" },
    history: { state: null, replaceState() {} },
    sessionStorage: {
      setItem(key, value) {
        stored = JSON.parse(value);
      },
      removeItem() {},
    },
    Plaid: {
      create(options) {
        linkOptions = options;
        return { open() {}, destroy() {} };
      },
    },
  };
  try {
    await actionButton(harness.render(), "Update accounts").props.onClick();
    assert.deepEqual(harness.actions, [
      { action: "createPlaidLinkToken", data: { connectionId: 7 } },
    ]);
    assert.equal(stored.connectionId, 7);
    await linkOptions.onSuccess(null, {});
    assert.deepEqual(harness.actions.at(-1), {
      action: "syncConnection",
      data: { id: 7 },
    });
    assert.ok(
      !harness.actions.some(
        (item) => item.action === "exchangePlaidPublicToken",
      ),
    );
    assert.equal(harness.refreshes(), 1);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("disconnected connections retain history labels and cannot sync, update, or unlink again", () => {
  const html = render(BankAccountsPanel, {
    activity: {
      ...bankActivity,
      accounts: [],
      connections: [{ ...bankActivity.connections[0], status: "disconnected" }],
    },
    rate: 63,
    onAction: async () => {},
    onRefresh: async () => {},
  });
  assert.match(html, /disconnected/);
  assert.doesNotMatch(
    html,
    /Update accounts|Sync now|Unlink Example Bank connection/,
  );
});

test("the transaction account filter distinguishes same-named savings accounts by identity and mask", () => {
  const slots = [];
  let cursor = 0;
  const components = loadComponents({
    ...require("react"),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots))
        slots[index] = typeof initial === "function" ? initial() : initial;
      return [
        slots[index],
        (next) => {
          slots[index] = typeof next === "function" ? next(slots[index]) : next;
        },
      ];
    },
    useMemo: (calculate) => calculate(),
    useEffect() {},
  });
  const props = {
    ...tableProps,
    activity: {
      ...activity,
      accounts: bankAccounts,
      transactions: [
        {
          ...transactions[0],
          id: 101,
          accountId: 12,
          accountName: "Savings",
          merchant: "Annual reserve interest",
        },
        {
          ...transactions[0],
          id: 102,
          accountId: 13,
          accountName: "Savings",
          merchant: "Payday savings interest",
        },
      ],
    },
  };
  const renderTree = () => {
    cursor = 0;
    return components.TransactionsPanel(props);
  };
  let tree = renderTree();
  const accountSelect = findElement(
    tree,
    (node) =>
      node.type === "label" &&
      node.props.children?.[0]?.props?.children === "Account filter",
  ).props.children[1];
  accountSelect.props.onChange({ target: { value: "12" } });
  let html = renderToStaticMarkup(renderTree());
  assert.match(html, /Annual reserve interest/);
  assert.doesNotMatch(html, /Payday savings interest/);
  assert.match(html, /Savings · ••2345/);
  tree = renderTree();
  findElement(
    tree,
    (node) => node.type === "select" && node.props.value === "12",
  ).props.onChange({ target: { value: "13" } });
  html = renderToStaticMarkup(renderTree());
  assert.match(html, /Payday savings interest/);
  assert.doesNotMatch(html, /Annual reserve interest/);
  assert.match(html, /Savings · ••3456/);
});

function accountRenameHarness(props = {}) {
  const slots = [];
  let cursor = 0;
  const saved = [];
  const components = loadComponents({ ...require("react"), useState(initial) {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
  } });
  const currentProps = { account, onSave: (details) => saved.push(details), onCancel() {}, ...props };
  const render = () => { cursor = 0; return components.AccountRenameForm(currentProps); };
  return { render, saved, props: currentProps,
    set(value) { findElement(render(), (node) => node.type === "input").props.onChange({ target: { value } }); },
    submit() { return findElement(render(), (node) => node.type === "form").props.onSubmit({ preventDefault() {} }); },
  };
}

test("account renaming validates a name and submits no balances or other account details", () => {
  const linked = { ...bankAccounts[0], name: "Bank checking", nativeCurrentBalance: 1500 };
  const before = structuredClone(linked);
  const harness = accountRenameHarness({ account: linked });
  assert.match(renderToStaticMarkup(harness.render()), /bank refreshes/);
  for (const invalid of ["", " ", "a".repeat(81)]) {
    harness.set(invalid);
    harness.submit();
    assert.equal(harness.saved.length, 0);
    assert.ok(findElement(harness.render(), (node) => node.props?.role === "alert"));
  }
  harness.set("  Daily   spending  ");
  harness.props.account = { ...linked, nativeCurrentBalance: 2500 };
  harness.submit();
  assert.deepEqual(harness.saved, [{ name: "Daily spending" }]);
  assert.deepEqual(linked, before);
  assert.equal(findElement(harness.render(), (node) => node.props?.name === "currentBalance"), null);
});

test("account renaming is available to manual and linked accounts and saves then refreshes once", async () => {
  for (const flags of [{}, { isLinked: true, provider: "plaid", connectionId: 4 },
    { isLinked: true, provider: "brankas", connectionId: 5 }]) {
    const notices = [];
    const current = { ...account, ...flags };
    const before = structuredClone(current);
    const harness = bankHarness({ props: { activity: { ...bankActivity, accounts: [current] },
      onNotice: (notice) => notices.push(notice) } });
    const rename = actionButton(harness.render(), "Rename");
    assert.equal(rename.props["aria-expanded"], false);
    rename.props.onClick();
    assert.equal(actionButton(harness.render(), "Rename").props["aria-expanded"], true);
    const editor = findElement(harness.render(), (node) => node.type?.name === "AccountRenameForm");
    assert.equal(editor.props.account, current);
    await editor.props.onSave({ name: "Daily spending", currentBalance: 999, currency: "EUR" });
    assert.deepEqual(harness.actions, [{ action: "renameAccount", data: { id: current.id, name: "Daily spending" } }]);
    assert.equal(harness.refreshes(), 1);
    assert.deepEqual(notices, ["Account renamed to Daily spending."]);
    assert.equal(findElement(harness.render(), (node) => node.type?.name === "AccountRenameForm"), null);
    assert.deepEqual(current, before);
  }
});

test("failed renames keep the form open, while cancel and disabled accounts cannot save", async () => {
  const errors = [];
  const harness = bankHarness({ result() { throw new Error("Name was not saved."); },
    props: { activity: { ...bankActivity, accounts: [account] }, onError: (error) => errors.push(error) } });
  actionButton(harness.render(), "Rename").props.onClick();
  let editor = findElement(harness.render(), (node) => node.type?.name === "AccountRenameForm");
  await editor.props.onSave({ name: "Wallet" });
  assert.deepEqual(errors, ["Name was not saved."]);
  assert.equal(harness.refreshes(), 0);
  editor = findElement(harness.render(), (node) => node.type?.name === "AccountRenameForm");
  assert.ok(editor);
  editor.props.onCancel();
  assert.equal(findElement(harness.render(), (node) => node.type?.name === "AccountRenameForm"), null);
  assert.equal(harness.actions.length, 1);
  for (const props of [{ disabled: true }, { saving: true }, { account: { ...account, isArchived: true } }]) {
    const blocked = accountRenameHarness(props);
    blocked.set("New name");
    blocked.submit();
    assert.equal(blocked.saved.length, 0);
  }
  for (const flags of [{ isArchived: true }, { isSyncExcluded: true }, { mergedIntoAccountId: 2 }]) {
    const blocked = bankHarness({ props: { activity: { ...bankActivity, accounts: [{ ...account, ...flags }] } } });
    assert.equal(actionButton(blocked.render(), "Rename"), null);
  }
});

function manualAccountEditHarness(props = {}) {
  const slots = [];
  let cursor = 0;
  const saved = [];
  let cancelled = 0;
  const components = loadComponents({
    ...require("react"),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (next) => {
        slots[index] = typeof next === "function" ? next(slots[index]) : next;
      }];
    },
  });
  const currentProps = {
    account: { ...account, name: "PHP savings", type: "savings", nativeCurrentBalance: 1234.56 },
    onSave: (details) => saved.push(details),
    onCancel: () => cancelled++,
    ...props,
  };
  const harness = {
    saved,
    cancelled: () => cancelled,
    props: currentProps,
    render() {
      cursor = 0;
      return components.ManualAccountEditForm(currentProps);
    },
    field(name) {
      return findElement(harness.render(), (node) => node.props?.name === name);
    },
    set(name, value) {
      harness.field(name).props.onChange({ target: { value } });
    },
    submit() {
      return findElement(harness.render(), (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
    },
  };
  return harness;
}

test("manual account editing starts from the native current balance and preserves decimal drafts until saved", () => {
  const manual = { ...account, name: "PHP savings", type: "savings", nativeCurrentBalance: 1234.56 };
  const before = structuredClone(manual);
  const harness = manualAccountEditHarness({ account: manual });
  assert.match(renderToStaticMarkup(harness.render()), /Saving a correction adjusts the starting balance and keeps your transaction history/);
  assert.equal(harness.field("name").props.value, "PHP savings");
  assert.equal(Number(harness.field("currentBalance").props.value), 1234.56);
  assert.match(renderToStaticMarkup(harness.render()), /PHP/);
  assert.equal(findElement(harness.render(), (node) => node.type === "select" && node.props.name === "currency"), null);
  harness.set("name", "  RCBC savings  ");
  harness.set("currentBalance", "2500.");
  harness.props.account = { ...manual, nativeCurrentBalance: 9999 };
  assert.equal(harness.field("currentBalance").props.value, "2500.");
  harness.set("currentBalance", "2500.50");
  assert.equal(harness.saved.length, 0);
  harness.submit();
  assert.deepEqual(harness.saved, [{ name: "RCBC savings", type: "savings", currentBalance: 2500.5 }]);
  assert.deepEqual(manual, before);
});

test("manual account balance editing allows zero, overdrafts and card credits without changing statement details", () => {
  const card = { ...account, name: "PHP card", type: "credit", nativeCurrentBalance: 14930.79,
    creditCardDue: { statementBalance: 4000, dueDate: "2026-11-25" }, creditCardAutopayEnabled: true };
  const before = structuredClone(card);
  const harness = manualAccountEditHarness({ account: card });
  for (const value of ["0", "-53.27", "16000.01"]) {
    harness.set("currentBalance", value);
    harness.submit();
  }
  assert.deepEqual(harness.saved, [0, -53.27, 16000.01].map((currentBalance) => ({
    name: "PHP card", type: "credit", currentBalance,
  })));
  assert.deepEqual(card, before);
});

test("manual account edits reject blank or imprecise balances and invalid account details", () => {
  const harness = manualAccountEditHarness();
  for (const value of ["", " ", "0.001", "1000000000", "-1000000000", "Infinity", "NaN"]) {
    harness.set("currentBalance", value);
    harness.submit();
    assert.equal(harness.saved.length, 0, `invalid balance: ${value}`);
    assert.ok(findElement(harness.render(), (node) => node.props?.role === "alert"));
  }
  harness.set("currentBalance", "0");
  for (const value of ["", " ", "a".repeat(81)]) {
    harness.set("name", value);
    harness.submit();
    assert.equal(harness.saved.length, 0, `invalid name: ${value}`);
  }
  harness.set("name", "PHP savings");
  harness.set("type", "invalid");
  harness.submit();
  assert.equal(harness.saved.length, 0);
  harness.set("type", "checking");
  harness.submit();
  assert.deepEqual(harness.saved, [{ name: "PHP savings", type: "checking", currentBalance: 0 }]);
});

test("cancel and disabled manual account editors cannot save changes", () => {
  const harness = manualAccountEditHarness();
  harness.set("currentBalance", "999");
  actionButton(harness.render(), "Cancel").props.onClick();
  assert.equal(harness.cancelled(), 1);
  assert.equal(harness.saved.length, 0);
  for (const props of [{ disabled: true }, { saving: true }]) {
    const blocked = manualAccountEditHarness(props);
    assert.equal(findElement(blocked.render(), (node) => node.type === "fieldset").props.disabled, true);
    blocked.submit();
    assert.equal(blocked.saved.length, 0);
  }
});

test("only active manual accounts and cards expose account editing", () => {
  for (const type of ["checking", "savings", "cash", "credit", "other"]) {
    const harness = bankHarness({ props: { activity: { ...bankActivity, accounts: [{ ...account, type }] } } });
    assert.ok(actionButton(harness.render(), "Edit account"), type);
  }
  for (const flags of [
    { isLinked: true }, { provider: "plaid" }, { connectionId: 4 },
    { isArchived: true }, { isSyncExcluded: true }, { mergedIntoAccountId: 2 },
  ]) {
    const harness = bankHarness({ props: { activity: { ...bankActivity, accounts: [{ ...account, ...flags }] } } });
    assert.equal(actionButton(harness.render(), "Edit account"), null, JSON.stringify(flags));
  }
});

test("manual account edits save the entered current balance once and refresh the workspace", async () => {
  const notices = [];
  const manual = { ...account, name: "PHP savings", type: "savings" };
  const before = structuredClone(manual);
  const harness = bankHarness({ props: { activity: { ...bankActivity, accounts: [manual] },
    onNotice: (message) => notices.push(message) } });
  assert.equal(findElement(harness.render(), (node) => node.type?.name === "ManualAccountEditForm"), null);
  actionButton(harness.render(), "Edit account").props.onClick();
  const editor = findElement(harness.render(), (node) => node.type?.name === "ManualAccountEditForm");
  assert.equal(editor.props.account, manual);
  assert.equal(editor.props.disabled, false);
  await editor.props.onSave({ name: "RCBC savings", type: "savings", currentBalance: 2500.5 });
  assert.deepEqual(harness.actions, [{ action: "updateAccount", data: {
    id: manual.id, name: "RCBC savings", type: "savings", currentBalance: 2500.5,
  } }]);
  assert.equal(harness.refreshes(), 1);
  assert.equal(notices.length, 1);
  assert.equal(findElement(harness.render(), (node) => node.type?.name === "ManualAccountEditForm"), null);
  assert.deepEqual(manual, before);
});

test("failed manual account edits retain the editor for retry and cancel sends no update", async () => {
  const errors = [];
  const notices = [];
  const harness = bankHarness({ result() { throw new Error("Account could not be saved."); },
    props: { activity: { ...bankActivity, accounts: [account] },
      onError: (message) => errors.push(message), onNotice: (message) => notices.push(message) } });
  actionButton(harness.render(), "Edit account").props.onClick();
  let editor = findElement(harness.render(), (node) => node.type?.name === "ManualAccountEditForm");
  await editor.props.onSave({ name: "Wallet", type: "cash", currentBalance: 0 });
  assert.deepEqual(errors, ["Account could not be saved."]);
  assert.deepEqual(notices, []);
  assert.equal(harness.refreshes(), 0);
  editor = findElement(harness.render(), (node) => node.type?.name === "ManualAccountEditForm");
  assert.ok(editor);
  editor.props.onCancel();
  assert.equal(findElement(harness.render(), (node) => node.type?.name === "ManualAccountEditForm"), null);
  assert.equal(harness.actions.length, 1);
});

test("manual PHP accounts preserve their native opening balance and refresh available assignments", async () => {
  const harness = bankHarness();
  actionButton(harness.render(), "Add manual account").props.onClick();
  let tree = harness.render();
  assert.match(renderToStaticMarkup(tree), /Starting balance/);
  assert.match(renderToStaticMarkup(tree), /Live planner updates it through today/);
  assert.match(
    renderToStaticMarkup(tree),
    /does not open a bank account or connect to a bank/,
  );
  findElement(
    tree,
    (node) =>
      node.type === "input" &&
      node.props.placeholder === "e.g. PHP cash, RCBC checking",
  ).props.onChange({ target: { value: "  PHP savings  " } });
  tree = harness.render();
  findElement(
    tree,
    (node) => node.type === "select" && node.props.value === "cash",
  ).props.onChange({ target: { value: "savings" } });
  tree = harness.render();
  findElement(
    tree,
    (node) => node.type === "select" && node.props.value === "USD",
  ).props.onChange({ target: { value: "PHP" } });
  tree = harness.render();
  findElement(
    tree,
    (node) =>
      node.type === numberModule.exports.default &&
      node.props.min === "-999999999",
  ).props.onChange({ target: { value: "1234.56" } });
  tree = harness.render();
  assert.match(renderToStaticMarkup(tree), /Starting balance · PHP/);
  await findElement(
    tree,
    (node) =>
      node.type === "form" &&
      node.props.className.includes("fa-manual-account-form"),
  ).props.onSubmit({ preventDefault() {} });
  assert.deepEqual(harness.actions, [
    {
      action: "createAccount",
      data: {
        name: "PHP savings",
        type: "savings",
        currency: "PHP",
        openingBalance: 1234.56,
        color: "#548564",
      },
    },
  ]);
  assert.equal(harness.refreshes(), 1);
  assert.doesNotMatch(
    renderToStaticMarkup(harness.render()),
    /Add a manually tracked account/,
  );
});

test("manual account validation prevents invalid balances without sending an action", async () => {
  const harness = bankHarness();
  actionButton(harness.render(), "Add manual account").props.onClick();
  let tree = harness.render();
  findElement(
    tree,
    (node) =>
      node.type === "input" &&
      node.props.placeholder === "e.g. PHP cash, RCBC checking",
  ).props.onChange({ target: { value: "Wallet" } });
  tree = harness.render();
  findElement(
    tree,
    (node) =>
      node.type === numberModule.exports.default &&
      node.props.min === "-999999999",
  ).props.onChange({ target: { value: "0.001" } });
  tree = harness.render();
  await findElement(
    tree,
    (node) =>
      node.type === "form" &&
      node.props.className.includes("fa-manual-account-form"),
  ).props.onSubmit({ preventDefault() {} });
  assert.equal(harness.actions.length, 0);
  assert.match(
    renderToStaticMarkup(harness.render()),
    /valid opening balance below one billion with up to two decimal places/,
  );
  actionButton(harness.render(), "Cancel").props.onClick();
  assert.equal(harness.actions.length, 0);
});

test("one-time transaction edits retain decimal text across refreshes and save once explicitly", () => {
  const slots = [];
  let cursor = 0;
  const saved = [];
  const components = loadComponents({
    ...require("react"),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots))
        slots[index] = typeof initial === "function" ? initial() : initial;
      return [
        slots[index],
        (next) => {
          slots[index] = typeof next === "function" ? next(slots[index]) : next;
        },
      ];
    },
  });
  const renderForm = () => {
    cursor = 0;
    return components.QuickTransactionForm({
      transaction: {
        id: 100,
        date: "2026-11-02",
        amount: 50,
        merchant: "Groceries",
        currency: "USD",
        kind: "expense",
      },
      accounts: [],
      categories: [...activity.categories],
      rate: 63,
      onSave: (value) => saved.push(value),
    });
  };
  const amountField = (tree) =>
    findElement(
      tree,
      (node) =>
        node.type === numberModule.exports.default &&
        node.props["aria-label"] === "Transaction amount",
    );
  let form = renderForm();
  for (const raw of ["", "0.", "12.30"]) {
    amountField(form).props.onChange({ target: { value: raw } });
    form = renderForm();
    assert.equal(amountField(form).props.value, raw);
    assert.equal(saved.length, 0);
  }
  const saveButton = findElement(form, (node) => node.props.type === "submit");
  assert.equal(saveButton.props.children, "Save transaction");
  form.props.onSubmit({ preventDefault() {} });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].amount, 12.3);
  amountField(form).props.onChange({ target: { value: "12.345" } });
  form = renderForm();
  form.props.onSubmit({ preventDefault() {} });
  assert.equal(saved.length, 1);
  assert.match(renderToStaticMarkup(renderForm()), /up to two decimal places/);
});
