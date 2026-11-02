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
  getSummary as summarize,
  localDate,
  salaryOccurrences,
} from "../app/lib/financePlanner.mjs";

const getSummary = (document, rate, asOf = "2026-11-02") =>
  summarize(document, rate, asOf);

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

const payday = (id, amount, currency = "USD") => ({
  id,
  name: id,
  amount,
  currency,
  cadence: "payday",
  dueDay: null,
  dueDays: [],
  dueMonths: [],
});

test("payday bills follow the salary anchor with their full native amount on every paycheck", () => {
  const anchored = {
    ...salary,
    firstPayDate: "2026-10-23",
    payFrequency: "biweekly",
  };
  const house = {
    ...payday("House", 19000, "PHP"),
    dueDay: 14,
    dueDays: [14, 28],
    dueMonths: [11],
  };
  assert.deepEqual(billDueDays(house), []);
  assert.deepEqual(
    billOccurrences(house, "2026-11-01", "2026-11-30", anchored),
    [
      { date: "2026-11-06", amount: 19000, currency: "PHP", billId: "House" },
      { date: "2026-11-20", amount: 19000, currency: "PHP", billId: "House" },
    ],
  );
  assert.deepEqual(
    billOccurrences(house, "2026-10-01", "2026-11-10", anchored).map(
      (row) => row.date,
    ),
    ["2026-10-23", "2026-11-06"],
  );
  assert.deepEqual(
    billOccurrences(house, "2026-10-01", "2026-10-22", anchored),
    [],
  );
});

test("biweekly payday bills include three-paycheck months and keep fourteen-day dates in February", () => {
  const anchored = {
    ...salary,
    firstPayDate: "2026-10-23",
    payFrequency: "biweekly",
  };
  const bill = payday("House", 19000, "PHP");
  const january = billOccurrences(bill, "2027-01-01", "2027-01-31", anchored);
  assert.deepEqual(
    january.map((row) => row.date),
    ["2027-01-01", "2027-01-15", "2027-01-29"],
  );
  assert.equal(
    january.reduce((total, row) => total + row.amount, 0),
    57000,
  );
  assert.deepEqual(
    billOccurrences(bill, "2027-02-01", "2027-02-28", anchored).map(
      (row) => row.date,
    ),
    ["2027-02-12", "2027-02-26"],
  );
});

test("payday bills regenerate when the salary frequency or first payday changes", () => {
  const bill = payday("Payday fee", 25.01);
  const anchored = {
    ...salary,
    firstPayDate: "2026-10-23",
    payFrequency: "biweekly",
  };
  const range = ["2026-11-01", "2026-11-30"];
  assert.deepEqual(
    billOccurrences(bill, ...range, anchored).map((row) => row.date),
    ["2026-11-06", "2026-11-20"],
  );
  assert.deepEqual(
    billOccurrences(bill, ...range, {
      ...anchored,
      payFrequency: "semimonthly",
    }).map((row) => row.date),
    ["2026-11-08", "2026-11-23"],
  );
  assert.deepEqual(
    billOccurrences(bill, ...range, {
      ...anchored,
      firstPayDate: "2026-10-30",
    }).map((row) => row.date),
    ["2026-11-13", "2026-11-27"],
  );
  assert.deepEqual(
    billOccurrences(bill, "2027-02-01", "2027-02-28", {
      ...salary,
      firstPayDate: "2027-01-31",
    }).map((row) => row.date),
    ["2027-02-16", "2027-02-28"],
  );
});

test("payday bills need a valid salary schedule and date range", () => {
  const bill = payday("House", 19000, "PHP");
  for (const schedule of [
    undefined,
    null,
    {},
    { ...salary, firstPayDate: "2026-02-30" },
    { ...salary, payFrequency: "weekly" },
  ]) {
    assert.deepEqual(
      billOccurrences(bill, "2026-11-01", "2026-11-30", schedule),
      [],
    );
  }
  for (const range of [
    ["bad", "2026-11-30"],
    ["2026-11-30", "2026-11-01"],
  ]) {
    assert.deepEqual(billOccurrences(bill, ...range, salary), []);
  }
});

test("payday summaries use native per-pay amounts and monthly averages without double counting", () => {
  const document = {
    salary: { ...salary, amount: 2600, payFrequency: "biweekly" },
    bills: [
      monthly("Monthly USD", 26),
      monthly("Monthly PHP", 1300, "PHP"),
      payday("Payday USD", 125.01),
      payday("House", 19000.03, "PHP"),
      annual("Annual", 260, "USD", null),
    ],
    allocations: [],
  };
  const summary = getSummary(document, 50);
  assert.equal(summary.monthlyBillsUsd, 26);
  assert.equal(summary.monthlyBillsPhp, 1300);
  assert.equal(summary.paydayBillsUsd, 125.01);
  assert.equal(summary.paydayBillsPhp, 19000.03);
  assert.equal(summary.paydayMonthlyUsd, 270.86);
  assert.equal(summary.paydayMonthlyPhp, 41166.73);
  assert.equal(summary.billsUsd, 296.86);
  assert.equal(summary.billsPhp, 42466.73);
  assert.equal(summary.billsUsdPerPeriod, 137.01);
  assert.equal(summary.billsPhpPerPeriod, 19600.03);
  assert.equal(summary.annualPerPeriodUsd, 10);
  assert.equal(summary.remainingPerPeriodUsd, 660.99);
  assert.equal(summary.monthlyCommitmentsUsd, 1167.86);
  const twiceMonthly = getSummary(
    {
      ...document,
      salary: { ...document.salary, payFrequency: "semimonthly" },
    },
    50,
  );
  assert.equal(twiceMonthly.paydayBillsPhp, 19000.03);
  assert.equal(twiceMonthly.paydayMonthlyPhp, 38000.06);
  assert.equal(twiceMonthly.billsUsdPerPeriod, 138.01);
  assert.equal(twiceMonthly.billsPhpPerPeriod, 19650.03);
});

test("per-pay bill cents are added directly rather than recovered from rounded monthly equivalents", () => {
  const summary = getSummary(
    {
      salary: { ...salary, payFrequency: "biweekly" },
      bills: [
        monthly("Monthly USD", 0.01),
        monthly("Monthly PHP", 0.01, "PHP"),
        payday("Payday USD", 0.04),
        payday("Payday PHP", 0.04, "PHP"),
      ],
      allocations: [],
    },
    63,
  );
  assert.equal(summary.billsUsd, 0.1);
  assert.equal(summary.billsPhp, 0.1);
  assert.equal(summary.billsUsdPerPeriod, 0.04);
  assert.equal(summary.billsPhpPerPeriod, 0.04);
  assert.notEqual(
    summary.billsUsdPerPeriod,
    Math.round(((summary.billsUsd * 12) / 26) * 100) / 100,
  );
});

test("budget plans include payday bills even when forecast salary is switched off", () => {
  const document = {
    salary: {
      ...salary,
      amount: 2600,
      firstPayDate: "2026-10-23",
      payFrequency: "biweekly",
    },
    bills: [
      monthly("Internet", 100, "USD", 10),
      payday("House", 19000, "PHP"),
      payday("Payday fee", 5.25),
    ],
    allocations: [],
  };
  const plan = {
    startDate: "2026-11-01",
    endDate: "2026-11-30",
    openingUsd: 1000,
    openingPhp: 50000,
    includeIncome: false,
    includeAnnualReserve: false,
    includeAllocations: false,
    entries: [],
  };
  const before = JSON.stringify({ document, plan });
  const rows = buildPlanRows(plan, document, 63);
  assert.equal(rows.length, 5);
  assert.equal(rows.filter((row) => row.source === "salary").length, 0);
  assert.deepEqual(
    rows
      .filter((row) => row.billId === "House")
      .map((row) => [row.date, row.php]),
    [
      ["2026-11-06", -19000],
      ["2026-11-20", -19000],
    ],
  );
  assert.deepEqual(
    rows.filter((row) => row.billId === "Payday fee").map((row) => row.usd),
    [-5.25, -5.25],
  );
  assert.equal(rows.at(-1).balanceUsd, 889.5);
  assert.equal(rows.at(-1).balancePhp, 12000);
  assert.equal(JSON.stringify({ document, plan }), before);
  const withIncome = buildPlanRows(
    { ...plan, includeIncome: true },
    document,
    63,
  );
  assert.equal(withIncome.filter((row) => row.source === "salary").length, 2);
  assert.equal(withIncome.filter((row) => row.source === "bill").length, 5);
  assert.equal(withIncome[0].source, "salary");
});

test("posted payday bill payments replace one forecast without moving other bills to a bank posting date", () => {
  const document = {
    salary: {
      ...salary,
      amount: 2600,
      firstPayDate: "2026-10-23",
      payFrequency: "biweekly",
    },
    bills: [payday("House", 19000, "PHP"), payday("Payday fee", 5.25)],
    allocations: [],
  };
  const plan = {
    startDate: "2026-11-01",
    endDate: "2026-11-30",
    openingUsd: 0,
    openingPhp: 50000,
    includeIncome: true,
    includeAnnualReserve: false,
    includeAllocations: false,
    entries: [],
  };
  const transactions = [
    {
      id: 1,
      date: "2026-11-05",
      kind: "income",
      merchant: "Salary payroll",
      amount: 1200,
      currency: "USD",
    },
    {
      id: 2,
      date: "2026-11-07",
      kind: "expense",
      merchant: "House",
      amount: 19000,
      currency: "PHP",
    },
  ];
  const rows = buildPlanRows(plan, document, 63, { transactions });
  const house = rows.filter((row) => row.billId === "House");
  assert.equal(house.length, 2);
  assert.equal(house[0].source, "transaction");
  assert.equal(house[0].date, "2026-11-07");
  assert.equal(house[0].scheduledDate, "2026-11-06");
  assert.equal(house[0].php, -19000);
  assert.equal(house[1].date, "2026-11-20");
  assert.deepEqual(
    rows.filter((row) => row.billId === "Payday fee").map((row) => row.date),
    ["2026-11-06", "2026-11-20"],
  );
  assert.equal(
    rows.filter((row) => row.source === "transaction" && row.kind === "income")
      .length,
    1,
  );
  assert.equal(rows.filter((row) => row.source === "salary").length, 1);
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
  assert.equal(summary.annualMonthlyUsd, 104.64);
  assert.equal(summary.billsUsdPerPeriod, 31);
  assert.equal(summary.billsPhpPerPeriod, 2100);
  assert.equal(summary.billsPhpPerPeriodUsd, 33.33);
  assert.equal(summary.annualPerPeriodUsd, 52.32);
  assert.equal(summary.remainingPerPeriodUsd, 883.35);
  assert.equal(summary.unallocatedPerPeriodUsd, 383.35);
  assert.equal(summary.monthlyCommitmentsUsd, 233.31);
});

test("true biweekly pay annualizes income and expenses over 26 periods", () => {
  const document = {
    salary: { ...salary, payFrequency: "biweekly" },
    bills: [monthly("Bills", 260), annual("Annual", 260, "USD", null)],
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
  assert.equal(summary.annualMonthlyPhp, 217.64);
  assert.equal(summary.monthlyCommitmentsPhp, 512.65);
  assert.equal(summary.monthlyRemainingPhp, 487.36);
  assert.notEqual(
    summary.annualPhp,
    convert(summary.annualUsd, "USD", "PHP", 63),
  );
});

test("annual funding follows saved balances without changing the bill or calendar target", () => {
  const bill = {
    ...annual("Venture X", 395, "USD", 28, [11]),
    savedAmount: 100,
  };
  const before = JSON.stringify(bill);
  const {
    amount,
    savedAmount,
    remainingAmount,
    monthlyAmount,
    perPeriodAmount,
    fullyFunded,
  } = getAnnualBillFunding(bill);
  assert.deepEqual(
    {
      amount,
      savedAmount,
      remainingAmount,
      monthlyAmount,
      perPeriodAmount,
      fullyFunded,
    },
    {
      amount: 395,
      savedAmount: 100,
      remainingAmount: 295,
      monthlyAmount: 24.58,
      perPeriodAmount: 11.35,
      fullyFunded: false,
    },
  );
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
  for (const savedAmount of [
    undefined,
    -10,
    "invalid",
    Number.POSITIVE_INFINITY,
  ]) {
    assert.equal(
      getAnnualBillFunding({ ...annual("Legacy", 395), savedAmount })
        .remainingAmount,
      395,
    );
  }
  assert.equal(
    getAnnualBillFunding({
      ...annual("PHP", "6300.01", "PHP"),
      savedAmount: "1260.01",
    }).remainingAmount,
    5040,
  );
  assert.deepEqual(
    getAnnualBillFunding({ ...monthly("Monthly", 20), savedAmount: 10 }),
    getAnnualBillFunding(),
  );
  assert.equal(getAnnualBillFunding(annual("Invalid", -10)).amount, 0);
  assert.equal(
    getAnnualBillFunding(annual("Invalid", "invalid")).remainingAmount,
    0,
  );
  assert.equal(
    getAnnualBillFunding(annual("Fallback", 260), 0).perPeriodAmount,
    10,
  );
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
  assert.equal(summary.annualMonthlyUsd, 36.94);
  assert.equal(summary.annualMonthlyPhp, 2327.16);
  assert.equal(summary.annualPerPeriodUsd, 17.05);
  assert.equal(summary.monthlyCommitmentsUsd, 86.94);
  assert.equal(summary.monthlyRemainingUsd, 1913.06);
  assert.equal(summary.remainingPerPeriodUsd, 882.95);
  assert.equal(summary.unallocatedPerPeriodUsd, 782.95);
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
  assert.equal(partial.annualMonthlyUsd, 29.06);
  assert.equal(partial.annualMonthlyPhp, 1830.78);
  assert.equal(partial.annualPerPeriodUsd, 13.41);
  assert.equal(partial.monthlyCommitmentsUsd, 29.06);
  assert.equal(partial.monthlyRemainingUsd, 1970.94);
  assert.equal(partial.remainingPerPeriodUsd, 909.67);
  assert.equal(partial.unallocatedPerPeriodUsd, 409.67);
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
    { usd: 976.66, php: 4306.66, reserveUsd: 173.34, reservePhp: 1733.34 },
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
  assert.equal(domain.reserveShortfall, 0);
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
    usd: 0,
    php: 0,
    billSavingsUsd: 0,
    billSavingsPhp: 0,
    unassignedUsd: 0,
    unassignedPhp: 0,
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
    assert.deepEqual(
      getAnnualReserveOpening(
        { openingReserveUsd, openingReservePhp: 200 },
        document,
      ),
      {
        usd: Math.max(100, openingReserveUsd),
        php: 300,
        billSavingsUsd: 100,
        billSavingsPhp: 300,
        unassignedUsd: Math.max(0, openingReserveUsd - 100),
        unassignedPhp: 0,
      },
    );
  }
  assert.equal(
    getAnnualReserveOpening({ openingReservePhp: 500 }, document).unassignedPhp,
    200,
  );
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
  const rows = buildPlanRows(
    { ...annualSavingsPlan, includeAnnualReserve: true },
    document,
    63,
  );
  const funding = rows.filter((row) => row.source === "reserve");
  assert.equal(funding.length, 2);
  assert.ok(funding.every((row) => row.amount === 147.5));
  assert.deepEqual(funding[0].reserveAllocations, [
    { billId: "Venture X", amount: 147.5 },
  ]);
  const payment = rows.find((row) => row.annualPayment);
  assert.equal(payment.reserveUsed, 395);
  assert.equal(payment.usd, 0);
  assert.equal(payment.reserveUsd, 0);
  assert.equal(payment.balanceUsd, 205);
});

test("fully funded annual bills skip set-asides until payment then resume funding for renewal", () => {
  const document = {
    salary,
    bills: [{ ...annual("Venture X", 395, "USD", 6, [11]), savedAmount: 395 }],
  };
  const before = JSON.stringify(document);
  const rows = buildPlanRows(
    { ...annualSavingsPlan, includeAnnualReserve: true },
    document,
    63,
  );
  assert.deepEqual(
    rows.map((row) => [row.date, row.source]),
    [
      ["2026-11-06", "bill"],
      ["2026-11-21", "reserve"],
    ],
  );
  assert.equal(rows[0].amount, 395);
  assert.equal(rows[0].reserveUsed, 395);
  assert.equal(rows[0].usd, 0);
  assert.equal(rows[0].reserveUsd, 0);
  assert.equal(rows[1].amount, 16.46);
  assert.deepEqual(rows[1].reserveAllocations, [
    { billId: "Venture X", amount: 16.46 },
  ]);
  assert.equal(rows[1].reserveUsd, 16.46);
  assert.equal(rows[1].balanceUsd, 483.54);
  assert.equal(JSON.stringify(document), before);
});

test("changing saved money rebuilds existing plan funding without stale or zero rows", () => {
  const document = {
    salary,
    bills: [{ ...annual("Venture X", 395, "USD", 28, [11]), savedAmount: 395 }],
  };
  const plan = {
    ...annualSavingsPlan,
    endDate: "2026-11-27",
    includeAnnualReserve: true,
  };
  assert.deepEqual(buildPlanRows(plan, document, 63), []);
  document.bills[0].savedAmount = 100;
  const partial = buildPlanRows(plan, document, 63);
  assert.deepEqual(
    partial.map((row) => row.amount),
    [147.5, 147.5],
  );
  assert.equal(partial.at(-1).reserveUsd, 395);
  assert.equal(partial.at(-1).balanceUsd, 205);
  document.bills[0].savedAmount = 500;
  assert.deepEqual(buildPlanRows(plan, document, 63), []);
  document.bills[0].savedAmount = 0;
  assert.deepEqual(
    buildPlanRows(plan, document, 63).map((row) => row.amount),
    [197.5, 197.5],
  );
});

test("recorded annual payment dates reopen reserve funding after the actual payment", () => {
  const document = {
    salary,
    bills: [{ ...annual("Venture X", 395, "USD", 6, [11]), savedAmount: 395 }],
  };
  const rows = buildPlanRows(
    { ...annualSavingsPlan, includeAnnualReserve: true },
    document,
    63,
    {
      transactions: [
        {
          id: 1,
          date: "2026-11-05",
          merchant: "Venture X",
          kind: "expense",
          amount: 395,
          currency: "USD",
        },
      ],
    },
  );
  assert.equal(rows[0].source, "transaction");
  assert.equal(rows[0].date, "2026-11-05");
  assert.equal(rows[0].grossAmount, 395);
  assert.equal(rows[0].usd, 0);
  assert.deepEqual(
    rows.filter((row) => row.source === "reserve").map((row) => row.date),
    ["2026-11-06", "2026-11-21"],
  );
  assert.equal(rows.at(-1).reserveUsd, 31.6);
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
  const withLegacyFunds = buildPlanRows(
    { ...annualSavingsPlan, openingReserveUsd: 350 },
    document,
    63,
  ).at(-1);
  assert.equal(withLegacyFunds.reserveUsed, 150);
  assert.equal(withLegacyFunds.usd, -245);
  assert.equal(withLegacyFunds.reserveUsd, 200);
  const sameOpeningTotal = buildPlanRows(
    { ...annualSavingsPlan, openingReserveUsd: 300 },
    document,
    63,
  ).at(-1);
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
  const rows = buildPlanRows(
    { ...annualSavingsPlan, includeAnnualReserve: true },
    document,
    63,
  );
  const payment = rows.find((row) => row.annualPayment);
  assert.equal(payment.reserveUsed, 240);
  assert.equal(payment.usd, 0);
  assert.equal(payment.reserveUsd, 146.67);
  assert.equal(rows.at(-1).reserveUsd, 203.34);
  assert.deepEqual(rows[0].reserveAllocations, [
    { billId: "Venture X", amount: 240 },
    { billId: "Microsoft", amount: 46.67 },
  ]);
});

test("saved annual funds are consumed once across installments and later renewal cycles", () => {
  const document = {
    salary,
    bills: [{ ...annual("Car", 400, "USD", 9, [3, 9]), savedAmount: 300 }],
  };
  const rows = buildPlanRows(
    {
      ...annualSavingsPlan,
      startDate: "2026-01-01",
      endDate: "2027-09-30",
    },
    document,
    63,
  );
  assert.deepEqual(
    rows.map((row) => row.amount),
    [200, 200, 200, 200],
  );
  assert.deepEqual(
    rows.map((row) => row.reserveUsed),
    [200, 100, 0, 0],
  );
  assert.deepEqual(
    rows.map((row) => row.usd),
    [0, -100, -200, -200],
  );
  assert.deepEqual(
    rows.map((row) => row.reserveUsd),
    [100, 0, 0, 0],
  );
  assert.equal(rows.at(-1).balanceUsd, 0);
});

test("funded annual installments wait until their saved pot is consumed before funding the next deadline", () => {
  const document = {
    salary: { ...salary, firstPayDate: "2026-01-06" },
    bills: [
      { ...annual("Car", 480, "USD", 9, [3, 10]), savedAmount: 480 },
      { ...annual("Other reserve", 50, "USD", null, [12]), savedAmount: 50 },
    ],
  };
  const before = JSON.stringify(document);
  const rows = buildPlanRows(
    {
      ...annualSavingsPlan,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      includeAnnualReserve: true,
    },
    document,
    63,
  );
  const payments = rows.filter((row) => row.annualPayment);
  const funding = rows.filter((row) => row.source === "reserve");
  assert.equal(rows[0].date, "2026-03-09");
  assert.equal(rows[0].source, "bill");
  assert.deepEqual(
    payments.map((row) => [row.date, row.amount, row.reserveUsed, row.usd]),
    [
      ["2026-03-09", 240, 240, 0],
      ["2026-10-09", 240, 240, 0],
    ],
  );
  assert.equal(payments[0].reserveUsd, 290);
  assert.equal(payments[0].balanceUsd, 500);
  assert.equal(funding[0].date, "2026-10-21");
  assert.equal(funding[0].reserveUsd, 74);
  assert.equal(funding.length, 5);
  assert.ok(funding.every((row) => row.amount === 24));
  assert.ok(
    funding.every(
      (row) =>
        row.reserveAllocations.length === 1 &&
        row.reserveAllocations[0].billId === "Car",
    ),
  );
  assert.ok(rows.every((row) => row.reserveUsd >= 50 && row.reserveUsd <= 530));
  assert.ok(!funding.some((row) => row.date <= "2026-10-09"));
  assert.equal(payments[1].reserveUsd, 50);
  assert.equal(payments[1].balanceUsd, 500);
  assert.equal(rows.at(-1).reserveUsd, 170);
  assert.equal(rows.at(-1).balanceUsd, 380);
  assert.equal(
    rows.at(-1).balanceUsd + rows.at(-1).reserveUsd,
    500 + 530 - 480,
  );
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
  const rows = buildPlanRows(
    { ...annualSavingsPlan, endDate: "2027-11-30" },
    document,
    63,
  );
  assert.deepEqual(
    rows.map((row) => row.usd),
    [0, -290],
  );
  assert.deepEqual(
    rows.map((row) => row.reserveUsed),
    [395, 105],
  );
  assert.deepEqual(
    rows.map((row) => row.reserveUsd),
    [105, 0],
  );
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
  const rows = buildPlanRows(
    {
      ...annualSavingsPlan,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      includeAnnualReserve: true,
    },
    document,
    63,
  );
  for (const bill of document.bills) {
    const totalCents = rows
      .flatMap((row) => row.reserveAllocations)
      .filter((allocation) => allocation.billId === bill.id)
      .reduce(
        (sum, allocation) => sum + Math.round(allocation.amount * 100),
        0,
      );
    assert.equal(totalCents, Math.round(bill.amount * 100));
  }
  assert.equal(rows.at(-1).reserveUsd, 495.03);
  assert.equal(rows.at(-1).reservePhp, 633.05);
});

test("26 contributions fund each item's initial remaining cents exactly and stop at capacity", () => {
  const document = {
    salary: { ...salary, payFrequency: "biweekly", firstPayDate: "2026-01-02" },
    bills: [
      {
        ...annual("Partial USD", 395.02, "USD", null, [12]),
        savedAmount: 80.01,
      },
      {
        ...annual("Partial PHP", 633.05, "PHP", null, [12]),
        savedAmount: 200.02,
      },
      { ...annual("Full USD", 100, "USD", null, [12]), savedAmount: 100 },
      { ...annual("Excess PHP", 300, "PHP", null, [12]), savedAmount: 500 },
    ],
  };
  const before = JSON.stringify(document);
  const rows = buildPlanRows(
    {
      ...annualSavingsPlan,
      startDate: "2026-01-01",
      endDate: "2028-12-31",
      includeAnnualReserve: true,
    },
    document,
    63,
  );
  const allocations = rows.flatMap((row) => row.reserveAllocations);
  assert.equal(rows.length, 52);
  assert.ok(rows.every((row) => row.date <= "2026-12-18" && row.amount > 0));
  assert.ok(allocations.every((allocation) => allocation.amount > 0));
  assert.deepEqual(
    [...new Set(allocations.map((allocation) => allocation.billId))].sort(),
    ["Partial PHP", "Partial USD"],
  );
  assert.equal(
    allocations
      .filter((allocation) => allocation.billId === "Partial USD")
      .reduce(
        (sum, allocation) => sum + Math.round(allocation.amount * 100),
        0,
      ),
    31501,
  );
  assert.equal(
    allocations
      .filter((allocation) => allocation.billId === "Partial PHP")
      .reduce(
        (sum, allocation) => sum + Math.round(allocation.amount * 100),
        0,
      ),
    43303,
  );
  assert.equal(rows.at(-1).reserveUsd, 495.02);
  assert.equal(rows.at(-1).reservePhp, 1133.05);
  assert.equal(rows.at(-1).balanceUsd, 184.99);
  assert.equal(rows.at(-1).balancePhp, 566.97);
  assert.equal(JSON.stringify(document), before);
});

const deadlineSalary = {
  amount: 2100,
  currency: "USD",
  payFrequency: "biweekly",
  firstPayDate: "2026-10-23",
};
const deadlineContext = { salary: deadlineSalary, asOf: "2026-11-02" };

test("the saved-target screenshot funds each next deadline using its actual remaining paydays", () => {
  const bills = [
    { ...annual("Microsoft", 100, "USD", 9, [9]), savedAmount: 14.79 },
    { ...annual("Domain", 20, "USD", 4, [6]), savedAmount: 8.27 },
    { ...annual("Venture X", 395, "USD", 28, [11]), savedAmount: 395 },
    { ...annual("Car", 500, "USD", 1, [3, 9]), savedAmount: 85.64 },
  ];
  const document = { salary: deadlineSalary, bills, allocations: [] };
  const before = JSON.stringify(document);
  const summary = getSummary(document, 63, "2026-11-02");
  assert.deepEqual(
    summary.annualFunding.map((bill) => [
      bill.billId,
      bill.nextDueDate,
      bill.installmentAmount,
      bill.remainingForNextPayment,
      bill.paydaysRemaining,
      bill.perPeriodAmount,
    ]),
    [
      ["Microsoft", "2027-09-09", 100, 85.21, 22, 3.88],
      ["Domain", "2027-06-04", 20, 11.73, 16, 0.74],
      ["Venture X", "2026-11-28", 395, 0, 2, 0],
      ["Car", "2027-03-01", 250, 164.36, 9, 18.27],
    ],
  );
  assert.equal(summary.annualUsd, 1015);
  assert.equal(summary.annualSavedUsd, 503.7);
  assert.equal(summary.annualRemainingUsd, 511.3);
  assert.equal(summary.annualPerPeriodUsd, 22.89);
  assert.equal(summary.annualMonthlyUsd, 49.6);
  assert.equal(summary.annualImmediateUsd, 0);
  assert.equal(summary.annualEstimatedCount, 0);
  assert.equal(JSON.stringify(document), before);
});

test("saved edits and due-date edits recalculate contributions rather than restarting a full savings year", () => {
  const bill = {
    ...annual("Venture X", 395, "USD", 28, [11]),
    savedAmount: 100,
  };
  const partial = getAnnualBillFunding(bill, 26, deadlineContext);
  assert.equal(partial.paydaysRemaining, 2);
  assert.equal(partial.perPeriodAmount, 147.5);
  assert.equal(partial.monthlyAmount, 319.58);
  for (const savedAmount of [395, 500]) {
    const funded = getAnnualBillFunding(
      { ...bill, savedAmount },
      26,
      deadlineContext,
    );
    assert.equal(funded.remainingForNextPayment, 0);
    assert.equal(funded.perPeriodAmount, 0);
    assert.equal(funded.monthlyAmount, 0);
  }
  assert.equal(
    getAnnualBillFunding(bill, 26, deadlineContext).perPeriodAmount,
    147.5,
  );
  const later = getAnnualBillFunding(
    { ...bill, dueMonths: [12] },
    26,
    deadlineContext,
  );
  assert.equal(later.paydaysRemaining, 4);
  assert.equal(later.perPeriodAmount, 73.75);
});

test("the next installment can be funded without funding the whole annual amount", () => {
  const bill = { ...annual("Car", 500, "USD", 1, [3, 9]), savedAmount: 250 };
  const funding = getAnnualBillFunding(bill, 26, deadlineContext);
  assert.equal(funding.fullyFunded, false);
  assert.equal(funding.remainingAmount, 250);
  assert.equal(funding.installmentAmount, 250);
  assert.equal(funding.remainingForNextPayment, 0);
  assert.equal(funding.perPeriodAmount, 0);
  const odd = getAnnualBillFunding(
    { ...bill, amount: 100.01, savedAmount: 25 },
    26,
    {
      salary: deadlineSalary,
      asOf: "2027-06-01",
    },
  );
  assert.equal(odd.installmentAmount, 50.01);
  assert.equal(odd.remainingForNextPayment, 25.01);
});

test("annual funding identifies cash needed before any eligible payday", () => {
  const bill = {
    ...annual("Before payday", 395, "USD", 4, [11]),
    savedAmount: 100,
  };
  const funding = getAnnualBillFunding(bill, 26, deadlineContext);
  assert.equal(funding.paydaysRemaining, 0);
  assert.equal(funding.immediateAmount, 295);
  assert.equal(funding.perPeriodAmount, 0);
  assert.equal(funding.monthlyAmount, 0);
  assert.equal(funding.estimated, false);
  assert.equal(funding.fullyFunded, false);
  const summary = getSummary(
    { salary: deadlineSalary, bills: [bill] },
    63,
    "2026-11-02",
  );
  assert.equal(summary.annualImmediateUsd, 295);
  assert.equal(summary.annualImmediatePhp, 18585);
  const rows = buildPlanRows(
    { ...annualSavingsPlan, includeAnnualReserve: true },
    { salary: deadlineSalary, bills: [bill] },
    63,
  );
  assert.equal(rows[0].date, "2026-11-04");
  assert.equal(rows[0].reserveShortfall, 295);
  assert.equal(rows[0].usd, -295);
});

test("missing annual dates or salary schedules retain clearly marked estimates", () => {
  const undated = getAnnualBillFunding(
    annual("Undated", 260, "USD", null),
    26,
    deadlineContext,
  );
  assert.equal(undated.needsDate, true);
  assert.equal(undated.estimated, true);
  assert.equal(undated.perPeriodAmount, 10);
  const noSalary = getAnnualBillFunding(annual("No salary", 260), 26, {
    asOf: "2026-11-02",
  });
  assert.equal(noSalary.needsSchedule, true);
  assert.equal(noSalary.estimated, true);
  assert.equal(noSalary.perPeriodAmount, 10);
  const summary = getSummary(
    { salary: deadlineSalary, bills: [annual("Undated", 260, "USD", null)] },
    63,
    "2026-11-02",
  );
  assert.equal(summary.annualEstimatedCount, 1);
});

test("payday on the due date contributes before the bill is paid", () => {
  const bill = annual("Same day", 12.34, "PHP", 6, [11]);
  const funding = getAnnualBillFunding(bill, 26, {
    ...deadlineContext,
    asOf: "2026-11-06",
  });
  assert.equal(funding.paydaysRemaining, 1);
  assert.equal(funding.perPeriodAmount, 12.34);
  const rows = buildPlanRows(
    { ...annualSavingsPlan, endDate: "2026-11-06", includeAnnualReserve: true },
    { salary: deadlineSalary, bills: [bill] },
    63,
  );
  assert.deepEqual(
    rows.map((row) => row.source),
    ["reserve", "bill"],
  );
  assert.equal(rows[0].php, -12.34);
  assert.equal(rows[1].php, 0);
  assert.equal(rows[1].reserveUsed, 12.34);
  assert.equal(rows[1].reservePhp, 0);
});

test("rolling remaining-payday funding finishes exact cents without overfunding", () => {
  const salary = { ...deadlineSalary, firstPayDate: "2026-11-01" };
  const bill = annual("One dollar", 1, "USD", 30, [11]);
  const rows = buildPlanRows(
    { ...annualSavingsPlan, includeAnnualReserve: true },
    { salary, bills: [bill] },
    63,
  );
  assert.deepEqual(
    rows.filter((row) => row.source === "reserve").map((row) => row.amount),
    [0.34, 0.33, 0.33],
  );
  assert.equal(rows.at(-1).reserveUsed, 1);
  assert.equal(rows.at(-1).usd, 0);
  assert.equal(rows.at(-1).reserveUsd, 0);
  assert.equal(rows.at(-1).balanceUsd, 499);
});

test("deadline funding follows leap dates and salary changes", () => {
  const bill = annual("Leap renewal", 10, "USD", 29, [2]);
  const twiceMonthly = {
    ...deadlineSalary,
    payFrequency: "semimonthly",
    firstPayDate: "2027-01-31",
  };
  const february = getAnnualBillFunding(bill, 24, {
    salary: twiceMonthly,
    asOf: "2027-02-01",
  });
  assert.equal(february.nextDueDate, "2027-02-28");
  assert.equal(february.paydaysRemaining, 2);
  assert.equal(february.perPeriodAmount, 5);
  const leap = getAnnualBillFunding(bill, 24, {
    salary: twiceMonthly,
    asOf: "2028-02-01",
  });
  assert.equal(leap.nextDueDate, "2028-02-29");
  const shifted = getAnnualBillFunding(
    annual("Soon", 100, "USD", 13, [11]),
    26,
    {
      salary: { ...deadlineSalary, firstPayDate: "2026-11-13" },
      asOf: "2026-11-02",
    },
  );
  assert.equal(shifted.paydaysRemaining, 1);
  assert.equal(shifted.perPeriodAmount, 100);
});

test("reconciled early and late annual payments consume the scheduled installment only once", () => {
  const bill = {
    ...annual("Matched renewal", 100, "USD", 6, [11]),
    savedAmount: 100,
  };
  for (const date of ["2026-11-03", "2026-11-09"]) {
    const rows = buildPlanRows(
      { ...annualSavingsPlan, includeAnnualReserve: true },
      { salary: deadlineSalary, bills: [bill] },
      63,
      {
        transactions: [
          {
            id: 1,
            date,
            merchant: bill.name,
            kind: "expense",
            amount: 100,
            currency: "USD",
          },
        ],
      },
    );
    const payment = rows.find((row) => row.annualPayment);
    assert.equal(payment.date, date);
    assert.equal(payment.scheduledDate, "2026-11-06");
    assert.equal(payment.reserveUsed, 100);
    assert.equal(payment.usd, 0);
    assert.equal(rows.filter((row) => row.annualPayment).length, 1);
    const contributions = rows.filter((row) => row.source === "reserve");
    assert.ok(contributions.every((row) => row.date > date));
    assert.ok(contributions.every((row) => row.amount < 5));
  }
});

test("multiple installment cycles are fully funded by each deadline and conserve available plus reserve cash", () => {
  const document = {
    salary: { ...deadlineSalary, firstPayDate: "2026-01-02" },
    bills: [
      { ...annual("Installments", 101.01, "USD", 1, [3, 9]), savedAmount: 10 },
    ],
  };
  const rows = buildPlanRows(
    {
      ...annualSavingsPlan,
      startDate: "2026-01-01",
      endDate: "2027-09-02",
      includeAnnualReserve: true,
    },
    document,
    63,
  );
  const payments = rows.filter((row) => row.annualPayment);
  assert.deepEqual(
    payments.map((row) => row.amount),
    [50.5, 50.51, 50.5, 50.51],
  );
  assert.ok(
    payments.every(
      (row) =>
        row.reserveShortfall === 0 && row.usd === 0 && row.reserveUsd === 0,
    ),
  );
  assert.ok(
    rows.every((row) => row.reserveUsd >= 0 && row.reserveUsd <= 50.51),
  );
  assert.equal(
    roundCents(rows.at(-1).balanceUsd + rows.at(-1).reserveUsd),
    roundCents(500 + 10 - 202.02),
  );
});

function roundCents(value) {
  return Math.round(value * 100) / 100;
}
