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
      if (specifier === "./FinanceAccountSelect") return selectModule.exports;
      if (specifier === "./FinanceNumberInput") return numberModule.exports;
      return require(specifier);
    },
    componentModule,
    componentModule.exports,
  );
  return componentModule.exports;
}
const { QuickTransactionForm, TransactionsPanel, BankAccountsPanel } =
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
  assert.match(html, /automatically in Budget Plans for the due date/);
  assert.doesNotMatch(html, /\$25\.00/);
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
  assert.match(missingDetails, /Statement balance<\/dt><dd>Unavailable/);
  assert.match(missingDetails, /Payment due<\/dt><dd>Unavailable/);
  assert.doesNotMatch(missingDetails, /\$990\.00|\$0\.00/);
  assert.match(missing, /has not supplied complete statement details/);
  const stale = renderCard({
    creditCardDueStatus: "stale",
    creditCardDue: { statementBalance: 0, dueDate: "2026-11-20" },
  });
  assert.match(stale, /Statement balance[\s\S]*\$0\.00/);
  assert.match(stale, /Last known statement details/);
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

test("manual PHP accounts preserve their native opening balance and refresh available assignments", async () => {
  const harness = bankHarness();
  actionButton(harness.render(), "Add manual account").props.onClick();
  let tree = harness.render();
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
  assert.match(renderToStaticMarkup(tree), /Opening balance · PHP/);
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
