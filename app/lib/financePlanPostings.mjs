import { convert, entryOccurrences, localDate, roundMoney } from "./financePlanner.mjs";

const DAY = 86400000;
const keyFor = (planId, rowId, leg) => JSON.stringify([planId, rowId, leg]);
const providerRecord = (row) => Boolean(row.external_provider || row.external_transaction_id);
const parse = (value) => {
  try { return typeof value === "string" ? JSON.parse(value) : value || {}; } catch { return {}; }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const dateOnly = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value || "").slice(0, 10);
const money = (value) => roundMoney(Number(value) || 0);

export const financePlanPendingMovementSql = (alias = "a", currentDate = localDate()) => `(SELECT COALESCE(SUM(CASE WHEN pt.kind = 'income' THEN pt.amount ELSE -pt.amount END), 0)
  FROM personal_finance_transactions pt WHERE pt.account_id = ${alias}.id AND pt.currency = ${alias}.currency
    AND pt.plan_provisional = 1 AND pt.source_plan_id IS NOT NULL AND pt.pending = 0
    AND pt.duplicate_of_id IS NULL AND pt.is_provider_removed = 0 AND pt.transaction_date <= '${/^\d{4}-\d{2}-\d{2}$/.test(currentDate) ? currentDate : localDate()}')`;

/** Only completed custom occurrences become recorded money. Future forecasts stay forecasts. */
export function financePlanPostingSpecs(document, accounts, existing = [], { today = localDate(), rate = 58 } = {}) {
  const byId = new Map(accounts.map((row) => [Number(row.id), row]));
  const prior = new Map(existing.map((row) => [keyFor(row.source_plan_id, row.source_plan_row_id, row.source_plan_leg), parse(row.plan_record_json)]));
  const specs = [];
  const nativeBalance = (account) => {
    const liability = ["credit", "loan"].includes(account.account_type || account.type);
    if (account.external_provider && account.external_account_id)
      return money(Number(account.current_balance || 0) + (liability ? -1 : 1) * Number(account.plan_pending_movement || 0));
    return money(Number(account.opening_balance || 0) + (liability ? -1 : 1) * Number(account.native_movement || 0));
  };
  for (const plan of document.plans || []) {
    const completed = new Set((plan.completedRows || []).map((row) => row.rowId));
    if (!completed.size) continue;
    const overrides = new Map((plan.rowOverrides || []).map((row) => [row.rowId, row]));
    for (const entry of plan.entries || []) {
      const recurring = entry.recurrence && entry.recurrence !== "once";
      // A continuous planner can span years. Its receipts are addressed by
      // completion IDs, so recording never expands every unpaid recurrence.
      const prefix = `entry:${entry.id}:`;
      const occurrenceDates = recurring
        ? [...completed].filter((rowId) => rowId.startsWith(prefix)).map((rowId) => rowId.slice(prefix.length))
        : completed.has(`entry:${entry.id}`) ? [entry.date] : [];
      const occurrences = occurrenceDates.flatMap((day) => entryOccurrences(entry, day, day, document.salary));
      for (const occurrence of occurrences) {
        const rowId = recurring ? `entry:${entry.id}:${occurrence.date}` : `entry:${entry.id}`;
        if (!completed.has(rowId)) continue;
        const row = { ...entry, date: occurrence.date, ...overrides.get(rowId) };
        if (!row.date || row.date > today) continue;
        const transfer = ["transfer", "conversion"].includes(row.kind);
        if (transfer ? !row.fromAccountId || !row.toAccountId : !row.accountId) continue;
        const source = byId.get(Number(transfer ? row.fromAccountId : row.accountId));
        const target = transfer ? byId.get(Number(row.toAccountId)) : null;
        if (!source || source.currency !== row.currency || (transfer && (!target ||
          target.currency !== (row.kind === "conversion" ? row.currency === "USD" ? "PHP" : "USD" : row.currency)))) continue;
        const signature = [row.kind, Number(row.accountId) || null, Number(row.fromAccountId) || null,
          Number(row.toAccountId) || null, row.date, money(row.amount), row.currency, row.amountMode || "fixed"];
        const old = prior.get(keyFor(plan.id, rowId, transfer ? "debit" : "single"));
        const frozen = same(old?.signature, signature);
        const recordedRate = frozen ? old.conversionRate : Number.isFinite(Number(rate)) && Number(rate) > 0 ? Number(rate) : 58;
        const amount = frozen ? old.sourceAmount : row.amountMode === "cardBalance" && target
          ? Math.max(0, nativeBalance(target)) : money(row.amount);
        if (!Number.isFinite(amount) || amount <= 0) continue;
        const card = transfer && (target.account_type || target.type) === "credit" ? target : null;
        const due = parse(card?.credit_card_due_json);
        const explicitDue = card && new RegExp(`^creditCardDue:${Number(card.id)}:(\\d{4}-\\d{2}-\\d{2})$`).exec(row.scheduledRowId || "")?.[1];
        const dueDate = explicitDue || (frozen ? old.creditCardPaymentDueDate || null
          : /^\d{4}-\d{2}-\d{2}$/.test(due.dueDate || "") &&
            (!due.lastStatementDate || row.date >= due.lastStatementDate) && row.date <= due.dueDate ? due.dueDate : null);
        const base = { planId: plan.id, rowId, date: row.date, sourceAmount: amount,
          description: row.description, category: transfer ? "Transfer" : "Uncategorized",
          signature, conversionRate: recordedRate, creditCardPaymentFor: card ? Number(card.id) : null,
          planScheduledRowId: row.scheduledRowId || null,
          creditCardPaymentDueDate: dueDate };
        const append = (leg, account, kind, value, counterpart) => specs.push({ ...base, leg,
          accountId: Number(account.id), currency: account.currency, kind, amount: money(value),
          transferAccountId: counterpart ? Number(counterpart.id) : null,
          awaitingBankSync: Boolean(account.external_provider && account.external_account_id),
        });
        if (transfer) {
          append("debit", source, "expense", amount, target);
          append("credit", target, "income", row.kind === "conversion" ? convert(amount, row.currency, target.currency, recordedRate) : amount, source);
        } else append("single", source, row.kind, amount, null);
      }
    }
  }
  return specs;
}

/** Run inside the caller's transaction while holding the planner row lock. */
export async function synchronizeFinancePlanPostings(connection, document, { today = localDate(), rate = 58 } = {}) {
  const hasCompleted = (document.plans || []).some((plan) => (plan.completedRows || []).some((row) => row.rowId.startsWith("entry:")));
  const [existing] = await connection.query(`SELECT t.*, DATE_FORMAT(t.transaction_date, '%Y-%m-%d') AS posting_date
    FROM personal_finance_transactions t WHERE t.source_plan_id IS NOT NULL FOR UPDATE`);
  if (!hasCompleted && !existing.length) return { recorded: 0, reconciled: 0 };
  const [accounts] = await connection.query(`SELECT a.*,
    (SELECT COALESCE(SUM(CASE WHEN t.kind = 'income' THEN t.amount ELSE -t.amount END), 0)
     FROM personal_finance_transactions t WHERE t.account_id = a.id AND t.currency = a.currency
       AND t.pending = 0 AND t.duplicate_of_id IS NULL AND t.is_provider_removed = 0 AND t.transaction_date <= ?) AS native_movement,
    ${financePlanPendingMovementSql()} AS plan_pending_movement
    FROM personal_finance_accounts a`, [today]);
  const specs = financePlanPostingSpecs(document, accounts, existing, { today, rate });
  const planIds = new Set((document.plans || []).map((plan) => plan.id));
  // Removing a whole forecast never erases payments already made. Preserve its
  // receipts as editable history, including bank reconciliation still in flight.
  for (const row of existing) {
    const saved = parse(row.plan_record_json);
    if (planIds.has(row.source_plan_id) && !saved.detached) continue;
    if (!saved.planId || !saved.rowId || !saved.leg) continue;
    const changedAccount = Number(row.account_id) !== Number(saved.accountId) || row.kind !== saved.kind;
    const spec = { ...saved, detached: true,
      ...(row.plan_generated ? { accountId: Number(row.account_id), currency: row.currency, kind: row.kind,
        date: dateOnly(row.posting_date || row.transaction_date), amount: money(row.amount),
        description: row.merchant, category: row.category, note: row.note } : {}),
      ...(changedAccount ? { transferAccountId: null, creditCardPaymentFor: null,
        creditCardPaymentDueDate: null, planScheduledRowId: null } : {}),
    };
    const account = accounts.find((item) => Number(item.id) === spec.accountId);
    spec.awaitingBankSync = Boolean(account?.external_provider && account?.external_account_id);
    specs.push(spec);
  }
  const wanted = new Map(specs.map((spec) => [keyFor(spec.planId, spec.rowId, spec.leg), spec]));
  const old = new Map();
  for (const row of existing) {
    const key = keyFor(row.source_plan_id, row.source_plan_row_id, row.source_plan_leg);
    if (wanted.has(key) && !row.is_provider_removed && row.duplicate_of_id == null) old.set(key, row);
    else await releasePosting(connection, row);
  }
  const linkedSpecs = specs.filter((spec) => spec.awaitingBankSync);
  let candidates = [];
  if (linkedSpecs.length) {
    const dates = linkedSpecs.map((spec) => Date.parse(`${spec.date}T00:00:00Z`));
    const [rows] = await connection.query(`SELECT t.*, DATE_FORMAT(t.transaction_date, '%Y-%m-%d') AS posting_date
      FROM personal_finance_transactions t WHERE t.account_id IN (?) AND t.pending = 0
        AND t.duplicate_of_id IS NULL AND t.is_provider_removed = 0
        AND (t.external_provider IS NOT NULL AND t.external_provider <> '')
        AND t.transaction_date BETWEEN ? AND ? FOR UPDATE`,
      [[...new Set(linkedSpecs.map((spec) => spec.accountId))], new Date(Math.min(...dates) - 3 * DAY).toISOString().slice(0, 10),
        new Date(Math.max(...dates) + 3 * DAY).toISOString().slice(0, 10)]);
    candidates = rows;
  }
  const matches = new Map();
  const competing = new Map();
  for (const spec of linkedSpecs) {
    const key = keyFor(spec.planId, spec.rowId, spec.leg);
    const eligible = candidates.filter((row) => Number(row.account_id) === spec.accountId && row.kind === spec.kind &&
      row.currency === spec.currency && Math.abs(Number(row.amount) - spec.amount) < 0.005 &&
      Math.abs(Date.parse(`${dateOnly(row.posting_date || row.transaction_date)}T00:00:00Z`) - Date.parse(`${spec.date}T00:00:00Z`)) <= 3 * DAY &&
      (!row.source_plan_id || keyFor(row.source_plan_id, row.source_plan_row_id, row.source_plan_leg) === key));
    matches.set(key, eligible);
    for (const row of eligible) competing.set(Number(row.id), (competing.get(Number(row.id)) || 0) + 1);
  }
  let recorded = 0;
  let reconciled = 0;
  for (const spec of specs) {
    const key = keyFor(spec.planId, spec.rowId, spec.leg);
    let previous = old.get(key);
    const possible = matches.get(key) || [];
    const matched = possible.length === 1 && competing.get(Number(possible[0].id)) === 1 ? possible[0] : null;
    if (previous && providerRecord(previous) && (!matched || Number(matched.id) !== Number(previous.id))) {
      await releasePosting(connection, previous);
      previous = null;
    }
    if (matched) {
      if (previous && Number(previous.id) !== Number(matched.id)) await releasePosting(connection, previous);
      await connection.query(`UPDATE personal_finance_transactions SET source_plan_id = ?, source_plan_row_id = ?,
        source_plan_leg = ?, plan_generated = 0, plan_provisional = 0, plan_record_json = ? WHERE id = ?`,
        [spec.planId, spec.rowId, spec.leg, JSON.stringify(spec), Number(matched.id)]);
      reconciled++;
    } else {
      // Repeated saves update the same provisional/manual row; no balance baseline is rewritten.
      await connection.query(`INSERT INTO personal_finance_transactions
        (transaction_date, kind, account_id, category, merchant, note, amount, currency,
         source_plan_id, source_plan_row_id, source_plan_leg, plan_generated, plan_provisional, plan_record_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NOW(3), NOW(3))
        ON DUPLICATE KEY UPDATE transaction_date = VALUES(transaction_date), kind = VALUES(kind),
          account_id = VALUES(account_id), category = VALUES(category), merchant = VALUES(merchant), note = VALUES(note),
          amount = VALUES(amount), currency = VALUES(currency), plan_provisional = VALUES(plan_provisional),
          plan_record_json = VALUES(plan_record_json), updated_at = NOW(3)`,
        [spec.date, spec.kind, spec.accountId, spec.category, spec.description.slice(0, 120), spec.note ?? "Recorded from Budget Plans",
          spec.amount, spec.currency, spec.planId, spec.rowId, spec.leg, spec.awaitingBankSync ? 1 : 0, JSON.stringify(spec)]);
      recorded++;
    }
  }
  return { recorded, reconciled };
}

async function releasePosting(connection, row) {
  if (row.plan_generated && !providerRecord(row))
    await connection.query(`DELETE FROM personal_finance_transactions WHERE id = ? AND plan_generated = 1
      AND (external_provider IS NULL OR external_provider = '') AND (external_transaction_id IS NULL OR external_transaction_id = '')`, [Number(row.id)]);
  else await connection.query(`UPDATE personal_finance_transactions SET source_plan_id = NULL, source_plan_row_id = NULL,
    source_plan_leg = NULL, plan_generated = 0, plan_provisional = 0, plan_record_json = NULL WHERE id = ?`, [Number(row.id)]);
}

/** Refresh/backfill previously completed entries and reconcile newly imported bank transactions. */
export async function refreshFinancePlanPostings(database, currentDate) {
  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    let rows;
    try {
      [rows] = await connection.query("SELECT document, exchange_rate FROM personal_finance_planner WHERE id = 1 FOR UPDATE");
    } catch (error) {
      if (error?.errno === 1146) { await connection.commit(); return; }
      throw error;
    }
    if (rows.length) {
      const document = parse(rows[0].document);
      const rate = Number(parse(rows[0].exchange_rate).rate) || 58;
      await synchronizeFinancePlanPostings(connection, document, { today: currentDate, rate });
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally { connection.release(); }
}

export function financePlanTransactionMetadata(row) {
  if (!row.source_plan_id) return {};
  const details = parse(row.plan_record_json);
  return {
    planId: row.source_plan_id, planRowId: row.source_plan_row_id,
    planScheduledRowId: details.planScheduledRowId || null,
    transferAccountId: details.transferAccountId || null,
    creditCardPaymentFor: details.creditCardPaymentFor || null,
    creditCardPaymentDueDate: details.creditCardPaymentDueDate || null,
    awaitingBankSync: Boolean(row.plan_provisional),
    recordedFromPlan: Boolean(row.plan_generated),
    planGenerated: Boolean(row.plan_generated && !details.detached),
    planDetached: Boolean(details.detached),
  };
}
