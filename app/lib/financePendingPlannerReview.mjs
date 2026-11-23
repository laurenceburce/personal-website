import { addDays, buildPlanRows, localDate } from "./financePlanner.mjs";
import { mapFinanceActivityAccount } from "./financeActivity.mjs";
import { financePlanTransactionMetadata } from "./financePlanPostings.mjs";

/** Scope a maintenance review to one explicitly identified custom charge. */
export async function reviewFinancePendingPlanner(pool, operation, { refresh, today = localDate() } = {}) {
  const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
  if (!operation || operation.purpose !== "pending-charge-review" || typeof operation.description !== "string" ||
      !operation.description.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(operation.date) ||
      !["USD", "PHP"].includes(operation.currency) || !Number.isFinite(operation.amount) || operation.amount <= 0)
    fail("Invalid review scope", 400);
  if (refresh) await refresh(pool, today);
  const [saved] = await pool.query("SELECT document, exchange_rate FROM personal_finance_planner WHERE id = 1");
  if (saved.length !== 1) fail("Saved planner unavailable");
  const document = typeof saved[0].document === "string" ? JSON.parse(saved[0].document) : saved[0].document;
  const plan = document.plans[0];
  const normalized = (text) => String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
  const entries = (plan?.entries || []).filter((entry) => normalized(entry.description) === normalized(operation.description) &&
    entry.date === operation.date && entry.currency === operation.currency && entry.kind === "expense" &&
    Math.abs(Number(entry.amount) - operation.amount) < 0.005);
  if (entries.length !== 1 || !entries[0].accountId) fail("The exact custom charge is missing or ambiguous");
  const entry = entries[0];
  const [accountRows] = await pool.query(`SELECT a.*,
    (SELECT COALESCE(SUM(CASE WHEN t.kind = 'income' THEN t.amount ELSE -t.amount END), 0)
     FROM personal_finance_transactions t WHERE t.account_id = a.id AND t.currency = a.currency
       AND t.pending = 0 AND t.duplicate_of_id IS NULL AND t.is_provider_removed = 0 AND t.transaction_date <= ?) AS native_movement
    FROM personal_finance_accounts a WHERE a.is_archived = 0 AND a.merged_into_account_id IS NULL AND a.is_sync_excluded = 0`, [today]);
  const account = accountRows.find((item) => Number(item.id) === Number(entry.accountId));
  if (!account || account.account_type !== "credit" || account.currency !== operation.currency ||
      !account.external_provider || !account.external_account_id) fail("The selected charge is not on an active linked credit card");
  const from = addDays(operation.date, -7), through = addDays(today > operation.date ? today : operation.date, 7);
  const [records] = await pool.query(`SELECT t.*, DATE_FORMAT(t.transaction_date, '%Y-%m-%d') AS transaction_date,
      a.account_type
    FROM personal_finance_transactions t LEFT JOIN personal_finance_accounts a ON a.id = t.account_id
    WHERE t.transaction_date BETWEEN ? AND ? AND t.currency IN ('USD', 'PHP')
    ORDER BY t.transaction_date, t.id LIMIT 10001`, [from, through]);
  if (records.length > 10000) fail("Review history exceeds its limit");
  const transactions = records.filter((row) => !row.is_provider_removed && row.duplicate_of_id == null).map((row) => ({
    ...financePlanTransactionMetadata(row), id: Number(row.id), date: row.transaction_date,
    accountId: row.account_id == null ? null : Number(row.account_id), accountType: row.account_type,
    kind: row.kind, amount: Number(row.amount), currency: row.currency, merchant: row.merchant,
    category: row.category, note: row.note, provider: row.external_provider || "", externalId: row.external_transaction_id || "",
    pendingExternalId: row.external_pending_transaction_id || "", pending: Boolean(row.pending),
  }));
  const rate = typeof saved[0].exchange_rate === "string" ? JSON.parse(saved[0].exchange_rate) : saved[0].exchange_rate;
  const options = { today, accounts: accountRows.map(mapFinanceActivityAccount).filter(Boolean), transactions,
    creditCardPaymentTransactions: transactions };
  const summarize = (row) => ({ id: row.id, date: row.date, description: row.description, amount: row.amount,
    source: row.source, completed: row.completed, completionSource: row.completionSource,
    awaitingBankSync: Boolean(row.awaitingBankSync), bankPending: Boolean(row.bankPending),
    bankPendingRemoved: Boolean(row.bankPendingRemoved), pendingOriginalDate: row.pendingOriginalDate,
    carriedPending: Boolean(row.carriedPending), pendingTransactionIds: row.pendingTransactionIds || [],
    matchedTransactionIds: row.matchedTransactionIds || [], planRowId: row.planRowId, entryId: row.entryId,
  });
  const forRange = (startDate) => buildPlanRows({ ...plan, startDate, endDate: addDays(today, 35), includeTransactions: true },
    document, Number(rate?.rate) || 58, options).filter((row) => row.entryId === entry.id ||
      row.planRowId === `entry:${entry.id}` || row.matchedForecast?.entryId === entry.id).map(summarize);
  return { today, entry: { id: entry.id, date: entry.date, description: entry.description, amount: entry.amount,
      currency: entry.currency, accountId: entry.accountId },
    markedComplete: (plan.completedRows || []).some((item) => item.rowId === `entry:${entry.id}`),
    account: { id: Number(account.id), name: account.custom_name || account.name, type: account.account_type,
      currency: account.currency, bankCurrentBalance: account.current_balance == null ? null : Number(account.current_balance) },
    matchingRecords: records.filter((row) => Number(row.account_id) === Number(account.id) &&
      (Math.abs(Number(row.amount) - operation.amount) < 0.005 || row.source_plan_row_id === `entry:${entry.id}`))
      .map((row) => ({ id: Number(row.id), date: row.transaction_date, kind: row.kind, amount: Number(row.amount),
        currency: row.currency, merchant: row.merchant, provider: row.external_provider || "", pending: Boolean(row.pending),
        isProviderRemoved: Boolean(row.is_provider_removed), planGenerated: Boolean(row.plan_generated),
        planProvisional: Boolean(row.plan_provisional), sourcePlanId: row.source_plan_id, sourcePlanRowId: row.source_plan_row_id,
        externalId: row.external_transaction_id, pendingExternalId: row.external_pending_transaction_id || "" })),
    rows: forRange(operation.date), futureRows: forRange(today) };
}
