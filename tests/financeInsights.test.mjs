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

const paydayBill = (id, amount, currency = "PHP") => ({
  id,
  name: id,
  amount,
  currency,
  cadence: "payday",
  dueDay: null,
  dueDays: [],
  dueMonths: [],
  savedAmount: 0,
});

test("payday bills appear on salary dates with full native payments and no missing-date warning", () => {
  const planner = {
    ...document,
    salary: { ...salary, payFrequency: "biweekly", firstPayDate: "2026-10-23" },
    bills: [
      paydayBill("House", 19000),
      paydayBill("US payment", 25.5, "USD"),
      {
        id: "internet",
        name: "Internet",
        amount: 2500,
        currency: "PHP",
        cadence: "monthly",
        dueDay: 11,
        dueMonths: [],
      },
    ],
  };
  const result = insights({ document: planner });
  assert.equal(result.undatedBillCount, 0);
  assert.deepEqual(
    result.scheduledBills
      .filter((bill) => bill.name === "House")
      .map((bill) => [bill.date, bill.amount, bill.currency]),
    [
      ["2026-11-06", 19000, "PHP"],
      ["2026-11-20", 19000, "PHP"],
    ],
  );
  assert.deepEqual(
    result.scheduledBills
      .filter((bill) => bill.name === "US payment")
      .map((bill) => [bill.date, bill.amount, bill.currency]),
    [
      ["2026-11-06", 25.5, "USD"],
      ["2026-11-20", 25.5, "USD"],
    ],
  );
  assert.equal(result.scheduledBills.length, 5);
  const withUndated = insights({
    document: {
      ...planner,
      bills: [
        ...planner.bills,
        {
          id: "open",
          cadence: "monthly",
          amount: 1,
          currency: "USD",
          dueDay: null,
        },
      ],
    },
  });
  assert.equal(withUndated.undatedBillCount, 1);
});

test("changing the salary schedule regenerates payday bills including three-payday months", () => {
  const planner = {
    ...document,
    salary: { ...salary, payFrequency: "biweekly", firstPayDate: "2026-10-23" },
    bills: [paydayBill("House", 19000)],
  };
  const dates = (result) => result.scheduledBills.map((bill) => bill.date);
  assert.deepEqual(dates(insights({ document: planner, month: "2027-01" })), [
    "2027-01-01",
    "2027-01-15",
    "2027-01-29",
  ]);
  assert.deepEqual(
    dates(
      insights({
        document: {
          ...planner,
          salary: { ...planner.salary, firstPayDate: "2026-10-30" },
        },
      }),
    ),
    ["2026-11-13", "2026-11-27"],
  );
  assert.deepEqual(
    dates(
      insights({
        document: {
          ...planner,
          salary: { ...planner.salary, payFrequency: "semimonthly" },
        },
      }),
    ),
    ["2026-11-08", "2026-11-23"],
  );
  assert.deepEqual(
    dates(
      insights({
        document: {
          ...planner,
          salary: { ...planner.salary, firstPayDate: "2026-12-04" },
        },
      }),
    ),
    [],
  );
});

test("allocation charts include monthly equivalents of payday bills without adding recorded activity", () => {
  const planner = {
    ...document,
    salary: {
      ...salary,
      amount: 2600,
      payFrequency: "biweekly",
      firstPayDate: "2026-10-23",
    },
    bills: [
      paydayBill("USD payday", 26, "USD"),
      paydayBill("PHP payday", 6300),
      {
        id: "monthly-usd",
        name: "US monthly",
        amount: 62,
        currency: "USD",
        cadence: "monthly",
        dueDay: 11,
        dueMonths: [],
      },
      {
        id: "monthly-php",
        name: "PH monthly",
        amount: 630,
        currency: "PHP",
        cadence: "monthly",
        dueDay: 11,
        dueMonths: [],
      },
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
  };
  const activity = {
    transactions: [
      transaction(1, "income", 1000),
      transaction(2, "expense", 630, "PHP"),
    ],
  };
  const before = structuredClone({ planner, activity });
  const usd = insights({ document: planner, activity });
  const php = insights({ document: planner, activity, currency: "PHP" });
  assert.equal(
    usd.allocationSegments.find((segment) => segment.id === "usd-bills").value,
    118.33,
  );
  assert.equal(
    usd.allocationSegments.find((segment) => segment.id === "php-bills").value,
    226.67,
  );
  assert.equal(usd.plannedCommitted, 605);
  assert.equal(usd.plannedRemaining, 1995);
  assert.equal(
    php.allocationSegments.find((segment) => segment.id === "php-bills").value,
    14280,
  );
  assert.equal(php.plannedCommitted, 38114.79);
  assert.equal(usd.income, 1000);
  assert.equal(usd.expenses, 10);
  assert.equal(usd.transactionCount, 2);
  assert.equal(php.expenses, 630);
  assert.deepEqual({ planner, activity }, before);
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
  assert.equal(result.plannedCommitted, 520);
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
    { saved: 0, reserve: 395, committed: 1105, remaining: 895 },
    { saved: 100, reserve: 295, committed: 1005, remaining: 995 },
    { saved: 395, reserve: 0, committed: 710, remaining: 1290 },
    { saved: 100, reserve: 295, committed: 1005, remaining: 995 },
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

const annualDeadlineDocument = {
  ...document,
  salary: { ...salary, payFrequency: "biweekly", firstPayDate: "2026-10-23" },
  bills: [
    {
      id: "microsoft",
      name: "Microsoft",
      cadence: "annual",
      amount: 100,
      savedAmount: 14.79,
      currency: "USD",
      dueDay: 9,
      dueMonths: [9],
    },
    {
      id: "domain",
      name: "Namecheap",
      cadence: "annual",
      amount: 20,
      savedAmount: 8.27,
      currency: "USD",
      dueDay: 4,
      dueMonths: [6],
    },
    {
      id: "venture",
      name: "Venture X",
      cadence: "annual",
      amount: 395,
      savedAmount: 395,
      currency: "USD",
      dueDay: 28,
      dueMonths: [11],
    },
    {
      id: "car",
      name: "Car Maintenance",
      cadence: "annual",
      amount: 500,
      savedAmount: 85.64,
      currency: "USD",
      dueDay: 1,
      dueMonths: [3, 9],
    },
  ],
};

test("annual chart funding uses actual remaining paydays and the next split installment", () => {
  const result = insights({ document: annualDeadlineDocument });
  const funding = new Map(
    result.annualFunding.map((bill) => [bill.billId, bill]),
  );
  assert.deepEqual(
    ["microsoft", "domain", "venture", "car"].map((id) => {
      const bill = funding.get(id);
      return [
        bill.nextDueDate,
        bill.installmentAmount,
        bill.paydaysRemaining,
        bill.perPeriodAmount,
      ];
    }),
    [
      ["2027-09-09", 100, 22, 3.88],
      ["2027-06-04", 20, 16, 0.74],
      ["2026-11-28", 395, 2, 0],
      ["2027-03-01", 250, 9, 18.27],
    ],
  );
  assert.equal(funding.get("car").remainingForNextPayment, 164.36);
  assert.equal(result.annualFundingAsOf, "2026-11-02");
  assert.equal(result.annualImmediate, 0);
  assert.equal(result.annualEstimatedCount, 0);
  assert.equal(result.plannedCommitted, 49.6);
  assert.equal(result.plannedRemaining, 1950.4);
  assert.equal(
    result.allocationSegments.find((segment) => segment.id === "annual").value,
    49.6,
  );
  assert.equal(result.income, 0);
  assert.equal(result.expenses, 0);
});

test("changing the selected history month does not move the annual funding reference date", () => {
  const current = insights({ document: annualDeadlineDocument });
  for (const month of ["2026-08", "2027-03", "2027-11"]) {
    const changed = insights({ document: annualDeadlineDocument, month });
    assert.equal(changed.annualFundingAsOf, "2026-11-02");
    assert.deepEqual(changed.annualFunding, current.annualFunding);
    assert.equal(changed.plannedCommitted, current.plannedCommitted);
  }
});

test("annual funding recalculates from edited due dates, salary dates and saved balances", () => {
  const car = annualDeadlineDocument.bills.find((bill) => bill.id === "car");
  const fundingForCar = (options) =>
    insights(options).annualFunding.find((bill) => bill.billId === "car");
  const dueLater = fundingForCar({
    document: { ...annualDeadlineDocument, bills: [{ ...car, dueDay: 15 }] },
  });
  assert.equal(dueLater.nextDueDate, "2027-03-15");
  assert.equal(dueLater.paydaysRemaining, 10);
  assert.equal(dueLater.perPeriodAmount, 16.44);
  const differentSalary = fundingForCar({
    document: {
      ...annualDeadlineDocument,
      salary: { ...annualDeadlineDocument.salary, firstPayDate: "2026-10-30" },
      bills: [car],
    },
  });
  assert.equal(differentSalary.paydaysRemaining, 8);
  assert.equal(differentSalary.perPeriodAmount, 20.55);
  for (const [savedAmount, expected] of [
    [100, 16.67],
    [250, 0],
    [500, 0],
    [85.64, 18.27],
  ]) {
    const changed = fundingForCar({
      document: { ...annualDeadlineDocument, bills: [{ ...car, savedAmount }] },
    });
    assert.equal(changed.perPeriodAmount, expected);
  }
});

test("annual amounts due before the next payday remain visible in the overview currency", () => {
  const urgent = {
    ...annualDeadlineDocument,
    bills: [
      {
        id: "usd",
        name: "USD due",
        cadence: "annual",
        amount: 100,
        savedAmount: 25,
        currency: "USD",
        dueDay: 4,
        dueMonths: [11],
      },
      {
        id: "php",
        name: "PHP due",
        cadence: "annual",
        amount: 6300,
        savedAmount: 0,
        currency: "PHP",
        dueDay: 5,
        dueMonths: [11],
      },
    ],
  };
  const usd = insights({ document: urgent });
  const php = insights({ document: urgent, currency: "PHP" });
  assert.equal(usd.annualImmediate, 175);
  assert.equal(php.annualImmediate, 11025);
  assert.equal(usd.annualEstimatedCount, 0);
  assert.equal(
    usd.allocationSegments.find((segment) => segment.id === "annual").value,
    0,
  );
  assert.ok(
    usd.annualFunding.every(
      (bill) => bill.paydaysRemaining === 0 && bill.immediateAmount > 0,
    ),
  );
});

test("undated annual funding remains visibly estimated while dated funding uses payday counts", () => {
  const result = insights({
    document: {
      ...annualDeadlineDocument,
      bills: [
        {
          id: "estimated",
          cadence: "annual",
          amount: 260,
          savedAmount: 0,
          currency: "USD",
          dueDay: null,
          dueMonths: [11],
        },
        { ...annualDeadlineDocument.bills[0] },
      ],
    },
  });
  assert.equal(result.annualEstimatedCount, 1);
  assert.equal(
    result.annualFunding.find((bill) => bill.billId === "estimated").estimated,
    true,
  );
  assert.equal(
    result.annualFunding.find((bill) => bill.billId === "microsoft").estimated,
    false,
  );
});

test("a small native PHP immediate shortfall remains visible even when its USD equivalent rounds to zero", () => {
  const result = insights({
    document: {
      ...annualDeadlineDocument,
      bills: [
        {
          id: "tiny",
          name: "Tiny native fee",
          cadence: "annual",
          amount: 0.01,
          currency: "PHP",
          dueDay: 4,
          dueMonths: [11],
        },
      ],
    },
  });
  assert.equal(result.annualImmediate, 0);
  assert.equal(result.annualImmediateUsd, 0);
  assert.equal(result.annualImmediatePhp, 0.01);
  assert.equal(result.annualFunding[0].immediateAmount, 0.01);
});
