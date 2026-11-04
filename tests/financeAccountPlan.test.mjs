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

test("live selected percentages override old account snapshots and follow refreshed balances", () => {
  const current = { ...plan, startingAccounts: [{ accountId: 1, percentage: 80 }], includeIncome: false, includeAnnualReserve: false, includeAllocations: false };
  const doc = { salary, bills: [], allocations: [] };
  const refreshed = structuredClone(accounts);
  let result = project(current, doc, { accounts: refreshed });
  assert.equal(result.openingSource, "live");
  assert.equal(byId(result, 1).openingBalance, 600);
  assert.equal(byId(result, 1).endingBalance, 600);
  refreshed[0].nativeCurrentBalance = 1000;
  result = project(current, doc, { accounts: refreshed });
  assert.equal(byId(result, 1).openingBalance, 800);
  assert.equal(byId(result, 1).endingBalance, 800);
  assert.equal(current.accountOpeningBalances[0].balance, 750);
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
  assert.equal(byId(result, 2).endingBalance, 0);
  assert.equal(byId(result, 2).endingAnnualReserved, 0);
  assert.equal(byId(result, 3).endingBalance, 1000);
  assert.equal(byId(result, 3).savingsAllocated, 1000);
  assert.equal(
    byId(result, 4).endingBalance,
    20,
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
      [2, -395, -395],
      [4, 395, -395],
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

test("annual card reserve release projects the new charge without a physical reserve payment", () => {
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
  assert.equal(result.accounts.find((account) => account.accountId === 1).endingBalance, 1200);
  assert.equal(result.accounts.find((account) => account.accountId === 1).endingAnnualReserved, 0);
  assert.equal(result.accounts.find((account) => account.accountId === 2).endingBalance, 200);
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
