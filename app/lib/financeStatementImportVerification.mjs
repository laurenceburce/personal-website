import { addDays, buildPlanRows } from "./financePlanner.mjs";
import { mapFinanceActivityAccount } from "./financeActivity.mjs";
import { financePlanPendingMovementSql, financePlanTransactionMetadata } from "./financePlanPostings.mjs";
import { ensurePrimaryFinancePlanner } from "./financePrimaryPlanner.mjs";

/** Read the saved planner and ledger without triggering syncs or generated postings. */
export async function verifyFinanceStatementPlan(pool, operation, imported, today) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [plans] = await connection.query("SELECT document, exchange_rate FROM personal_finance_planner WHERE id = 1");
    if (plans.length !== 1) throw Object.assign(new Error("Saved planner unavailable"), { status: 409 });
    const [accountRows] = await connection.query(`SELECT a.*,
      ${financePlanPendingMovementSql("a", today)} AS plan_pending_movement,
      (SELECT COALESCE(SUM(CASE WHEN t.kind = 'income' THEN t.amount ELSE -t.amount END), 0)
       FROM personal_finance_transactions t WHERE t.account_id = a.id AND t.currency = a.currency
         AND t.pending = 0 AND t.duplicate_of_id IS NULL AND t.is_provider_removed = 0 AND t.transaction_date <= ?) AS native_movement
      FROM personal_finance_accounts a
      WHERE a.is_archived = 0 AND a.is_sync_excluded = 0 AND a.merged_into_account_id IS NULL`, [today]);
    const [records] = await connection.query(`SELECT t.*, DATE_FORMAT(t.transaction_date, '%Y-%m-%d') AS transaction_date,
        a.account_type
      FROM personal_finance_transactions t LEFT JOIN personal_finance_accounts a ON a.id = t.account_id
      WHERE t.duplicate_of_id IS NULL AND t.is_provider_removed = 0
        AND t.transaction_date >= ? AND t.transaction_date <= ?
      ORDER BY t.transaction_date, t.id LIMIT 10001`, [operation.statement.lastStatementDate, today]);
    if (records.length > 10000) throw Object.assign(new Error("Statement history exceeds the verification limit"), { status: 409 });
    const accounts = accountRows.map(mapFinanceActivityAccount).filter(Boolean);
    const account = accounts.find((item) => item.id === imported.id);
    if (!account) throw Object.assign(new Error("Imported card unavailable"), { status: 409 });
    const transactions = records.map((row) => ({ ...financePlanTransactionMetadata(row), id: Number(row.id),
      date: row.transaction_date, amount: Number(row.amount), currency: row.currency, kind: row.kind,
      accountId: row.account_id == null ? null : Number(row.account_id), accountType: row.account_type,
      merchant: row.merchant, category: row.category, note: row.note, pending: Boolean(row.pending) }));
    const document = ensurePrimaryFinancePlanner(typeof plans[0].document === "string" ? JSON.parse(plans[0].document) : plans[0].document, today);
    const savedRate = typeof plans[0].exchange_rate === "string" ? JSON.parse(plans[0].exchange_rate) : plans[0].exchange_rate;
    const plan = { ...document.plans[0], startDate: today, endDate: addDays(today, 62), balanceMode: "live", includeTransactions: true };
    const rows = buildPlanRows(plan, document, Number(savedRate?.rate) || 58,
      { accounts, transactions, creditCardPaymentTransactions: transactions, today });
    await connection.commit();
    return { today, accountId: account.id, currentBalance: account.nativeCurrentBalance,
      balanceUnchanged: account.nativeCurrentBalance === imported.currentBalance,
      statementRows: rows.filter((row) => row.source === "creditCardDue" && Number(row.creditAccountId) === account.id)
        .map((row) => ({ id: row.id, date: row.date, dueDate: row.dueDate, statementBalance: row.statementBalance,
          paidAmount: row.paidAmount, amount: row.amount, estimated: Boolean(row.estimated),
          projectedCycle: Boolean(row.projectedCycle), plannedPaymentAmount: row.plannedPaymentAmount })),
      paymentRows: rows.filter((row) => row.source === "manual" && row.kind === "transfer" && Number(row.toAccountId) === account.id)
        .map((row) => ({ id: row.id, date: row.date, amount: row.amount, amountMode: row.amountMode,
          liveCardBalance: Boolean(row.liveCardBalance), fromAccountId: row.fromAccountId, toAccountId: row.toAccountId })) };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally { connection.release(); }
}
