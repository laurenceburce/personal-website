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

const currencyLabel = (account) => ({ USD: "US", PHP: "PH" })[String(account?.currency || "").toUpperCase()];
const accountType = (account) => account?.type || account?.account_type;
const activeAccount = (account) => account && !account.isArchived && !account.is_archived &&
  !account.isSyncExcluded && !account.is_sync_excluded && !account.mergedIntoAccountId && !account.merged_into_account_id;
const normalizeLabel = (value) => String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
const sameAccount = (first, second) => first === second || (Number(first?.id) > 0 && Number(second?.id) > 0 &&
  Number(first.id) === Number(second.id));
const cleanAccountName = (value) => {
  let name = String(value || "").trim().replace(/\s+/g, " ");
  let previous;
  do {
    previous = name;
    name = name.replace(/\s*[·|–—-]\s*[•●*xX]+\s*\d{2,8}\s*$/, "")
      .replace(/\s*[•●*]+\s*\d{2,8}\s*$/, "")
      .replace(/\s+[xX]{2,}\s*\d{2,8}\s*$/, "")
      .replace(/\s*\(\s*[•●*xX]+\s*\d{2,8}\s*\)\s*$/, "")
      .replace(/\s*\(\s*(?:US|PH|USD|PHP)\s*\)\s*$/i, "")
      .replace(/\s*[·|]\s*(?:US|PH|USD|PHP)\s*$/i, "").trim();
  } while (name !== previous);
  return name;
};
const accountBaseName = (account) => cleanAccountName(account?.name) || cleanAccountName(account?.officialName || account?.official_name) ||
  ({ checking: "Checking", savings: "Savings", credit: "Credit Card", cash: "Cash", loan: "Loan", investment: "Investment" })[accountType(account)] || "Account";
const maskedDigits = (account) => String(account?.mask || account?.account_mask || "").replace(/\D/g, "").slice(-4) ||
  /[•●*xX]+\s*(\d{2,8})/.exec(String(account?.name || ""))?.[1].slice(-4) || "";
const sameCurrency = (first, second) => String(first?.currency || "").toUpperCase() === String(second?.currency || "").toUpperCase();

/** A short column label; account identities and matching names stay untouched. */
export function getPlannerAccountLabel(account, accounts = []) {
  const name = accountDisplayName(account);
  const currency = currencyLabel(account);
  const duplicate = accounts.some((other) => activeAccount(other) && !sameAccount(other, account) && sameCurrency(other, account) &&
    normalizeLabel(accountDisplayName(other)) === normalizeLabel(name));
  const mask = duplicate ? maskedDigits(account) : "";
  return `${name}${currency ? ` (${currency})` : ""}${mask ? ` · ••${mask}` : ""}`;
}

const genericCardName = (name) => /^(?:credit\s*card|credit|card|account)$/i.test(name);
const cardBaseName = (account) => {
  const name = accountBaseName(account);
  if (!genericCardName(name)) return name;
  const official = cleanAccountName(account.officialName || account.official_name);
  if (official && !genericCardName(official)) return official;
  const institution = cleanAccountName(account.institutionName || account.institution_name);
  return institution ? /\bcredit\s*card$/i.test(institution) ? institution : `${institution} Credit Card` : "Credit Card";
};
const accountDisplayName = (account) => accountType(account) === "credit" ? cardBaseName(account) : accountBaseName(account);

/** Use a specific card name for automatic payments without changing row metadata. */
export function getPlannerTransactionLabel(row, accounts = []) {
  const description = row?.description || "";
  const automatic = row?.autopayEnabled === true || row?.matchedForecast?.autopayEnabled === true ||
    /\bautomatic\s+payment\b|\bautopay\b/i.test(`${description} ${row?.matchedForecast?.description || ""}`);
  if (!automatic) return description;
  const ids = [row?.creditAccountId, row?.creditCardPaymentFor, row?.toAccountId,
    row?.matchedForecast?.creditAccountId, row?.matchedForecast?.creditCardPaymentFor];
  const card = ids.map((id) => id == null ? null : accounts.find((account) =>
    Number(account.id) === Number(id) && accountType(account) === "credit")).find(Boolean);
  if (!card) return description;
  const name = cardBaseName(card);
  const duplicate = accounts.some((other) => activeAccount(other) && accountType(other) === "credit" && !sameAccount(other, card) &&
    normalizeLabel(cardBaseName(other)) === normalizeLabel(name));
  const label = duplicate ? getPlannerAccountLabel({ ...card, name }, accounts.filter((account) => accountType(account) === "credit")
    .map((account) => ({ ...account, name: cardBaseName(account) }))) : name;
  return `${label} (Automatic Payment)`;
}

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
