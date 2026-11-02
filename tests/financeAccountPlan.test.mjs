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
