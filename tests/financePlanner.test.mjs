import test from "node:test";
import assert from "node:assert/strict";
import {
  addDays, billOccurrences, buildPlanRows, convert, formatDate, getSummary, localDate, salaryOccurrences
} from "../app/lib/financePlanner.mjs";

const salary = { amount: 2000, currency: "USD", payFrequency: "semimonthly", firstPayDate: "2026-11-06" };
const monthly = (id, amount, currency = "USD", dueDay = 18) => ({ id, name: id, amount, currency, cadence: "monthly", dueDay, dueMonths: [] });
const annual = (id, amount, currency = "USD", dueDay = 9, dueMonths = [9]) => ({ id, name: id, amount, currency, cadence: "annual", dueDay, dueMonths });

test("monthly and pay-period summaries reserve annual bills exactly once", () => {
  const document = {
    salary,
    bills: [monthly("US bills", 62), monthly("PH bills", 4200, "PHP"), annual("Microsoft", 100), annual("Domain", 20), annual("Car", 500, "USD", 9, [3, 9]), annual("Venture X", 395)],
    allocations: [{ amount: 500, currency: "USD", kind: "savings" }]
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
  const document = { salary: { ...salary, payFrequency: "biweekly" }, bills: [monthly("Bills", 260), annual("Annual", 260)], allocations: [] };
  const summary = getSummary(document, 63);
  assert.equal(summary.payPeriods, 26);
  assert.equal(summary.incomePerPeriodUsd, 923.08);
  assert.equal(summary.billsUsdPerPeriod, 120);
  assert.equal(summary.annualPerPeriodUsd, 10);
  assert.equal(summary.remainingPerPeriodUsd, 793.08);
});

test("PHP salary and allocations keep native currency and convert once", () => {
  const summary = getSummary({ salary: { ...salary, amount: 126000, currency: "PHP" }, bills: [annual("PHP annual", 6300, "PHP")], allocations: [{ amount: 6300, currency: "PHP" }] }, 63);
  assert.equal(summary.monthlyUsd, 2000);
  assert.equal(summary.monthlyPhp, 126000);
  assert.equal(summary.annualUsd, 100);
  assert.equal(summary.allocationsPerPeriodUsd, 100);
});

test("PHP summary totals preserve native cents instead of round-tripping rounded USD", () => {
  const summary = getSummary({
    salary: { ...salary, amount: 1000.01, currency: "PHP" },
    bills: [monthly("PHP monthly", 169.01, "PHP"), monthly("USD monthly", 2), annual("PHP annual", 1015.01, "PHP"), annual("USD annual", 20)],
    allocations: []
  }, 63);
  assert.equal(summary.annualPhp, 2275.01);
  assert.equal(summary.annualMonthlyPhp, 189.58);
  assert.equal(summary.monthlyCommitmentsPhp, 484.59);
  assert.equal(summary.monthlyRemainingPhp, 515.42);
  assert.notEqual(summary.annualPhp, convert(summary.annualUsd, "USD", "PHP", 63));
});

test("monthly dates clamp to month end across leap years and year boundaries", () => {
  const bill = monthly("Month end", 10, "USD", 31);
  assert.deepEqual(billOccurrences(bill, "2024-01-31", "2024-03-31").map((row) => row.date), ["2024-01-31", "2024-02-29", "2024-03-31"]);
  assert.deepEqual(billOccurrences(bill, "2026-12-01", "2027-02-28").map((row) => row.date), ["2026-12-31", "2027-01-31", "2027-02-28"]);
  assert.deepEqual(billOccurrences({ ...bill, dueDay: null }, "2026-11-01", "2026-11-30"), []);
});

test("annual installment rounding preserves total and deduplicates months", () => {
  const bill = annual("Installments", 100, "USD", 31, [9, 3, 6, 3]);
  const rows = billOccurrences(bill, "2026-01-01", "2026-12-31");
  assert.deepEqual(rows.map(({ date, amount }) => ({ date, amount })), [
    { date: "2026-03-31", amount: 33.33 }, { date: "2026-06-30", amount: 33.33 }, { date: "2026-09-30", amount: 33.34 }
  ]);
  assert.equal(rows.reduce((sum, row) => sum + Math.round(row.amount * 100), 0), 10000);
});

test("salary schedules respect first payday, range edges and leap dates", () => {
  assert.deepEqual(salaryOccurrences(salary, "2026-11-01", "2026-12-21").map((row) => row.date), ["2026-11-06", "2026-11-21", "2026-12-06", "2026-12-21"]);
  assert.deepEqual(salaryOccurrences({ ...salary, firstPayDate: "2026-11-20" }, "2026-11-01", "2026-12-31").map((row) => row.date), ["2026-11-20", "2026-12-05", "2026-12-20"]);
  assert.deepEqual(salaryOccurrences({ ...salary, firstPayDate: "2024-01-31" }, "2024-02-01", "2024-02-29").map((row) => row.date), ["2024-02-16", "2024-02-29"]);
  const fortnightly = salaryOccurrences({ ...salary, payFrequency: "biweekly" }, "2026-11-07", "2026-12-18");
  assert.deepEqual(fortnightly.map((row) => row.date), ["2026-11-20", "2026-12-04", "2026-12-18"]);
  assert.equal(fortnightly[0].amount, 923.08);
});

test("budget ledger generates native bills and income with independent running balances", () => {
  const document = { salary, bills: [monthly("USD bill", 100, "USD", 6), monthly("PHP bill", 6300, "PHP", 6), annual("Annual", 200, "USD", 6, [3, 11])], allocations: [] };
  const plan = { startDate: "2026-11-01", endDate: "2026-11-06", openingUsd: 750, openingPhp: 0, includeIncome: true, entries: [{ id: "fx", date: "2026-11-06", description: "Convert", kind: "conversion", amount: 100, currency: "USD" }] };
  const rows = buildPlanRows(plan, document, 63);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].source, "salary");
  assert.equal(rows[1].kind, "conversion");
  assert.equal(rows.at(-1).balanceUsd, 1450);
  assert.equal(rows.at(-1).balancePhp, 0);
  assert.equal(rows.filter((row) => row.source === "bill").length, 3);
  assert.deepEqual(buildPlanRows(plan, document, 63), rows);
});

test("manual PHP conversions conserve value and negative balances stay visible", () => {
  const plan = { startDate: "2026-11-01", endDate: "2026-11-30", openingUsd: 0, openingPhp: 0, includeIncome: false, entries: [
    { id: "convert", date: "2026-11-06", description: "Convert PHP to USD", kind: "conversion", amount: 630, currency: "PHP" },
    { id: "expense", date: "2026-11-06", description: "Expense", kind: "expense", amount: 20, currency: "USD" },
    { id: "outside", date: "2026-12-01", description: "Outside range", kind: "income", amount: 1000, currency: "USD" }
  ] };
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
