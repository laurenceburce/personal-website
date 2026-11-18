import test from "node:test";
import assert from "node:assert/strict";
import { filterLivePlannerRows, getLivePlannerAnalytics, getLivePlannerComputationRange, getLivePlannerRange, withLivePlannerBalances } from "../app/lib/financeLivePlanner.mjs";

const today = "2026-11-18";
const range = { startDate: today, endDate: "2027-01-01" };
const account = (id, type, balance, currency = "USD") => ({ id, name: `Account ${id}`, type, currency, nativeCurrentBalance: balance });
const movement = (accountId, amount, currency = "USD", extra = {}) => ({ accountId, amount, currency, ...extra });
const flow = (id, date, moves, extra = {}) => ({ id, date, source: "manual", kind: "expense", amount: 10, accountMovements: moves, ...extra });

test("view range validation and computation dates preserve history without extending a historical query to today", () => {
  assert.deepEqual(getLivePlannerRange({ today }), { startDate: "2026-11-04", endDate: "2027-02-16" });
  assert.deepEqual(getLivePlannerComputationRange({ startDate: "2026-12-01", endDate: "2027-01-01" }, today), range);
  assert.deepEqual(getLivePlannerComputationRange({ startDate: "2020-01-01", endDate: "2020-02-01" }, today), { startDate: "2020-01-01", endDate: "2020-02-01" });
  for (const dates of [
    { startDate: "2026-02-30", endDate: today }, { startDate: today, endDate: "2026-11-17" },
    { startDate: "2026-01-01", endDate: "2029-01-01" }, { startDate: "2028-11-18", endDate: "2028-12-18" },
  ]) assert.throws(() => getLivePlannerRange({ ...dates, today }), (error) => error.status === 400);
});

test("a view filter preserves computed running balances and never mutates or saves the source rows", () => {
  const rows = [flow("before", today, [], { balanceUsd: 90 }), flow("visible", "2026-12-01", [], { balanceUsd: 75 }), flow("after", "2027-02-01", [])];
  const before = structuredClone(rows);
  assert.deepEqual(filterLivePlannerRows(rows, { startDate: "2026-12-01", endDate: "2027-01-01" }), [rows[1]]);
  assert.deepEqual(rows, before);
});

test("analytics start with real native balances and apply future movements once, including hidden earlier future flows", () => {
  const accounts = [account(1, "checking", 1000), account(2, "savings", 500), account(3, "credit", 300), account(4, "checking", 6300, "PHP")];
  const rows = [
    flow("already-paid", "2026-11-17", [movement(1, -200)], { completed: true, source: "transaction" }),
    flow("unpaid-overdue", "2026-11-17", [movement(1, -20)]),
    flow("hidden-income", "2026-11-20", [movement(1, 100)], { kind: "income" }),
    flow("internal-transfer", "2026-12-01", [movement(1, -50), movement(2, 50)], { kind: "transfer" }),
    flow("card-purchase", "2026-12-03", [movement(3, -80, "USD", { balanceDelta: 80 })]),
    flow("card-payment", "2026-12-15", [movement(1, -100), movement(3, 100, "USD", { balanceDelta: -100 })], { kind: "transfer" }),
    flow("php-bill", "2026-12-20", [movement(4, -300, "PHP")]),
    flow("outside", "2027-02-01", [movement(1, -999)]),
  ];
  // Share-weighted balances in a planner row must not replace live total funds.
  rows[2].accountBalances = { 1: 5, 2: 10 };
  const before = structuredClone({ accounts, rows });
  const result = getLivePlannerAnalytics({ accounts, rows, today, range: { startDate: "2026-12-01", endDate: "2027-01-01" } });
  assert.deepEqual(result.assets.USD, { current: 1500, projected: 1500, change: 0 });
  assert.deepEqual(result.assets.PHP, { current: 6300, projected: 6000, change: -300 });
  assert.deepEqual(result.debt.USD, { current: 300, projected: 280, change: -20 });
  assert.deepEqual(result.cashflow.USD, { income: 0, payments: 100, net: -100 });
  assert.deepEqual(result.cashflow.PHP, { income: 0, payments: 300, net: -300 });
  assert.equal(result.upcomingCount, 4);
  assert.equal(result.overdueCount, 0);
  assert.equal(result.points[0].USD, 1500);
  assert.equal(result.points.at(-1).USD, 1500);
  const expandedHistory = getLivePlannerAnalytics({ accounts, rows, today, range: { startDate: "2026-11-01", endDate: "2027-01-01" } });
  assert.deepEqual(expandedHistory.assets, result.assets, "the history filter cannot change the same ending projection");
  assert.deepEqual(expandedHistory.debt, result.debt);
  assert.equal(expandedHistory.overdueCount, 1);
  assert.deepEqual({ accounts, rows }, before);
});

test("unavailable balances remain unavailable and liabilities never appear as cash", () => {
  const result = getLivePlannerAnalytics({ today, range, accounts: [account(1, "checking", null), account(2, "credit", 800),
    { ...account(3, "checking", 9000), isArchived: true }, account(4, "checking", "250.25", "PHP")],
    rows: [flow("unassigned", "2026-11-25", [], { accountId: null })] });
  assert.deepEqual(result.assets.USD, { current: null, projected: null, change: null });
  assert.equal(result.debt.USD.current, 800);
  assert.equal(result.assets.PHP.current, 250.25);
  assert.equal(result.unassignedCount, 1);
  assert.equal(result.accounts.length, 3);
});

test("historical ranges keep current balances live without inventing a historical or projected balance", () => {
  const result = getLivePlannerAnalytics({ today, range: { startDate: "2026-10-01", endDate: "2026-10-31" },
    accounts: [account(1, "checking", 100)], rows: [flow("old", "2026-10-25", [movement(1, -50)])] });
  assert.equal(result.hasProjection, false);
  assert.deepEqual(result.assets.USD, { current: 100, projected: null, change: null });
  assert.deepEqual(result.points, []);
  assert.equal(result.upcomingCount, 0);
});

test("native conversions affect projected balances without being counted as earned income or payments", () => {
  const result = getLivePlannerAnalytics({ today, range, accounts: [account(1, "checking", 100), account(2, "checking", 0, "PHP")],
    rows: [flow("conversion", "2026-11-25", [movement(1, -10), movement(2, 630, "PHP")], { kind: "conversion" })] });
  assert.equal(result.assets.USD.projected, 90);
  assert.equal(result.assets.PHP.projected, 630);
  assert.equal(result.cashflow.PHP.income, 0);
  assert.equal(result.cashflow.USD.payments, 0);
});

test("table balances use actual account funds and agree with summary after transfers and card payments", () => {
  const accounts = [account(1, "checking", 1000), account(2, "savings", 500), account(3, "credit", 300), account(4, "checking", 700, "PHP")];
  const rows = [
    flow("past", "2026-11-01", [movement(1, -50)], { balanceUsd: -50 }),
    flow("posted", today, [], { completed: true, source: "transaction", balanceUsd: 0 }),
    flow("transfer", "2026-11-20", [movement(1, -200), movement(2, 200)], { kind: "transfer", balanceUsd: -200 }),
    flow("payment", "2026-11-21", [movement(1, -100), movement(3, 100, "USD", { balanceDelta: -100 })], { kind: "transfer", balanceUsd: -300 }),
    flow("php", "2026-11-22", [movement(4, -70, "PHP")]),
  ];
  const before = structuredClone(rows);
  const table = withLivePlannerBalances({ accounts, rows, today });
  assert.equal(table[2].projectedBalanceUsd, 1500, "internal cash transfers keep total funds");
  assert.equal(table[3].projectedBalanceUsd, 1400, "card payment reduces cash, without subtracting debt twice");
  assert.equal(table.at(-1).projectedBalancePhp, 630);
  const analytics = getLivePlannerAnalytics({ accounts, rows, range, today });
  assert.equal(table.at(-1).projectedBalanceUsd, analytics.assets.USD.projected);
  assert.equal(table.at(-1).projectedBalancePhp, analytics.assets.PHP.projected);
  assert.deepEqual(rows, before);
  assert.equal(withLivePlannerBalances({ accounts: [account(1, "checking", null)], rows, today })[0].projectedBalanceUsd, null);
});

test("card dues need a valid cash funding leg before projected debt can be paid", () => {
  const accounts = [account(1, "checking", 1000), account(2, "credit", 300),
    { ...account(3, "checking", 500), isArchived: true }, account(4, "checking", 600, "PHP")];
  const makeDue = (moves) => flow("due", "2026-12-01", moves, { source: "creditCardDue", creditAccountId: 2, amount: 100, currency: "USD" });
  const cardCredit = movement(2, 100, "USD", { balanceDelta: -100 });
  for (const moves of [[], [cardCredit], [movement(3, -100), cardCredit], [movement(4, -100, "USD"), cardCredit]]) {
    const result = getLivePlannerAnalytics({ accounts, rows: [makeDue(moves)], range, today });
    assert.equal(result.debt.USD.current, 300);
    assert.equal(result.debt.USD.projected, 300, "missing, archived or wrong-currency funding cannot erase debt");
    assert.equal(result.assets.USD.projected, 1000);
    assert.equal(result.unassignedCount, 1, "an incomplete due is counted once even when it has no valid movements");
  }
  const funded = getLivePlannerAnalytics({ accounts, rows: [makeDue([movement(1, -100), cardCredit])], range, today });
  assert.equal(funded.debt.USD.projected, 200);
  assert.equal(funded.assets.USD.projected, 900);
  assert.equal(funded.unassignedCount, 0);
  assert.equal(funded.cashflow.USD.payments, 100);
});
