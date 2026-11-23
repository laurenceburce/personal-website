import test from "node:test";
import assert from "node:assert/strict";
import { verifyFinanceStatementPlan } from "../app/lib/financeStatementImportVerification.mjs";

function harness({ records = [], extraAccounts = [] } = {}) {
  const today = "2026-11-22";
  const statement = { statementBalance: 169, minimumPayment: 169, lastStatementDate: "2026-11-03", dueDate: "2026-12-01" };
  const operation = { statement };
  const accounts = [
    { id: 1, name: "Funding", account_type: "checking", currency: "PHP", opening_balance: 30000, native_movement: 0 },
    { id: 2, name: "Example Visa", account_type: "credit", currency: "PHP", opening_balance: 0, native_movement: -2240.01,
      credit_card_due_json: JSON.stringify(statement), credit_card_due_status: "manual", credit_card_autopay_enabled: 1, credit_card_autopay_days_before_due: 7 },
    ...extraAccounts,
  ];
  const document = { salary: {}, bills: [], allocations: [], plans: [{ id: "live", continuous: true,
    startDate: today, endDate: "2027-03-01", balanceMode: "live", entries: [], includeTransactions: true,
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
  return { events, today, operation, imported: { id: 2, currentBalance: 2240.01 }, pool: { getConnection: async () => connection } };
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
  assert.deepEqual(context.events.slice(-2), ["commit", "release"]);
});

test("statement verification fails closed and releases its read transaction when the ledger is truncated", async () => {
  const context = harness({ records: Array.from({ length: 10001 }, () => ({})) });
  await assert.rejects(verifyFinanceStatementPlan(context.pool, context.operation, context.imported, context.today), /verification limit/);
  assert.deepEqual(context.events.slice(-2), ["rollback", "release"]);
  assert.equal(context.events.includes("commit"), false);
});
