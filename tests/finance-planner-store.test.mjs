import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultFinancePlanner, validateFinancePlanner } from "../app/lib/financePlannerStore.js";

const document = () => ({
  salary: { amount: 2000, currency: "USD", payFrequency: "semimonthly", firstPayDate: "2026-11-06" },
  bills: [{ id: "bill-1", name: " Microsoft ", amount: 100, currency: "USD", cadence: "annual", dueDay: 9, dueMonths: [9], paymentMethod: "US Bank Credit", isAutopay: true }],
  allocations: [{ id: "saving-1", name: "Savings", amount: 500, currency: "USD", kind: "savings" }],
  plans: [{ id: "plan-1", name: "November", startDate: "2026-11-01", endDate: "2026-11-30", openingUsd: 750, openingPhp: 0, includeIncome: true,
    entries: [{ id: "conversion-1", date: "2026-11-06", description: "Convert for bills", kind: "conversion", amount: 333.09, currency: "USD" }] }]
});

test("default is an empty personal planner with a USD salary and real local date", () => {
  const planner = createDefaultFinancePlanner();
  assert.equal(planner.salary.currency, "USD");
  assert.equal(planner.salary.payFrequency, "biweekly");
  assert.match(planner.salary.firstPayDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(validateFinancePlanner(planner), planner);
});

test("round trips annual installments, savings and two-currency conversion entries", () => {
  const planner = document();
  planner.bills[0].dueMonths = [9, 3, 9];
  const clean = validateFinancePlanner(planner);
  assert.equal(clean.bills[0].name, "Microsoft");
  assert.deepEqual(clean.bills[0].dueMonths, [3, 9]);
  assert.deepEqual(clean.plans[0].entries, planner.plans[0].entries);
});

test("legacy annual bills receive zero saved funds without changing their source document", () => {
  const planner = document();
  const before = structuredClone(planner);
  const clean = validateFinancePlanner(planner);
  assert.equal(clean.bills[0].savedAmount, 0);
  assert.deepEqual(planner, before);
  assert.equal(Object.hasOwn(planner.bills[0], "savedAmount"), false);
  assert.deepEqual(validateFinancePlanner(clean), clean);
});

test("annual saved funds round trip in the bill currency and can exceed the yearly cost", () => {
  const planner = document();
  planner.bills[0].savedAmount = 150.126;
  planner.bills.push({ ...planner.bills[0], id: "php-bill", currency: "PHP", savedAmount: 12600.5 });
  const clean = validateFinancePlanner(planner);
  assert.equal(clean.bills[0].amount, 100);
  assert.equal(clean.bills[0].savedAmount, 150.13);
  assert.equal(clean.bills[0].currency, "USD");
  assert.equal(clean.bills[1].savedAmount, 12600.5);
  assert.equal(clean.bills[1].currency, "PHP");
  assert.deepEqual(validateFinancePlanner(clean), clean);
  planner.bills[0].savedAmount = 999_999_999;
  assert.equal(validateFinancePlanner(planner).bills[0].savedAmount, 999_999_999);
});

test("annual saved funds reject negative, nonfinite, nonnumeric and excessive values", () => {
  for (const savedAmount of [-0.01, NaN, Infinity, -Infinity, 1_000_000_000, "100", null, true, {}, []]) {
    const planner = document();
    planner.bills[0].savedAmount = savedAmount;
    assert.throws(() => validateFinancePlanner(planner), /Saved amount/, `saved amount ${String(savedAmount)}`);
  }
});

test("monthly bills normalize stale annual saved funds to zero", () => {
  for (const savedAmount of [undefined, 100, 999_999_999, null, "stale"]) {
    const planner = document();
    Object.assign(planner.bills[0], { cadence: "monthly", dueMonths: [], savedAmount });
    const clean = validateFinancePlanner(planner);
    assert.equal(clean.bills[0].savedAmount, 0);
    assert.deepEqual(validateFinancePlanner(clean), clean);
  }
});

test("retains a signed opening balance and allows a zero salary", () => {
  const planner = document();
  planner.salary.amount = 0;
  planner.plans[0].openingUsd = -120;
  assert.equal(validateFinancePlanner(planner).plans[0].openingUsd, -120);
});

test("rejects invalid calendar dates instead of silently rolling them forward", () => {
  const planner = document();
  planner.salary.firstPayDate = "2026-02-29";
  assert.throws(() => validateFinancePlanner(planner), /valid date/);
  planner.salary.firstPayDate = "2028-02-29";
  assert.equal(validateFinancePlanner(planner).salary.firstPayDate, "2028-02-29");
});

test("rejects unknown currencies and pay schedules", () => {
  for (const [key, value] of [["currency", "EUR"], ["payFrequency", "weekly"]]) {
    const planner = document();
    planner.salary[key] = value;
    assert.throws(() => validateFinancePlanner(planner), /invalid/);
  }
});

test("rejects NaN, infinity, negative and out of bounds monthly salary", () => {
  for (const value of [NaN, Infinity, -1, 1_000_000_000, "2000", null]) {
    const planner = document();
    planner.salary.amount = value;
    assert.throws(() => validateFinancePlanner(planner), /amount/);
  }
});

test("requires an annual due month and allows an open due day for both bill frequencies", () => {
  const planner = document();
  planner.bills[0].dueMonths = [];
  assert.throws(() => validateFinancePlanner(planner), /at least one due month/);
  planner.bills[0].cadence = "monthly";
  planner.bills[0].dueDay = null;
  assert.equal(validateFinancePlanner(planner).bills[0].dueDay, null);
  planner.bills[0].cadence = "annual";
  planner.bills[0].dueMonths = [11];
  assert.equal(validateFinancePlanner(planner).bills[0].dueDay, null);
});

test("monthly payments normalize two due days without changing the total monthly bill amount", () => {
  const planner = document();
  Object.assign(planner.bills[0], { cadence: "monthly", amount: 100.01, dueDay: 20, dueDays: [20, 5, 20], dueMonths: [] });
  const bill = validateFinancePlanner(planner).bills[0];
  assert.deepEqual(bill.dueDays, [5, 20]);
  assert.equal(bill.dueDay, 5);
  assert.equal(bill.amount, 100.01);
  assert.deepEqual(validateFinancePlanner({ ...planner, bills: [bill] }).bills[0], bill);
});

test("legacy monthly due days are preserved and explicit empty dates remain open", () => {
  const planner = document();
  Object.assign(planner.bills[0], { cadence: "monthly", dueDay: 11, dueMonths: [] });
  assert.deepEqual(validateFinancePlanner(planner).bills[0].dueDays, [11]);
  planner.bills[0].dueDays = [];
  const open = validateFinancePlanner(planner).bills[0];
  assert.deepEqual(open.dueDays, []);
  assert.equal(open.dueDay, null);
  assert.equal(validateFinancePlanner(planner).salary.payFrequency, "semimonthly");
});

test("monthly schedules reject more than two unique dates and invalid day values", () => {
  for (const dueDays of [[1, 15, 30], [0, 15], [15, 32], [1.5], ["15"], null, "1,15"]) {
    const planner = document();
    Object.assign(planner.bills[0], { cadence: "monthly", dueMonths: [], dueDays });
    assert.throws(() => validateFinancePlanner(planner), /two monthly due days/);
  }
});

test("annual month schedules retain their single due day independently of monthly split dates", () => {
  const planner = document();
  planner.bills[0].dueDays = [4, 19];
  const annual = validateFinancePlanner(planner).bills[0];
  assert.equal(annual.dueDay, 9);
  assert.deepEqual(annual.dueMonths, [9]);
  assert.deepEqual(annual.dueDays, []);
});

test("legacy plans default to full money flow and distinct zero opening annual reserves", () => {
  const plan = validateFinancePlanner(document()).plans[0];
  assert.equal(plan.includeIncome, true);
  assert.equal(plan.includeTransactions, true);
  assert.equal(plan.includeAllocations, true);
  assert.equal(plan.includeAnnualReserve, true);
  assert.equal(plan.openingReserveUsd, 0);
  assert.equal(plan.openingReservePhp, 0);
  assert.equal(plan.openingUsd, 750);
  assert.equal(plan.openingPhp, 0);
});

test("plans retain selected flow switches and native opening annual reserves", () => {
  const planner = document();
  Object.assign(planner.plans[0], { includeTransactions: false, includeAllocations: false, includeAnnualReserve: false, openingReserveUsd: 120.126, openingReservePhp: 6500.50 });
  const clean = validateFinancePlanner(planner).plans[0];
  assert.equal(clean.includeTransactions, false);
  assert.equal(clean.includeAllocations, false);
  assert.equal(clean.includeAnnualReserve, false);
  assert.equal(clean.openingReserveUsd, 120.13);
  assert.equal(clean.openingReservePhp, 6500.5);
  assert.deepEqual(validateFinancePlanner({ ...planner, plans: [clean] }).plans[0], clean);
});

test("reserve balances cannot be negative or nonnumeric and flow switches must be booleans", () => {
  for (const [key, value] of [["openingReserveUsd", -1], ["openingReservePhp", null], ["openingReservePhp", "500"], ["openingReserveUsd", Infinity], ["openingReserveUsd", 1_000_000_000], ["includeTransactions", "false"], ["includeAllocations", null], ["includeAnnualReserve", 0]]) {
    const planner = document();
    planner.plans[0][key] = value;
    assert.throws(() => validateFinancePlanner(planner));
  }
});

test("rejects invalid due days, due months and automatic payment flags", () => {
  for (const [key, value] of [["dueDay", 32], ["dueDay", 1.5], ["dueMonths", [0]], ["dueMonths", [13]], ["isAutopay", "false"]]) {
    const planner = document();
    planner.bills[0][key] = value;
    assert.throws(() => validateFinancePlanner(planner));
  }
});

test("rejects duplicate IDs to prevent ambiguous edits", () => {
  const planner = document();
  planner.bills.push({ ...planner.bills[0] });
  assert.throws(() => validateFinancePlanner(planner), /IDs must be unique/);
});

test("rejects inverted dates, plans over two years and out of range entries", () => {
  const planner = document();
  planner.plans[0].endDate = "2026-10-31";
  assert.throws(() => validateFinancePlanner(planner), /dates must be in order/);
  planner.plans[0].endDate = "2029-11-30";
  assert.throws(() => validateFinancePlanner(planner), /two years/);
  planner.plans[0].endDate = "2026-11-30";
  planner.plans[0].entries[0].date = "2026-12-01";
  assert.throws(() => validateFinancePlanner(planner), /within the plan/);
});

test("strips arbitrary properties and prototype names from stored records", () => {
  const planner = document();
  planner.admin = true;
  planner.salary.sensitive = "discard";
  planner.bills[0].constructor = "discard";
  const clean = validateFinancePlanner(planner);
  assert.equal(Object.hasOwn(clean, "admin"), false);
  assert.equal(Object.hasOwn(clean.salary, "sensitive"), false);
  assert.equal(Object.hasOwn(clean.bills[0], "constructor"), false);
});

test("caps row counts and total UTF-8 document size", () => {
  const planner = document();
  planner.bills = Array.from({ length: 301 }, (_, index) => ({ ...planner.bills[0], id: `bill-${index}` }));
  assert.throws(() => validateFinancePlanner(planner), /at most 300/);
  planner.bills = [];
  planner.ignored = "x".repeat(1_000_000);
  assert.throws(() => validateFinancePlanner(planner), (error) => error.status === 413);
});
