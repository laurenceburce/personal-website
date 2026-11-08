import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAccountPlan,
  getFinanceAccountAllocations,
} from "../app/lib/financeAccountPlan.mjs";
import { buildPlanRows } from "../app/lib/financePlanner.mjs";

const accounts = [
  {
    id: 1,
    name: "Checking",
    mask: "1001",
    type: "checking",
    currency: "USD",
    nativeCurrentBalance: 750,
  },
  {
    id: 2,
    name: "Annual savings",
    mask: "1002",
    type: "savings",
    currency: "USD",
    nativeCurrentBalance: 100,
  },
  {
    id: 3,
    name: "Payday savings",
    mask: "1003",
    type: "savings",
    currency: "USD",
    nativeCurrentBalance: 0,
  },
  {
    id: 4,
    name: "Credit",
    type: "credit",
    currency: "USD",
    nativeCurrentBalance: 0,
  },
  {
    id: 5,
    name: "PHP account",
    type: "checking",
    currency: "PHP",
    nativeCurrentBalance: 10000,
  },
];

for (const liveOpening of [false, true]) {
  test(`electronic salary deposits count once with ${liveOpening ? "live" : "dated"} account openings`, () => {
    const depositAccounts = [
      { id: 1, name: "Checking", type: "checking", currency: "USD", nativeCurrentBalance: 1130.39 },
    ];
    const depositDocument = {
      salary: { amount: 2300, currency: "USD", payFrequency: "biweekly", firstPayDate: "2026-10-23", accountId: 1 },
      bills: [],
      allocations: [],
    };
    const depositPlan = {
      startDate: "2026-11-05", endDate: "2026-11-07",
      openingUsd: liveOpening ? 0 : 160.72, openingPhp: 0,
      includeIncome: true, includeTransactions: true, includeAnnualReserve: false, includeAllocations: false,
      entries: [],
      accountOpeningBalances: liveOpening ? [] : [{ accountId: 1, balance: 160.72 }],
      startingAccounts: liveOpening ? [{ accountId: 1, percentage: 100 }] : [],
      rowOverrides: [{ rowId: "salary:2026-11-06", date: "2026-11-06", description: "Salary", amount: 969.67 }],
    };
    const transactions = [
      { id: 2534, date: "2026-11-06", kind: "income", amount: 969.67, currency: "USD", accountId: 1,
        merchant: "Electronic Deposit 11/06 Maxx Potential", category: "Income" },
    ];
    const before = JSON.stringify({ depositPlan, depositDocument, depositAccounts, transactions });
    const options = { accounts: depositAccounts, transactions, today: "2026-11-06" };
    const rows = buildPlanRows(depositPlan, depositDocument, 63, options);
    const projection = buildAccountPlan(depositPlan, depositDocument, 63, { ...options, rows });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "transaction");
    assert.equal(rows[0].transactionId, 2534);
    assert.equal(rows[0].scheduledSource, "salary");
    assert.equal(rows[0].completionKey, "salary:2026-11-06");
    assert.equal(rows[0].completed, true);
    assert.equal(rows[0].completionSource, "transaction");
    assert.equal(rows[0].balanceUsd, 1130.39);
    assert.equal(rows[0].balanceAppliedUsd, liveOpening ? 0 : 969.67);
    assert.equal(projection.accounts[0].endingBalance, 1130.39);
    assert.equal(projection.rows[0].accountMovements.length, liveOpening ? 0 : 1);
    assert.equal(before, JSON.stringify({ depositPlan, depositDocument, depositAccounts, transactions }));
  });
}

test("recurring transfers preserve native assets and posted legs replace only one occurrence", () => {
  const transferAccounts = [
    { id: 1, name: "Checking", type: "checking", currency: "USD", nativeCurrentBalance: 1000 },
    { id: 2, name: "Other account", type: "checking", currency: "USD", nativeCurrentBalance: 0 },
  ];
  const transferPlan = {
    startDate: "2026-11-01", endDate: "2026-11-03", openingUsd: 1000, openingPhp: 0,
    accountOpeningBalances: [{ accountId: 1, balance: 1000 }, { accountId: 2, balance: 0 }],
    includeIncome: false, includeAnnualReserve: false, includeAllocations: false,
    entries: [{ id: "daily-transfer", date: "2026-11-01", kind: "transfer", description: "Move funds", amount: 25, currency: "USD",
      recurrence: "daily", repeatUntil: null, fromAccountId: 1, toAccountId: 2 }],
  };
  const records = [
    { id: 1, date: "2026-11-01", kind: "expense", amount: 25, currency: "USD", accountId: 1, category: "Transfer Out" },
    { id: 2, date: "2026-11-01", kind: "income", amount: 25, currency: "USD", accountId: 2, category: "Transfer In" },
  ];
  const document = { salary: {}, bills: [], allocations: [] };
  const rows = buildPlanRows(transferPlan, document, 63, { accounts: transferAccounts, transactions: records, today: "2026-11-01" });
  const projection = buildAccountPlan(transferPlan, document, 63, { accounts: transferAccounts, rows, today: "2026-11-01" });
  assert.equal(projection.accounts.find((account) => account.accountId === 1).endingBalance, 925);
  assert.equal(projection.accounts.find((account) => account.accountId === 2).endingBalance, 75);
  assert.equal(rows.at(-1).balanceUsd, 1000);
  assert.equal(rows.filter((row) => row.source === "manual" && row.completed).length, 1);
  assert.equal(projection.rows.filter((row) => row.source === "manual" && row.accountMovements.length === 0).length, 1);
});

test("recurring currency conversions and a single amount override project exact native balances", () => {
  const conversionAccounts = [
    { id: 1, name: "USD", type: "checking", currency: "USD", nativeCurrentBalance: 1000 },
    { id: 2, name: "PHP", type: "checking", currency: "PHP", nativeCurrentBalance: 0 },
  ];
  const conversionPlan = {
    startDate: "2026-11-01", endDate: "2026-11-03", openingUsd: 1000, openingPhp: 0,
    accountOpeningBalances: [{ accountId: 1, balance: 1000 }, { accountId: 2, balance: 0 }],
    includeIncome: false, includeAnnualReserve: false, includeAllocations: false,
    entries: [{ id: "convert", date: "2026-11-01", kind: "conversion", description: "Convert funds", amount: 10, currency: "USD",
      recurrence: "daily", fromAccountId: 1, toAccountId: 2 }],
    rowOverrides: [{ rowId: "entry:convert:2026-11-02", date: "2026-11-02", description: "Convert extra", amount: 20 }],
  };
  const projection = buildAccountPlan(conversionPlan, { salary: {}, bills: [], allocations: [] }, 63,
    { accounts: conversionAccounts, today: "2026-11-01" });
  assert.equal(projection.accounts.find((account) => account.accountId === 1).endingBalance, 960);
  assert.equal(projection.accounts.find((account) => account.accountId === 2).endingBalance, 2520);
  assert.equal(projection.rows.at(-1).balanceUsd, 960);
  assert.equal(projection.rows.at(-1).balancePhp, 2520);
});
const salary = {
  amount: 2000,
  currency: "USD",
  payFrequency: "semimonthly",
  firstPayDate: "2026-11-06",
  accountId: 1,
};
const document = {
  salary,
  bills: [
    {
      id: "venture",
      name: "Venture X",
      cadence: "annual",
      amount: 395,
      currency: "USD",
      dueDay: 28,
      dueMonths: [11],
      savedAmount: 100,
      accountId: 4,
      reserveAccountId: 2,
    },
    {
      id: "monthly",
      name: "Monthly subscription",
      cadence: "monthly",
      amount: 20,
      currency: "USD",
      dueDay: 18,
      dueMonths: [],
      accountId: 4,
    },
  ],
  allocations: [
    {
      id: "save",
      name: "Savings",
      kind: "savings",
      amount: 500,
      currency: "USD",
      accountId: 3,
    },
  ],
};
const plan = {
  startDate: "2026-11-01",
  endDate: "2026-11-30",
  openingUsd: 750,
  openingPhp: 0,
  openingReserveUsd: 0,
  openingReservePhp: 0,
  includeIncome: true,
  includeTransactions: true,
  includeAllocations: true,
  includeAnnualReserve: true,
  entries: [],
  accountOpeningBalances: accounts.map((a) => ({
    accountId: a.id,
    balance: a.nativeCurrentBalance,
  })),
};
const project = (planner = plan, doc = document, extra = {}) =>
  buildAccountPlan(planner, doc, 63, {
    accounts,
    today: "2026-11-02",
    ...extra,
  });
const byId = (result, accountId) =>
  result.accounts.find((account) => account.accountId === accountId);

function linkedPocketFixture(dated = false) {
  const bank = [
    { id: 1, name: "Checking", type: "checking", currency: "USD", nativeCurrentBalance: 854.23 },
    { id: 2, name: "Savings", type: "savings", currency: "USD", nativeCurrentBalance: 526.59 },
    { id: 28, name: "Smartly Savings", type: "savings", currency: "USD", nativeCurrentBalance: 500 },
  ];
  const doc = {
    salary: { amount: 2300, currency: "USD", payFrequency: "biweekly", firstPayDate: "2026-10-23", accountId: 1 },
    bills: [{ id: "annual", name: "Annual bill", cadence: "annual", amount: 1000, currency: "USD", dueDay: 31,
      dueMonths: [12], savedAmount: 503.70, reserveAccountId: 2, sourceAccountId: 2 }],
    allocations: [{ id: "save", name: "Savings", kind: "savings", amount: 253.27, currency: "USD", accountId: 28, sourceAccountId: 2 }],
  };
  const planner = {
    startDate: "2026-11-05", endDate: "2026-11-07", openingUsd: 0, openingPhp: 0,
    includeIncome: true, includeTransactions: true, includeAnnualReserve: true, includeAllocations: true, entries: [],
    accountLinks: { availableUsdAccountId: 1, annualReserveUsdAccountId: 2, savingsUsdAccountId: 28 },
    startingAccounts: [{ accountId: 1, percentage: 0 }],
    accountOpeningBalances: dated ? [{ accountId: 1, balance: 160.72 }, { accountId: 2, balance: 503.70 }, { accountId: 28, balance: 246.73 }] : [],
    rowOverrides: [
      { rowId: "salary:2026-11-06", date: "2026-11-06", description: "Salary", amount: 969.67 },
      { rowId: "reserve:USD:2026-11-06", date: "2026-11-06", description: "Set aside for annual bills", amount: 22.89 },
    ],
  };
  const records = [
    { id: 2534, accountId: 1, date: "2026-11-06", kind: "income", amount: 969.67, currency: "USD", merchant: "Electronic Deposit 11/06 Maxx Potential", category: "Income" },
    { id: 2533, accountId: 1, date: "2026-11-06", kind: "expense", amount: 22.89, currency: "USD", category: "Transfer Out" },
    { id: 2535, accountId: 2, date: "2026-11-06", kind: "income", amount: 22.89, currency: "USD", category: "Transfer In" },
    { id: 2532, accountId: 1, date: "2026-11-06", kind: "expense", amount: 253.27, currency: "USD", category: "Transfer Out" },
    { id: 2536, accountId: 28, date: "2026-11-06", kind: "income", amount: 253.27, currency: "USD", category: "Transfer In" },
  ];
  return { bank, doc, planner, records };
}

for (const dated of [false, true]) for (const includeTransactions of [false, true]) {
  test(`linked columns follow their own native accounts with ${dated ? "dated" : "live"} openings and ${includeTransactions ? "visible" : "hidden"} reconciled bank transfers`, () => {
    const { bank, doc, planner, records } = linkedPocketFixture(dated);
    planner.includeTransactions = includeTransactions;
    const before = JSON.stringify({ bank, doc, planner, records });
    const result = buildAccountPlan(planner, doc, 63, { accounts: bank, transactions: records, today: "2026-11-06" });
    assert.deepEqual(result.openingBalances, { usd: dated ? 160.72 : 854.23, php: 0 });
    assert.equal(result.openingReserve.usd, dated ? 503.70 : 526.59);
    assert.equal(result.openingSavings.usd, dated ? 246.73 : 500);
    assert.equal(result.rows.length, 3, "each paycheck or matched transfer has one logical row");
    assert.equal(result.rows.at(-1).balanceUsd, 854.23);
    assert.equal(result.rows.at(-1).reserveUsd, 526.59);
    assert.equal(result.rows.at(-1).savingsUsd, 500);
    const reserve = result.rows.find((row) => row.source === "reserve");
    const savings = result.rows.find((row) => row.source === "allocation");
    assert.equal(reserve.balanceAppliedUsd, dated ? -22.89 : 0);
    assert.equal(reserve.reserveDeltaUsd, dated ? 22.89 : 0);
    assert.equal(savings.balanceAppliedUsd, dated ? -253.27 : 0);
    assert.ok(result.rows.every((row) => row.completed));
    assert.ok(result.rows.every((row) => row.balanceUsd <= 1130.39), "savings receipts cannot inflate checking");
    assert.equal(byId(result, 1).endingBalance, 854.23);
    assert.equal(byId(result, 2).endingBalance, 526.59);
    assert.equal(byId(result, 28).endingBalance, 500);
    assert.equal(before, JSON.stringify({ bank, doc, planner, records }));
  });
}

test("linked savings and reserve columns use full selected bank balances rather than other earmarks or allocations", () => {
  const { bank, doc, planner } = linkedPocketFixture();
  doc.allocations.push({ id: "another", name: "Other savings", kind: "savings", amount: 1, currency: "USD", accountId: 29 });
  bank.push({ id: 29, name: "Other savings", currency: "USD", type: "savings", nativeCurrentBalance: 900 });
  const result = buildAccountPlan({ ...planner, endDate: "2026-11-05" }, doc, 63, { accounts: bank, today: "2026-11-06" });
  assert.equal(result.openingReserve.usd, 526.59);
  assert.equal(result.openingReserve.billSavingsUsd, 503.70);
  assert.equal(result.openingSavings.usd, 500);
  assert.deepEqual(result.openingSavings.accountIds, [28]);
});

test("unavailable linked columns stay unknown instead of falling back to cash or another bank account", () => {
  const { bank, doc, planner } = linkedPocketFixture();
  bank[0].nativeCurrentBalance = null;
  bank[1].isArchived = true;
  const result = buildAccountPlan({ ...planner, openingUsd: 10000,
    accountLinks: { ...planner.accountLinks, savingsUsdAccountId: 99 } }, doc, 63,
  { accounts: bank, today: "2026-11-05" });
  assert.equal(result.openingBalances.usd, null);
  assert.equal(result.openingReserve.usd, null);
  assert.equal(result.openingSavings.usd, null);
  assert.equal(result.rows.at(-1).balanceUsd, null);
  assert.equal(result.rows.at(-1).reserveUsd, null);
  assert.equal(result.rows.at(-1).savingsUsd, null);
  assert.ok(result.warnings.some((warning) => warning.includes("balance is unavailable")));
  assert.ok(result.warnings.some((warning) => warning.includes("Annual reserves")));
  assert.ok(result.warnings.some((warning) => warning.includes("Savings")));
});

test("unselected columns in an explicit linked plan do not inherit unrelated manual cash or bank savings", () => {
  const { bank, doc, planner } = linkedPocketFixture();
  const result = buildAccountPlan({ ...planner, openingUsd: 5000, openingPhp: 7000,
    accountLinks: { annualReserveUsdAccountId: 2 }, endDate: "2026-11-05" }, doc, 63,
  { accounts: bank, today: "2026-11-06" });
  assert.deepEqual(result.openingBalances, { usd: 0, php: 0 });
  assert.equal(result.openingReserve.usd, 526.59);
  assert.equal(result.openingReserve.php, 0);
  assert.equal(result.openingSavings.usd, 0);
  assert.equal(result.openingSavings.php, 0);
  assert.deepEqual(result.openingSavings.accountIds, []);
});

test("automatic card dues use the linked checking funding account once and preserve both savings columns", () => {
  const { bank, doc, planner } = linkedPocketFixture();
  bank.push({ id: 3, name: "Card", type: "credit", currency: "USD", nativeCurrentBalance: 200,
    creditCardDue: { statementBalance: 200, dueDate: "2026-11-20", lastStatementDate: "2026-10-20" } });
  const result = buildAccountPlan({ ...planner, endDate: "2026-11-30", includeIncome: false,
    includeAnnualReserve: false, includeAllocations: false }, doc, 63, { accounts: bank, today: "2026-11-06" });
  assert.equal(result.rows.length, 1);
  const due = result.rows[0];
  assert.equal(due.source, "creditCardDue");
  assert.equal(due.fundingAccountId, 1);
  assert.equal(due.balanceUsd, 654.23);
  assert.equal(due.balanceAppliedUsd, -200);
  assert.equal(due.reserveUsd, 526.59);
  assert.equal(due.savingsUsd, 500);
  assert.equal(byId(result, 3).endingBalance, 0);
  assert.equal(byId(result, 1).endingBalance, 654.23);
  assert.ok(!result.warnings.some((warning) => warning.includes("funding account is unknown")));
});

test("accountless future entries and conversions use linked available accounts while explicit assignments keep their own account", () => {
  const { bank, doc, planner } = linkedPocketFixture();
  bank.push({ id: 34, name: "RCBC", type: "checking", currency: "PHP", nativeCurrentBalance: 0 });
  const result = buildAccountPlan({ ...planner, includeIncome: false, includeAnnualReserve: false, includeAllocations: false,
    accountLinks: { ...planner.accountLinks, availablePhpAccountId: 34 }, entries: [
      { id: "fee", date: "2026-11-07", description: "Fee", kind: "expense", amount: 10, currency: "USD" },
      { id: "refund", date: "2026-11-07", description: "Refund", kind: "income", amount: 20, currency: "USD" },
      { id: "convert", date: "2026-11-07", description: "Convert", kind: "conversion", amount: 50, currency: "USD" },
      { id: "reserve-fee", date: "2026-11-07", description: "Reserve fee", kind: "expense", amount: 5, currency: "USD", accountId: 2 },
    ] }, doc, 63, { accounts: bank, today: "2026-11-06" });
  assert.equal(result.rows.at(-1).balanceUsd, 814.23);
  assert.equal(result.rows.at(-1).balancePhp, 3150);
  assert.equal(result.rows.at(-1).reserveUsd, 521.59);
  assert.equal(result.rows.at(-1).savingsUsd, 500);
  assert.equal(byId(result, 1).endingBalance, 814.23);
  assert.equal(byId(result, 34).endingBalance, 3150);
  assert.ok(!result.warnings.some((warning) => warning.includes("no account assigned")));
});

test("a grouped unplanned bank transfer moves the linked source and destination once", () => {
  const { bank, doc, planner, records } = linkedPocketFixture(true);
  const result = buildAccountPlan({ ...planner, includeIncome: false, includeAnnualReserve: false, includeAllocations: false }, doc, 63,
  { accounts: bank, transactions: records.filter((record) => [2533, 2535].includes(record.id)), today: "2026-11-06" });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].kind, "transfer");
  assert.equal(result.rows[0].accountMovements.length, 2);
  assert.equal(result.rows[0].balanceUsd, 137.83);
  assert.equal(result.rows[0].reserveUsd, 526.59);
  assert.equal(result.rows[0].savingsUsd, 246.73);
});

test("a coalesced partial transfer preserves its missing forecast leg without replaying its posted leg", () => {
  for (const dated of [false, true]) {
    const { bank, doc, planner } = linkedPocketFixture(dated);
    const result = buildAccountPlan({ ...planner, includeIncome: false, includeAnnualReserve: false, includeAllocations: false,
      entries: [{ id: "partial", date: "2026-11-07", description: "Move savings", kind: "transfer", amount: 50, currency: "USD", fromAccountId: 1, toAccountId: 28 }] }, doc, 63,
    { accounts: bank, today: "2026-11-06", transactions: [
      { id: 99, date: "2026-11-06", accountId: 1, kind: "expense", currency: "USD", amount: 50, category: "Transfer Out" },
    ] });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].completed, false);
    assert.equal(result.rows[0].recordedTransactions.length, 1);
    assert.equal(result.rows[0].balanceUsd, dated ? 110.72 : 854.23);
    assert.equal(result.rows[0].savingsUsd, dated ? 296.73 : 550);
    assert.equal(result.rows[0].accountMovements.length, dated ? 2 : 1);
  }
});

test("running savings starts with the linked bank balance and only a single edited payday changes", () => {
  const currentAccounts = structuredClone(accounts);
  currentAccounts.find((account) => account.id === 3).nativeCurrentBalance = 246.73;
  const doc = { ...document, bills: [], salary: { ...salary, payFrequency: "biweekly" } };
  const current = { ...plan, accountOpeningBalances: [], includeIncome: false, includeAnnualReserve: false,
    rowOverrides: [{ rowId: "allocation:save:2026-11-06", date: "2026-11-07", description: "One-off savings", amount: 275 }] };
  const projection = project(current, doc, { accounts: currentAccounts });
  assert.equal(projection.openingSavings.usd, 246.73);
  assert.equal(projection.openingSavings.php, 0);
  assert.deepEqual(projection.openingSavings.accountIds, [3]);
  assert.equal(projection.rows[0].date, "2026-11-07");
  assert.equal(projection.rows[0].savingsUsd, 521.73);
  assert.equal(projection.rows[1].amount, 500);
  assert.equal(projection.rows[1].savingsUsd, 1021.73);
  assert.equal(doc.allocations[0].amount, 500);
  currentAccounts.find((account) => account.id === 3).nativeCurrentBalance = 300;
  assert.equal(project(current, doc, { accounts: currentAccounts }).rows[0].savingsUsd, 575);
});

test("savings totals count distinct native destinations and keep annual funds separate", () => {
  const currentAccounts = structuredClone(accounts);
  currentAccounts.find((account) => account.id === 2).nativeCurrentBalance = 150;
  const doc = { salary: { ...salary, amount: 0 }, bills: document.bills.slice(0, 1), allocations: [
    { id: "one", name: "One", kind: "savings", amount: 10, currency: "USD", accountId: 2 },
    { id: "two", name: "Two", kind: "savings", amount: 20, currency: "USD", accountId: 2 },
    { id: "pesos", name: "Pesos", kind: "savings", amount: 100, currency: "PHP", accountId: 5, sourceAccountId: 5 },
  ] };
  const current = { ...plan, endDate: "2026-11-06", accountOpeningBalances: [], includeIncome: false };
  const projection = project(current, doc, { accounts: currentAccounts });
  assert.equal(projection.openingSavings.usd, 50);
  assert.equal(projection.openingSavings.php, 10000);
  assert.deepEqual(projection.openingSavings.accountIds, [2, 5]);
  assert.equal(projection.rows.find((row) => row.source === "reserve").savingsUsd, 50);
  assert.equal(projection.rows.at(-1).savingsUsd, 80);
  assert.equal(projection.rows.at(-1).savingsPhp, 10000);
});

test("unassigned savings accumulate from zero while unavailable assigned balances stay unknown", () => {
  const doc = { salary: { ...salary, amount: 0 }, bills: [], allocations: [
    { id: "unassigned", name: "Cash savings", kind: "savings", amount: 10, currency: "PHP" },
    { id: "unknown", name: "Unknown bank", kind: "savings", amount: 20, currency: "USD", accountId: 3 },
  ] };
  const currentAccounts = structuredClone(accounts);
  currentAccounts.find((account) => account.id === 3).nativeCurrentBalance = null;
  const projection = project({ ...plan, accountOpeningBalances: [], includeIncome: false, includeAnnualReserve: false }, doc, { accounts: currentAccounts });
  assert.equal(projection.openingSavings.usd, null);
  assert.equal(projection.openingSavings.php, 0);
  assert.equal(projection.rows.at(-1).savingsUsd, null);
  assert.equal(projection.rows.at(-1).savingsPhp, 20);
  assert.ok(projection.warnings.some((warning) => warning.includes("savings balance is unavailable")));
});

test("posted transfers and historical live activity do not add a savings deposit twice", () => {
  const currentAccounts = structuredClone(accounts);
  currentAccounts.find((account) => account.id === 3).nativeCurrentBalance = 500;
  const doc = { ...document, salary: { ...salary, amount: 0 }, bills: [] };
  const current = { ...plan, accountOpeningBalances: [], includeIncome: false, includeAnnualReserve: false,
    rowOverrides: [{ rowId: "allocation:save:2026-11-06", date: "2026-11-07", description: "Savings this payday", amount: 275 }] };
  const transactions = [
    { id: 101, date: "2026-11-07", accountId: 1, kind: "expense", currency: "USD", amount: 275, category: "Transfer" },
    { id: 102, date: "2026-11-07", accountId: 3, kind: "income", currency: "USD", amount: 275, category: "Transfer" },
  ];
  const projection = project(current, doc, { accounts: currentAccounts, transactions, today: "2026-11-07" });
  const first = projection.rows.find((row) => row.id === "allocation:save:2026-11-06");
  assert.equal(first.completed, true);
  assert.equal(first.savingsUsd, 500);
  assert.equal(projection.rows.at(-1).savingsUsd, 1000);
});

test("saved percentage openings retain the full native account balance after a bank refresh", () => {
  const current = { ...plan, startingAccounts: [{ accountId: 1, percentage: 80 }], includeIncome: false, includeAnnualReserve: false, includeAllocations: false };
  const doc = { salary, bills: [], allocations: [] };
  const refreshed = structuredClone(accounts);
  let result = project(current, doc, { accounts: refreshed });
  assert.equal(result.openingSource, "plan");
  assert.equal(result.openingBalances.usd, 1350);
  assert.equal(byId(result, 1).openingBalance, 750);
  assert.equal(byId(result, 1).endingBalance, 750);
  refreshed[0].nativeCurrentBalance = 1000;
  result = project(current, doc, { accounts: refreshed });
  assert.equal(result.openingBalances.usd, 1350);
  assert.equal(byId(result, 1).openingBalance, 750);
  assert.equal(byId(result, 1).endingBalance, 750);
  assert.equal(current.accountOpeningBalances[0].balance, 750);
});

for (const currency of ["USD", "PHP"]) for (const linked of [false, true]) {
  test(`saved ${currency} ${linked ? "linked column" : "percentage"} openings replay posted expenses once across bank refreshes`, () => {
    const percentage = linked ? 100 : 80;
    const planner = {
      startDate: "2026-11-01", endDate: "2026-11-30", openingUsd: 0, openingPhp: 0,
      includeIncome: false, includeTransactions: true, includeAllocations: false, includeAnnualReserve: false,
      entries: [], startingAccounts: [{ accountId: 1, percentage }],
      accountOpeningBalances: [{ accountId: 1, balance: 200 }],
      ...(linked ? { accountLinks: { [currency === "USD" ? "availableUsdAccountId" : "availablePhpAccountId"]: 1 } } : {}),
    };
    const doc = { salary: {}, bills: [], allocations: [] };
    const firstExpense = { id: 91, accountId: 1, currency, date: "2026-11-02", kind: "expense", amount: 50, merchant: "Groceries" };
    for (const currentBalance of [150, 90]) {
      const bank = [{ id: 1, name: "Checking", type: "checking", currency, nativeCurrentBalance: currentBalance }];
      const result = buildAccountPlan(planner, doc, 63, { accounts: bank, transactions: [firstExpense], today: "2026-11-08" });
      const suffix = currency === "USD" ? "Usd" : "Php";
      assert.equal(result.openingBalances[currency.toLowerCase()], percentage === 100 ? 200 : 160);
      assert.equal(result.rows[0][`balance${suffix}`], percentage === 100 ? 150 : 110);
      assert.equal(result.rows[0].accountMovements.length, 1);
      assert.equal(byId(result, 1).openingBalance, 200);
      assert.equal(byId(result, 1).endingBalance, 150);
      const later = buildAccountPlan(planner, doc, 63, { accounts: bank, today: "2026-11-08",
        transactions: [firstExpense, { ...firstExpense, id: 92, date: "2026-11-08", amount: 60 }] });
      assert.equal(later.openingBalances[currency.toLowerCase()], percentage === 100 ? 200 : 160);
      assert.equal(byId(later, 1).endingBalance, 90);
      assert.equal(later.rows.at(-1)[`balance${suffix}`], percentage === 100 ? 90 : 50);
    }
  });
}

test("saved linked available, reserve and savings columns retain separate USD and PHP openings", () => {
  const fields = ["availableUsdAccountId", "availablePhpAccountId", "annualReserveUsdAccountId", "annualReservePhpAccountId", "savingsUsdAccountId", "savingsPhpAccountId"];
  const bank = fields.map((field, index) => ({ id: index + 1, name: field, type: "checking", currency: field.includes("Usd") ? "USD" : "PHP", nativeCurrentBalance: 9999 }));
  const planner = {
    startDate: "2026-11-01", endDate: "2026-11-30", openingUsd: 0, openingPhp: 0,
    includeIncome: false, includeTransactions: true, includeAllocations: false, includeAnnualReserve: false,
    entries: [], accountLinks: Object.fromEntries(fields.map((field, index) => [field, index + 1])),
    accountOpeningBalances: bank.map((account) => ({ accountId: account.id, balance: account.id * 100 })),
  };
  const result = buildAccountPlan(planner, { salary: {}, bills: [], allocations: [] }, 63, { accounts: bank, today: "2026-11-08" });
  assert.deepEqual(result.openingBalances, { usd: 100, php: 200 });
  assert.equal(result.openingReserve.usd, 300);
  assert.equal(result.openingReserve.php, 400);
  assert.equal(result.openingSavings.usd, 500);
  assert.equal(result.openingSavings.php, 600);
  assert.ok(result.accounts.every((account) => account.openingSource === "plan" && account.openingBalance === account.accountId * 100));
});

test("an archived linked account retains its saved opening balance", () => {
  const bank = [{ id: 1, name: "Old checking", type: "checking", currency: "USD", nativeCurrentBalance: 0, isArchived: true }];
  const planner = { startDate: "2026-11-01", endDate: "2026-11-30", openingUsd: 0, openingPhp: 0,
    includeIncome: false, includeAllocations: false, includeAnnualReserve: false, entries: [],
    accountLinks: { availableUsdAccountId: 1 }, accountOpeningBalances: [{ accountId: 1, balance: 200 }] };
  const result = buildAccountPlan(planner, { salary: {}, bills: [], allocations: [] }, 63, { accounts: bank, today: "2026-11-08" });
  assert.equal(result.openingBalances.usd, 200);
  assert.equal(byId(result, 1).openingBalance, 200);
  assert.equal(result.openingSource, "plan");
});

test("one grouped annual bank transfer completes several bill earmarks and moves each account only once", () => {
  const doc = { salary: { ...salary, amount: 0 }, allocations: [], bills: [
    { ...document.bills[0], id: "one", name: "One", amount: 10, dueDay: 6, savedAmount: 0 },
    { ...document.bills[0], id: "two", name: "Two", amount: 20, dueDay: 6, savedAmount: 0 },
  ] };
  const current = { ...plan, startDate: "2026-11-06", endDate: "2026-11-06", includeIncome: false };
  const transactions = [
    { id: 101, accountId: 1, date: "2026-11-06", amount: 30, currency: "USD", kind: "expense", category: "Transfer", merchant: "Annual savings transfer" },
    { id: 102, accountId: 2, date: "2026-11-06", amount: 30, currency: "USD", kind: "income", category: "Transfer", merchant: "Annual savings transfer" },
  ];
  const result = project(current, doc, { transactions, today: "2026-11-06" });
  const reserve = result.rows.find((row) => row.source === "reserve");
  assert.equal(reserve.amount, 30);
  assert.equal(reserve.completed, true);
  assert.deepEqual(reserve.matchedTransactionIds, [101, 102]);
  assert.equal(reserve.accountMovements.length, 0);
  assert.equal(result.rows.find((row) => row.transactionId === 101).accountMovements.length, 1);
  assert.equal(result.rows.find((row) => row.transactionId === 102).accountMovements.length, 1);
});

test("an automatically completed expense allocation debits the account through its posted expense only", () => {
  const doc = { salary: { ...salary, amount: 0 }, bills: [], allocations: [
    { id: "food", name: "Groceries", kind: "expense", amount: 50, currency: "USD", accountId: 1 },
  ] };
  const current = { ...plan, startDate: "2026-11-06", endDate: "2026-11-06", includeIncome: false };
  const transactions = [{ id: 101, accountId: 1, date: "2026-11-06", amount: 50, currency: "USD", kind: "expense", merchant: "Groceries" }];
  const result = project(current, doc, { transactions, today: "2026-11-06" });
  assert.equal(byId(result, 1).endingBalance, 700);
  assert.equal(result.rows.find((row) => row.source === "allocation").accountMovements.length, 0);
});

test("salary, annual reserves and payday savings project into separate accounts without moving bank balances", () => {
  const before = JSON.stringify({ plan, document, accounts });
  const result = project();
  assert.equal(byId(result, 1).endingBalance, 1455);
  assert.equal(byId(result, 2).endingBalance, 395);
  assert.equal(byId(result, 2).endingAnnualReserved, 395);
  assert.equal(byId(result, 3).endingBalance, 1000);
  assert.equal(byId(result, 3).savingsAllocated, 1000);
  assert.equal(
    byId(result, 4).endingBalance,
    415,
    "credit expenses increase a positive balance owed",
  );
  assert.equal(result.openingSource, "plan");
  const annual = result.rows.find((row) => row.annualPayment);
  assert.equal(annual.usd, 0);
  assert.deepEqual(
    annual.accountMovements.map((move) => [
      move.accountId,
      move.amount,
      move.balanceDelta,
    ]),
    [
      [4, -395, 395],
    ],
  );
  assert.ok(annual.accountNames.includes("Annual savings · •1002"));
  assert.equal(before, JSON.stringify({ plan, document, accounts }));
});

test("automatic card dues reduce the liability without inventing a funding account debit", () => {
  const cardAccounts = [
    { id: 1, name: "Checking", type: "checking", currency: "USD", nativeCurrentBalance: 1000 },
    { id: 2, name: "Travel Card", type: "credit", currency: "USD", nativeCurrentBalance: 300,
      creditCardDue: { statementBalance: 200, dueDate: "2026-11-20", lastStatementDate: "2026-10-25" } },
  ];
  const cardPlan = { startDate: "2026-11-01", endDate: "2026-11-30", openingUsd: 1000,
    includeIncome: false, includeAllocations: false, includeAnnualReserve: false, entries: [] };
  const result = buildAccountPlan(cardPlan, { salary: {}, bills: [], allocations: [] }, 63,
    { accounts: cardAccounts, today: "2026-11-04" });
  assert.equal(result.accounts.find((account) => account.accountId === 1).endingBalance, 1000);
  assert.equal(result.accounts.find((account) => account.accountId === 2).endingBalance, 100);
  assert.equal(result.rows[0].balanceUsd, 800);
  assert.deepEqual(result.rows[0].accountMovements.map((move) => [move.accountId, move.amount, move.balanceDelta]), [[2, 200, -200]]);
  assert.ok(result.warnings.some((warning) => warning.includes("funding account is unknown")));
});

test("a next-cycle estimate pays the known native card debt once without guessing the funding account", () => {
  const cardAccounts = [
    { id: 1, name: "Checking", type: "checking", currency: "USD", nativeCurrentBalance: 2000 },
    { id: 2, name: "Venture X", type: "credit", currency: "USD", isLinked: true, nativeCurrentBalance: 1380.16,
      creditCardDue: { statementBalance: 0, dueDate: "2026-12-18" } },
  ];
  const cardPlan = { startDate: "2026-11-06", endDate: "2027-01-01", openingUsd: 2000,
    includeIncome: false, includeAllocations: false, includeAnnualReserve: false, entries: [] };
  const result = buildAccountPlan(cardPlan, { salary: {}, bills: [], allocations: [] }, 63,
    { accounts: cardAccounts, today: "2026-11-05" });
  assert.equal(result.accounts.find((account) => account.accountId === 1).endingBalance, 2000);
  assert.equal(result.accounts.find((account) => account.accountId === 2).endingBalance, 0);
  assert.deepEqual(result.rows[0].accountMovements.map((move) => [move.accountId, move.amount, move.balanceDelta]), [[2, 1380.16, -1380.16]]);
  assert.equal(result.rows[0].balanceUsd, 619.84);
  assert.equal(result.rows[0].estimated, true);
});

test("planned payments split between actual and estimated dues conserve native account balances", () => {
  const cardAccounts = [
    { id: 1, name: "Checking", type: "checking", currency: "USD", nativeCurrentBalance: 1000 },
    { id: 2, name: "Travel Card", type: "credit", currency: "USD", isLinked: true, nativeCurrentBalance: 500,
      creditCardDue: { statementBalance: 200, dueDate: "2026-11-20", lastStatementDate: "2026-10-25" } },
  ];
  const cardPlan = { startDate: "2026-11-01", endDate: "2026-12-31", openingUsd: 1000,
    includeIncome: false, includeAllocations: false, includeAnnualReserve: false, entries: [
      { id: "pay", date: "2026-11-18", description: "Pay card", kind: "transfer", amount: 250, currency: "USD", fromAccountId: 1, toAccountId: 2 },
    ] };
  const result = buildAccountPlan(cardPlan, { salary: {}, bills: [], allocations: [] }, 63,
    { accounts: cardAccounts, today: "2026-11-05" });
  assert.equal(result.accounts.find((account) => account.accountId === 1).endingBalance, 750);
  assert.equal(result.accounts.find((account) => account.accountId === 2).endingBalance, 0);
  assert.equal(result.rows.at(-1).balanceUsd, 500);
});

test("same-day reflected payments do not shrink an estimate or replay native transfer legs", () => {
  const cardDocument = { salary: {}, bills: [], allocations: [] };
  for (const statementBalance of [0, null]) for (const live of [false, true]) {
    const cardAccounts = [
      { id: 1, name: "Checking", type: "checking", currency: "USD", nativeCurrentBalance: 700 },
      { id: 2, name: "Travel Card", type: "credit", currency: "USD", isLinked: true, nativeCurrentBalance: 1000,
        creditCardDue: { statementBalance, dueDate: "2026-12-18" } },
    ];
    const cardPlan = { startDate: "2026-11-01", endDate: "2026-12-31", openingUsd: live ? 0 : 1000,
      ...(live ? { startingAccounts: [{ accountId: 1, percentage: 100 }] }
        : { accountOpeningBalances: [{ accountId: 1, balance: 1000 }, { accountId: 2, balance: 1300 }] }),
      includeIncome: false, includeAllocations: false, includeAnnualReserve: false, entries: [
        { id: "paid", date: "2026-11-05", description: "Pay card", kind: "transfer", amount: 300, currency: "USD", fromAccountId: 1, toAccountId: 2 },
      ] };
    const result = buildAccountPlan(cardPlan, cardDocument, 63, { accounts: cardAccounts, today: "2026-11-05", transactions: [
      { id: 1, date: "2026-11-05", amount: 300, currency: "USD", kind: "income", accountId: 2, category: "Debt", merchant: "Automatic payment" },
      { id: 2, date: "2026-11-05", amount: 300, currency: "USD", kind: "expense", accountId: 1, category: "Debt", merchant: "Travel Card payment" },
    ] });
    assert.equal(result.rows.find((row) => row.estimated).amount, 1000);
    assert.equal(result.accounts.find((account) => account.accountId === 1).endingBalance, 700);
    assert.equal(result.accounts.find((account) => account.accountId === 2).endingBalance, 0);
    assert.equal(result.rows.at(-1).balanceUsd, -300);
    assert.deepEqual(result.rows.find((row) => row.entryId === "paid").accountMovements, []);
  }
});

test("card purchases and posted partial payments change owed balances once alongside the remaining statement", () => {
  const cardAccounts = [
    { id: 1, name: "Checking", type: "checking", currency: "USD", nativeCurrentBalance: 950 },
    { id: 2, name: "Travel Card", type: "credit", currency: "USD", nativeCurrentBalance: 290,
      creditCardDue: { statementBalance: 200, dueDate: "2026-11-20", lastStatementDate: "2026-10-25" } },
  ];
  const cardPlan = { startDate: "2026-11-01", endDate: "2026-11-30", openingUsd: 1000,
    accountOpeningBalances: [{ accountId: 1, balance: 1000 }, { accountId: 2, balance: 300 }],
    includeIncome: false, includeAllocations: false, includeAnnualReserve: false, entries: [] };
  const rows = buildPlanRows(cardPlan, { salary: {}, bills: [], allocations: [] }, 63, { accounts: cardAccounts, today: "2026-11-04", transactions: [
    { id: 10, date: "2026-11-02", amount: 40, currency: "USD", kind: "expense", accountId: 2, merchant: "Market" },
    { id: 11, date: "2026-11-03", amount: 50, currency: "USD", kind: "income", accountId: 2, category: "Transfer In" },
    { id: 12, date: "2026-11-03", amount: 50, currency: "USD", kind: "expense", accountId: 1, category: "Loan Payments" },
  ] });
  const result = buildAccountPlan(cardPlan, { salary: {}, bills: [], allocations: [] }, 63,
    { accounts: cardAccounts, rows, today: "2026-11-04" });
  assert.equal(result.accounts.find((account) => account.accountId === 1).endingBalance, 950);
  assert.equal(result.accounts.find((account) => account.accountId === 2).endingBalance, 140);
  assert.equal(result.rows.at(-1).balanceUsd, 800);
});

test("annual card charges increase debt while keeping their reserve held for statement payment", () => {
  const cardAccounts = [
    { id: 1, name: "Checking", type: "checking", currency: "USD", nativeCurrentBalance: 1200 },
    { id: 2, name: "Card", type: "credit", currency: "USD", nativeCurrentBalance: 200,
      creditCardDue: { statementBalance: 200, dueDate: "2026-11-20", lastStatementDate: "2026-10-25" } },
  ];
  const cardDocument = { salary: {}, bills: [
    { id: "annual", name: "Annual fee", cadence: "annual", amount: 200, currency: "USD", dueDay: 10, dueMonths: [11], savedAmount: 200,
      accountId: 2, reserveAccountId: 1 },
  ], allocations: [] };
  const cardPlan = { startDate: "2026-11-01", endDate: "2026-11-30", openingUsd: 1000,
    includeIncome: false, includeAllocations: false, includeAnnualReserve: false, entries: [] };
  const result = buildAccountPlan(cardPlan, cardDocument, 63, { accounts: cardAccounts, today: "2026-11-04" });
  const charge = result.rows.find((row) => row.annualPayment);
  assert.deepEqual(charge.accountMovements.map((move) => [move.accountId, move.amount, move.balanceDelta]), [[2, -200, 200]]);
  assert.equal(charge.reserveHeld, 200);
  assert.equal(charge.reserveUsed, 0);
  assert.equal(result.accounts.find((account) => account.accountId === 1).endingBalance, 1200);
  assert.equal(result.accounts.find((account) => account.accountId === 1).endingAnnualReserved, 200);
  assert.equal(result.accounts.find((account) => account.accountId === 2).endingBalance, 200);
});

function annualCardCoverageFixture(reserveUsed = 395) {
  const accounts = [
    { id: 1, name: "Checking", type: "checking", currency: "USD", nativeCurrentBalance: 2000 },
    { id: 2, name: "Annual savings", type: "savings", currency: "USD", nativeCurrentBalance: 526.59 },
    { id: 28, name: "Smartly Savings", type: "savings", currency: "USD", nativeCurrentBalance: 500 },
    { id: 32, name: "Venture X", type: "credit", currency: "USD", nativeCurrentBalance: 1658.16 },
  ];
  const document = { salary: {}, allocations: [], bills: [
    { id: "venture-annual", name: "Venture X", cadence: "annual", amount: 395, currency: "USD", dueMonths: [11], dueDay: 1,
      savedAmount: 395, accountId: 32, reserveAccountId: 2, sourceAccountId: 1 },
  ] };
  const plan = { startDate: "2026-11-05", endDate: "2026-12-31", openingUsd: 0, openingPhp: 0, entries: [],
    includeIncome: false, includeAnnualReserve: false, includeAllocations: false,
    accountLinks: { availableUsdAccountId: 1, annualReserveUsdAccountId: 2, savingsUsdAccountId: 28 } };
  const row = { id: "creditCardDue:32:2026-12-18", date: "2026-12-18", source: "creditCardDue", kind: "expense",
    description: "Venture X · estimated next statement", amount: 1658.16, currency: "USD", creditAccountId: 32,
    usd: -1658.16, php: 0, annualBillCoverage: [{ billId: "venture-annual", billName: "Venture X", chargeDate: "2026-11-01",
      chargeTransactionId: 2506, amount: 395, reserveUsed, reserveAccountId: 2 }] };
  return { accounts, document, plan, row };
}

test("annual fee coverage pays a card statement from annual reserves and checking exactly once", () => {
  for (const reserveUsed of [0, 100, 395]) {
    const { accounts, document, plan, row } = annualCardCoverageFixture(reserveUsed);
    const before = JSON.stringify({ accounts, document, plan, row });
    const result = buildAccountPlan(plan, document, 63, { accounts, rows: [row], today: "2026-11-06" });
    assert.equal(byId(result, 32).endingBalance, 0);
    assert.equal(byId(result, 1).endingBalance, Math.round((2000 - 1658.16 + reserveUsed) * 100) / 100);
    assert.equal(byId(result, 2).endingBalance, Math.round((526.59 - reserveUsed) * 100) / 100);
    assert.equal(byId(result, 2).endingAnnualReserved, 395 - reserveUsed);
    assert.equal(byId(result, 28).endingBalance, 500);
    assert.equal(result.rows[0].reserveUsd, byId(result, 2).endingBalance);
    assert.equal(result.rows[0].savingsUsd, 500);
    assert.equal(result.rows[0].balanceAppliedUsd, -(1658.16 - reserveUsed));
    assert.equal(result.rows[0].accountMovements.filter((move) => move.accountId === 32).length, 1);
    assert.equal(result.rows[0].accountMovements.filter((move) => move.accountId === 32)[0].amount, 1658.16);
    assert.equal(before, JSON.stringify({ accounts, document, plan, row }));
  }
});

test("annual statement coverage cannot exceed the remaining card payment or use an unavailable reserve account", () => {
  const { accounts, document, plan, row } = annualCardCoverageFixture();
  const result = buildAccountPlan(plan, document, 63, {
    accounts, rows: [{ ...row, amount: 100, usd: -100 }], today: "2026-11-06",
  });
  assert.equal(byId(result, 2).endingBalance, 426.59);
  assert.equal(byId(result, 1).endingBalance, 2000);
  assert.equal(byId(result, 32).endingBalance, 1558.16);
  const unavailable = buildAccountPlan(plan, document, 63, {
    accounts: accounts.map((account) => account.id === 2 ? { ...account, isArchived: true } : account), rows: [row], today: "2026-11-06",
  });
  assert.equal(byId(unavailable, 1).endingBalance, 341.84);
  assert.equal(byId(unavailable, 2).endingBalance, 526.59);
  assert.ok(unavailable.warnings.some((warning) => warning.includes("statement reserve account is unavailable")));
});

test("zero remaining card dues do not draw annual reserve funding again", () => {
  const { accounts, document, plan, row } = annualCardCoverageFixture();
  const result = buildAccountPlan(plan, document, 63, { accounts, rows: [{ ...row, amount: 0, usd: 0 }], today: "2026-11-06" });
  assert.equal(byId(result, 1).endingBalance, 2000);
  assert.equal(byId(result, 2).endingBalance, 526.59);
  assert.equal(byId(result, 32).endingBalance, 1658.16);
  assert.deepEqual(result.rows[0].accountMovements, []);
});

test("annual reserve funding already transferred to checking is consumed without another reserve withdrawal", () => {
  const { accounts, document, plan, row } = annualCardCoverageFixture();
  const transfer = { id: "entry:fund", date: "2026-12-17", source: "manual", kind: "transfer", description: "Move annual fee funding",
    amount: 395, currency: "USD", fromAccountId: 2, toAccountId: 1, usd: 0, php: 0 };
  const result = buildAccountPlan(plan, document, 63, { accounts, rows: [transfer, {
    ...row, annualBillCoverage: row.annualBillCoverage.map((coverage) => ({ ...coverage, reserveTransferredAmount: 395 })),
  }], today: "2026-11-06" });
  assert.equal(byId(result, 2).endingBalance, 131.59);
  assert.equal(byId(result, 2).endingAnnualReserved, 0);
  assert.equal(byId(result, 1).endingBalance, 736.84);
  assert.equal(byId(result, 32).endingBalance, 0);
  assert.equal(result.rows[1].accountMovements.some((move) => move.accountId === 2), false);
});

test("an annual fee already paid directly from reserves is not funded twice by its remaining card statement", () => {
  const { accounts, document, plan, row } = annualCardCoverageFixture();
  for (const fullyPlanned of [false, true]) {
    const transfer = { id: "entry:reserve-pay", date: "2026-12-17", source: "manual", kind: "transfer", description: "Pay annual fee from reserves",
      amount: 395, currency: "USD", fromAccountId: 2, toAccountId: 32, usd: 0, php: 0 };
    const checkingTransfer = { ...transfer, id: "entry:checking-pay", fromAccountId: 1, amount: 1263.16 };
    const remaining = fullyPlanned ? 0 : 1263.16;
    const due = { ...row, amount: remaining, usd: -remaining,
      annualBillCoverage: row.annualBillCoverage.map((coverage) => ({ ...coverage, reserveAlreadyPaidAmount: 395 })) };
    const result = buildAccountPlan(plan, document, 63, { accounts,
      rows: [transfer, ...(fullyPlanned ? [checkingTransfer] : []), due], today: "2026-11-06" });
    assert.equal(byId(result, 2).endingBalance, 131.59);
    assert.equal(byId(result, 2).endingAnnualReserved, 0);
    assert.equal(byId(result, 1).endingBalance, 736.84);
    assert.equal(byId(result, 32).endingBalance, 0);
    assert.equal(result.rows.at(-1).accountMovements.some((move) => move.accountId === 2), false);
  }
});

test("a historical card annual fee funds the existing next statement without another card charge", () => {
  const { accounts, document, plan } = annualCardCoverageFixture();
  Object.assign(accounts.find((account) => account.id === 32), { isLinked: true, creditCardDueStatus: "current",
    creditCardDue: { statementBalance: 0, dueDate: "2026-12-18", lastStatementDate: null } });
  const fee = { id: 2506, date: "2026-11-01", kind: "expense", accountId: 32, amount: 395, currency: "USD",
    merchant: "CAPITAL ONE MEMBER FEE", category: "Bank Fees" };
  const result = buildAccountPlan(plan, document, 63, { accounts, transactions: [], creditCardPaymentTransactions: [fee], today: "2026-11-06" });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].amount, 1658.16);
  assert.equal(result.rows[0].annualBillCoverage[0].chargeTransactionId, 2506);
  assert.equal(result.rows[0].annualBillCoverage[0].reserveUsed, 395);
  assert.equal(byId(result, 32).endingBalance, 0);
  assert.equal(byId(result, 1).endingBalance, 736.84);
  assert.equal(byId(result, 2).endingBalance, 131.59);
  assert.equal(byId(result, 28).endingBalance, 500);
});

test("an in-range annual card charge changes dated debt once and keeps its reserve until the statement", () => {
  const { accounts, document, plan } = annualCardCoverageFixture();
  Object.assign(accounts.find((account) => account.id === 32), { isLinked: true,
    creditCardDue: { statementBalance: 0, dueDate: "2026-12-18", lastStatementDate: null } });
  const fee = { id: 2506, date: "2026-11-01", kind: "expense", accountId: 32, amount: 395, currency: "USD",
    merchant: "CAPITAL ONE MEMBER FEE", category: "Bank Fees" };
  const result = buildAccountPlan({ ...plan, startDate: "2026-10-31",
    accountOpeningBalances: accounts.map((account) => ({ accountId: account.id, balance: account.id === 32 ? 1263.16 : account.nativeCurrentBalance })),
  }, document, 63, { accounts, transactions: [fee], creditCardPaymentTransactions: [fee], today: "2026-11-06" });
  const charge = result.rows.find((row) => row.transactionId === 2506);
  assert.equal(charge.deferReserveToCardDue, true);
  assert.equal(charge.reserveUsd, 526.59);
  assert.equal(charge.accountAnnualReserves[2], 395);
  assert.equal(charge.accountBalances[32], 1658.16);
  assert.equal(byId(result, 32).endingBalance, 0);
  assert.equal(byId(result, 1).endingBalance, 736.84);
  assert.equal(byId(result, 2).endingBalance, 131.59);
});

test("linked annual card coverage honors explicit reserve funding and card payments without duplicate native debits", () => {
  for (const funding of ["checking transfer", "reserve card payment", "full card payments"]) {
    const { accounts, document, plan } = annualCardCoverageFixture();
    Object.assign(accounts.find((account) => account.id === 32), { isLinked: true,
      creditCardDue: { statementBalance: 0, dueDate: "2026-12-18", lastStatementDate: null } });
    const fee = { id: 2506, date: "2026-11-01", kind: "expense", accountId: 32, amount: 395, currency: "USD",
      merchant: "CAPITAL ONE MEMBER FEE", category: "Bank Fees" };
    const entry = { id: "fund", date: "2026-12-17", kind: "transfer", description: "Fund card annual fee", amount: 395,
      currency: "USD", fromAccountId: 2, toAccountId: funding === "checking transfer" ? 1 : 32 };
    const entries = [entry, ...(funding === "full card payments" ? [{ ...entry, id: "remaining", fromAccountId: 1, amount: 1263.16 }] : [])];
    const result = buildAccountPlan({ ...plan, entries }, document, 63, {
      accounts, transactions: [], creditCardPaymentTransactions: [fee], today: "2026-11-06",
    });
    assert.equal(byId(result, 1).endingBalance, 736.84, funding);
    assert.equal(byId(result, 2).endingBalance, 131.59, funding);
    assert.equal(byId(result, 2).endingAnnualReserved, 0, funding);
    assert.equal(byId(result, 32).endingBalance, 0, funding);
    assert.equal(byId(result, 28).endingBalance, 500, funding);
  }
});

test("posted partial reserve payments are not withdrawn again from confirmed or estimated annual statements", () => {
  for (const issued of [false, true]) {
    for (const paymentDate of ["2026-11-04", "2026-11-06"]) {
      const { accounts, document, plan } = annualCardCoverageFixture();
      accounts.find((account) => account.id === 2).nativeCurrentBalance = 426.59;
      Object.assign(accounts.find((account) => account.id === 32), { isLinked: true, nativeCurrentBalance: 1558.16,
        creditCardDue: { statementBalance: issued ? 1658.16 : 0, dueDate: "2026-12-18", lastStatementDate: issued ? "2026-11-02" : null } });
      const fee = { id: 2506, date: "2026-11-01", kind: "expense", accountId: 32, amount: 395, currency: "USD",
        merchant: "CAPITAL ONE MEMBER FEE", category: "Bank Fees" };
      const records = [
        { id: 2507, date: paymentDate, kind: "expense", accountId: 2, amount: 100, currency: "USD", category: "Transfer Out", merchant: "Venture X card payment" },
        { id: 2508, date: paymentDate, kind: "income", accountId: 32, amount: 100, currency: "USD", category: "Transfer In", merchant: "Payment received" },
      ];
      const result = buildAccountPlan(plan, document, 63, { accounts, transactions: records.filter((transaction) => transaction.date >= plan.startDate),
        creditCardPaymentTransactions: [fee, ...records], today: "2026-11-06" });
      assert.equal(byId(result, 1).endingBalance, 736.84);
      assert.equal(byId(result, 2).endingBalance, 131.59);
      assert.equal(byId(result, 2).endingAnnualReserved, 0);
      assert.equal(byId(result, 32).endingBalance, 0);
      assert.equal(byId(result, 28).endingBalance, 500);
      const due = result.rows.find((row) => row.source === "creditCardDue");
      assert.equal(due.annualBillCoverage[0].reserveAlreadyPaidAmount, 100);
      assert.equal(due.accountMovements.find((move) => move.kind === "cardReserveFunding").amount, -295);
    }
  }
});

test("a reserve transfer in transit keeps only its missing native leg after its scheduled date", () => {
  for (const [postedLeg, pendingCounterpart] of [
    ["reserve debit", false], ["reserve debit", true], ["checking credit", false], ["checking credit", true],
  ]) {
    const { accounts, document, plan } = annualCardCoverageFixture();
    const debitPosted = postedLeg === "reserve debit";
    accounts.find((account) => account.id === 2).nativeCurrentBalance = debitPosted ? 131.59 : 526.59;
    accounts.find((account) => account.id === 1).nativeCurrentBalance = debitPosted ? 2000 : 2395;
    Object.assign(accounts.find((account) => account.id === 32), { isLinked: true,
      creditCardDue: { statementBalance: 0, dueDate: "2026-12-18", lastStatementDate: null } });
    const fee = { id: 2506, date: "2026-11-01", kind: "expense", accountId: 32, amount: 395, currency: "USD",
      merchant: "CAPITAL ONE MEMBER FEE", category: "Bank Fees" };
    const debit = { id: 2510, date: "2026-11-10", kind: "expense", accountId: 2, amount: 395, currency: "USD",
      merchant: "Bank transfer withdrawal", category: "Transfer Out", pending: !debitPosted };
    const credit = { id: 2511, date: "2026-11-10", kind: "income", accountId: 1, amount: 395, currency: "USD",
      merchant: "Bank transfer deposit", category: "Transfer In", pending: debitPosted };
    const records = [debitPosted ? debit : credit, ...(pendingCounterpart ? [debitPosted ? credit : debit] : [])];
    const entry = { id: "reserve-funding", date: "2026-11-10", kind: "transfer", amount: 395, currency: "USD",
      fromAccountId: 2, toAccountId: 1, description: "Prepare annual fee funding" };
    const result = buildAccountPlan({ ...plan, entries: [entry] }, document, 63, { accounts,
      transactions: records, creditCardPaymentTransactions: [fee, ...records], today: "2026-11-11" });
    const transfer = result.rows.find((row) => row.entryId === entry.id);
    assert.equal(transfer.completed, false);
    assert.equal(transfer.recordedTransactions.length, 1);
    assert.deepEqual(transfer.accountMovements.map((move) => [move.accountId, move.amount]), debitPosted ? [[1, 395]] : [[2, -395]]);
    assert.equal(transfer.accountBalances[1], 2395);
    assert.equal(transfer.accountBalances[2], 131.59);
    const due = result.rows.find((row) => row.source === "creditCardDue");
    assert.equal(due.annualBillCoverage[0].reserveTransferredAmount, 395);
    assert.equal(byId(result, 1).endingBalance, 736.84);
    assert.equal(byId(result, 2).endingBalance, 131.59);
    assert.equal(byId(result, 32).endingBalance, 0);
  }
});

test("explicit card transfers and statement dues project each native movement once before and after posting", () => {
  const cardAccounts = [
    { id: 1, name: "Checking", type: "checking", currency: "USD", nativeCurrentBalance: 1000 },
    { id: 2, name: "Card", type: "credit", currency: "USD", nativeCurrentBalance: 200,
      creditCardDue: { statementBalance: 200, dueDate: "2026-11-20", lastStatementDate: "2026-10-25" } },
  ];
  const cardPlan = { startDate: "2026-11-01", endDate: "2026-11-30", openingUsd: 1000,
    accountOpeningBalances: [{ accountId: 1, balance: 1000 }, { accountId: 2, balance: 200 }],
    includeIncome: false, includeAllocations: false, includeAnnualReserve: false,
    entries: [{ id: "pay-card", date: "2026-11-18", description: "Pay card", kind: "transfer", amount: 200, currency: "USD", fromAccountId: 1, toAccountId: 2 }] };
  const cardDocument = { salary: {}, bills: [], allocations: [] };
  for (const posted of [false, true]) {
    const rows = buildPlanRows(cardPlan, cardDocument, 63, { accounts: cardAccounts, today: posted ? "2026-11-19" : "2026-11-04", transactions: posted ? [
      { id: 1, date: "2026-11-18", amount: 200, currency: "USD", kind: "income", accountId: 2, category: "Transfer In" },
      { id: 2, date: "2026-11-18", amount: 200, currency: "USD", kind: "expense", accountId: 1, category: "Transfer Out" },
    ] : [] });
    const result = buildAccountPlan(cardPlan, cardDocument, 63,
      { accounts: cardAccounts, rows, today: posted ? "2026-11-19" : "2026-11-04" });
    assert.equal(result.accounts.find((account) => account.accountId === 1).endingBalance, 800);
    assert.equal(result.accounts.find((account) => account.accountId === 2).endingBalance, 0);
    assert.equal(result.rows.at(-1).balanceUsd, 800);
  }
});

test("recognized Debt card payments suppress duplicate explicit native transfer legs with dated and live openings", () => {
  const cardDocument = { salary: {}, bills: [], allocations: [] };
  for (const live of [false, true]) {
    const cardAccounts = [
      { id: 1, name: "Checking", type: "checking", currency: "USD", nativeCurrentBalance: 800 },
      { id: 2, name: "Travel Card", type: "credit", currency: "USD", nativeCurrentBalance: 0,
        creditCardDue: { statementBalance: 200, dueDate: "2026-11-20", lastStatementDate: "2026-10-25" } },
    ];
    const cardPlan = { startDate: "2026-11-01", endDate: "2026-11-30", openingUsd: live ? 0 : 1000,
      ...(live ? { startingAccounts: [{ accountId: 1, percentage: 100 }] }
        : { accountOpeningBalances: [{ accountId: 1, balance: 1000 }, { accountId: 2, balance: 200 }] }),
      includeIncome: false, includeAllocations: false, includeAnnualReserve: false,
      entries: [{ id: "pay-card", date: "2026-11-18", description: "Pay card", kind: "transfer", amount: 200, currency: "USD", fromAccountId: 1, toAccountId: 2 }] };
    const rows = buildPlanRows(cardPlan, cardDocument, 63, { accounts: cardAccounts, today: "2026-11-18", transactions: [
      { id: 1, date: "2026-11-18", amount: 200, currency: "USD", kind: "income", accountId: 2, category: "Debt", merchant: "Automatic payment" },
      { id: 2, date: "2026-11-18", amount: 200, currency: "USD", kind: "expense", accountId: 1, category: "Debt", merchant: "Travel Card payment" },
    ] });
    const result = buildAccountPlan(cardPlan, cardDocument, 63, { accounts: cardAccounts, rows, today: "2026-11-18" });
    assert.equal(result.accounts.find((account) => account.accountId === 1).endingBalance, 800);
    assert.equal(result.accounts.find((account) => account.accountId === 2).endingBalance, 0);
    assert.equal(result.rows.at(-1).balanceUsd, 800);
    assert.deepEqual(result.rows.find((row) => row.entryId === "pay-card").accountMovements, []);
  }
});

test("current account earmarks report over-allocation without inventing saved funds", () => {
  const rows = getFinanceAccountAllocations(
    {
      ...document,
      bills: [{ ...document.bills[0], savedAmount: 150 }],
    },
    accounts,
    63,
    "2026-11-02",
  );
  const annual = rows.find((row) => row.accountId === 2);
  assert.equal(annual.annualReserved, 150);
  assert.equal(annual.unallocatedBalance, -50);
  assert.equal(annual.overassigned, 50);
  assert.equal(annual.annualPerPayday, 122.5);
  assert.equal(rows.find((row) => row.accountId === 3).savingsPerPayday, 500);
  assert.equal(rows.find((row) => row.accountId === 1).salaryPerPayday, 1000);
  assert.equal(
    rows.find((row) => row.accountId === 4).unallocatedBalance,
    null,
  );
});

test("saving within the same account changes its earmark without a bank transfer", () => {
  const doc = {
    ...document,
    bills: [{ ...document.bills[0], accountId: 1, reserveAccountId: 1 }],
    allocations: [],
  };
  const result = project({ ...plan, endDate: "2026-11-06" }, doc);
  const reserve = result.rows.find((row) => row.source === "reserve");
  assert.deepEqual(reserve.accountMovements, []);
  assert.ok(reserve.accountNames.includes("Checking · •1001"));
  assert.equal(byId(result, 1).endingBalance, 1750);
  assert.equal(byId(result, 1).endingAnnualReserved, 247.5);
  assert.equal(byId(result, 1).availableAfterAnnualReserve, 1502.5);
});

test("same-currency manual transfers have zero aggregate expense and preserve total assets", () => {
  const doc = { ...document, bills: [], allocations: [] };
  const entry = {
    id: "transfer",
    date: "2026-11-10",
    description: "Move savings",
    kind: "transfer",
    currency: "USD",
    amount: 200,
    fromAccountId: 1,
    toAccountId: 3,
  };
  const result = project(
    { ...plan, includeIncome: false, entries: [entry] },
    doc,
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].usd, 0);
  assert.equal(result.rows[0].php, 0);
  assert.equal(result.rows[0].balanceUsd, 750);
  assert.equal(byId(result, 1).endingBalance, 550);
  assert.equal(byId(result, 3).endingBalance, 200);
});

test("a transfer between linked payday savings and checking shifts available money while conserving native assets", () => {
  const currentAccounts = accounts.map((account) => ({
    ...account,
    nativeCurrentBalance: account.id === 1 ? 921.4 : account.id === 3 ? 246.73 : account.nativeCurrentBalance,
  }));
  const doc = { ...document, bills: [] };
  for (const [fromAccountId, toAccountId, expectedAvailable, expectedSavings, flow] of [
    [3, 1, 1018.13, 150, 96.73],
    [1, 3, 824.67, 343.46, -96.73],
  ]) {
    const result = project({
      ...plan,
      startDate: "2026-11-27",
      endDate: "2026-11-27",
      openingUsd: 921.4,
      accountOpeningBalances: [],
      includeIncome: false,
      includeAllocations: false,
      includeAnnualReserve: false,
      entries: [{ id: "transfer", date: "2026-11-27", description: "Transfer", kind: "transfer", currency: "USD", amount: 96.73, fromAccountId, toAccountId }],
    }, doc, { accounts: currentAccounts });
    const row = result.rows[0];
    assert.equal(row.usd, flow);
    assert.equal(row.balanceUsd, expectedAvailable);
    assert.equal(row.savingsUsd, expectedSavings);
    assert.equal(byId(result, 1).endingBalance, expectedAvailable);
    assert.equal(byId(result, 3).endingBalance, expectedSavings);
    assert.equal(Math.round((byId(result, 1).endingBalance + byId(result, 3).endingBalance) * 100), 116813);
    assert.deepEqual(row.accountMovements.map((move) => [move.accountId, move.amount]), [[fromAccountId, -96.73], [toAccountId, 96.73]]);
  }
});

test("moving money between two linked savings accounts leaves available and total savings unchanged", () => {
  const currentAccounts = [
    ...accounts.map((account) => ({ ...account, nativeCurrentBalance: account.id === 3 ? 246.73 : account.nativeCurrentBalance })),
    { id: 6, name: "Second savings", type: "savings", currency: "USD", nativeCurrentBalance: 50 },
  ];
  const doc = { ...document, bills: [], allocations: [
    ...document.allocations,
    { ...document.allocations[0], id: "second", accountId: 6 },
  ] };
  const result = project({
    ...plan,
    accountOpeningBalances: [],
    includeIncome: false,
    includeAllocations: false,
    includeAnnualReserve: false,
    entries: [{ id: "transfer", date: "2026-11-27", description: "Rebalance savings", kind: "transfer", currency: "USD", amount: 96.73, fromAccountId: 3, toAccountId: 6 }],
  }, doc, { accounts: currentAccounts });
  assert.equal(result.rows[0].usd, 0);
  assert.equal(result.rows[0].balanceUsd, 750);
  assert.equal(result.rows[0].savingsUsd, 296.73);
  assert.equal(byId(result, 3).endingBalance, 150);
  assert.equal(byId(result, 6).endingBalance, 146.73);
});

test("a posted savings withdrawal is reflected once in current live checking and savings balances", () => {
  const currentAccounts = accounts.map((account) => ({
    ...account,
    nativeCurrentBalance: account.id === 1 ? 1018.13 : account.id === 3 ? 150 : account.nativeCurrentBalance,
  }));
  const transactions = [
    { id: 201, date: "2026-11-27", accountId: 3, kind: "expense", currency: "USD", amount: 96.73, category: "Transfer", merchant: "Transfer to checking" },
    { id: 202, date: "2026-11-27", accountId: 1, kind: "income", currency: "USD", amount: 96.73, category: "Transfer", merchant: "Transfer from savings" },
  ];
  const current = {
    ...plan,
    startDate: "2026-11-27",
    endDate: "2026-11-27",
    openingUsd: 0,
    accountOpeningBalances: [],
    startingAccounts: [{ accountId: 1, percentage: 100 }],
    includeIncome: false,
    includeAllocations: false,
    includeAnnualReserve: false,
    entries: [{ id: "transfer", date: "2026-11-27", description: "Transfer", kind: "transfer", currency: "USD", amount: 96.73, fromAccountId: 3, toAccountId: 1 }],
  };
  for (const transactionDate of ["2026-11-27", "2026-11-25"]) {
    for (const includeTransactions of [true, false]) {
      const result = project({ ...current, startDate: "2026-11-25", includeTransactions }, { ...document, bills: [] }, {
        accounts: currentAccounts,
        transactions: transactions.map((transaction) => ({ ...transaction, date: transactionDate })),
        today: transactionDate,
      });
      assert.equal(result.rows.find((row) => row.entryId === "transfer").completed, true);
      assert.equal(result.rows.at(-1).balanceUsd, 1018.13);
      assert.equal(result.rows.at(-1).savingsUsd, 150);
      assert.equal(byId(result, 1).endingBalance, 1018.13);
      assert.equal(byId(result, 3).endingBalance, 150);
    }
  }
});

test("completed transfers still move explicitly dated account openings when posted rows are hidden", () => {
  const result = project({
    ...plan,
    startDate: "2026-11-27",
    endDate: "2026-11-27",
    openingUsd: 921.4,
    accountOpeningBalances: [{ accountId: 1, balance: 921.4 }, { accountId: 3, balance: 246.73 }],
    includeIncome: false,
    includeTransactions: false,
    includeAllocations: false,
    includeAnnualReserve: false,
    entries: [{ id: "transfer", date: "2026-11-27", description: "Transfer", kind: "transfer", currency: "USD", amount: 96.73, fromAccountId: 3, toAccountId: 1 }],
  }, { ...document, bills: [] }, {
    accounts: accounts.map((account) => ({ ...account, nativeCurrentBalance: account.id === 1 ? 1018.13 : account.id === 3 ? 150 : account.nativeCurrentBalance })),
    transactions: [
      { id: 201, date: "2026-11-27", accountId: 3, kind: "expense", currency: "USD", amount: 96.73, category: "Transfer" },
      { id: 202, date: "2026-11-27", accountId: 1, kind: "income", currency: "USD", amount: 96.73, category: "Transfer" },
    ],
    today: "2026-11-27",
  });
  assert.equal(result.rows[0].completed, true);
  assert.equal(result.rows[0].accountMovements.length, 2);
  assert.equal(byId(result, 1).endingBalance, 1018.13);
  assert.equal(byId(result, 3).endingBalance, 150);
});

test("one posted transfer leg is not replayed while its missing counterpart stays forecast", () => {
  const cases = [96.73, 200].flatMap((amount) => [3, 1].map((postedAccountId) => ({ amount, postedAccountId })));
  for (const { amount, postedAccountId } of cases) {
    for (const includeTransactions of [true, false]) {
      const result = project({
        ...plan,
        startDate: "2026-11-25",
        endDate: "2026-11-27",
        openingUsd: 0,
        accountOpeningBalances: [],
        startingAccounts: [{ accountId: 1, percentage: 100 }],
        includeIncome: false,
        includeTransactions,
        includeAllocations: false,
        includeAnnualReserve: false,
        entries: [{ id: "transfer", date: "2026-11-27", description: "Transfer", kind: "transfer", currency: "USD", amount, fromAccountId: 3, toAccountId: 1 }],
      }, { ...document, bills: [] }, {
        accounts: accounts.map((account) => ({
          ...account,
          nativeCurrentBalance: account.id === 1 ? postedAccountId === 1 ? Math.round((921.4 + amount) * 100) / 100 : 921.4 : account.id === 3 ? postedAccountId === 3 ? Math.round((246.73 - amount) * 100) / 100 : 246.73 : account.nativeCurrentBalance,
        })),
        transactions: [{ id: 201, date: "2026-11-25", accountId: postedAccountId, kind: postedAccountId === 3 ? "expense" : "income", currency: "USD", amount, category: "Transfer" }],
        today: "2026-11-25",
      });
      const transfer = result.rows.find((row) => row.entryId === "transfer");
      assert.equal(transfer.completed, false);
      assert.deepEqual(transfer.postedTransferAccountIds, [postedAccountId]);
      assert.equal(transfer.accountMovements.length, 1);
      assert.equal(transfer.accountMovements[0].accountId, postedAccountId === 3 ? 1 : 3);
      assert.equal(result.rows.at(-1).balanceUsd, Math.round((921.4 + amount) * 100) / 100);
      assert.equal(result.rows.at(-1).savingsUsd, Math.round((246.73 - amount) * 100) / 100);
      assert.equal(byId(result, 1).endingBalance, Math.round((921.4 + amount) * 100) / 100);
      assert.equal(byId(result, 3).endingBalance, Math.round((246.73 - amount) * 100) / 100);
    }
  }
});

test("explicit currency conversions debit and credit their native accounts", () => {
  const doc = { ...document, bills: [], allocations: [] };
  const entry = {
    id: "convert",
    date: "2026-11-10",
    description: "Convert",
    kind: "conversion",
    currency: "USD",
    amount: 100,
    fromAccountId: 1,
    toAccountId: 5,
  };
  const result = project(
    { ...plan, includeIncome: false, entries: [entry] },
    doc,
  );
  assert.equal(byId(result, 1).endingBalance, 650);
  assert.equal(byId(result, 5).endingBalance, 16300);
  assert.deepEqual(
    result.rows[0].accountMovements.map((move) => [
      move.accountId,
      move.amount,
      move.currency,
    ]),
    [
      [1, -100, "USD"],
      [5, 6300, "PHP"],
    ],
  );
});

test("recorded transfer legs replace forecast bank movements once while savings stays allocated", () => {
  const doc = { ...document, bills: [], allocations: document.allocations };
  const transactions = [
    {
      id: 11,
      date: "2026-11-06",
      amount: 500,
      currency: "USD",
      kind: "expense",
      accountId: 1,
      category: "Transfer Out",
      merchant: "Savings transfer",
    },
    {
      id: 12,
      date: "2026-11-06",
      amount: 500,
      currency: "USD",
      kind: "income",
      accountId: 3,
      category: "Transfer In",
      merchant: "Savings transfer",
    },
  ];
  const result = project(
    { ...plan, endDate: "2026-11-06", includeIncome: false },
    doc,
    { transactions },
  );
  assert.equal(byId(result, 1).endingBalance, 250);
  assert.equal(byId(result, 3).endingBalance, 500);
  assert.equal(byId(result, 3).savingsAllocated, 500);
  assert.deepEqual(
    result.rows.find((row) => row.source === "allocation").accountMovements,
    [],
  );
  const unmatched = project(
    { ...plan, endDate: "2026-11-06", includeIncome: false },
    doc,
    {
      transactions: transactions.map((transaction) => ({
        ...transaction,
        category: "Shopping",
      })),
    },
  );
  assert.equal(
    byId(unmatched, 3).endingBalance,
    1000,
    "ordinary income is never silently treated as an internal transfer",
  );
});

test("a transfer record cannot replace two separate scheduled savings movements", () => {
  const doc = {
    ...document,
    bills: [],
    allocations: [
      ...document.allocations,
      { ...document.allocations[0], id: "other-save" },
    ],
  };
  const transactions = [
    {
      id: 11,
      date: "2026-11-06",
      amount: 500,
      currency: "USD",
      kind: "expense",
      accountId: 1,
      category: "Transfer Out",
      merchant: "Savings transfer",
    },
    {
      id: 12,
      date: "2026-11-06",
      amount: 500,
      currency: "USD",
      kind: "income",
      accountId: 3,
      category: "Transfer In",
      merchant: "Savings transfer",
    },
  ];
  const result = project(
    { ...plan, endDate: "2026-11-06", includeIncome: false },
    doc,
    { transactions },
  );
  assert.equal(byId(result, 1).endingBalance, -250);
  assert.equal(byId(result, 3).endingBalance, 1000);
});

test("recorded annual charges and reserve repayments move their bank accounts only once", () => {
  const doc = {
    ...document,
    bills: [{ ...document.bills[0], savedAmount: 395 }],
    allocations: [],
  };
  const transactions = [
    {
      id: 11,
      date: "2026-11-28",
      amount: 395,
      currency: "USD",
      kind: "expense",
      accountId: 4,
      category: "Bills",
      merchant: "Venture X",
    },
    {
      id: 12,
      date: "2026-11-28",
      amount: 395,
      currency: "USD",
      kind: "expense",
      accountId: 2,
      category: "Transfer Out",
      merchant: "Credit repayment",
    },
    {
      id: 13,
      date: "2026-11-28",
      amount: 395,
      currency: "USD",
      kind: "income",
      accountId: 4,
      category: "Transfer In",
      merchant: "Credit repayment",
    },
  ];
  const result = project(
    {
      ...plan,
      includeIncome: false,
      includeAnnualReserve: false,
      accountOpeningBalances: [
        { accountId: 2, balance: 395 },
        { accountId: 4, balance: 0 },
      ],
    },
    doc,
    { transactions },
  );
  assert.equal(byId(result, 2).endingBalance, 0);
  assert.equal(byId(result, 4).endingBalance, 0);
  const annual = result.rows.find((row) => row.annualPayment);
  assert.equal(annual.source, "transaction");
  assert.deepEqual(
    annual.accountMovements.map((move) => [move.accountId, move.amount]),
    [[4, -395]],
  );
});

test("forecast reconciliation respects the assigned salary and bill account", () => {
  const doc = {
    ...document,
    bills: [{ ...document.bills[1], accountId: 4 }],
    allocations: [],
  };
  const transactions = [
    {
      id: 1,
      date: "2026-11-06",
      kind: "income",
      amount: 1000,
      currency: "USD",
      accountId: 3,
      merchant: "Salary",
    },
    {
      id: 2,
      date: "2026-11-18",
      kind: "expense",
      amount: 20,
      currency: "USD",
      accountId: 1,
      merchant: "Monthly subscription",
    },
  ];
  const rows = buildPlanRows(plan, doc, 63, {
    transactions,
    today: "2026-11-02",
  });
  assert.equal(rows.filter((row) => row.source === "salary").length, 2);
  assert.equal(rows.filter((row) => row.source === "bill").length, 1);
  const matching = buildPlanRows(plan, doc, 63, {
    transactions: transactions.map((row) => ({
      ...row,
      accountId: row.kind === "income" ? 1 : 4,
    })),
    today: "2026-11-02",
  });
  assert.equal(matching.filter((row) => row.source === "salary").length, 1);
  assert.equal(matching.filter((row) => row.source === "bill").length, 0);
  assert.equal(matching.find((row) => row.transactionId === 2).accountId, 4);
});

test("bank-snapshot openings exclude already posted activity and historical forecasts", () => {
  const bank = [{ ...accounts[0], nativeCurrentBalance: 100 }];
  const doc = { salary: { ...salary, amount: 0 }, bills: [], allocations: [] };
  const planner = {
    ...plan,
    includeIncome: false,
    accountOpeningBalances: [],
    entries: [
      {
        id: "old",
        date: "2026-11-01",
        description: "Old forecast",
        kind: "expense",
        amount: 40,
        currency: "USD",
        accountId: 1,
      },
      {
        id: "future",
        date: "2026-11-03",
        description: "Future forecast",
        kind: "expense",
        amount: 30,
        currency: "USD",
        accountId: 1,
      },
    ],
  };
  const transactions = [
    {
      id: 5,
      date: "2026-11-02",
      kind: "expense",
      amount: 20,
      currency: "USD",
      accountId: 1,
      merchant: "Already posted",
    },
  ];
  const result = buildAccountPlan(planner, doc, 63, {
    accounts: bank,
    transactions,
    today: "2026-11-02",
  });
  assert.equal(byId(result, 1).openingBalance, 100);
  assert.equal(byId(result, 1).endingBalance, 70);
  assert.equal(result.openingSource, "bank");
  assert.ok(
    result.warnings.some((message) => message.includes("historical plan")),
  );
  assert.equal(
    result.rows.find((row) => row.transactionId === 5).accountMovements.length,
    0,
  );
});

test("unavailable and different-currency assignments produce warnings instead of imaginary conversions", () => {
  const doc = {
    ...document,
    bills: [],
    allocations: [
      {
        id: "php",
        name: "PHP savings",
        currency: "PHP",
        amount: 100,
        kind: "savings",
        accountId: 5,
      },
    ],
  };
  const result = project(
    { ...plan, endDate: "2026-11-06", includeIncome: false },
    doc,
  );
  assert.equal(byId(result, 1).endingBalance, 750);
  assert.equal(byId(result, 5).endingBalance, 10100);
  assert.ok(
    result.warnings.some((message) => message.includes("explicit conversion")),
  );
  const removed = project(
    { ...plan, endDate: "2026-11-06" },
    { ...document, allocations: [], bills: [] },
    {
      accounts: accounts.map((account) =>
        account.id === 1 ? { ...account, isArchived: true } : account,
      ),
    },
  );
  assert.equal(byId(removed, 1).endingBalance, 750);
  assert.ok(
    removed.warnings.some((message) =>
      message.includes("unavailable or removed"),
    ),
  );
});
