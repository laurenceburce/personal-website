import test from "node:test";
import assert from "node:assert/strict";
import { verifyFinanceStatementPlan } from "../app/lib/financeStatementImportVerification.mjs";

function harness({ records = [], extraAccounts = [], entries = [], currentBalance = 2240.01,
  statement = { statementBalance: 169, minimumPayment: 169, lastStatementDate: "2026-11-03", dueDate: "2026-12-01" } } = {}) {
  const today = "2026-11-22";
  const operation = { statement };
  const accounts = [
    { id: 1, name: "Funding", account_type: "checking", currency: "PHP", opening_balance: 30000, native_movement: 0 },
    { id: 2, name: "Example card", account_type: "credit", currency: "PHP", opening_balance: 0, native_movement: -currentBalance,
      credit_card_due_json: JSON.stringify(statement), credit_card_due_status: "manual", credit_card_autopay_enabled: 1, credit_card_autopay_days_before_due: 7 },
    ...extraAccounts,
  ];
  const document = { salary: {}, bills: [], allocations: [], plans: [{ id: "live", continuous: true,
    startDate: today, endDate: "2027-03-01", balanceMode: "live", entries, includeTransactions: true,
    openingUsd: 0, openingPhp: 0, openingReserveUsd: 0, openingReservePhp: 0, startingAccounts: [],
    accountLinks: { availablePhpAccountId: 1 }, completedRows: [], rowOverrides: [] }] };
  const events = [];
  const connection = {
    beginTransaction: async () => events.push("begin"), commit: async () => events.push("commit"),
    rollback: async () => events.push("rollback"), release: () => events.push("release"),
    query: async (sql) => {
      assert.match(sql.trim(), /^SELECT /, "verification must never change stored data");
      events.push(sql);
      if (sql.includes("FROM personal_finance_planner")) return [[{ document: JSON.stringify(document), exchange_rate: JSON.stringify({ rate: 63 }) }]];
      if (sql.includes("FROM personal_finance_accounts a")) return [structuredClone(accounts)];
      if (sql.includes("FROM personal_finance_transactions t LEFT JOIN")) return [structuredClone(records)];
      throw new Error("Unexpected query");
    },
  };
  return { events, today, operation, imported: { id: 2, currentBalance }, pool: { getConnection: async () => connection } };
}

test("saved statement verification uses real native balances and separates issued and estimated payments without writes", async () => {
  const context = harness({ extraAccounts: [{ id: 9, name: "Unsupported foreign account", currency: "EUR" }] });
  const result = await verifyFinanceStatementPlan(context.pool, context.operation, context.imported, context.today);
  assert.equal(result.currentBalance, 2240.01);
  assert.equal(result.balanceUnchanged, true);
  const issued = result.statementRows.find((row) => row.dueDate === "2026-12-01");
  assert.equal(issued.date, "2026-11-24");
  assert.equal(issued.amount, 169);
  assert.equal(issued.estimated, false);
  assert.equal(issued.plannedPaymentAmount, 0, "no separate planned transfer already covers this statement");
  const estimate = result.statementRows.find((row) => row.dueDate === "2027-01-01");
  assert.equal(estimate.amount, 2071.01);
  assert.equal(estimate.estimated, true);
  assert.equal(result.statementRows.every((row) => row.id.startsWith("creditCardDue:2:")), true);
  assert.deepEqual(result.paymentRows, []);
  assert.deepEqual(context.events.slice(-2), ["commit", "release"]);
});

test("saved statement verification exposes the later live payment after prior statement forecasts consume its debt once", async () => {
  const context = harness({ currentBalance: 13696.72,
    statement: { statementBalance: 4653.76, minimumPayment: 500, lastStatementDate: "2026-11-04", dueDate: "2026-12-01" },
    entries: [{ id: "remaining", description: "Full balance payment", date: "2027-01-01", kind: "transfer",
      currency: "PHP", amount: 13696.72, amountMode: "cardBalance", fromAccountId: 1, toAccountId: 2 }] });
  const result = await verifyFinanceStatementPlan(context.pool, context.operation, context.imported, context.today);
  assert.equal(result.currentBalance, 13696.72, "the uploaded statement does not replace current app debt");
  assert.equal(result.balanceUnchanged, true);
  assert.deepEqual(result.statementRows.map(({ date, dueDate, amount, estimated, plannedPaymentAmount }) =>
    ({ date, dueDate, amount, estimated, plannedPaymentAmount })), [
    { date: "2026-11-24", dueDate: "2026-12-01", amount: 4653.76, estimated: false, plannedPaymentAmount: 0 },
    { date: "2026-12-25", dueDate: "2027-01-01", amount: 9042.96, estimated: true, plannedPaymentAmount: 0 },
  ]);
  assert.deepEqual(result.paymentRows, [{ id: "entry:remaining", date: "2027-01-01", amount: 0,
    amountMode: "cardBalance", liveCardBalance: true, fromAccountId: 1, toAccountId: 2 }]);
  const projectedPayments = [...result.statementRows, ...result.paymentRows];
  assert.equal(Math.round(projectedPayments.reduce((total, row) => total + row.amount, 0) * 100), 1369672,
    "the current debt is paid once across issued, estimated and explicit payment rows");
  assert.deepEqual(context.events.slice(-2), ["commit", "release"]);
});

test("statement verification fails closed and releases its read transaction when the ledger is truncated", async () => {
  const context = harness({ records: Array.from({ length: 10001 }, () => ({})) });
  await assert.rejects(verifyFinanceStatementPlan(context.pool, context.operation, context.imported, context.today), /verification limit/);
  assert.deepEqual(context.events.slice(-2), ["rollback", "release"]);
  assert.equal(context.events.includes("commit"), false);
});
