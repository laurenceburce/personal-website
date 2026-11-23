import test from "node:test";
import assert from "node:assert/strict";
import { filterLivePlannerRows, getLivePlannerAnalytics, getLivePlannerComputationRange, getLivePlannerRange, getLivePlannerOpeningRow, withLivePlannerBalances, withLivePlannerAccountSnapshots } from "../app/lib/financeLivePlanner.mjs";
import { buildAccountPlan } from "../app/lib/financeAccountPlan.mjs";
import { orderPlanRows } from "../app/lib/financePlanRowOrder.mjs";
import { buildPlanRows } from "../app/lib/financePlanner.mjs";

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

test("a restarted timeline clamps stale history URLs to its known starting day", () => {
  const date = "2026-11-20";
  assert.deepEqual(getLivePlannerRange({ today: date, minDate: date }), { startDate: date, endDate: "2027-02-18" });
  assert.deepEqual(getLivePlannerRange({ today: date, minDate: date, startDate: "2026-11-01", endDate: "2026-11-15" }),
    { startDate: date, endDate: "2027-02-18" });
  assert.deepEqual(getLivePlannerRange({ today: date, minDate: date, startDate: "2026-11-25", endDate: "2026-11-30" }),
    { startDate: "2026-11-25", endDate: "2026-11-30" });
});

test("a reset opening retains captured native values when current accounts later refresh", () => {
  const plan = { restart: { version: 1, date: "2026-11-20", transactionId: 100, balances: [
    { accountId: 1, type: "checking", currency: "USD", balance: 1252.13 },
    { accountId: 2, type: "credit", currency: "PHP", balance: 10824.12 },
  ] } };
  const accounts = [account(1, "checking", 9999), account(2, "credit", 9999, "PHP")];
  const before = structuredClone({ plan, accounts });
  const opening = getLivePlannerOpeningRow(plan, { accounts });
  assert.equal(opening.description, "Starting balances");
  assert.equal(opening.date, "2026-11-20");
  assert.equal(opening.isOpeningBalance, true);
  assert.deepEqual(opening.accountBalanceSnapshot.map((item) => item.balance), [1252.13, 10824.12]);
  assert.equal(opening.projectedBalanceUsd, 1252.13);
  assert.equal(opening.projectedBalancePhp, 0, "card debt stays separate from native account funds");
  assert.equal(opening.accountMovements, undefined, "an opening must not move money or become another posting");
  assert.equal(getLivePlannerOpeningRow(plan, { accounts: [{ ...accounts[0], nativeCurrentBalance: 700 }, accounts[1]] })
    .accountBalanceSnapshot[0].balance, 1252.13);
  const unknown = getLivePlannerOpeningRow({ restart: { ...plan.restart, balances: [] } }, { accounts });
  assert.ok(unknown.accountBalanceSnapshot.every((item) => item.balance === null), "missing reset values never use today's newer balances");
  assert.deepEqual({ plan, accounts }, before);
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

test("a carried issued payment projects once from current funds while preserving its real due and configured dates", () => {
  const today = "2026-11-22";
  const accounts = [account(1, "checking", 1000), { ...account(2, "credit", 100), isLinked: true,
    creditCardDueStatus: "current", creditCardAutopayEnabled: true, creditCardAutopayDaysBeforeDue: 7,
    creditCardDue: { statementBalance: 100, dueDate: "2026-11-25", lastStatementDate: "2026-11-01" } }];
  const range = { startDate: "2026-11-23", endDate: "2026-12-01" };
  const plan = { id: "live", continuous: true, balanceMode: "live", ...getLivePlannerComputationRange(range, today),
    accountLinks: { availableUsdAccountId: 1 }, includeIncome: false, includeTransactions: true,
    includeAnnualReserve: false, includeAllocations: false, entries: [],
    restart: { version: 1, date: "2026-11-20", transactionId: 100, balances: [], coveredEntryIds: [] } };
  const document = { salary: {}, bills: [], allocations: [], plans: [plan] };
  const before = structuredClone({ accounts, plan, document });
  const rows = buildPlanRows(plan, document, 58, { today, accounts });
  const native = buildAccountPlan(plan, document, 58, { today, accounts, rows });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].carriedPayment, true);
  assert.equal(rows[0].date, today);
  assert.equal(rows[0].dueDate, "2026-11-25");
  assert.equal(rows[0].scheduledPaymentDate, "2026-11-18");
  assert.equal(rows[0].amount, 100);
  const snapshot = withLivePlannerAccountSnapshots({ today, accounts, rows: native.rows })[0];
  assert.equal(snapshot.projectedBalanceUsd, 900);
  assert.deepEqual(snapshot.accountBalanceSnapshot.map((item) => item.balance), [900, 0]);
  const summary = getLivePlannerAnalytics({ today, accounts, rows: native.rows, range });
  assert.equal(summary.assets.USD.current, 1000);
  assert.equal(summary.assets.USD.projected, 900);
  assert.equal(summary.debt.USD.current, 100);
  assert.equal(summary.debt.USD.projected, 0);
  assert.deepEqual(filterLivePlannerRows([snapshot], range), [], "hiding today's carried row cannot remove its effect on later projections");
  assert.deepEqual({ accounts, plan, document }, before);
});

test("partially funded card dues reduce debt only by their known native funding", () => {
  const date = "2026-11-20";
  const accounts = [account(1, "checking", 60), account(2, "savings", 40), account(3, "credit", 100)];
  const due = { id: "due", date: "2026-11-21", description: "Card statement", source: "creditCardDue",
    kind: "expense", amount: 100, currency: "USD", creditAccountId: 3,
    annualBillCoverage: [{ billId: "fee", billName: "Annual fee", reserveUsed: 40, reserveAccountId: 2 }] };
  for (const fullyFunded of [false, true]) {
    const plan = { id: "live", startDate: date, endDate: due.date, balanceMode: "live", entries: [],
      accountLinks: { annualReserveUsdAccountId: 2, ...(fullyFunded ? { availableUsdAccountId: 1 } : {}) } };
    const built = buildAccountPlan(plan, { salary: {}, bills: [], allocations: [] }, 63,
      { today: date, accounts, rows: [due] });
    const before = structuredClone({ accounts, rows: built.rows });
    const input = { accounts, rows: built.rows, today: date };
    const summary = getLivePlannerAnalytics({ ...input, range: { startDate: date, endDate: due.date } });
    const snapshot = withLivePlannerAccountSnapshots(input)[0];
    assert.equal(summary.debt.USD.projected, fullyFunded ? 0 : 60);
    assert.equal(built.accounts.find((item) => item.accountId === 3).endingBalance, summary.debt.USD.projected);
    assert.equal(summary.assets.USD.projected, fullyFunded ? 0 : 60);
    assert.equal(summary.cashflow.USD.payments, fullyFunded ? 100 : 40);
    assert.equal(summary.unassignedCount, fullyFunded ? 0 : 1);
    assert.equal(snapshot.accountBalanceSnapshot.find((item) => item.accountId === 3).balance, summary.debt.USD.projected);
    assert.equal(snapshot.projectedBalanceUsd, summary.assets.USD.projected);
    assert.equal(withLivePlannerBalances(input)[0].projectedBalanceUsd, summary.assets.USD.projected);
    assert.deepEqual({ accounts, rows: built.rows }, before, "funding caps must not rewrite stored rows or account balances");
  }
});

test("card payment funding caps ignore unavailable, invalid and already recorded native debits", () => {
  const date = "2026-11-20";
  const accounts = [account(1, "checking", 100), account(2, "credit", 100),
    { ...account(3, "savings", 500), isArchived: true }, account(4, "checking", 500, "PHP"),
    { ...account(5, "checking", 500), isSyncExcluded: true }];
  const credit = movement(2, 100, "USD", { balanceDelta: -100 });
  for (const ignored of [movement(3, -60), movement(5, -60), movement(99, -60), movement(4, -60),
    movement(4, -60, "PHP"), movement(1, -60, "USD", { recordedDate: date }),
    movement(1, -60, "USD", { balanceDelta: NaN })]) {
    const rows = [flow("due", "2026-11-21", [movement(1, -40), ignored, credit],
      { source: "creditCardDue", amount: 100, currency: "USD", creditAccountId: 2 })];
    const before = structuredClone({ accounts, rows });
    const input = { accounts, rows, today: date };
    const summary = getLivePlannerAnalytics({ ...input, range: { startDate: date, endDate: rows[0].date } });
    const snapshot = withLivePlannerAccountSnapshots(input)[0];
    assert.equal(summary.debt.USD.projected, 60);
    assert.equal(summary.unassignedCount, 1);
    assert.equal(snapshot.accountBalanceSnapshot.find((item) => item.accountId === 2).balance, 60);
    assert.equal(snapshot.projectedBalanceUsd, summary.assets.USD.projected);
    assert.deepEqual({ accounts, rows }, before);
  }
});

test("multiple card credit legs share their funding once and cannot exceed the remaining due", () => {
  const accounts = [account(1, "checking", 200), account(2, "credit", 200)];
  for (const [funding, expectedDebt] of [[40, 160], [200, 100]]) {
    const rows = [flow("due", "2026-11-21", [movement(1, -funding), movement(2, 60), movement(2, 60)],
      { source: "creditCardDue", amount: 100, currency: "USD", creditAccountId: 2 })];
    const input = { accounts, rows, today };
    const summary = getLivePlannerAnalytics({ ...input, range });
    const snapshot = withLivePlannerAccountSnapshots(input)[0];
    assert.equal(summary.debt.USD.projected, expectedDebt);
    assert.equal(snapshot.accountBalanceSnapshot.find((item) => item.accountId === 2).balance, expectedDebt);
    assert.equal(snapshot.projectedBalanceUsd, summary.assets.USD.projected);
  }
});

test("a known future funding amount does not invent an unavailable cash balance", () => {
  const accounts = [account(1, "checking", null), account(2, "credit", 100)];
  const rows = [flow("due", "2026-11-21", [movement(1, -40), movement(2, 100)],
    { source: "creditCardDue", amount: 100, currency: "USD", creditAccountId: 2 })];
  const input = { accounts, rows, today };
  const summary = getLivePlannerAnalytics({ ...input, range });
  const snapshot = withLivePlannerAccountSnapshots(input)[0];
  assert.equal(summary.assets.USD.projected, null);
  assert.equal(summary.debt.USD.projected, 60);
  assert.deepEqual(snapshot.accountBalanceSnapshot.map((item) => item.balance), [null, 60]);
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

test("same-day recorded snapshots follow planner rows when posting IDs were saved in a different order", () => {
  const date = "2026-11-20";
  const accounts = [account(1, "checking", 67554.08, "PHP"), account(2, "credit", 10824.12, "PHP"),
    account(3, "checking", 300)];
  const history = [
    [1, 2, "expense", 26487.24],
    [2, 1, "income", 44576.70],
    [3, 1, "expense", 20000],
    [4, 2, "income", 20000],
  ].map(([id, accountId, kind, amount]) => ({ id, date, accountId, kind, amount, currency: "PHP" }));
  const rows = [
    { id: "entry:income", date, completed: true, recordedInAccounts: true, matchedTransactionIds: [2] },
    { id: "entry:payment", date, completed: true, recordedInAccounts: true, matchedTransactionIds: [3, 4] },
    { id: "entry:fill", date, completed: true, recordedInAccounts: true, matchedTransactionIds: [1] },
  ];
  const before = structuredClone({ accounts, rows, history });
  const result = withLivePlannerAccountSnapshots({ accounts, rows, today: date, historyTransactions: history,
    historyFrom: date, historyThrough: date, historyComplete: true });
  assert.deepEqual(result.map((row) => row.accountBalanceSnapshot.map((item) => item.balance)), [
    [87554.08, 4336.88, 300],
    [67554.08, -15663.12, 300],
    [67554.08, 10824.12, 300],
  ]);
  assert.ok(result.every((row) => row.accountBalanceSnapshotKind === "recorded"));
  assert.deepEqual(filterLivePlannerRows(result, { startDate: date, endDate: date }), result);
  assert.deepEqual({ accounts, rows, history }, before, "snapshot ordering cannot change saved or bank balances");
});

test("saved row order moves a complete native transfer together and keeps future and missing-history balances honest", () => {
  const date = "2026-11-20";
  const accounts = [account(1, "checking", 950), account(2, "savings", 100), account(3, "credit", 230)];
  const history = [[1, 1, "expense", 100], [2, 2, "income", 100], [3, 1, "income", 50], [4, 3, "expense", 30]]
    .map(([id, accountId, kind, amount]) => ({ id, date, accountId, kind, amount, currency: "USD" }));
  const rows = [
    { id: "entry:transfer", date, completed: true, recordedInAccounts: true, matchedTransactionIds: [1, 2] },
    { id: "transaction:3", completionKey: "entry:income", date, source: "transaction", transactionId: 3, completed: true },
    { id: "entry:charge", date, completed: true, recordedInAccounts: true, matchedTransactionIds: [4] },
    flow("future", "2026-11-21", [movement(1, -25)]),
  ];
  const plan = { rowOrder: [{ date, rowIds: ["entry:charge", "entry:income", "entry:transfer"] }] };
  const input = { accounts, rows, plan, history };
  const before = structuredClone(input);
  const ordered = orderPlanRows(rows, plan);
  const options = { accounts, rows: ordered, today: date, historyTransactions: history,
    historyFrom: date, historyThrough: date, historyComplete: true };
  const result = withLivePlannerAccountSnapshots(options);
  assert.deepEqual(result.map((row) => row.accountBalanceSnapshot.map((item) => item.balance)),
    [[1000, 0, 230], [1050, 0, 230], [950, 100, 230], [925, 100, 230]]);
  assert.deepEqual(result.map((row) => row.accountBalanceSnapshotKind), ["recorded", "recorded", "recorded", "projected"]);
  assert.deepEqual(result[2].matchedTransactionIds, [1, 2], "both actual transfer legs remain owned by the one moved row");
  const summary = getLivePlannerAnalytics({ accounts, rows: ordered, today: date, range: { startDate: date, endDate: "2026-11-21" } });
  assert.equal(summary.assets.USD.current, 1050);
  assert.equal(summary.assets.USD.projected, 1025);
  const incomplete = withLivePlannerAccountSnapshots({ ...options, historyComplete: false });
  assert.ok(incomplete.slice(0, 3).every((row) => row.accountBalanceSnapshotKind === "unavailable"));
  assert.deepEqual(incomplete[3].accountBalanceSnapshot.map((item) => item.balance), [925, 100, 230]);
  assert.deepEqual(input, before);
});

test("November 20 Done balances anchor to reported bank 1252.13 without losing remaining future plans", () => {
  const date = "2026-11-20";
  const accounts = [{ ...account(1, "checking", 1252.13), isLinked: true }];
  const history = [
    { id: 1, date: "2026-11-19", accountId: 1, kind: "income", amount: 100, currency: "USD" },
    { id: 2, date, accountId: 1, kind: "expense", amount: 50, currency: "USD" },
  ];
  const rows = [
    { id: "transaction:1", date: "2026-11-19", source: "transaction", transactionId: 1, completed: true },
    flow("unrecorded-today", date, [movement(1, -100)]),
    { id: "transaction:2", date, source: "transaction", transactionId: 2, completed: true },
    flow("future", "2026-11-21", [movement(1, -25)]),
  ];
  const input = { accounts, rows, today: date, historyTransactions: history,
    historyFrom: "2026-11-19", historyThrough: date, historyComplete: true };
  const before = structuredClone(input);
  const result = withLivePlannerAccountSnapshots(input);
  assert.deepEqual(result.map((row) => row.accountBalanceSnapshot[0].balance), [1302.13, 1202.13, 1252.13, 1127.13]);
  assert.deepEqual(result.map((row) => row.projectedBalanceUsd), [1302.13, 1202.13, 1252.13, 1127.13]);
  assert.deepEqual(result.map((row) => row.accountBalanceSnapshotKind), ["recorded", "projected", "recorded", "projected"]);
  assert.doesNotMatch(result[2].accountBalanceSnapshotNote, /including earlier planned/);
  const summary = getLivePlannerAnalytics({ ...input, range: { startDate: "2026-11-19", endDate: "2026-11-21" } });
  assert.equal(summary.assets.USD.current, 1252.13);
  assert.equal(summary.assets.USD.projected, 1127.13, "the unrecorded 100 and future 25 remain projected exactly once");
  assert.deepEqual(input, before);
});

test("a saved November 20 Done receipt awaiting a bank match still closes at reported 1252.13", () => {
  const date = "2026-11-20";
  for (const status of [{ awaitingBankSync: true }, { plan_provisional: 1 }]) {
    const accounts = [{ ...account(1, "checking", 1252.13), isLinked: true }];
    const receipt = { id: 2, date, accountId: 1, kind: "expense", amount: 50, currency: "USD", planGenerated: true, ...status };
    const history = [{ id: 1, date: "2026-11-19", accountId: 1, kind: "income", amount: 100, currency: "USD" }, receipt];
    const rows = [
      { id: "transaction:1", date: "2026-11-19", source: "transaction", transactionId: 1, completed: true },
      flow("unrecorded-today", date, [movement(1, -100)]),
      { id: "entry:saved-done", date, completed: true, recordedInAccounts: true, completionSource: "plan",
        matchedTransactionIds: [2], recordedTransactions: [receipt], awaitingBankSync: true },
      flow("future", "2026-11-21", [movement(1, -25)]),
    ];
    const input = { accounts, rows, today: date, historyTransactions: history,
      historyFrom: "2026-11-19", historyThrough: date, historyComplete: true };
    const before = structuredClone(input);
    const result = withLivePlannerAccountSnapshots(input);
    assert.deepEqual(result.map((row) => row.accountBalanceSnapshot[0].balance), [1302.13, 1202.13, 1252.13, 1127.13]);
    assert.deepEqual(result.map((row) => row.accountBalanceSnapshotKind), ["recorded", "projected", "recorded", "projected"]);
    assert.equal(result[2].awaitingBankSync, true, "bank matching remains a separate status from the saved dated balance");
    assert.equal(getLivePlannerAnalytics({ ...input, range: { startDate: date, endDate: "2026-11-21" } }).assets.USD.projected,
      1127.13, "the saved Done expense is not subtracted again in future projections");
    assert.deepEqual(input, before);
  }
});

test("recorded bank and manual card rows exclude forecasts while later projections keep both outstanding legs", () => {
  const date = "2026-11-20";
  const accounts = [{ ...account(1, "checking", 1252.13), isLinked: true }, account(2, "credit", 200)];
  const history = [
    { id: 1, date, accountId: 1, kind: "expense", amount: 50, currency: "USD" },
    { id: 2, date, accountId: 2, kind: "expense", amount: 30, currency: "USD", manualPlannerSource: true },
  ];
  const rows = [
    flow("planned-cash", date, [movement(1, -100)]),
    flow("planned-card", date, [movement(2, -40, "USD", { balanceDelta: 40 })]),
    { id: "transaction:1", date, source: "transaction", transactionId: 1, completed: true },
    { id: "entry:manual-card", date, completed: true, recordedInAccounts: true, matchedTransactionIds: [2] },
    flow("future", "2026-11-21", [movement(1, -25), movement(2, -10, "USD", { balanceDelta: 10 })]),
  ];
  const input = { accounts, rows, today: date, historyTransactions: history,
    historyFrom: date, historyThrough: date, historyComplete: true };
  const result = withLivePlannerAccountSnapshots(input);
  assert.deepEqual(result.map((row) => row.accountBalanceSnapshot.map((item) => item.balance)), [
    [1202.13, 170], [1202.13, 210], [1252.13, 170], [1252.13, 200], [1127.13, 250],
  ]);
  assert.deepEqual(result.map((row) => row.accountBalanceSnapshotKind), ["projected", "projected", "recorded", "recorded", "projected"]);
  const summary = getLivePlannerAnalytics({ ...input, range: { startDate: date, endDate: "2026-11-21" } });
  assert.equal(summary.assets.USD.projected, 1127.13);
  assert.equal(summary.debt.USD.projected, 250);
});

test("partial today rows keep forecasts while fully recorded rows retain their actual balances", () => {
  const date = "2026-11-20";
  const accounts = [account(1, "checking", 67554.08, "PHP"), account(2, "credit", 10824.12, "PHP"), account(3, "cash", 100)];
  const history = [
    { id: 1, date, accountId: 2, kind: "expense", amount: 26487.24, currency: "PHP" },
    { id: 2, date, accountId: 2, kind: "income", amount: 20000, currency: "PHP" },
  ];
  const rows = [
    flow("income", date, [movement(1, 44576.70, "PHP")], { kind: "income" }),
    ...[1, 2, 3].map((id) => flow(`bill:${id}`, date, [movement(3, -1)])),
    flow("payment", date, [movement(1, -20000, "PHP")], { kind: "transfer", matchedTransactionIds: [2],
      recordedTransactions: [{ transactionId: 2, date, accountId: 2 }], completed: false }),
    flow("fill", date, [], { completed: true, recordedInAccounts: true, matchedTransactionIds: [1] }),
    flow("future", "2026-11-21", [movement(1, -100, "PHP")]),
  ];
  const before = structuredClone({ accounts, rows, history });
  const result = withLivePlannerAccountSnapshots({ accounts, rows, today: date, historyTransactions: history,
    historyFrom: date, historyThrough: date, historyComplete: true });
  const balances = (accountId) => result.map((row) => row.accountBalanceSnapshot.find((item) => item.accountId === accountId).balance);
  assert.deepEqual(balances(2), [4336.88, 4336.88, 4336.88, 4336.88, -15663.12, 10824.12, 10824.12]);
  assert.deepEqual(balances(1), [112130.78, 112130.78, 112130.78, 112130.78, 92130.78, 67554.08, 92030.78]);
  assert.deepEqual(balances(3), [100, 99, 98, 97, 97, 100, 97]);
  assert.deepEqual(result.map((row) => row.projectedBalancePhp), balances(1), "collapsed totals use the same display timeline");
  assert.deepEqual(result.map((row) => row.projectedBalanceUsd), balances(3));
  assert.deepEqual(result.map((row) => row.accountBalanceSnapshotKind),
    ["projected", "projected", "projected", "projected", "projected", "recorded", "projected"]);
  assert.equal(result[4].completed, false, "the partially recorded transfer keeps its outstanding funding projection");
  assert.equal(result[5].completed, true, "display provenance cannot change completion status");
  const analytics = getLivePlannerAnalytics({ accounts, rows, today: date, range: { startDate: date, endDate: "2026-11-21" } });
  assert.equal(analytics.assets.PHP.current, 67554.08);
  assert.equal(analytics.assets.PHP.projected, balances(1).at(-1));
  assert.equal(analytics.debt.PHP.current, 10824.12);
  assert.equal(analytics.debt.PHP.projected, balances(2).at(-1));
  assert.deepEqual({ accounts, rows, history }, before);
});

test("saved linked and manual receipts reconstruct the dated closing balance while plans remain separate", () => {
  const date = "2026-11-20";
  for (const flag of [{ awaitingBankSync: true }, { plan_provisional: 1 }]) {
    const accounts = [{ ...account(1, "checking", 1000), isLinked: true }, account(2, "savings", 250),
      { ...account(3, "checking", 300, "PHP"), isLinked: true }];
    const bankIncome = { id: 1, date, accountId: 1, kind: "income", amount: 100, currency: "USD" };
    const bankDebit = { id: 2, date, accountId: 1, kind: "expense", amount: 50, currency: "USD", ...flag };
    const manualCredit = { id: 3, date, accountId: 2, kind: "income", amount: 50, currency: "USD",
      manualPlannerSource: true, awaitingBankSync: true };
    const history = [bankIncome, bankDebit, manualCredit];
    const rows = [
      flow("forecast-before", date, [movement(1, -20)]),
      { id: "transaction:1", date, source: "transaction", transactionId: 1, completed: true },
      { id: "entry:transfer", date, kind: "transfer", completed: true, recordedInAccounts: true, awaitingBankSync: true,
        matchedTransactionIds: [2, 3], recordedTransactions: [bankDebit, manualCredit] },
      flow("future", "2026-11-21", [movement(1, -10)]),
    ];
    const input = { accounts, rows, today: date, historyTransactions: history,
      historyFrom: date, historyThrough: date, historyComplete: true };
    const before = structuredClone(input);
    const result = withLivePlannerAccountSnapshots(input);
    assert.deepEqual(result.map((row) => row.accountBalanceSnapshot.map((item) => item.balance)),
      [[930, 200, 300], [1050, 200, 300], [1000, 250, 300], [970, 250, 300]]);
    assert.deepEqual(result.map((row) => row.projectedBalanceUsd), [1130, 1250, 1250, 1220]);
    assert.ok(result.every((row) => row.projectedBalancePhp === 300));
    assert.deepEqual(result.map((row) => row.accountBalanceSnapshotKind), ["projected", "recorded", "recorded", "projected"]);
    assert.match(result[2].accountBalanceSnapshotNote, /Reconstructed/);
    const summary = getLivePlannerAnalytics({ ...input, range: { startDate: date, endDate: "2026-11-21" } });
    assert.equal(summary.assets.USD.current, 1250, "the provider baseline and the manual actual remain authoritative");
    assert.equal(summary.assets.USD.projected, 1220, "future flows start from the reported bank value once");
    assert.deepEqual(input, before);
  }
});

test("a saved Done row with a genuinely missing receipt stays unavailable even when it is awaiting a bank match", () => {
  const date = "2026-11-20";
  const accounts = [{ ...account(1, "checking", 1000), balanceSource: "bank" }, account(2, "cash", 250)];
  const history = [{ id: 1, date, accountId: 1, kind: "income", amount: 100, currency: "USD" }];
  const rows = [
    flow("before", date, [movement(1, -20)]),
    { id: "transaction:1", date, source: "transaction", transactionId: 1, completed: true },
    { id: "transaction:2", date, source: "transaction", transactionId: 2, accountId: 1, kind: "expense",
      amount: 50, currency: "USD", completed: true, awaitingBankSync: true },
    flow("future", "2026-11-21", [movement(1, -10)]),
  ];
  const result = withLivePlannerAccountSnapshots({ accounts, rows, today: date, historyTransactions: history,
    historyFrom: date, historyThrough: date, historyComplete: true });
  assert.deepEqual(result.map((row) => row.accountBalanceSnapshotKind), ["unavailable", "recorded", "unavailable", "projected"]);
  assert.deepEqual(result[0].accountBalanceSnapshot.map((item) => item.balance), [null, null]);
  assert.deepEqual(result[2].accountBalanceSnapshot.map((item) => item.balance), [null, null]);
  assert.deepEqual(result[3].accountBalanceSnapshot.map((item) => item.balance), [970, 250]);
  assert.equal(result[2].completed, true, "balance provenance does not rewrite the transaction's completion state");
});

test("later saved receipts reconstruct earlier dated rows before and after a bank match", () => {
  const date = "2026-11-20";
  const income = { id: 1, date, accountId: 1, kind: "income", amount: 100, currency: "USD" };
  const localDebit = { id: 2, date, accountId: 1, kind: "expense", amount: 50, currency: "USD", awaitingBankSync: true };
  const rows = [{ id: "transaction:1", date, source: "transaction", transactionId: 1, completed: true },
    flow("future", "2026-11-21", [movement(1, -10)])];
  const input = { rows, today: date, historyFrom: date, historyThrough: date, historyComplete: true };
  const unconfirmed = withLivePlannerAccountSnapshots({ ...input, accounts: [{ ...account(1, "checking", 1000), isLinked: true }],
    historyTransactions: [income, localDebit] });
  assert.deepEqual(unconfirmed.map((row) => row.accountBalanceSnapshot[0].balance), [1050, 990]);
  const imported = withLivePlannerAccountSnapshots({ ...input, accounts: [{ ...account(1, "checking", 950), isLinked: true }],
    historyTransactions: [income, { ...localDebit, awaitingBankSync: false, provider: "plaid", planGenerated: false }] });
  assert.deepEqual(imported.map((row) => row.accountBalanceSnapshot[0].balance), [1000, 940],
    "the updated bank closing balance remains the dated anchor after a bank match");
});

test("an imported bank receipt overrides stale provisional row metadata after reconciliation", () => {
  const date = "2026-11-20";
  const accounts = [{ ...account(1, "checking", 950), isLinked: true }];
  const history = [{ id: 1, date, accountId: 1, kind: "expense", amount: 50, currency: "USD", awaitingBankSync: false }];
  const rows = [{ id: "transaction:1", date, source: "transaction", transactionId: 1, accountId: 1,
    completed: true, awaitingBankSync: true }, flow("future", "2026-11-21", [movement(1, -10)])];
  const result = withLivePlannerAccountSnapshots({ accounts, rows, today: date, historyTransactions: history,
    historyFrom: date, historyThrough: date, historyComplete: true });
  assert.deepEqual(result.map((row) => row.accountBalanceSnapshot[0].balance), [950, 940]);
  assert.equal(result[0].accountBalanceSnapshotKind, "recorded");
});

test("saved card charges and payments reconstruct their closing balances regardless of bank match status", () => {
  const date = "2026-11-20";
  for (const kind of ["expense", "income"]) {
    const accounts = [{ ...account(1, "credit", 500), isLinked: true }, account(2, "credit", 100)];
    const history = [
      { id: 1, date, accountId: 1, kind, amount: 40, currency: "USD", awaitingBankSync: true },
      { id: 2, date, accountId: 2, kind: "expense", amount: 20, currency: "USD", awaitingBankSync: true, manualPlannerSource: true },
      { id: 3, date, accountId: 1, kind: "expense", amount: 10, currency: "USD", provider: "plaid" },
    ];
    const rows = [
      { id: "transaction:2", date, source: "transaction", transactionId: 2, completed: true },
      { id: "transaction:1", date, source: "transaction", transactionId: 1, completed: true },
      { id: "transaction:3", date, source: "transaction", transactionId: 3, completed: true },
      flow("future-charge", "2026-11-21", [movement(1, -30, "USD", { balanceDelta: 30 })]),
    ];
    const input = { accounts, rows, today: date, historyTransactions: history,
      historyFrom: date, historyThrough: date, historyComplete: true };
    const result = withLivePlannerAccountSnapshots(input);
    assert.deepEqual(result.map((row) => row.accountBalanceSnapshot.map((item) => item.balance)),
      [[kind === "expense" ? 450 : 530, 100], [490, 100], [500, 100], [530, 100]]);
    const summary = getLivePlannerAnalytics({ ...input, range: { startDate: date, endDate: "2026-11-21" } });
    assert.equal(summary.debt.USD.current, 600);
    assert.equal(summary.debt.USD.projected, 630);
  }
});

test("today forecasts preserve hidden actual slots without changing recorded row anchors", () => {
  const date = "2026-11-20";
  const accounts = [account(1, "checking", 85)];
  const history = [
    { id: 1, date, accountId: 1, kind: "income", amount: 10, currency: "USD" },
    { id: 2, date, accountId: 1, kind: "expense", amount: 5, currency: "USD" },
    { id: 3, date, accountId: 1, kind: "expense", amount: 20, currency: "USD" },
  ];
  const rows = [
    flow("before", date, [movement(1, -2)]),
    { id: "entry:first", date, completed: true, recordedInAccounts: true, matchedTransactionIds: [3] },
    flow("between", date, [movement(1, 3)]),
    { id: "entry:last", date, completed: true, recordedInAccounts: true, matchedTransactionIds: [1] },
    flow("after", date, [movement(1, -4)]),
  ];
  const result = withLivePlannerAccountSnapshots({ accounts, rows, today: date, historyTransactions: history,
    historyFrom: date, historyThrough: date, historyComplete: true });
  assert.deepEqual(result.map((row) => row.accountBalanceSnapshot[0].balance), [98, 80, 76, 85, 82]);
  assert.deepEqual(result.map((row) => row.projectedBalanceUsd), [98, 80, 76, 85, 82]);
  assert.deepEqual(result.map((row) => row.accountBalanceSnapshotKind), ["projected", "recorded", "projected", "recorded", "projected"]);
  assert.equal(getLivePlannerAnalytics({ accounts, rows, today: date, range: { startDate: date, endDate: date } }).assets.USD.projected, 82);
});

test("incomplete today receipt history cannot seed earlier planned rows with a closing balance", () => {
  const date = "2026-11-20";
  const accounts = [account(1, "checking", 90)];
  const history = [{ id: 1, date, accountId: 1, kind: "expense", amount: 10, currency: "USD" }];
  const rows = [
    flow("planned", date, [movement(1, -5)]),
    { id: "transaction:1", date, source: "transaction", transactionId: 1, completed: true },
    flow("future", "2026-11-21", [movement(1, 2)]),
  ];
  const input = { accounts, rows, today: date, historyTransactions: history, historyFrom: date, historyThrough: date, historyComplete: true };
  for (const change of [{ historyComplete: false }, { historyTransactions: [] }, { historyThrough: "2026-11-19" }, { historyFrom: "2026-11-21" }]) {
    const result = withLivePlannerAccountSnapshots({ ...input, ...change });
    assert.deepEqual(result.map((row) => row.accountBalanceSnapshot[0].balance), [null, null, 87]);
    assert.deepEqual(result.map((row) => row.accountBalanceSnapshotKind), ["unavailable", "unavailable", "projected"]);
    assert.equal(result[0].projectedBalanceUsd, null);
  }
  const forecastsOnly = withLivePlannerAccountSnapshots({ accounts, rows: [rows[0]], today: date });
  assert.equal(forecastsOnly[0].accountBalanceSnapshot[0].balance, 85, "a forecast without a same-day recorded row still starts from current funds");
});

test("partial transfers with earlier actual legs keep those native movements on their actual dates", () => {
  const date = "2026-11-20";
  const accounts = [account(1, "checking", 85), account(2, "savings", 0)];
  const history = [
    { id: 1, date: "2026-11-18", accountId: 1, kind: "expense", amount: 20, currency: "USD" },
    { id: 2, date: "2026-11-19", accountId: 1, kind: "income", amount: 5, currency: "USD" },
  ];
  const rows = [
    { id: "transaction:2", date: "2026-11-19", source: "transaction", transactionId: 2, completed: true },
    flow("income", date, [movement(1, 10)]),
    flow("transfer", date, [movement(2, 20)], { kind: "transfer", matchedTransactionIds: [1],
      recordedTransactions: [{ transactionId: 1, date: "2026-11-18", accountId: 1 }], completed: false }),
    flow("future", "2026-11-21", [movement(1, -5)]),
  ];
  const input = { accounts, rows, today: date, historyTransactions: history,
    historyFrom: "2026-11-18", historyThrough: date, historyComplete: true };
  const result = withLivePlannerAccountSnapshots(input);
  assert.deepEqual(result.map((row) => row.accountBalanceSnapshot.map((item) => item.balance)), [[85, 0], [95, 0], [95, 20], [90, 20]]);
  const visibleRange = { startDate: date, endDate: "2026-11-21" };
  assert.deepEqual(withLivePlannerAccountSnapshots({ ...input, rows: filterLivePlannerRows(rows, visibleRange) }),
    filterLivePlannerRows(result, visibleRange));
  const analytics = getLivePlannerAnalytics({ accounts, rows, today: date, range: visibleRange });
  assert.equal(analytics.assets.USD.projected, 110);
  assert.equal(result.at(-1).projectedBalanceUsd, 110);
});

test("statement payment references do not claim the same actual movements as their visible payment rows", () => {
  const date = "2026-11-20";
  const accounts = [account(1, "checking", 800), account(2, "credit", 300)];
  const history = [
    { id: 1, date, accountId: 1, kind: "expense", amount: 200, currency: "USD" },
    { id: 2, date, accountId: 2, kind: "income", amount: 200, currency: "USD" },
  ];
  const rows = [
    { id: "transaction:2", date, source: "transaction", transactionId: 2, completed: true },
    { id: "due:paid", date, source: "creditCardDue", amount: 0, completed: true, completionSource: "transaction",
      matchedTransactionIds: [2, 1], paymentTransactionIds: [2, 1] },
    { id: "transaction:1", date, source: "transaction", transactionId: 1, completed: true },
    flow("due:remaining", "2026-11-21", [movement(1, -50), movement(2, 50, "USD", { balanceDelta: -50 })],
      { source: "creditCardDue", creditAccountId: 2, amount: 50, matchedTransactionIds: [2, 1] }),
    { id: "due:future-paid", date: "2026-11-22", source: "creditCardDue", amount: 0, completed: true,
      completionSource: "transaction", matchedTransactionIds: [2, 1] },
  ];
  const result = withLivePlannerAccountSnapshots({ accounts, rows, today: date, historyTransactions: history,
    historyFrom: date, historyThrough: date, historyComplete: true });
  assert.deepEqual(result.map((row) => row.accountBalanceSnapshot.map((item) => item.balance)),
    [[1000, 300], [1000, 300], [800, 300], [750, 250], [750, 250]]);
  assert.deepEqual(result.map((row) => row.accountBalanceSnapshotKind), ["recorded", "recorded", "recorded", "projected", "projected"]);
});

test("reordering planner events preserves hidden same-day slots and reverses later hidden dates", () => {
  const date = "2026-11-20";
  const accounts = [account(1, "checking", 92)];
  const history = [
    { id: 1, date, accountId: 1, kind: "income", amount: 10, currency: "USD" },
    { id: 2, date, accountId: 1, kind: "expense", amount: 5, currency: "USD" },
    { id: 3, date, accountId: 1, kind: "expense", amount: 20, currency: "USD" },
    { id: 4, date: "2026-11-21", accountId: 1, kind: "income", amount: 7, currency: "USD" },
  ];
  const rows = [
    { id: "entry:first", date, completed: true, recordedInAccounts: true, matchedTransactionIds: [3] },
    { id: "entry:last", date, completed: true, recordedInAccounts: true, matchedTransactionIds: [1] },
  ];
  const result = withLivePlannerAccountSnapshots({ accounts, rows, today: "2026-11-21", historyTransactions: history,
    historyFrom: date, historyThrough: "2026-11-21", historyComplete: true });
  assert.deepEqual(result.map((row) => row.accountBalanceSnapshot[0].balance), [80, 85]);
  assert.equal(accounts[0].nativeCurrentBalance, 92, "later independent receipts remain in the current balance");
});

test("multi-day transfer receipts retain actual dates and snapshot after the final leg", () => {
  const accounts = [account(1, "checking", 90), account(2, "savings", 30)];
  const history = [
    [1, "2026-11-18", 1, "expense", 20],
    [2, "2026-11-19", 1, "expense", 5],
    [3, "2026-11-20", 1, "income", 10],
    [4, "2026-11-20", 2, "income", 20],
    [5, "2026-11-20", 2, "income", 10],
    [6, "2026-11-21", 1, "income", 5],
  ].map(([id, date, accountId, kind, amount]) => ({ id, date, accountId, kind, amount, currency: "USD" }));
  const rows = [
    { id: "transaction:2", date: "2026-11-19", source: "transaction", transactionId: 2, completed: true },
    { id: "entry:transfer", date: "2026-11-20", recordedInAccounts: true, completed: true, matchedTransactionIds: [1, 4] },
  ];
  const input = { accounts, rows, today: "2026-11-21", historyTransactions: history,
    historyFrom: "2026-11-18", historyThrough: "2026-11-21", historyComplete: true };
  const result = withLivePlannerAccountSnapshots(input);
  assert.deepEqual(result.map((row) => row.accountBalanceSnapshot.map((item) => item.balance)), [[75, 0], [85, 20]],
    "the Nov 19 row includes the Nov 18 debit even though its paired row is on Nov 20");
  const visibleRange = { startDate: "2026-11-20", endDate: "2026-11-20" };
  assert.deepEqual(withLivePlannerAccountSnapshots({ ...input, rows: filterLivePlannerRows(rows, visibleRange) }),
    filterLivePlannerRows(result, visibleRange), "hiding an earlier date cannot change the transfer snapshot");
  const incomplete = withLivePlannerAccountSnapshots({ ...input, historyFrom: "2026-11-19" });
  assert.equal(incomplete[1].accountBalanceSnapshotKind, "unavailable", "coverage must include every paired receipt date");
  assert.deepEqual(incomplete[1].accountBalanceSnapshot.map((item) => item.balance), [null, null]);
});

test("rows claiming the same receipt stay unavailable without replaying shared history twice", () => {
  const date = "2026-11-20";
  const accounts = [account(1, "checking", 75)];
  const history = [
    { id: 1, date, accountId: 1, kind: "expense", amount: 10, currency: "USD" },
    { id: 2, date, accountId: 1, kind: "expense", amount: 20, currency: "USD" },
    { id: 3, date, accountId: 1, kind: "income", amount: 5, currency: "USD" },
  ];
  const rows = [
    { id: "entry:first", date, recordedInAccounts: true, completed: true, matchedTransactionIds: [1] },
    { id: "entry:duplicate", date, recordedInAccounts: true, completed: true, matchedTransactionIds: [1, 2] },
    { id: "transaction:3", date, source: "transaction", transactionId: 3, completed: true },
  ];
  const result = withLivePlannerAccountSnapshots({ accounts, rows, today: date, historyTransactions: history,
    historyFrom: date, historyThrough: date, historyComplete: true });
  assert.deepEqual(result.map((row) => row.accountBalanceSnapshotKind), ["unavailable", "unavailable", "recorded"]);
  assert.deepEqual(result.map((row) => row.accountBalanceSnapshot[0].balance), [null, null, 75]);
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
