import crypto from "node:crypto";
import { localDate } from "./financePlanner.mjs";

const AUDIT_TABLE = "personal_finance_statement_imports";
const STATEMENT_FIELDS = ["statementBalance", "minimumPayment", "lastStatementDate", "dueDate"];
const CURRENCIES = new Set(["USD", "PHP"]);

function fail(message, status = 400, code = "INVALID_IMPORT") {
  throw Object.assign(new Error(message), { status, code });
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "1900-01-01" || value > "2200-12-31") return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function normalizedName(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function money(value, label, { stored = false } = {}) {
  if ((!stored && typeof value !== "number") || !["number", "string"].includes(typeof value) ||
      !String(value).trim() || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > 999_999_999 ||
      (!stored && Number(value) < 0) || Math.abs(Number(value) * 100 - Math.round(Number(value) * 100)) > 0.00001)
    fail(`${label} is invalid.`, stored ? 409 : 400, stored ? "INVALID_EXISTING_ACCOUNT" : "INVALID_IMPORT");
  return Math.round(Number(value) * 100) / 100;
}

function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

const serialized = (value) => JSON.stringify(canonical(value));
const hash = (value) => crypto.createHash("sha256").update(serialized(value)).digest("hex");

function validate(operation, today) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation) ||
      typeof operation.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(operation.id)) fail("Choose a valid import operation.");
  const target = operation.target;
  if (!target || typeof target.name !== "string" || !target.name.trim() || target.name.length > 80 ||
      /[\u0000-\u001f\u007f]/.test(target.name) || !CURRENCIES.has(target.currency) ||
      typeof target.mask !== "string" || !/^\d{4}$/.test(target.mask)) fail("Choose an exact credit card name, currency and last four digits.");
  const statement = operation.statement;
  if (!statement || !validDate(statement.lastStatementDate) || !validDate(statement.dueDate) ||
      !validDate(today) || statement.lastStatementDate > today || statement.lastStatementDate > statement.dueDate)
    fail("The statement closing and due dates are invalid.");
  const result = { id: operation.id, target: { name: normalizedName(target.name), currency: target.currency, mask: target.mask },
    statement: { statementBalance: money(statement.statementBalance, "Statement balance"),
      minimumPayment: money(statement.minimumPayment, "Minimum payment"),
      lastStatementDate: statement.lastStatementDate, dueDate: statement.dueDate } };
  if (result.statement.minimumPayment > result.statement.statementBalance) fail("Minimum payment cannot exceed the statement balance.");
  return result;
}

function manualAccount(account) {
  return account.account_type === "credit" && Number.isSafeInteger(Number(account.id)) && Number(account.id) > 0 &&
    !Number(account.is_archived || 0) && !Number(account.is_sync_excluded || 0) && account.merged_into_account_id == null &&
    !String(account.external_provider || "").trim() && !String(account.external_account_id || "").trim() && account.connection_id == null;
}

function matches(account, target) {
  const displayName = account.custom_name || account.name;
  const storedMask = String(account.account_mask || "").trim();
  const mask = /^[*xX•·\s-]*(\d{4})$/.exec(storedMask)?.[1];
  return manualAccount(account) && account.currency === target.currency && normalizedName(displayName) === target.name &&
    (!storedMask || mask === target.mask);
}

function parseStatement(value) {
  if (value == null || value === "") return null;
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { fail("Existing statement data needs review.", 409, "STATEMENT_CONFLICT"); }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("Existing statement data needs review.", 409, "STATEMENT_CONFLICT");
  return parsed;
}

function proposedStatement(account, statement) {
  const previous = parseStatement(account.credit_card_due_json);
  for (const field of STATEMENT_FIELDS) {
    const existing = previous?.[field];
    if (existing == null || existing === "") continue;
    if (field === "dueDate" || field === "lastStatementDate") {
      if (!validDate(existing) || existing !== statement[field])
        fail(existing > statement[field] ? "A newer statement is already saved." : "Existing statement dates differ from this import.",
          409, existing > statement[field] ? "NEWER_STATEMENT" : "STATEMENT_CONFLICT");
    } else if (money(existing, "Existing statement amount", { stored: true }) !== statement[field])
      fail("Existing statement amounts differ from this import.", 409, "STATEMENT_CONFLICT");
  }
  return { ...previous, ...statement,
    lastPaymentDate: previous?.lastPaymentDate ?? null,
    lastPaymentAmount: previous?.lastPaymentAmount ?? null,
    syncedAt: previous?.syncedAt ?? null };
}

async function findTarget(connection, target, lock) {
  const [accounts] = await connection.query(`SELECT a.* FROM personal_finance_accounts a
    WHERE a.account_type = 'credit' AND a.currency = ? AND a.is_archived = 0 AND a.is_sync_excluded = 0
      AND a.merged_into_account_id IS NULL AND a.connection_id IS NULL
      AND (a.external_provider IS NULL OR a.external_provider = '')
      AND (a.external_account_id IS NULL OR a.external_account_id = '')
    ORDER BY a.id${lock ? " FOR UPDATE" : ""}`, [target.currency]);
  const candidates = accounts.filter((account) => matches(account, target));
  if (candidates.length !== 1) fail(candidates.length ? "More than one manual card matches this import." : "The exact active manual card was not found.",
    candidates.length ? 409 : 404, candidates.length ? "AMBIGUOUS_ACCOUNT" : "ACCOUNT_NOT_FOUND");
  return candidates[0];
}

async function accountHistory(connection, accountId, lock) {
  const [transactions] = await connection.query(`SELECT t.*, DATE_FORMAT(t.transaction_date, '%Y-%m-%d') AS statement_import_date
    FROM personal_finance_transactions t WHERE t.account_id = ? ORDER BY t.id${lock ? " FOR UPDATE" : ""}`, [accountId]);
  return transactions;
}

function accountReceipt(account, transactions, today) {
  const openingBalance = money(account.opening_balance, "Account opening balance", { stored: true });
  let currentCents = Math.round(openingBalance * 100);
  let postedTransactionCount = 0;
  for (const transaction of transactions) {
    if (transaction.currency !== account.currency || Number(transaction.pending || 0) || transaction.duplicate_of_id != null ||
        Number(transaction.is_provider_removed || 0) || transaction.statement_import_date > today ||
        !validDate(transaction.statement_import_date) || !["income", "expense"].includes(transaction.kind)) continue;
    const amount = money(transaction.amount, "Recorded transaction amount", { stored: true });
    currentCents += (transaction.kind === "expense" ? 1 : -1) * Math.round(amount * 100);
    postedTransactionCount += 1;
  }
  return { id: Number(account.id), name: account.custom_name || account.name, currency: account.currency,
    currentBalance: currentCents / 100, openingBalance,
    storedCurrentBalance: account.current_balance == null ? null : money(account.current_balance, "Stored current balance", { stored: true }),
    autopayEnabled: Boolean(Number(account.credit_card_autopay_enabled || 0)),
    autopayDaysBeforeDue: Number(account.credit_card_autopay_days_before_due ?? 7),
    creditCardDue: parseStatement(account.credit_card_due_json), creditCardDueStatus: account.credit_card_due_status,
    transactionCount: transactions.length, postedTransactionCount };
}

function protectedAccount(account) {
  const { credit_card_due_json, credit_card_due_status, updated_at, ...protectedFields } = account;
  return protectedFields;
}

function preview(operation, account, history, today) {
  const creditCardDue = proposedStatement(account, operation.statement);
  return { operationId: operation.id, mode: "preview", account: accountReceipt(account, history, today),
    proposed: { creditCardDue, creditCardDueStatus: "manual" },
    changesRequired: serialized(parseStatement(account.credit_card_due_json)) !== serialized(creditCardDue) || account.credit_card_due_status !== "manual" };
}

/** Apply a fixed, independently authorized statement import; this helper provides no HTTP authorization. */
export async function importFinanceCardStatement(pool, operation, { apply = false, today = localDate() } = {}) {
  if (typeof apply !== "boolean") fail("Choose preview or apply.");
  const request = validate(operation, today);
  if (!apply) {
    const account = await findTarget(pool, request.target, false);
    return preview(request, account, await accountHistory(pool, account.id, false), today);
  }
  // MySQL DDL commits implicitly. Provision this apply-only audit table before
  // beginning the transaction that owns both the update and its durable marker.
  await pool.query(`CREATE TABLE IF NOT EXISTS ${AUDIT_TABLE} (
    operation_id VARCHAR(80) PRIMARY KEY, request_hash CHAR(64) NOT NULL,
    account_id BIGINT UNSIGNED NULL, before_json LONGTEXT NULL, after_json LONGTEXT NULL,
    status VARCHAR(16) NOT NULL, created_at DATETIME(3) NOT NULL, completed_at DATETIME(3) NULL
  )`);
  const connection = await pool.getConnection();
  let committed = false;
  try {
    await connection.beginTransaction();
    const requestHash = hash(request);
    const [inserted] = await connection.query(`INSERT IGNORE INTO ${AUDIT_TABLE}
      (operation_id, request_hash, status, created_at) VALUES (?, ?, 'pending', NOW(3))`, [request.id, requestHash]);
    const [auditRows] = await connection.query(`SELECT * FROM ${AUDIT_TABLE} WHERE operation_id = ? FOR UPDATE`, [request.id]);
    const audit = auditRows[0];
    if (!audit || audit.request_hash !== requestHash) fail("This import identifier belongs to a different request.", 409, "OPERATION_CONFLICT");
    if (["applied", "unchanged"].includes(audit.status)) {
      const [accounts] = await connection.query("SELECT * FROM personal_finance_accounts WHERE id = ? FOR UPDATE", [audit.account_id]);
      if (!accounts[0]) fail("The previously imported account is unavailable.", 409, "ACCOUNT_NOT_FOUND");
      const history = await accountHistory(connection, accounts[0].id, true);
      const result = { operationId: request.id, auditId: request.id, mode: "already-applied",
        account: accountReceipt(accounts[0], history, today), changesRequired: false,
        proposed: { creditCardDue: request.statement, creditCardDueStatus: "manual" } };
      await connection.commit();
      committed = true;
      return result;
    }
    if (audit.status !== "pending" || !inserted.affectedRows) fail("This import requires an audit review before retrying.", 409, "OPERATION_CONFLICT");
    const account = await findTarget(connection, request.target, true);
    const history = await accountHistory(connection, account.id, true);
    const result = preview(request, account, history, today);
    if (result.changesRequired) {
      const [updated] = await connection.query(`UPDATE personal_finance_accounts
        SET credit_card_due_json = ?, credit_card_due_status = 'manual', updated_at = NOW(3) WHERE id = ?`,
      [JSON.stringify(result.proposed.creditCardDue), account.id]);
      if (updated.affectedRows !== 1) fail("The statement update could not be verified.", 409, "IMPORT_VERIFICATION_FAILED");
    }
    const [afterRows] = await connection.query("SELECT * FROM personal_finance_accounts WHERE id = ? FOR UPDATE", [account.id]);
    const after = afterRows[0];
    const afterHistory = await accountHistory(connection, account.id, true);
    if (!after || serialized(protectedAccount(account)) !== serialized(protectedAccount(after)) || hash(history) !== hash(afterHistory) ||
        serialized(parseStatement(after.credit_card_due_json)) !== serialized(result.proposed.creditCardDue) || after.credit_card_due_status !== "manual")
      fail("The import changed unrelated data or failed its read-back check.", 409, "IMPORT_VERIFICATION_FAILED");
    const receipt = { ...result, mode: result.changesRequired ? "applied" : "unchanged", auditId: request.id,
      account: accountReceipt(after, afterHistory, today) };
    const [recorded] = await connection.query(`UPDATE ${AUDIT_TABLE}
      SET account_id = ?, before_json = ?, after_json = ?, status = ?, completed_at = NOW(3) WHERE operation_id = ? AND status = 'pending'`,
    [account.id, JSON.stringify({ account, transactionHash: hash(history), transactionCount: history.length }), JSON.stringify(receipt), receipt.mode, request.id]);
    if (recorded.affectedRows !== 1) fail("The import audit could not be saved.", 409, "IMPORT_VERIFICATION_FAILED");
    await connection.commit();
    committed = true;
    return receipt;
  } finally {
    if (!committed) await connection.rollback().catch(() => {});
    connection.release();
  }
}
