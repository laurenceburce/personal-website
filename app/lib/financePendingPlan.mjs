const DAY = 86_400_000;
const genericWords = new Set(["a", "an", "and", "the", "for", "to", "from", "payment", "payments", "purchase", "purchases",
  "debit", "credit", "transaction", "card", "pending", "online", "subscription", "monthly", "bill", "bills", "com", "www",
  "llc", "inc", "ltd", "us", "usd", "php", "visa", "mastercard", "jcb", "transfer", "pos", "auth", "authorization"]);

const words = (value) => [...new Set(String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")
  .split(" ").filter((word) => word.length >= 3 && /\p{L}/u.test(word) && !genericWords.has(word)))];
const date = (value) => {
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value || "").slice(0, 10);
  const time = /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(`${text}T00:00:00Z`) : NaN;
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === text ? time : NaN;
};

/** Pending bank evidence links a task; it never proves a settled movement. */
export function pendingPlanMatch(row, transaction) {
  if (!(transaction?.pending === true || Number(transaction?.pending) === 1) || Number(row.accountId ?? row.account_id) !== Number(transaction.accountId ?? transaction.account_id) ||
      row.currency !== transaction.currency || row.kind !== transaction.kind ||
      !Number.isFinite(Number(transaction.amount)) || Number(transaction.amount) <= 0) return false;
  const rowId = row.rowId ?? row.id;
  const transactionPlan = transaction.planId ?? transaction.source_plan_id;
  const transactionRow = transaction.planRowId ?? transaction.source_plan_row_id;
  if (transactionPlan != null || transactionRow != null) return transactionPlan != null && transactionRow != null &&
    (row.planId ?? row.source_plan_id) != null && rowId != null && String(row.planId ?? row.source_plan_id) === String(transactionPlan) &&
    String(rowId) === String(transactionRow) && Boolean(transaction.provider || transaction.external_provider || transaction.bankPendingRemoved);
  if (!transaction.provider && !transaction.external_provider) return false;
  if (!Number.isFinite(Number(row.amount)) || Math.abs(Number(row.amount) - Number(transaction.amount)) >= 0.005 ||
      Math.abs(date(row.date ?? row.transaction_date) - date(transaction.date ?? transaction.posting_date ?? transaction.transaction_date)) > 3 * DAY ||
      !Number.isFinite(date(row.date ?? row.transaction_date)) || !Number.isFinite(date(transaction.date ?? transaction.posting_date ?? transaction.transaction_date))) return false;
  const planned = words(row.description ?? row.merchant);
  const imported = words(transaction.merchant ?? transaction.description);
  const [shorter, longer] = planned.length <= imported.length ? [planned, imported] : [imported, planned];
  return shorter.length > 0 && shorter.every((word) => longer.includes(word));
}
