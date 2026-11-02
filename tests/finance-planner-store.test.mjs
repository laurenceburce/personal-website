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
