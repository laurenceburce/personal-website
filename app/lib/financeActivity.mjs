const MAX_AMOUNT = 999_999_999;
const CURRENCIES = new Set(["USD", "PHP"]);

function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function today() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function financeActivityWindow(value) {
  const month =
    value === null || value === undefined || value === ""
      ? today().slice(0, 7)
      : value;
  if (
    typeof month !== "string" ||
    !/^(19\d{2}|20\d{2}|21\d{2}|2200)-(0[1-9]|1[0-2])$/.test(month)
  ) {
    throw invalid("Choose a valid month between 1900 and 2200.");
  }
  const [year, number] = month.split("-").map(Number);
  const iso = (date) => date.toISOString().slice(0, 10);
  return {
    month,
    today: today(),
    historyStart: iso(new Date(Date.UTC(year, number - 6, 1))),
    historyEnd: iso(new Date(Date.UTC(year, number, 0))),
    nextMonthStart: iso(new Date(Date.UTC(year, number, 1))),
  };
}

export function validateFinanceTransactionInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid("Enter a transaction.");
  const date = value.date;
  if (
    typeof date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    date < "1900-01-01" ||
    date > "2200-12-31"
  )
    throw invalid("Enter a valid transaction date.");
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== date
  )
    throw invalid("Enter a valid transaction date.");
  if (!["income", "expense"].includes(value.kind))
    throw invalid("Choose income or expense.");
  if (!CURRENCIES.has(value.currency))
    throw invalid("Choose USD or PHP for this transaction.");
  if (
    typeof value.amount !== "number" ||
    !Number.isFinite(value.amount) ||
    value.amount <= 0 ||
    value.amount > MAX_AMOUNT
  )
    throw invalid("Amount must be greater than zero and below one billion.");
  const amount = Math.round((value.amount + Number.EPSILON) * 100) / 100;
  if (amount <= 0) throw invalid("Amount must be at least 0.01.");
  const accountId =
    value.accountId === undefined ||
    value.accountId === null ||
    value.accountId === ""
      ? null
      : Number(value.accountId);
  if (
    accountId !== null &&
    (!Number.isSafeInteger(accountId) || accountId <= 0)
  )
    throw invalid("Choose a valid account.");
  const clean = (input, label, max, fallback = "") => {
    if (input === undefined || input === null) return fallback;
    if (typeof input !== "string" || input.length > max)
      throw invalid(`${label} must be text of at most ${max} characters.`);
    return input.trim().replace(/\s+/g, " ") || fallback;
  };
  const merchant = clean(value.merchant, "Description", 120);
  if (!merchant) throw invalid("Enter a transaction description.");
  return {
    date,
    kind: value.kind,
    amount,
    currency: value.currency,
    accountId,
    merchant,
    category: clean(value.category, "Category", 80, "Uncategorized"),
    note: clean(value.note, "Note", 300),
  };
}

export function financeProviderStatus(env = process.env) {
  const environment = String(env.PLAID_ENV || "sandbox").toLowerCase();
  const hasTokenSecret = Boolean(
    env.FINANCE_TOKEN_SECRET || env.AUTH_SECRET || env.NEXTAUTH_SECRET,
  );
  let brankasConfigured = false;
  try {
    const url = new URL(
      env.BRANKAS_LINK_URL || env.BRANKAS_STATIC_LINK_URL || "",
    );
    brankasConfigured = hasTokenSecret && url.protocol === "https:";
  } catch {
    /* Provider setup is optional. */
  }
  return {
    plaid: {
      configured: Boolean(
        hasTokenSecret &&
        env.PLAID_CLIENT_ID &&
        env.PLAID_SECRET &&
        ["sandbox", "development", "production"].includes(environment),
      ),
      environment,
    },
    brankas: { configured: brankasConfigured, syncSupported: false },
  };
}

export function mapFinanceActivityAccount(row) {
  const currency = String(row.currency || "USD").toUpperCase();
  if (!CURRENCIES.has(currency)) return null;
  const money = (value) =>
    value === null || value === undefined
      ? null
      : Math.round(Number(value) * 100) / 100;
  const isLinked = Boolean(row.external_provider && row.external_account_id);
  const liability = ["credit", "loan"].includes(row.account_type);
  const opening = Number(row.opening_balance || 0);
  const movement = Number(row.native_movement || 0);
  return {
    id: Number(row.id),
    name: row.name,
    type: row.account_type,
    currency,
    nativeCurrentBalance: isLinked
      ? money(row.current_balance)
      : money(opening + (liability ? -movement : movement)),
    nativeAvailableBalance: isLinked ? money(row.available_balance) : null,
    provider: row.external_provider || "",
    institutionName: row.institution_name || "",
    connectionId: row.connection_id ? Number(row.connection_id) : null,
    isLinked,
    mask: row.account_mask || "",
    officialName: row.official_name || "",
    isArchived: Boolean(row.is_archived || row.merged_into_account_id),
    isSyncExcluded: Boolean(row.is_sync_excluded),
    mergedIntoAccountId: row.merged_into_account_id
      ? Number(row.merged_into_account_id)
      : null,
    connectionStatus: row.connection_status || "",
    color: row.color || "#34d399",
  };
}
