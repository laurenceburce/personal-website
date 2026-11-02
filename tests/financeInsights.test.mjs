import test from "node:test";
import assert from "node:assert/strict";
import { getFinanceInsights } from "../app/lib/financeInsights.mjs";

const salary = {
  amount: 2000,
  currency: "USD",
  payFrequency: "semimonthly",
  firstPayDate: "2026-11-06",
};
const document = { salary, bills: [], allocations: [], plans: [] };
const transaction = (
  id,
  kind,
  amount,
  currency = "USD",
  date = "2026-11-01",
  extra = {},
) => ({ id, kind, amount, currency, date, ...extra });
const insights = (options = {}) =>
  getFinanceInsights({
    document,
    activity: {},
    rate: 63,
    month: "2026-11",
    today: "2026-11-02",
    ...options,
  });

test("actual metrics convert currencies and exclude pending and future transactions", () => {
  const result = insights({
    activity: {
      transactions: [
        transaction(1, "income", 1000),
        transaction(2, "expense", 630, "PHP"),
        transaction(3, "expense", 200, "USD", "2026-11-01", { pending: true }),
        transaction(4, "income", 1000, "USD", "2026-11-06"),
      ],
    },
  });
  assert.equal(result.income, 1000);
  assert.equal(result.expenses, 10);
  assert.equal(result.net, 990);
  assert.equal(result.transactionCount, 2);
  assert.equal(result.pendingCount, 1);
  assert.equal(result.scheduledCount, 1);
  assert.equal(result.recentTransactions.length, 4);
});

test("planned salary and bills never count as actual income or spending", () => {
  const result = insights({
    document: {
      ...document,
      bills: [
        {
          id: "rent",
          name: "Rent",
          amount: 600,
          currency: "USD",
          cadence: "monthly",
          dueDay: 1,
          dueMonths: [],
        },
      ],
    },
  });
  assert.equal(result.income, 0);
  assert.equal(result.expenses, 0);
  assert.equal(result.plannedIncome, 2000);
  assert.equal(result.plannedCommitted, 600);
  assert.equal(result.plannedRemaining, 1400);
});

test("net worth uses native balances and subtracts credit and loan liabilities once", () => {
  const result = insights({
    activity: {
      accounts: [
        { type: "checking", currency: "USD", nativeCurrentBalance: 1000 },
        { type: "savings", currency: "PHP", nativeCurrentBalance: 6300 },
        { type: "credit", currency: "USD", nativeCurrentBalance: 200 },
        { type: "loan", currency: "PHP", nativeCurrentBalance: 3150 },
        { type: "cash", currency: "USD", nativeCurrentBalance: null },
      ],
    },
  });
  assert.equal(result.assets, 1100);
  assert.equal(result.liabilities, 250);
  assert.equal(result.netWorth, 850);
  assert.equal(result.unavailableAccountCount, 1);
  assert.equal(result.knownAccountCount, 4);
});

test("an overpaid credit balance increases net worth rather than becoming debt", () => {
  const result = insights({
    activity: {
      accounts: [
        { type: "credit", currency: "PHP", nativeCurrentBalance: -630 },
      ],
    },
  });
  assert.equal(result.netWorth, 10);
  assert.equal(result.liabilities, -10);
});

test("bank transfers and loan repayments do not inflate earned income or consumption", () => {
  const result = insights({
    activity: {
      transactions: [
        transaction(1, "income", 1000, "USD", "2026-11-01", {
          category: "Transfer In",
        }),
        transaction(2, "expense", 500, "USD", "2026-11-01", {
          category: " transfer  OUT ",
        }),
        transaction(3, "expense", 100, "USD", "2026-11-01", {
          category: "Loan Payments",
        }),
        transaction(4, "expense", 50, "USD", "2026-11-01", {
          category: "Payment for groceries",
        }),
      ],
    },
  });
  assert.equal(result.income, 0);
  assert.equal(result.expenses, 50);
  assert.equal(result.transferCount, 3);
  assert.equal(result.recentTransactions.length, 4);
});

test("missing and unsupported account balances are unavailable rather than invented zero", () => {
  assert.equal(insights().netWorth, null);
  const result = insights({
    activity: {
      accounts: [
        { currency: "EUR", nativeCurrentBalance: 99 },
        { currency: "USD", nativeCurrentBalance: null },
      ],
    },
  });
  assert.equal(result.netWorth, null);
  assert.equal(result.unavailableAccountCount, 2);
});

test("a six-month series spans year boundaries, zero fills months and excludes older records", () => {
  const result = insights({
    month: "2027-02",
    today: "2027-02-15",
    activity: {
      transactions: [
        transaction(1, "income", 100, "USD", "2026-09-01"),
        transaction(2, "expense", 30, "USD", "2026-12-31"),
        transaction(3, "income", 9000, "USD", "2026-08-31"),
      ],
    },
  });
  assert.deepEqual(
    result.series.map((row) => row.month),
    ["2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02"],
  );
  assert.equal(result.series[0].income, 100);
  assert.equal(result.series[3].net, -30);
  assert.equal(result.series[5].income, 0);
});

test("PHP charts and allocation values preserve native PHP amounts", () => {
  const result = insights({
    currency: "PHP",
    document: {
      ...document,
      bills: [
        {
          id: "bill",
          name: "Bill",
          amount: 169.01,
          currency: "PHP",
          cadence: "monthly",
          dueDay: 11,
          dueMonths: [],
        },
      ],
    },
    activity: { transactions: [transaction(1, "expense", 169.01, "PHP")] },
  });
  assert.equal(result.expenses, 169.01);
  assert.equal(result.plannedIncome, 126000);
  assert.equal(
    result.allocationSegments.find((segment) => segment.id === "php-bills")
      .value,
    169.01,
  );
});

test("negative cashflow and an over-budget plan are preserved without negative donut segments", () => {
  const result = insights({
    document: {
      ...document,
      allocations: [{ amount: 1100, currency: "USD", kind: "savings" }],
    },
    activity: { transactions: [transaction(1, "expense", 100)] },
  });
  assert.equal(result.net, -100);
  assert.equal(result.plannedCommitted, 2200);
  assert.equal(result.plannedRemaining, -200);
  assert.equal(result.overBudget, 200);
  assert.ok(result.allocationSegments.every((segment) => segment.value >= 0));
  assert.equal(
    result.allocationSegments.find((segment) => segment.id === "remaining")
      .value,
    0,
  );
});

test("true biweekly allocations annualize over 26 periods and annual reserves count once", () => {
  const result = insights({
    document: {
      ...document,
      salary: { ...salary, payFrequency: "biweekly" },
      allocations: [{ amount: 120, currency: "USD" }],
      bills: [
        {
          id: "annual",
          name: "Annual",
          amount: 120,
          currency: "USD",
          cadence: "annual",
          dueDay: 9,
          dueMonths: [11],
        },
      ],
    },
  });
  assert.equal(
    result.allocationSegments.find((segment) => segment.id === "allocations")
      .value,
    260,
  );
  assert.equal(result.plannedCommitted, 270);
  assert.equal(result.scheduledBills[0].amount, 120);
});

test("changing annual savings recalculates planned commitments and chart allocations in either direction", () => {
  const annual = {
    id: "venture",
    name: "Venture X",
    amount: 395,
    currency: "USD",
    cadence: "annual",
    dueDay: 28,
    dueMonths: [11],
  };
  const activity = {
    transactions: [
      transaction(1, "income", 1000),
      transaction(2, "expense", 395),
    ],
  };
  const states = [
    { saved: 0, reserve: 32.92, committed: 742.92, remaining: 1257.08 },
    { saved: 100, reserve: 24.58, committed: 734.58, remaining: 1265.42 },
    { saved: 395, reserve: 0, committed: 710, remaining: 1290 },
    { saved: 100, reserve: 24.58, committed: 734.58, remaining: 1265.42 },
  ];
  for (const state of states) {
    const result = insights({
      document: {
        ...document,
        bills: [
          { ...annual, savedAmount: state.saved },
          { id: "rent", amount: 600, currency: "USD", cadence: "monthly" },
          { id: "internet", amount: 630, currency: "PHP", cadence: "monthly" },
        ],
        allocations: [{ amount: 50, currency: "USD", kind: "savings" }],
      },
      activity,
    });
    assert.equal(
      result.allocationSegments.find((segment) => segment.id === "annual")
        .value,
      state.reserve,
    );
    assert.equal(result.plannedCommitted, state.committed);
    assert.equal(result.plannedRemaining, state.remaining);
    assert.equal(
      result.allocationSegments.find((segment) => segment.id === "remaining")
        .value,
      state.remaining,
    );
    assert.equal(result.allocationTotal, 2000);
    assert.deepEqual(
      [result.income, result.expenses, result.net],
      [1000, 395, 605],
      "saved balances do not rewrite posted activity",
    );
    assert.equal(
      result.scheduledBills.find((bill) => bill.billId === "venture").amount,
      395,
    );
  }
});

test("an overfunded USD bill does not offset another annual bill's native PHP funding", () => {
  const mixedDocument = {
    ...document,
    bills: [
      {
        id: "usd",
        amount: 395,
        savedAmount: 500,
        currency: "USD",
        cadence: "annual",
      },
      {
        id: "php",
        amount: 12600,
        savedAmount: 6300,
        currency: "PHP",
        cadence: "annual",
      },
    ],
  };
  const usd = insights({ document: mixedDocument });
  const php = insights({ document: mixedDocument, currency: "PHP" });
  assert.equal(
    usd.allocationSegments.find((segment) => segment.id === "annual").value,
    8.33,
  );
  assert.equal(usd.plannedRemaining, 1991.67);
  assert.equal(
    php.allocationSegments.find((segment) => segment.id === "annual").value,
    525,
  );
  assert.equal(php.plannedRemaining, 125475);
  const fullyFunded = insights({
    document: {
      ...mixedDocument,
      bills: mixedDocument.bills.map((bill) => ({
        ...bill,
        savedAmount: bill.amount + 10,
      })),
    },
  });
  assert.equal(fullyFunded.plannedCommitted, 0);
  assert.equal(fullyFunded.plannedRemaining, 2000);
});

test("zero salary and empty activity produce an empty chart without invalid numbers", () => {
  const result = insights({
    document: { ...document, salary: { ...salary, amount: 0 } },
  });
  assert.equal(result.allocationTotal, 0);
  assert.equal(result.hasHistory, false);
  assert.equal(result.net, 0);
  assert.ok(
    result.series.every(
      (period) => period.income === 0 && period.expenses === 0,
    ),
  );
});

test("scheduled bills clamp dates, split annual installments, and flag open dates", () => {
  const result = insights({
    month: "2027-02",
    today: "2027-02-02",
    document: {
      ...document,
      bills: [
        {
          id: "monthly",
          name: "Monthly",
          amount: 10,
          currency: "USD",
          cadence: "monthly",
          dueDay: 31,
          dueMonths: [],
        },
        {
          id: "annual",
          name: "Annual",
          amount: 100,
          currency: "USD",
          cadence: "annual",
          dueDay: 4,
          dueMonths: [2, 8],
        },
        {
          id: "open",
          name: "Undated",
          amount: 50,
          currency: "USD",
          cadence: "monthly",
          dueDay: null,
          dueMonths: [],
        },
      ],
    },
  });
  assert.deepEqual(
    result.scheduledBills.map((bill) => [bill.name, bill.date, bill.amount]),
    [
      ["Annual", "2027-02-04", 50],
      ["Monthly", "2027-02-28", 10],
    ],
  );
  assert.equal(result.undatedBillCount, 1);
});

test("partial and unsupported currency data are explicitly identified", () => {
  const result = insights({
    activity: {
      limitHit: true,
      transactions: [
        transaction(1, "income", 100, "EUR"),
        transaction(2, "income", 50),
      ],
    },
  });
  assert.equal(result.income, 50);
  assert.equal(result.partial, true);
  assert.equal(result.excludedUnsupportedCount, 1);
});
