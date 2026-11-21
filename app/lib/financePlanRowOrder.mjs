const value = (candidate) => typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
const transactionId = (candidate) => /^transaction(?::|-pair:)/.test(candidate || "");

/** Keep the same identity when a planned row is replaced by its saved receipt. */
export function getPlanRowOrderId(row = {}) {
  // A statement references its bank payment legs; those remain separate events.
  const paymentReference = row.source === "transaction" && (row.matchedForecast?.source === "creditCardDue" ||
    [row.completionKey, row.planRowId, row.planScheduledRowId, row.scheduledRowId].some((candidate) => /^creditCardDue:/.test(candidate || "")));
  const owned = (candidate) => paymentReference && /^creditCardDue:/.test(candidate || "") ? null : candidate;
  const candidates = [
    !paymentReference && row.completionKey,
    !paymentReference && row.matchedForecast?.id,
    owned(row.planRowId), row.id, owned(row.planScheduledRowId), owned(row.scheduledRowId), row.rowId,
  ].map(value).filter(Boolean);
  return candidates.find((candidate) => !transactionId(candidate)) || candidates[0] || null;
}

const defaultPriority = (row) => row.kind === "income" ? 0 : row.kind === "conversion" ? 1
  : row.source === "reserve" ? 2 : row.source === "allocation" ? 3 : 4;

/** Saved same-day ranks override the default; unlisted ties retain input order. */
export function orderPlanRows(rows = [], plan = {}, { priority = defaultPriority } = {}) {
  const days = new Map();
  for (const day of plan.rowOrder || []) {
    if (!day || typeof day.date !== "string" || !Array.isArray(day.rowIds) || days.has(day.date)) continue;
    days.set(day.date, new Map(day.rowIds.map((id, index) => [id, index])));
  }
  return rows.map((row, index) => ({ row, index, id: getPlanRowOrderId(row) })).sort((first, second) => {
    const opening = Number(Boolean(second.row.isOpeningBalance)) - Number(Boolean(first.row.isOpeningBalance));
    if (opening) return opening;
    const date = String(first.row.date || "").localeCompare(String(second.row.date || ""));
    if (date) return date;
    const ranks = days.get(first.row.date);
    const a = ranks?.get(first.id);
    const b = ranks?.get(second.id);
    if (a != null || b != null) return a == null ? 1 : b == null ? -1 : a - b || first.index - second.index;
    return priority(first.row) - priority(second.row) || first.index - second.index;
  }).map(({ row }) => row);
}
