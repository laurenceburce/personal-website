import test from "node:test";
import assert from "node:assert/strict";
import { importFinanceCardStatement } from "../app/lib/financeStatementImport.mjs";

const today = "2027-01-20";
const operation = () => ({ id: "anonymous-statement-import-v1", target: { name: "Card A", currency: "USD", mask: "1234" },
  statement: { statementBalance: 472.35, minimumPayment: 25, lastStatementDate: "2027-01-12", dueDate: "2027-02-05" } });
const account = (extra = {}) => ({ id: 7, name: "Card A", custom_name: null, account_type: "credit", currency: "USD",
  account_mask: "1234", opening_balance: "500.00", current_balance: "800.00", available_balance: "100.00",
  credit_card_autopay_enabled: 1, credit_card_autopay_days_before_due: 7,
  credit_card_due_json: JSON.stringify({ lastPaymentDate: "2027-01-11", lastPaymentAmount: 20,
    syncedAt: "2027-01-15T10:00:00Z", existingNote: "Retain this metadata" }), credit_card_due_status: "unavailable",
  external_provider: null, external_account_id: null, connection_id: null, is_archived: 0, is_sync_excluded: 0,
  merged_into_account_id: null, created_at: "2026-01-01", updated_at: "2027-01-19", ...extra });
const transaction = (id, extra = {}) => ({ id, account_id: 7, currency: "USD", kind: "expense", amount: "80.00",
  transaction_date: "2027-01-10", pending: 0, duplicate_of_id: null, is_provider_removed: 0, ...extra });
const history = () => [transaction(10), transaction(11, { kind: "income", amount: "20.00" }),
  transaction(12, { amount: "900.00", pending: 1 }), transaction(13, { transaction_date: "2027-02-02" }),
  transaction(14, { duplicate_of_id: 10 }), transaction(15, { is_provider_removed: 1 }), transaction(16, { currency: "PHP" })];

function database({ accounts = [account()], transactions = history(), fault = null } = {}) {
  let saved = { accounts: structuredClone(accounts), transactions: structuredClone(transactions), audits: {}, tableExists: false };
  let current = null;
  let started = false;
  const calls = [];
  const query = async (source, sql, parameters = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    calls.push({ source, sql: normalized, parameters: structuredClone(parameters), started });
    const state = source === "connection" ? current : saved;
    if (normalized.startsWith("CREATE TABLE IF NOT EXISTS personal_finance_statement_imports")) {
      assert.equal(started, false, "audit DDL must precede the transaction because MySQL implicitly commits DDL");
      state.tableExists = true;
      return [{ affectedRows: 0 }];
    }
    if (normalized.startsWith("SELECT a.* FROM personal_finance_accounts")) return [structuredClone(state.accounts)];
    if (normalized.startsWith("SELECT * FROM personal_finance_accounts WHERE id"))
      return [structuredClone(state.accounts.filter((row) => Number(row.id) === Number(parameters[0])))];
    if (normalized.startsWith("SELECT t.*, DATE_FORMAT")) return [structuredClone(state.transactions
      .filter((row) => Number(row.account_id) === Number(parameters[0]))
      .map((row) => ({ ...row, statement_import_date: row.transaction_date })))];
    if (normalized.startsWith("INSERT IGNORE INTO personal_finance_statement_imports")) {
      assert.equal(started, true);
      if (state.audits[parameters[0]]) return [{ affectedRows: 0 }];
      state.audits[parameters[0]] = { operation_id: parameters[0], request_hash: parameters[1], status: "pending" };
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith("SELECT * FROM personal_finance_statement_imports"))
      return [[state.audits[parameters[0]]].filter(Boolean).map((row) => structuredClone(row))];
    if (normalized.startsWith("UPDATE personal_finance_accounts")) {
      assert.equal(started, true);
      const selected = state.accounts.find((row) => Number(row.id) === Number(parameters[1]));
      if (!selected) return [{ affectedRows: 0 }];
      selected.credit_card_due_json = parameters[0];
      selected.credit_card_due_status = "manual";
      selected.updated_at = "2027-01-20";
      if (fault === "balance") selected.current_balance = "1.00";
      if (fault === "ledger") state.transactions[0].amount = "1.00";
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith("UPDATE personal_finance_statement_imports")) {
      assert.equal(started, true);
      if (fault === "audit") throw new Error("Simulated audit write failure");
      const [accountId, before, after, status, id] = parameters;
      const selected = state.audits[id];
      if (!selected || selected.status !== "pending") return [{ affectedRows: 0 }];
      Object.assign(selected, { account_id: accountId, before_json: before, after_json: after, status });
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected database operation: ${normalized}`);
  };
  const connection = {
    async beginTransaction() { assert.equal(started, false); current = structuredClone(saved); started = true; calls.push({ source: "begin" }); },
    async query(sql, parameters) { return query("connection", sql, parameters); },
    async commit() { assert.equal(started, true); saved = current; current = null; started = false; calls.push({ source: "commit" }); },
    async rollback() { current = null; started = false; calls.push({ source: "rollback" }); },
    release() { calls.push({ source: "release" }); },
  };
  return { calls, get state() { return saved; }, pool: {
    async query(sql, parameters) { return query("pool", sql, parameters); },
    async getConnection() { return connection; },
  } };
}

test("statement import preview is read-only and distinguishes native ledger debt from the stored balance", async () => {
  const db = database();
  const request = operation();
  const before = structuredClone({ state: db.state, request });
  const result = await importFinanceCardStatement(db.pool, request, { today });
  assert.equal(result.mode, "preview");
  assert.equal(result.changesRequired, true);
  assert.equal(result.account.id, 7);
  assert.equal(result.account.openingBalance, 500);
  assert.equal(result.account.currentBalance, 560, "only posted native activity through today changes manual card debt");
  assert.equal(result.account.storedCurrentBalance, 800);
  assert.equal(result.account.autopayEnabled, true);
  assert.equal(result.account.autopayDaysBeforeDue, 7);
  assert.equal(result.account.transactionCount, 7);
  assert.equal(result.account.postedTransactionCount, 2);
  assert.deepEqual(result.proposed.creditCardDue, { ...request.statement, lastPaymentDate: "2027-01-11", lastPaymentAmount: 20,
    syncedAt: "2027-01-15T10:00:00Z", existingNote: "Retain this metadata" });
  assert.deepEqual({ state: db.state, request }, before);
  assert.equal(db.calls.length, 2);
  assert.ok(db.calls.every((call) => call.source === "pool" && call.sql.startsWith("SELECT")));
});

test("statement apply atomically saves metadata and its audit while preserving every financial field and transaction", async () => {
  const db = database();
  const request = operation();
  const originalAccount = structuredClone(db.state.accounts[0]);
  const originalTransactions = structuredClone(db.state.transactions);
  const receipt = await importFinanceCardStatement(db.pool, request, { apply: true, today });
  assert.equal(receipt.mode, "applied");
  assert.equal(receipt.auditId, request.id);
  assert.equal(receipt.account.currentBalance, 560);
  assert.equal(receipt.account.creditCardDueStatus, "manual");
  const after = db.state.accounts[0];
  for (const [key, value] of Object.entries(originalAccount))
    if (!["credit_card_due_json", "credit_card_due_status", "updated_at"].includes(key)) assert.deepEqual(after[key], value, key);
  assert.deepEqual(db.state.transactions, originalTransactions);
  assert.deepEqual(JSON.parse(after.credit_card_due_json), receipt.proposed.creditCardDue);
  const audit = db.state.audits[request.id];
  assert.equal(audit.status, "applied");
  assert.deepEqual(JSON.parse(audit.before_json).account, originalAccount);
  assert.equal(JSON.parse(audit.after_json).account.currentBalance, 560);
  assert.ok(db.calls.some((call) => call.sql?.startsWith("SELECT a.*") && call.sql.endsWith("FOR UPDATE")));
  assert.ok(db.calls.some((call) => call.sql?.startsWith("SELECT t.*") && call.sql.endsWith("FOR UPDATE")));
  assert.equal(db.calls.filter((call) => call.source === "commit").length, 1);
  assert.equal(db.calls.filter((call) => call.source === "rollback").length, 0);
});

test("retries reuse the durable marker without another account update and reject a changed operation", async () => {
  const db = database();
  const request = operation();
  await importFinanceCardStatement(db.pool, request, { apply: true, today });
  const beforeRetry = structuredClone(db.state);
  const repeated = await importFinanceCardStatement(db.pool, request, { apply: true, today });
  assert.equal(repeated.mode, "already-applied");
  assert.equal(repeated.account.currentBalance, 560);
  assert.deepEqual(db.state, beforeRetry);
  assert.equal(db.calls.filter((call) => call.sql?.startsWith("UPDATE personal_finance_accounts")).length, 1);
  await assert.rejects(importFinanceCardStatement(db.pool, { ...request, statement: { ...request.statement, statementBalance: 500 } }, { apply: true, today }),
    (error) => error.status === 409 && error.code === "OPERATION_CONFLICT");
  assert.deepEqual(db.state, beforeRetry);
});

test("a completed import never overwrites a newer statement during a later retry", async () => {
  const db = database();
  const request = operation();
  await importFinanceCardStatement(db.pool, request, { apply: true, today });
  const newer = { ...request.statement, statementBalance: 80, lastStatementDate: "2027-02-12", dueDate: "2027-03-05" };
  db.state.accounts[0].credit_card_due_json = JSON.stringify(newer);
  const repeated = await importFinanceCardStatement(db.pool, request, { apply: true, today: "2027-02-20" });
  assert.equal(repeated.mode, "already-applied");
  assert.deepEqual(repeated.account.creditCardDue, newer);
  assert.deepEqual(JSON.parse(db.state.accounts[0].credit_card_due_json), newer);
});

test("exact target selection rejects linked, inactive, wrong-mask, wrong-currency and ambiguous accounts", async () => {
  for (const extra of [{ name: "Card A backup" }, { custom_name: "Different nickname" }, { currency: "PHP" },
    { account_mask: "9999" }, { account_mask: "00001234" }, { account_type: "checking" }, { connection_id: 3 },
    { external_provider: "plaid" }, { external_account_id: "external-card" }, { is_archived: 1 },
    { is_sync_excluded: 1 }, { merged_into_account_id: 99 }]) {
    const db = database({ accounts: [account(extra)] });
    await assert.rejects(importFinanceCardStatement(db.pool, operation(), { today }), (error) => error.status === 404);
    assert.ok(db.calls.every((call) => call.sql.startsWith("SELECT")));
  }
  const ambiguous = database({ accounts: [account(), account({ id: 8, account_mask: null })] });
  await assert.rejects(importFinanceCardStatement(ambiguous.pool, operation(), { apply: true, today }),
    (error) => error.status === 409 && error.code === "AMBIGUOUS_ACCOUNT");
  assert.deepEqual(ambiguous.state.audits, {});
  assert.ok(!ambiguous.calls.some((call) => call.sql?.startsWith("UPDATE personal_finance_accounts")));
  for (const account_mask of [null, "", "••1234"]) {
    const exact = database({ accounts: [account({ name: "  CARD   A  ", account_mask })] });
    assert.equal((await importFinanceCardStatement(exact.pool, operation(), { today })).account.id, 7);
  }
});

test("invalid imports fail before querying any database or provisioning an audit table", async () => {
  const original = operation();
  const invalid = [
    { ...original, id: "not an id" }, { ...original, target: { ...original.target, name: "" } },
    { ...original, target: { ...original.target, mask: "1234567890123456" } },
    { ...original, target: { ...original.target, currency: "EUR" } },
    ...[{ statementBalance: "472.35" }, { statementBalance: -1 }, { statementBalance: 1.001 }, { statementBalance: NaN },
      { minimumPayment: 500 }, { dueDate: "2027-02-30" }, { dueDate: "2027-01-01" }, { lastStatementDate: "2027-02-01" }]
      .map((changes) => ({ ...original, statement: { ...original.statement, ...changes } })),
  ];
  for (const request of invalid) {
    const db = database();
    await assert.rejects(importFinanceCardStatement(db.pool, request, { apply: true, today }), (error) => error.status === 400);
    assert.deepEqual(db.calls, []);
  }
});

test("missing statement fields can be filled but any nonempty conflicting amount or cycle is preserved", async () => {
  const request = operation();
  const incomplete = database({ accounts: [account({ credit_card_due_json: JSON.stringify({ statementBalance: 472.35,
    dueDate: request.statement.dueDate, minimumPayment: null, lastStatementDate: null }) })] });
  const filled = await importFinanceCardStatement(incomplete.pool, request, { apply: true, today });
  assert.equal(filled.mode, "applied");
  assert.equal(filled.account.creditCardDue.minimumPayment, 25);
  assert.equal(filled.account.creditCardDue.lastStatementDate, request.statement.lastStatementDate);
  for (const previous of [{ statementBalance: 0 }, { minimumPayment: 0 }, { dueDate: "2027-03-05" },
    { dueDate: "2027-01-05" }, { lastStatementDate: "2027-02-12" }, { lastStatementDate: "2027-01-11" }]) {
    const db = database({ accounts: [account({ credit_card_due_json: JSON.stringify(previous) })] });
    const before = structuredClone(db.state.accounts);
    await assert.rejects(importFinanceCardStatement(db.pool, request, { apply: true, today }), (error) => error.status === 409);
    assert.deepEqual(db.state.accounts, before);
    assert.deepEqual(db.state.audits, {});
  }
});

test("an identical manual statement records a durable no-op receipt without rewriting the account", async () => {
  const request = operation();
  const details = { ...request.statement, lastPaymentDate: null, lastPaymentAmount: null, syncedAt: null };
  const db = database({ accounts: [account({ credit_card_due_json: JSON.stringify(details), credit_card_due_status: "manual" })] });
  const before = structuredClone(db.state.accounts);
  const result = await importFinanceCardStatement(db.pool, request, { apply: true, today });
  assert.equal(result.mode, "unchanged");
  assert.equal(result.changesRequired, false);
  assert.deepEqual(db.state.accounts, before);
  assert.equal(db.state.audits[request.id].status, "unchanged");
  assert.ok(!db.calls.some((call) => call.sql?.startsWith("UPDATE personal_finance_accounts")));
});

test("audit failure and unrelated read-back changes roll back the statement and marker together", async () => {
  for (const fault of ["audit", "balance", "ledger"]) {
    const db = database({ fault });
    const before = structuredClone(db.state);
    await assert.rejects(importFinanceCardStatement(db.pool, operation(), { apply: true, today }),
      (error) => fault === "audit" ? /audit write failure/.test(error.message) : error.code === "IMPORT_VERIFICATION_FAILED");
    assert.deepEqual(db.state.accounts, before.accounts);
    assert.deepEqual(db.state.transactions, before.transactions);
    assert.deepEqual(db.state.audits, {});
    assert.equal(db.calls.filter((call) => call.source === "commit").length, 0);
    assert.equal(db.calls.filter((call) => call.source === "rollback").length, 1);
    assert.equal(db.calls.at(-1).source, "release");
  }
});
