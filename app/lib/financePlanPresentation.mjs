// Stable categories for presentation; money flows and completion stay unchanged.
export const PLAN_ROW_CATEGORIES = [
  { key: "savings", label: "Savings" },
  { key: "bill", label: "Bills" },
  { key: "transfer", label: "Transfers" },
  { key: "reserve", label: "Annual reserves" },
  { key: "income", label: "Income" },
  { key: "expense", label: "Expenses" },
];

const categories = new Map(PLAN_ROW_CATEGORIES.map((category) => [category.key, category]));
const transferCategories = new Set([
  "transfer", "transfer in", "transfer out", "internal transfer", "account transfer",
  "loan payment", "loan payments",
]);

export function getPlanRowCategory(row) {
  const matched = row.matchedForecast;
  // Recorded activity keeps the category of the scheduled item it replaces.
  const source = row.source === "transaction"
    ? row.scheduledSource || matched?.source || row.source
    : row.source;
  const kind = matched?.kind || row.kind;
  const allocationKind = row.allocationKind || matched?.allocationKind;
  let key;

  if (source === "allocation" && allocationKind === "savings") key = "savings";
  else if (source === "reserve" || source === "reserveRelease") key = "reserve";
  else if (source === "bill" || source === "creditCardDue" ||
    row.billId != null || matched?.billId != null ||
    row.creditCardPaymentFor != null || matched?.creditCardPaymentFor != null) key = "bill";
  else if (source === "salary") key = "income";
  else if (kind === "transfer" || kind === "conversion" || transferCategories.has(
    String(row.category || "").trim().toLowerCase().replace(/\s+/g, " "),
  )) key = "transfer";
  else if (kind === "income") key = "income";
  else key = "expense";

  return categories.get(key);
}
