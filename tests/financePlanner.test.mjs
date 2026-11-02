import test from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  annualSavingsTarget,
  billDueDays,
  billOccurrences,
  buildPlanRows,
  convert,
  formatDate,
  getAnnualBillFunding,
  getAnnualReserveOpening,
  getSummary,
  localDate,
  salaryOccurrences,
} from "../app/lib/financePlanner.mjs";

const salary = {
  amount: 2000,
  currency: "USD",
  payFrequency: "semimonthly",
  firstPayDate: "2026-11-06",
};
const monthly = (id, amount, currency = "USD", dueDay = 18) => ({
  id,
  name: id,
  amount,
  currency,
  cadence: "monthly",
  dueDay,
  dueMonths: [],
});
const annual = (id, amount, currency = "USD", dueDay = 9, dueMonths = [9]) => ({
  id,
  name: id,
  amount,
  currency,
  cadence: "annual",
  dueDay,
  dueMonths,
});

test("monthly and pay-period summaries reserve annual bills exactly once", () => {
  const document = {
    salary,
    bills: [
      monthly("US bills", 62),
      monthly("PH bills", 4200, "PHP"),
      annual("Microsoft", 100),
      annual("Domain", 20),
      annual("Car", 500, "USD", 9, [3, 9]),
      annual("Venture X", 395),
    ],
    allocations: [{ amount: 500, currency: "USD", kind: "savings" }],
  };
  const summary = getSummary(document, 63);
  assert.equal(summary.monthlyUsd, 2000);
  assert.equal(summary.monthlyPhp, 126000);
  assert.equal(summary.annualUsd, 1015);
  assert.equal(summary.annualMonthlyUsd, 84.58);
  assert.equal(summary.billsUsdPerPeriod, 31);
  assert.equal(summary.billsPhpPerPeriod, 2100);
  assert.equal(summary.billsPhpPerPeriodUsd, 33.33);
  assert.equal(summary.annualPerPeriodUsd, 42.29);
  assert.equal(summary.remainingPerPeriodUsd, 893.38);
  assert.equal(summary.unallocatedPerPeriodUsd, 393.38);
  assert.equal(summary.monthlyCommitmentsUsd, 213.25);
});

test("true biweekly pay annualizes income and expenses over 26 periods", () => {
  const document = {
    salary: { ...salary, payFrequency: "biweekly" },
    bills: [monthly("Bills", 260), annual("Annual", 260)],
    allocations: [],
  };
  const summary = getSummary(document, 63);
  assert.equal(summary.payPeriods, 26);
  assert.equal(summary.incomePerPeriodUsd, 923.08);
  assert.equal(summary.billsUsdPerPeriod, 120);
  assert.equal(summary.annualPerPeriodUsd, 10);
  assert.equal(summary.remainingPerPeriodUsd, 793.08);
});

test("PHP salary and allocations keep native currency and convert once", () => {
  const summary = getSummary(
    {
      salary: { ...salary, amount: 126000, currency: "PHP" },
      bills: [annual("PHP annual", 6300, "PHP")],
      allocations: [{ amount: 6300, currency: "PHP" }],
    },
    63,
  );
  assert.equal(summary.monthlyUsd, 2000);
  assert.equal(summary.monthlyPhp, 126000);
  assert.equal(summary.annualUsd, 100);
  assert.equal(summary.allocationsPerPeriodUsd, 100);
});

test("PHP summary totals preserve native cents instead of round-tripping rounded USD", () => {
  const summary = getSummary(
    {
      salary: { ...salary, amount: 1000.01, currency: "PHP" },
      bills: [
        monthly("PHP monthly", 169.01, "PHP"),
        monthly("USD monthly", 2),
        annual("PHP annual", 1015.01, "PHP"),
        annual("USD annual", 20),
      ],
      allocations: [],
    },
    63,
  );
  assert.equal(summary.annualPhp, 2275.01);
  assert.equal(summary.annualMonthlyPhp, 189.58);
  assert.equal(summary.monthlyCommitmentsPhp, 484.59);
  assert.equal(summary.monthlyRemainingPhp, 515.42);
  assert.notEqual(
    summary.annualPhp,
    convert(summary.annualUsd, "USD", "PHP", 63),
  );
});

test("annual funding follows saved balances without changing the bill or calendar target", () => {
  const bill = { ...annual("Venture X", 395, "USD", 28, [11]), savedAmount: 100 };
  const before = JSON.stringify(bill);
  assert.deepEqual(getAnnualBillFunding(bill), {
    amount: 395,
    savedAmount: 100,
    remainingAmount: 295,
    monthlyAmount: 24.58,
    perPeriodAmount: 11.35,
    fullyFunded: false,
  });
  assert.equal(getAnnualBillFunding(bill, 24).perPeriodAmount, 12.29);
  for (const savedAmount of [395, 500]) {
    const funded = getAnnualBillFunding({ ...bill, savedAmount });
    assert.equal(funded.savedAmount, savedAmount);
    assert.equal(funded.remainingAmount, 0);
    assert.equal(funded.monthlyAmount, 0);
    assert.equal(funded.perPeriodAmount, 0);
    assert.equal(funded.fullyFunded, true);
    assert.deepEqual(
      annualSavingsTarget({ ...bill, savedAmount }, "2026-11-02"),
      annualSavingsTarget(bill, "2026-11-02"),
    );
  }
  assert.equal(JSON.stringify(bill), before);
});

test("annual funding sanitizes legacy values and excludes monthly savings", () => {
  for (const savedAmount of [undefined, -10, "invalid", Number.POSITIVE_INFINITY]) {
    assert.equal(getAnnualBillFunding({ ...annual("Legacy", 395), savedAmount }).remainingAmount, 395);
  }
  assert.equal(getAnnualBillFunding({ ...annual("PHP", "6300.01", "PHP"), savedAmount: "1260.01" }).remainingAmount, 5040);
  assert.deepEqual(getAnnualBillFunding({ ...monthly("Monthly", 20), savedAmount: 10 }), getAnnualBillFunding());
  assert.equal(getAnnualBillFunding(annual("Invalid", -10)).amount, 0);
  assert.equal(getAnnualBillFunding(annual("Invalid", "invalid")).remainingAmount, 0);
  assert.equal(getAnnualBillFunding(annual("Fallback", 260), 0).perPeriodAmount, 10);
});

test("summary funding clamps each item before aggregating native USD and PHP balances", () => {
  const document = {
    salary: { ...salary, payFrequency: "biweekly" },
    bills: [
      { ...annual("Funded", 100), savedAmount: 250 },
      { ...annual("Venture X", 395), savedAmount: 100 },
      { ...annual("PHP", 6300.01, "PHP"), savedAmount: 1260.01 },
      { ...monthly("Monthly", 50), savedAmount: 999 },
    ],
    allocations: [{ amount: 100, currency: "USD" }],
  };
  const summary = getSummary(document, 63);
  assert.equal(summary.annualUsd, 595);
  assert.equal(summary.annualPhp, 37485.01);
  assert.equal(summary.annualSavedUsd, 370);
  assert.equal(summary.annualSavedPhp, 23310.01);
  assert.equal(summary.annualRemainingUsd, 375);
  assert.equal(summary.annualRemainingPhp, 23625);
  assert.equal(summary.annualMonthlyUsd, 31.25);
  assert.equal(summary.annualMonthlyPhp, 1968.75);
  assert.equal(summary.annualPerPeriodUsd, 14.42);
  assert.equal(summary.monthlyCommitmentsUsd, 81.25);
  assert.equal(summary.monthlyRemainingUsd, 1918.75);
  assert.equal(summary.remainingPerPeriodUsd, 885.58);
  assert.equal(summary.unallocatedPerPeriodUsd, 785.58);
});

test("changing saved annual money recomputes all funding-based summary metrics", () => {
  const document = {
    salary: { ...salary, payFrequency: "biweekly" },
    bills: [{ ...annual("Venture X", 395), savedAmount: 395 }],
    allocations: [{ amount: 500, currency: "USD" }],
  };
  const funded = getSummary(document, 63);
  assert.equal(funded.annualMonthlyUsd, 0);
  assert.equal(funded.annualMonthlyPhp, 0);
  assert.equal(funded.annualPerPeriodUsd, 0);
  assert.equal(funded.monthlyRemainingUsd, 2000);
  assert.equal(funded.unallocatedPerPeriodUsd, 423.08);
  document.bills[0].savedAmount = 100;
  const partial = getSummary(document, 63);
  assert.equal(partial.annualUsd, funded.annualUsd);
  assert.equal(partial.annualPhp, funded.annualPhp);
  assert.equal(partial.annualRemainingUsd, 295);
  assert.equal(partial.annualRemainingPhp, 18585);
  assert.equal(partial.annualMonthlyUsd, 24.58);
  assert.equal(partial.annualMonthlyPhp, 1548.75);
  assert.equal(partial.annualPerPeriodUsd, 11.35);
  assert.equal(partial.monthlyCommitmentsUsd, 24.58);
  assert.equal(partial.monthlyRemainingUsd, 1975.42);
  assert.equal(partial.remainingPerPeriodUsd, 911.73);
  assert.equal(partial.unallocatedPerPeriodUsd, 411.73);
});

test("monthly dates clamp to month end across leap years and year boundaries", () => {
  const bill = monthly("Month end", 10, "USD", 31);
  assert.deepEqual(
    billOccurrences(bill, "2024-01-31", "2024-03-31").map((row) => row.date),
    ["2024-01-31", "2024-02-29", "2024-03-31"],
  );
  assert.deepEqual(
    billOccurrences(bill, "2026-12-01", "2027-02-28").map((row) => row.date),
    ["2026-12-31", "2027-01-31", "2027-02-28"],
  );
  assert.deepEqual(
    billOccurrences({ ...bill, dueDay: null }, "2026-11-01", "2026-11-30"),
    [],
  );
});

test("annual installment rounding preserves total and deduplicates months", () => {
  const bill = annual("Installments", 100, "USD", 31, [9, 3, 6, 3]);
  const rows = billOccurrences(bill, "2026-01-01", "2026-12-31");
  assert.deepEqual(
    rows.map(({ date, amount }) => ({ date, amount })),
    [
      { date: "2026-03-31", amount: 33.33 },
      { date: "2026-06-30", amount: 33.33 },
      { date: "2026-09-30", amount: 33.34 },
    ],
  );
  assert.equal(
    rows.reduce((sum, row) => sum + Math.round(row.amount * 100), 0),
    10000,
  );
});

test("salary schedules respect first payday, range edges and leap dates", () => {
  assert.deepEqual(
    salaryOccurrences(salary, "2026-11-01", "2026-12-21").map(
      (row) => row.date,
    ),
    ["2026-11-06", "2026-11-21", "2026-12-06", "2026-12-21"],
  );
  assert.deepEqual(
    salaryOccurrences(
      { ...salary, firstPayDate: "2026-11-20" },
      "2026-11-01",
      "2026-12-31",
    ).map((row) => row.date),
    ["2026-11-20", "2026-12-05", "2026-12-20"],
  );
  assert.deepEqual(
    salaryOccurrences(
      { ...salary, firstPayDate: "2024-01-31" },
      "2024-02-01",
      "2024-02-29",
    ).map((row) => row.date),
    ["2024-02-16", "2024-02-29"],
  );
  const fortnightly = salaryOccurrences(
    { ...salary, payFrequency: "biweekly" },
    "2026-11-07",
    "2026-12-18",
  );
  assert.deepEqual(
    fortnightly.map((row) => row.date),
    ["2026-11-20", "2026-12-04", "2026-12-18"],
  );
  assert.equal(fortnightly[0].amount, 923.08);
});

test("budget ledger generates native bills and income with independent running balances", () => {
  const document = {
    salary,
    bills: [
      monthly("USD bill", 100, "USD", 6),
      monthly("PHP bill", 6300, "PHP", 6),
      annual("Annual", 200, "USD", 6, [3, 11]),
    ],
    allocations: [],
  };
  const plan = {
    startDate: "2026-11-01",
    endDate: "2026-11-06",
    openingUsd: 750,
    openingPhp: 0,
    includeIncome: true,
    entries: [
      {
        id: "fx",
        date: "2026-11-06",
        description: "Convert",
        kind: "conversion",
        amount: 100,
        currency: "USD",
      },
    ],
  };
  const rows = buildPlanRows(plan, document, 63);
  assert.equal(rows.length, 6);
  assert.equal(rows[0].source, "salary");
  assert.equal(rows[1].kind, "conversion");
  assert.equal(rows.at(-1).balanceUsd, 1450);
  assert.equal(rows.at(-1).balancePhp, 0);
  assert.equal(rows.filter((row) => row.source === "bill").length, 3);
  assert.equal(rows.filter((row) => row.source === "reserve").length, 1);
  assert.equal(rows.filter((row) => row.source === "reserveRelease").length, 0);
  assert.equal(rows.at(-1).reserveUsd, 0);
  assert.deepEqual(buildPlanRows(plan, document, 63), rows);
});

test("manual PHP conversions conserve value and negative balances stay visible", () => {
  const plan = {
    startDate: "2026-11-01",
    endDate: "2026-11-30",
    openingUsd: 0,
    openingPhp: 0,
    includeIncome: false,
    entries: [
      {
        id: "convert",
        date: "2026-11-06",
        description: "Convert PHP to USD",
        kind: "conversion",
        amount: 630,
        currency: "PHP",
      },
      {
        id: "expense",
        date: "2026-11-06",
        description: "Expense",
        kind: "expense",
        amount: 20,
        currency: "USD",
      },
      {
        id: "outside",
        date: "2026-12-01",
        description: "Outside range",
        kind: "income",
        amount: 1000,
        currency: "USD",
      },
    ],
  };
  const rows = buildPlanRows(plan, { salary, bills: [] }, 63);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].usd + rows[0].php / 63, 0);
  assert.equal(rows.at(-1).balanceUsd, -10);
  assert.equal(rows.at(-1).balancePhp, -630);
});

test("date helpers use New York calendar dates without DST drift", () => {
  assert.equal(localDate(new Date("2026-11-02T02:00:00Z")), "2026-11-01");
  assert.equal(addDays("2026-03-07", 2), "2026-03-09");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-02-30", 1), "");
  assert.equal(formatDate("2026-11-06"), "Nov 6");
  assert.equal(convert(100, "USD", "PHP", 63), 6300);
  assert.equal(convert(6300, "PHP", "USD", 63), 100);
});

test("monthly bills split the total across two dates and retain legacy single due dates", () => {
  const bill = { ...monthly("Rent", 100.01), dueDays: [20, 5, 20] };
  assert.deepEqual(billDueDays(bill), [5, 20]);
  assert.deepEqual(
    billOccurrences(bill, "2026-11-01", "2026-12-31").map(
      ({ date, amount }) => ({ date, amount }),
    ),
    [
      { date: "2026-11-05", amount: 50 },
      { date: "2026-11-20", amount: 50.01 },
      { date: "2026-12-05", amount: 50 },
      { date: "2026-12-20", amount: 50.01 },
    ],
  );
  assert.equal(
    billOccurrences(bill, "2026-11-10", "2026-11-25")[0].amount,
    50.01,
  );
  assert.deepEqual(billDueDays(monthly("Legacy", 10, "USD", 18)), [18]);
  assert.deepEqual(
    billOccurrences({ ...bill, dueDays: [] }, "2026-11-01", "2026-11-30"),
    [],
  );
  assert.equal(
    getSummary({ salary, bills: [bill], allocations: [] }, 63).billsUsd,
    100.01,
  );
});

test("two monthly dates clamped to the same short-month day preserve the monthly total", () => {
  const bill = { ...monthly("Month end split", 101.01), dueDays: [30, 31] };
  assert.deepEqual(billOccurrences(bill, "2028-02-01", "2028-02-29"), [
    { date: "2028-02-29", amount: 101.01, currency: "USD", billId: bill.id },
  ]);
  assert.equal(
    billOccurrences(bill, "2026-04-01", "2026-04-30")[0].amount,
    101.01,
  );
});

test("annual savings targets progress between renewal dates and are fully funded on the due date", () => {
  const bill = annual("Renewal", 120, "USD", 1, [1]);
  assert.deepEqual(annualSavingsTarget(bill, "2026-01-01"), {
    target: 120,
    currency: "USD",
    cycleStart: "2025-01-01",
    nextDueDate: "2026-01-01",
    installmentAmount: 120,
    progress: 1,
    needsDate: false,
  });
  assert.equal(annualSavingsTarget(bill, "2026-01-02").target, 0.33);
  const afterSeptember = annualSavingsTarget(
    annual("Microsoft", 100),
    "2026-11-02",
  );
  assert.equal(afterSeptember.target, 14.79);
  assert.equal(afterSeptember.cycleStart, "2026-09-09");
  assert.equal(afterSeptember.nextDueDate, "2027-09-09");
});

test("annual target cycles handle leap dates, installment pennies and missing due dates", () => {
  const leap = annual("Leap renewal", 366, "PHP", 29, [2]);
  assert.equal(annualSavingsTarget(leap, "2024-02-28").target, 365);
  assert.equal(annualSavingsTarget(leap, "2024-02-29").target, 366);
  assert.equal(annualSavingsTarget(leap, "2024-03-01").target, 1);
  const installments = annual("Three installments", 100, "USD", 31, [3, 6, 9]);
  assert.equal(annualSavingsTarget(installments, "2026-09-30").target, 33.34);
  assert.equal(annualSavingsTarget(installments, "2026-12-30").target, 16.67);
  const unknown = annualSavingsTarget({ ...leap, dueDay: null }, "2026-11-02");
  assert.equal(unknown.needsDate, true);
  assert.equal(unknown.target, null);
  assert.equal(unknown.nextDueDate, null);
});

test("October 23 anchored biweekly pay stays on Fridays across November DST", () => {
  const anchored = {
    ...salary,
    firstPayDate: "2026-10-23",
    payFrequency: "biweekly",
  };
  assert.deepEqual(
    salaryOccurrences(anchored, "2026-11-01", "2026-12-31").map(
      (row) => row.date,
    ),
    ["2026-11-06", "2026-11-20", "2026-12-04", "2026-12-18"],
  );
  assert.deepEqual(
    salaryOccurrences(
      { ...anchored, payFrequency: "semimonthly" },
      "2026-11-01",
      "2026-11-30",
    ).map((row) => row.date),
    ["2026-11-08", "2026-11-23"],
  );
});

test("full plan flows include allocations, native reserves, one-time transactions and conversions", () => {
  const document = {
    salary: {
      amount: 2600,
      currency: "USD",
      payFrequency: "biweekly",
      firstPayDate: "2026-10-23",
    },
    bills: [
      monthly("Internet", 100, "USD", 10),
      annual("USD reserve", 260, "USD", 9, [12]),
      annual("PHP reserve", 2600, "PHP", 9, [12]),
    ],
    allocations: [
      {
        id: "save",
        name: "Savings",
        amount: 500,
        currency: "USD",
        kind: "savings",
      },
      {
        id: "food",
        name: "Groceries",
        amount: 630,
        currency: "PHP",
        kind: "expense",
      },
    ],
  };
  const plan = {
    startDate: "2026-11-01",
    endDate: "2026-11-30",
    openingUsd: 100,
    openingPhp: 1000,
    includeIncome: true,
    entries: [
      {
        id: "convert",
        date: "2026-11-19",
        description: "Convert",
        kind: "conversion",
        amount: 100,
        currency: "USD",
      },
    ],
  };
  const rows = buildPlanRows(plan, document, 63, {
    transactions: [
      {
        id: 1,
        date: "2026-11-15",
        merchant: "One-time purchase",
        kind: "expense",
        amount: 150,
        currency: "USD",
      },
    ],
  });
  assert.equal(rows.length, 13);
  assert.equal(rows.filter((row) => row.source === "salary").length, 2);
  assert.equal(rows.filter((row) => row.source === "allocation").length, 4);
  assert.equal(rows.filter((row) => row.source === "reserve").length, 4);
  assert.deepEqual(
    {
      usd: rows.at(-1).balanceUsd,
      php: rows.at(-1).balancePhp,
      reserveUsd: rows.at(-1).reserveUsd,
      reservePhp: rows.at(-1).reservePhp,
    },
    { usd: 1130, php: 5840, reserveUsd: 20, reservePhp: 200 },
  );
  const reserve = rows.find((row) => row.source === "reserve");
  assert.equal(
    reserve.usd +
      reserve.php / 63 +
      reserve.reserveDeltaUsd +
      reserve.reserveDeltaPhp / 63,
    0,
  );
});

test("annual payments consume existing reserves before charging available funds", () => {
  const document = {
    salary: { ...salary, firstPayDate: "2026-12-01" },
    bills: [annual("Insurance", 120, "USD", 9, [11])],
    allocations: [],
  };
  const plan = {
    startDate: "2026-11-01",
    endDate: "2026-11-10",
    openingUsd: 100,
    openingPhp: 0,
    openingReserveUsd: 120,
    includeIncome: false,
    includeAnnualReserve: false,
    entries: [],
  };
  const rows = buildPlanRows(plan, document, 63);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "bill");
  assert.equal(rows[0].usd, 0);
  assert.equal(rows[0].amount, 120);
  assert.equal(rows[0].grossAmount, 120);
  assert.equal(rows[0].reserveUsed, 120);
  assert.equal(rows[0].reserveDeltaUsd, -120);
  assert.equal(rows[0].balanceUsd, 100);
  assert.equal(rows[0].reserveUsd, 0);
  assert.equal(rows[0].reserveShortfall, 0);
  const shortfall = buildPlanRows(
    { ...plan, openingReserveUsd: 50 },
    document,
    63,
  ).at(-1);
  assert.equal(shortfall.balanceUsd, 30);
  assert.equal(shortfall.reserveShortfall, 70);
});

test("posted records replace matching salary, bills and exact dated manual forecasts once", () => {
  const document = {
    salary: {
      amount: 2600,
      currency: "USD",
      payFrequency: "biweekly",
      firstPayDate: "2026-10-23",
    },
    bills: [
      monthly("Google", 2, "USD", 6),
      annual("Domain", 260, "USD", 6, [11]),
    ],
    allocations: [],
  };
  const plan = {
    startDate: "2026-11-01",
    endDate: "2026-11-10",
    openingUsd: 500,
    openingPhp: 1000,
    includeIncome: true,
    entries: [
      {
        id: "groceries",
        description: "Groceries",
        date: "2026-11-08",
        kind: "expense",
        amount: 630,
        currency: "PHP",
      },
    ],
  };
  const transactions = [
    {
      id: 1,
      merchant: "Company payroll",
      date: "2026-11-05",
      kind: "income",
      amount: 1200,
      currency: "USD",
    },
    {
      id: 2,
      merchant: "Google Workspace",
      date: "2026-11-07",
      kind: "expense",
      amount: 2,
      currency: "USD",
    },
    {
      id: 3,
      merchant: "Domain",
      date: "2026-11-06",
      kind: "expense",
      amount: 260,
      currency: "USD",
    },
    {
      id: 4,
      merchant: "Groceries",
      date: "2026-11-08",
      kind: "expense",
      amount: 630,
      currency: "PHP",
    },
  ];
  const before = JSON.stringify({ plan, document, transactions });
  const rows = buildPlanRows(plan, document, 63, { transactions });
  assert.equal(rows.length, 5);
  assert.equal(rows.filter((row) => row.source === "transaction").length, 4);
  assert.equal(
    rows.filter((row) => ["salary", "bill", "manual"].includes(row.source))
      .length,
    0,
  );
  assert.equal(rows.find((row) => row.source === "reserve").date, "2026-11-05");
  const domain = rows.find((row) => row.transactionId === 3);
  assert.equal(domain.billId, "Domain");
  assert.equal(domain.scheduledSource, "bill");
  assert.equal(domain.reserveShortfall, 250);
  assert.equal(rows.at(-1).balanceUsd, 1438);
  assert.equal(rows.at(-1).balancePhp, 370);
  assert.equal(before, JSON.stringify({ plan, document, transactions }));
});

test("matching does not discard unrelated income or nonmatching user forecasts", () => {
  const document = {
    salary: {
      amount: 2600,
      currency: "USD",
      payFrequency: "biweekly",
      firstPayDate: "2026-10-23",
    },
    bills: [monthly("Google", 2, "USD", 6)],
    allocations: [],
  };
  const plan = {
    startDate: "2026-11-01",
    endDate: "2026-11-10",
    openingUsd: 0,
    includeIncome: true,
    entries: [
      {
        id: "lunch",
        date: "2026-11-06",
        description: "Lunch",
        kind: "expense",
        amount: 10,
        currency: "USD",
      },
    ],
  };
  const transactions = [
    {
      id: 1,
      merchant: "Birthday gift",
      date: "2026-11-06",
      kind: "income",
      amount: 1200,
      currency: "USD",
    },
    {
      id: 2,
      merchant: "Coffee",
      date: "2026-11-06",
      kind: "expense",
      amount: 2,
      currency: "USD",
    },
    {
      id: 3,
      merchant: "Lunch",
      date: "2026-11-07",
      kind: "expense",
      amount: 10,
      currency: "USD",
    },
  ];
  const rows = buildPlanRows(plan, document, 63, { transactions });
  assert.equal(rows.length, 6);
  assert.equal(rows.filter((row) => row.matchedForecast).length, 0);
  assert.equal(rows.at(-1).balanceUsd, 2376);
});

test("plan switches control new funding and records without erasing opening reserve funds", () => {
  const document = {
    salary,
    bills: [annual("Undated", 100, "USD", null, [12])],
    allocations: [
      {
        id: "save",
        name: "Savings",
        amount: 10,
        currency: "USD",
        kind: "savings",
      },
    ],
  };
  const plan = {
    startDate: "2026-11-01",
    endDate: "2026-11-30",
    openingUsd: 100,
    openingReserveUsd: 25,
    includeIncome: false,
    includeTransactions: false,
    includeAnnualReserve: false,
    includeAllocations: false,
    entries: [],
  };
  const transactions = [
    {
      id: 1,
      date: "2026-11-06",
      kind: "expense",
      amount: 1,
      currency: "USD",
      merchant: "Expense",
    },
  ];
  assert.deepEqual(buildPlanRows(plan, document, 63, { transactions }), []);
  const funded = buildPlanRows(
    { ...plan, includeAnnualReserve: true },
    document,
    63,
    { transactions },
  );
  assert.equal(funded.length, 2);
  assert.ok(funded.every((row) => row.source === "reserve"));
  assert.equal(funded.at(-1).reserveUsd, 33.34);
  assert.equal(funded.at(-1).balanceUsd, 91.66);
});

test("reserve funding spreads cents across a complete cycle without rounding drift", () => {
  const document = {
    salary: { ...salary, firstPayDate: "2026-01-06" },
    bills: [annual("Undated", 100, "USD", null, [12])],
    allocations: [],
  };
  const plan = {
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    openingUsd: 100,
    includeIncome: false,
    entries: [],
  };
  const rows = buildPlanRows(plan, document, 63);
  assert.equal(rows.length, 24);
  assert.equal(
    rows.reduce((sum, row) => sum + Math.round(row.amount * 100), 0),
    10000,
  );
  assert.equal(rows.at(-1).reserveUsd, 100);
  assert.equal(rows.at(-1).balanceUsd, 0);
});

test("recorded pending flows stay excluded while dated transfers and future entries stay visible", () => {
  const document = { salary, bills: [], allocations: [] };
  const plan = {
    startDate: "2026-11-01",
    endDate: "2026-11-30",
    openingUsd: 100,
    openingPhp: 0,
    includeIncome: false,
    entries: [],
  };
  const transactions = [
    {
      id: 1,
      date: "2026-11-02",
      kind: "expense",
      amount: 1000,
      currency: "USD",
      pending: true,
      merchant: "Pending",
    },
    {
      id: 2,
      date: "2026-11-02",
      kind: "expense",
      amount: 10,
      currency: "USD",
      category: "Transfer Out",
      merchant: "Transfer",
    },
    {
      id: 3,
      date: "2026-11-02",
      kind: "income",
      amount: 630,
      currency: "PHP",
      category: "Transfer In",
      merchant: "Transfer",
    },
    {
      id: 4,
      date: "2026-11-20",
      kind: "expense",
      amount: 5,
      currency: "USD",
      merchant: "Scheduled expense",
    },
  ];
  const rows = buildPlanRows(plan, document, 63, {
    transactions: [...transactions, transactions[3]],
    today: "2026-11-02",
  });
  assert.equal(rows.length, 3);
  assert.equal(rows.at(-1).scheduled, true);
  assert.equal(rows.at(-1).balanceUsd, 85);
  assert.equal(rows.at(-1).balancePhp, 630);
});

test("recorded annual payments inside the window can use reserves for a due date just outside it", () => {
  const document = {
    salary: { ...salary, firstPayDate: "2026-12-06" },
    bills: [annual("Insurance", 100, "USD", 1, [11])],
    allocations: [],
  };
  const plan = {
    startDate: "2026-11-02",
    endDate: "2026-11-05",
    openingUsd: 50,
    openingReserveUsd: 100,
    includeIncome: false,
    entries: [],
  };
  const rows = buildPlanRows(plan, document, 63, {
    transactions: [
      {
        id: 1,
        date: "2026-11-02",
        merchant: "Insurance",
        kind: "expense",
        amount: 100,
        currency: "USD",
      },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "transaction");
  assert.equal(rows[0].scheduledDate, "2026-11-01");
  assert.equal(rows[0].billId, "Insurance");
  assert.equal(rows[0].usd, 0);
  assert.equal(rows[0].reserveUsed, 100);
  assert.equal(rows[0].balanceUsd, 50);
  assert.equal(rows[0].reserveUsd, 0);
  assert.ok(
    rows.every((row) => row.date >= plan.startDate && row.date <= plan.endDate),
  );
});

test("paychecks shifted across a plan boundary keep their associated set-asides in the window", () => {
  const document = {
    salary: {
      amount: 2600,
      currency: "USD",
      payFrequency: "biweekly",
      firstPayDate: "2026-10-23",
    },
    bills: [annual("Annual", 260, "USD", null, [12])],
    allocations: [
      {
        id: "save",
        name: "Savings",
        amount: 100,
        currency: "USD",
        kind: "savings",
      },
    ],
  };
  const plan = {
    startDate: "2026-11-05",
    endDate: "2026-11-05",
    openingUsd: 0,
    includeIncome: false,
    entries: [],
  };
  const rows = buildPlanRows(plan, document, 63, {
    transactions: [
      {
        id: 1,
        date: "2026-11-05",
        merchant: "Payroll",
        kind: "income",
        amount: 1200,
        currency: "USD",
      },
    ],
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].source, "transaction");
  assert.equal(rows[0].scheduledDate, "2026-11-06");
  assert.equal(rows.at(-1).balanceUsd, 1090);
  assert.equal(rows.at(-1).reserveUsd, 10);
  assert.ok(rows.every((row) => row.date === "2026-11-05"));
});

const annualSavingsPlan = {
  startDate: "2026-11-01",
  endDate: "2026-11-30",
  openingUsd: 500,
  openingPhp: 1000,
  includeIncome: false,
  includeAnnualReserve: false,
  entries: [],
};

test("opening reserves include item savings once and retain only the unassigned legacy remainder", () => {
  assert.deepEqual(getAnnualReserveOpening(), {
    usd: 0, php: 0, billSavingsUsd: 0, billSavingsPhp: 0,
    unassignedUsd: 0, unassignedPhp: 0,
  });
  const document = {
    bills: [
      { ...annual("Venture X", 395), savedAmount: 100 },
      { ...annual("Car", 6300, "PHP"), savedAmount: 300 },
      { ...annual("Missing", 100), savedAmount: undefined },
      { ...annual("Invalid", 100), savedAmount: -50 },
      { ...monthly("Monthly", 50), savedAmount: 999 },
    ],
  };
  for (const openingReserveUsd of [0, 50, 100, 150]) {
    assert.deepEqual(getAnnualReserveOpening({ openingReserveUsd, openingReservePhp: 200 }, document), {
      usd: Math.max(100, openingReserveUsd),
      php: 300,
      billSavingsUsd: 100,
      billSavingsPhp: 300,
      unassignedUsd: Math.max(0, openingReserveUsd - 100),
      unassignedPhp: 0,
    });
  }
  assert.equal(getAnnualReserveOpening({ openingReservePhp: 500 }, document).unassignedPhp, 200);
});

test("a $395 annual bill with $100 saved shows one $295 cash outflow", () => {
  const document = {
    salary,
    bills: [{ ...annual("Venture X", 395, "USD", 28, [11]), savedAmount: 100 }],
  };
  const before = JSON.stringify({ plan: annualSavingsPlan, document });
  const rows = buildPlanRows(annualSavingsPlan, document, 63);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 395);
  assert.equal(rows[0].grossAmount, 395);
  assert.equal(rows[0].usd, -295);
  assert.equal(rows[0].php, 0);
  assert.equal(rows[0].reserveUsed, 100);
  assert.equal(rows[0].reserveShortfall, 295);
  assert.equal(rows[0].reserveDeltaUsd, -100);
  assert.equal(rows[0].reserveUsd, 0);
  assert.equal(rows[0].balanceUsd, 205);
  assert.equal(before, JSON.stringify({ plan: annualSavingsPlan, document }));
});

test("payday contributions add to each item's saved money before its annual payment", () => {
  const document = {
    salary,
    bills: [{ ...annual("Venture X", 395, "USD", 28, [11]), savedAmount: 100 }],
  };
  const rows = buildPlanRows({ ...annualSavingsPlan, includeAnnualReserve: true }, document, 63);
  const funding = rows.filter((row) => row.source === "reserve");
  assert.equal(funding.length, 2);
  assert.ok(funding.every((row) => row.amount === 12.3));
  assert.deepEqual(funding[0].reserveAllocations, [{ billId: "Venture X", amount: 12.3 }]);
  const payment = rows.find((row) => row.annualPayment);
  assert.equal(payment.reserveUsed, 124.6);
  assert.equal(payment.usd, -270.4);
  assert.equal(payment.reserveUsd, 0);
  assert.equal(payment.balanceUsd, 205);
});

test("fully funded annual bills skip set-asides until payment then resume funding for renewal", () => {
  const document = {
    salary,
    bills: [{ ...annual("Venture X", 395, "USD", 6, [11]), savedAmount: 395 }],
  };
  const before = JSON.stringify(document);
  const rows = buildPlanRows({ ...annualSavingsPlan, includeAnnualReserve: true }, document, 63);
  assert.deepEqual(rows.map((row) => [row.date, row.source]), [
    ["2026-11-06", "bill"],
    ["2026-11-21", "reserve"],
  ]);
  assert.equal(rows[0].amount, 395);
  assert.equal(rows[0].reserveUsed, 395);
  assert.equal(rows[0].usd, 0);
  assert.equal(rows[0].reserveUsd, 0);
  assert.equal(rows[1].amount, 16.46);
  assert.deepEqual(rows[1].reserveAllocations, [{ billId: "Venture X", amount: 16.46 }]);
  assert.equal(rows[1].reserveUsd, 16.46);
  assert.equal(rows[1].balanceUsd, 483.54);
  assert.equal(JSON.stringify(document), before);
});

test("changing saved money rebuilds existing plan funding without stale or zero rows", () => {
  const document = {
    salary,
    bills: [{ ...annual("Venture X", 395, "USD", 28, [11]), savedAmount: 395 }],
  };
  const plan = { ...annualSavingsPlan, endDate: "2026-11-27", includeAnnualReserve: true };
  assert.deepEqual(buildPlanRows(plan, document, 63), []);
  document.bills[0].savedAmount = 100;
  const partial = buildPlanRows(plan, document, 63);
  assert.deepEqual(partial.map((row) => row.amount), [12.3, 12.3]);
  assert.equal(partial.at(-1).reserveUsd, 124.6);
  assert.equal(partial.at(-1).balanceUsd, 475.4);
  document.bills[0].savedAmount = 500;
  assert.deepEqual(buildPlanRows(plan, document, 63), []);
  document.bills[0].savedAmount = 0;
  assert.deepEqual(buildPlanRows(plan, document, 63).map((row) => row.amount), [16.46, 16.46]);
});

test("recorded annual payment dates reopen reserve funding after the actual payment", () => {
  const document = {
    salary,
    bills: [{ ...annual("Venture X", 395, "USD", 6, [11]), savedAmount: 395 }],
  };
  const rows = buildPlanRows({ ...annualSavingsPlan, includeAnnualReserve: true }, document, 63, {
    transactions: [{ id: 1, date: "2026-11-05", merchant: "Venture X", kind: "expense", amount: 395, currency: "USD" }],
  });
  assert.equal(rows[0].source, "transaction");
  assert.equal(rows[0].date, "2026-11-05");
  assert.equal(rows[0].grossAmount, 395);
  assert.equal(rows[0].usd, 0);
  assert.deepEqual(rows.filter((row) => row.source === "reserve").map((row) => row.date), ["2026-11-06", "2026-11-21"]);
  assert.equal(rows.at(-1).reserveUsd, 32.92);
});

test("annual bills cannot consume another item's savings, but may use unassigned opening reserves", () => {
  const document = {
    salary,
    bills: [
      { ...annual("Venture X", 395, "USD", 28, [11]), savedAmount: 100 },
      { ...annual("Microsoft", 200, "USD", 9, [12]), savedAmount: 200 },
    ],
  };
  const isolated = buildPlanRows(annualSavingsPlan, document, 63).at(-1);
  assert.equal(isolated.reserveUsed, 100);
  assert.equal(isolated.usd, -295);
  assert.equal(isolated.reserveUsd, 200);
  const withLegacyFunds = buildPlanRows({ ...annualSavingsPlan, openingReserveUsd: 350 }, document, 63).at(-1);
  assert.equal(withLegacyFunds.reserveUsed, 150);
  assert.equal(withLegacyFunds.usd, -245);
  assert.equal(withLegacyFunds.reserveUsd, 200);
  const sameOpeningTotal = buildPlanRows({ ...annualSavingsPlan, openingReserveUsd: 300 }, document, 63).at(-1);
  assert.equal(sameOpeningTotal.reserveUsed, 100);
  assert.equal(sameOpeningTotal.reserveUsd, 200);
});

test("payday reserves are earmarked for their bill even when another annual bill is due first", () => {
  const document = {
    salary,
    bills: [
      annual("Venture X", 240, "USD", 9, [11]),
      { ...annual("Microsoft", 240, "USD", 9, [12]), savedAmount: 100 },
    ],
  };
  const rows = buildPlanRows({ ...annualSavingsPlan, includeAnnualReserve: true }, document, 63);
  const payment = rows.find((row) => row.annualPayment);
  assert.equal(payment.reserveUsed, 10);
  assert.equal(payment.usd, -230);
  assert.equal(payment.reserveUsd, 105.84);
  assert.equal(rows.at(-1).reserveUsd, 121.68);
  assert.deepEqual(rows[0].reserveAllocations, [
    { billId: "Venture X", amount: 10 },
    { billId: "Microsoft", amount: 5.84 },
  ]);
});

test("saved annual funds are consumed once across installments and later renewal cycles", () => {
  const document = {
    salary,
    bills: [{ ...annual("Car", 400, "USD", 9, [3, 9]), savedAmount: 300 }],
  };
  const rows = buildPlanRows({
    ...annualSavingsPlan,
    startDate: "2026-01-01",
    endDate: "2027-09-30",
  }, document, 63);
  assert.deepEqual(rows.map((row) => row.amount), [200, 200, 200, 200]);
  assert.deepEqual(rows.map((row) => row.reserveUsed), [200, 100, 0, 0]);
  assert.deepEqual(rows.map((row) => row.usd), [0, -100, -200, -200]);
  assert.deepEqual(rows.map((row) => row.reserveUsd), [100, 0, 0, 0]);
  assert.equal(rows.at(-1).balanceUsd, 0);
});

test("funded annual installments retain their own remaining pot and replenish only up to the annual cap", () => {
  const document = {
    salary: { ...salary, firstPayDate: "2026-01-06" },
    bills: [
      { ...annual("Car", 480, "USD", 9, [3, 10]), savedAmount: 480 },
      { ...annual("Other reserve", 50, "USD", null, [12]), savedAmount: 50 },
    ],
  };
  const before = JSON.stringify(document);
  const rows = buildPlanRows({
    ...annualSavingsPlan,
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    includeAnnualReserve: true,
  }, document, 63);
  const payments = rows.filter((row) => row.annualPayment);
  const funding = rows.filter((row) => row.source === "reserve");
  assert.equal(rows[0].date, "2026-03-09");
  assert.equal(rows[0].source, "bill");
  assert.deepEqual(payments.map((row) => [row.date, row.amount, row.reserveUsed, row.usd]), [
    ["2026-03-09", 240, 240, 0],
    ["2026-10-09", 240, 240, 0],
  ]);
  assert.equal(payments[0].reserveUsd, 290);
  assert.equal(payments[0].balanceUsd, 500);
  assert.equal(funding[0].date, "2026-03-21");
  assert.equal(funding[0].reserveUsd, 310);
  assert.equal(funding.length, 17);
  assert.ok(funding.every((row) => row.amount === 20));
  assert.ok(funding.every((row) => row.reserveAllocations.length === 1 && row.reserveAllocations[0].billId === "Car"));
  assert.ok(rows.every((row) => row.reserveUsd >= 50 && row.reserveUsd <= 530));
  assert.equal(funding.find((row) => row.date === "2026-09-06").reserveUsd, 530);
  assert.ok(!funding.some((row) => ["2026-09-21", "2026-10-06"].includes(row.date)));
  assert.equal(payments[1].reserveUsd, 290);
  assert.equal(payments[1].balanceUsd, 260);
  assert.equal(funding.find((row) => row.date === "2026-10-21").reserveUsd, 310);
  assert.equal(rows.at(-1).reserveUsd, 390);
  assert.equal(rows.at(-1).balanceUsd, 160);
  assert.equal(rows.at(-1).balanceUsd + rows.at(-1).reserveUsd, 500 + 530 - 480);
  assert.equal(JSON.stringify(document), before);
});

test("PHP annual savings offset PHP payments without converting or spending USD reserves", () => {
  const document = {
    salary,
    bills: [
      { ...annual("Insurance", 395, "PHP", 28, [11]), savedAmount: 100 },
      { ...annual("USD reserve", 100, "USD", 9, [12]), savedAmount: 100 },
    ],
  };
  const rows = buildPlanRows(annualSavingsPlan, document, 123);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usd, 0);
  assert.equal(rows[0].php, -295);
  assert.equal(rows[0].reserveDeltaPhp, -100);
  assert.equal(rows[0].reserveUsd, 100);
  assert.equal(rows[0].reservePhp, 0);
  assert.equal(rows[0].balanceUsd, 500);
  assert.equal(rows[0].balancePhp, 705);
});

test("overfunded annual savings carry forward and never create a positive cash payment", () => {
  const document = {
    salary,
    bills: [{ ...annual("Venture X", 395, "USD", 28, [11]), savedAmount: 500 }],
  };
  const rows = buildPlanRows({ ...annualSavingsPlan, endDate: "2027-11-30" }, document, 63);
  assert.deepEqual(rows.map((row) => row.usd), [0, -290]);
  assert.deepEqual(rows.map((row) => row.reserveUsed), [395, 105]);
  assert.deepEqual(rows.map((row) => row.reserveUsd), [105, 0]);
  assert.equal(rows.at(-1).balanceUsd, 210);
});

test("legacy annual bills with no actual savings retain their full native cash outflow", () => {
  for (const savedAmount of [undefined, 0, -10, "invalid"]) {
    const document = {
      salary,
      bills: [{ ...annual("Venture X", 395, "USD", 28, [11]), savedAmount }],
    };
    const payment = buildPlanRows(annualSavingsPlan, document, 63)[0];
    assert.equal(payment.usd, -395);
    assert.equal(payment.reserveUsed, 0);
    assert.equal(payment.reserveShortfall, 395);
    assert.equal(payment.reserveUsd, 0);
    assert.equal(payment.balanceUsd, 105);
  }
});

test("recorded annual payments match their gross amount then show only unfunded cash without mutating activity", () => {
  const document = {
    salary,
    bills: [{ ...annual("Venture X", 395, "USD", 28, [11]), savedAmount: 100 }],
  };
  const transaction = {
    id: 1,
    date: "2026-11-29",
    merchant: "Venture X",
    kind: "expense",
    amount: 395,
    currency: "USD",
  };
  const before = JSON.stringify({ document, transaction });
  const rows = buildPlanRows(annualSavingsPlan, document, 63, {
    transactions: [transaction, transaction],
    today: "2026-11-30",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "transaction");
  assert.equal(rows[0].billId, "Venture X");
  assert.equal(rows[0].scheduledDate, "2026-11-28");
  assert.equal(rows[0].amount, 395);
  assert.equal(rows[0].grossAmount, 395);
  assert.equal(rows[0].usd, -295);
  assert.equal(rows[0].reserveUsed, 100);
  assert.equal(rows[0].balanceUsd, 205);
  assert.equal(before, JSON.stringify({ document, transaction }));
});

test("per-item contributions preserve each annual total over a complete pay cycle", () => {
  const document = {
    salary: { ...salary, firstPayDate: "2026-01-06" },
    bills: [
      annual("First", 100.01, "USD", null, [12]),
      annual("Second", 395.02, "USD", null, [12]),
      annual("PHP", 633.05, "PHP", null, [12]),
    ],
  };
  const rows = buildPlanRows({
    ...annualSavingsPlan,
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    includeAnnualReserve: true,
  }, document, 63);
  for (const bill of document.bills) {
    const totalCents = rows.flatMap((row) => row.reserveAllocations)
      .filter((allocation) => allocation.billId === bill.id)
      .reduce((sum, allocation) => sum + Math.round(allocation.amount * 100), 0);
    assert.equal(totalCents, Math.round(bill.amount * 100));
  }
  assert.equal(rows.at(-1).reserveUsd, 495.03);
  assert.equal(rows.at(-1).reservePhp, 633.05);
});

test("26 contributions fund each item's initial remaining cents exactly and stop at capacity", () => {
  const document = {
    salary: { ...salary, payFrequency: "biweekly", firstPayDate: "2026-01-02" },
    bills: [
      { ...annual("Partial USD", 395.02, "USD", null, [12]), savedAmount: 80.01 },
      { ...annual("Partial PHP", 633.05, "PHP", null, [12]), savedAmount: 200.02 },
      { ...annual("Full USD", 100, "USD", null, [12]), savedAmount: 100 },
      { ...annual("Excess PHP", 300, "PHP", null, [12]), savedAmount: 500 },
    ],
  };
  const before = JSON.stringify(document);
  const rows = buildPlanRows({
    ...annualSavingsPlan,
    startDate: "2026-01-01",
    endDate: "2028-12-31",
    includeAnnualReserve: true,
  }, document, 63);
  const allocations = rows.flatMap((row) => row.reserveAllocations);
  assert.equal(rows.length, 52);
  assert.ok(rows.every((row) => row.date <= "2026-12-18" && row.amount > 0));
  assert.ok(allocations.every((allocation) => allocation.amount > 0));
  assert.deepEqual([...new Set(allocations.map((allocation) => allocation.billId))].sort(), ["Partial PHP", "Partial USD"]);
  assert.equal(allocations.filter((allocation) => allocation.billId === "Partial USD").reduce((sum, allocation) => sum + Math.round(allocation.amount * 100), 0), 31501);
  assert.equal(allocations.filter((allocation) => allocation.billId === "Partial PHP").reduce((sum, allocation) => sum + Math.round(allocation.amount * 100), 0), 43303);
  assert.equal(rows.at(-1).reserveUsd, 495.02);
  assert.equal(rows.at(-1).reservePhp, 1133.05);
  assert.equal(rows.at(-1).balanceUsd, 184.99);
  assert.equal(rows.at(-1).balancePhp, 566.97);
  assert.equal(JSON.stringify(document), before);
});
