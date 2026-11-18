import test from "node:test";
import assert from "node:assert/strict";
import { filterLivePlannerRows, getLivePlannerAnalytics, getLivePlannerComputationRange, getLivePlannerRange, withLivePlannerBalances, withLivePlannerAccountSnapshots } from "../app/lib/financeLivePlanner.mjs";

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

test("expanded recorded balances reverse later posted movements and keep both transfer legs together", () => {
  const accounts = [account(1, "checking", 900), account(2, "savings", 600), account(3, "credit", 225),
    account(4, "checking", 3000, "PHP"), account(5, "savings", null), { ...account(6, "checking", 9), isArchived: true }];
  const history = [
    [1, "2026-11-17", 1, "expense", 100], [2, "2026-11-17", 1, "income", 200],
    [3, "2026-11-17", 3, "expense", 50], [4, "2026-11-18", 1, "expense", 100],
    [5, "2026-11-18", 2, "income", 100], [6, "2026-11-18", 3, "income", 25],
    [7, "2026-11-18", 1, "expense", 25], [8, "2026-11-19", 1, "expense", 75],
  ].map(([id, date, accountId, kind, amount]) => ({ id, date, accountId, kind, amount, currency: "USD" }));
  const rows = [
    ...[1, 2, 3].map((id) => ({ id: `transaction:${id}`, transactionId: id, source: "transaction", date: "2026-11-17", completed: true })),
    { id: "entry:transfer", date: "2026-11-18", completed: true, recordedInAccounts: true,
      recordedTransactions: [{ transactionId: 4 }, { id: "transaction:5" }] },
    { id: "entry:payment", date: "2026-11-18", completed: true, completionSource: "plan", matchedTransactionIds: [6, 7] },
    { id: "transaction:8", transactionId: 8, date: "2026-11-19", source: "transaction", completed: true },
  ];
  const before = structuredClone({ accounts, rows, history });
  const result = withLivePlannerAccountSnapshots({ accounts, rows, today: "2026-11-20", historyTransactions: history,
    historyFrom: "2026-11-17", historyThrough: "2026-11-20", historyComplete: true });
  const balances = (row) => row.accountBalanceSnapshot.map((item) => item.balance);
  assert.deepEqual(balances(result[0]), [900, 500, 200, 3000, null]);
  assert.deepEqual(balances(result[1]), [1100, 500, 200, 3000, null]);
  assert.deepEqual(balances(result[2]), [1100, 500, 250, 3000, null]);
  assert.deepEqual(balances(result[3]), [1000, 600, 250, 3000, null]);
  assert.deepEqual(balances(result[4]), [975, 600, 225, 3000, null]);
  assert.deepEqual(balances(result[5]), [900, 600, 225, 3000, null]);
  assert.ok(result.every((row) => row.accountBalanceSnapshotKind === "recorded"));
  assert.equal(result[4].accountBalanceSnapshot[2].isDebt, true);
  assert.match(result[0].accountBalanceSnapshotNote, /Reconstructed/);
  assert.deepEqual({ accounts, rows, history }, before);
});

test("each future row snapshots all native accounts without replaying recorded movements", () => {
  const accounts = [account(1, "checking", 1000), account(2, "savings", 500), account(3, "credit", 300), account(4, "cash", 0, "PHP")];
  const rows = [
    flow("posted", today, [movement(1, -10, "USD", { recordedDate: today })], { completed: true, source: "transaction", transactionId: 9 }),
    flow("transfer", "2026-11-20", [movement(1, -100), movement(2, 100)]),
    flow("charge", "2026-11-21", [movement(3, -50, "USD", { balanceDelta: 50 })]),
    flow("card-payment", "2026-11-22", [movement(1, -200), movement(3, 200, "USD", { balanceDelta: -200 })]),
  ];
  const result = withLivePlannerAccountSnapshots({ accounts, rows, today });
  const values = (index) => result[index].accountBalanceSnapshot.map((item) => item.balance);
  assert.deepEqual(values(1), [900, 600, 300, 0]);
  assert.deepEqual(values(2), [900, 600, 350, 0]);
  assert.deepEqual(values(3), [700, 600, 150, 0]);
  assert.equal(result[3].accountBalanceSnapshotKind, "projected");
  assert.deepEqual(values(0), [null, null, null, null], "missing history cannot be replaced with current values");
});

test("incomplete or missing historical coverage stays unavailable and never fabricates past balances", () => {
  const accounts = [account(1, "checking", 0)];
  const row = { id: "transaction:10", transactionId: 10, date: "2026-11-17", source: "transaction", completed: true };
  const history = [{ id: 10, date: "2026-11-17", accountId: 1, kind: "expense", amount: 10, currency: "USD" },
    { id: 11, date: "2026-11-17", accountId: 1, kind: "expense", amount: 5, currency: "USD" }];
  const input = { accounts, rows: [row], today, historyTransactions: history, historyFrom: "2026-11-17", historyThrough: today, historyComplete: true };
  assert.equal(withLivePlannerAccountSnapshots(input)[0].accountBalanceSnapshot[0].balance, 5);
  for (const change of [{ historyComplete: false }, { historyThrough: "2026-11-17" }, { historyFrom: today }, { historyTransactions: [] }]) {
    const result = withLivePlannerAccountSnapshots({ ...input, ...change })[0];
    assert.equal(result.accountBalanceSnapshotKind, "unavailable");
    assert.equal(result.accountBalanceSnapshot[0].balance, null);
  }
  const past = withLivePlannerAccountSnapshots({ accounts, today, rows: [flow("unpaid", "2026-11-01", [])] })[0];
  assert.equal(past.accountBalanceSnapshotKind, "unavailable");
});

test("expanded snapshots and the analytics summary both retain unfunded card debt", () => {
  const accounts = [account(1, "checking", 500), account(2, "credit", 300)];
  const due = flow("due", "2026-12-01", [movement(2, 100, "USD", { balanceDelta: -100 })],
    { source: "creditCardDue", amount: 100, creditAccountId: 2 });
  const unfunded = withLivePlannerAccountSnapshots({ accounts, rows: [due], today })[0];
  assert.deepEqual(unfunded.accountBalanceSnapshot.map((item) => item.balance), [500, 300]);
  const funded = { ...due, accountMovements: [movement(1, -100), ...due.accountMovements] };
  const snapshot = withLivePlannerAccountSnapshots({ accounts, rows: [funded], today })[0];
  const analytics = getLivePlannerAnalytics({ accounts, rows: [funded], today, range });
  assert.equal(snapshot.accountBalanceSnapshot[1].balance, analytics.debt.USD.projected);
  assert.equal(snapshot.accountBalanceSnapshot[0].balance, analytics.assets.USD.projected);
});
