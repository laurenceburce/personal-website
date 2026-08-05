import crypto from "node:crypto";
import mysql from "mysql2/promise";

export const FINANCE_OWNER_EMAIL = "laurenceburce@gmail.com";

export const FINANCE_ACCOUNT_TYPES = [
  "checking",
  "savings",
  "credit",
  "cash",
  "investment",
  "loan",
  "other"
];

export const FINANCE_DEFAULT_CATEGORIES = [
  "Income",
  "Bills",
  "Savings",
  "Subscriptions",
  "Groceries",
  "Dining",
  "Transportation",
  "Healthcare",
  "Family",
  "Debt",
  "Shopping",
  "Travel",
  "Entertainment",
  "PC Build",
  "Other",
  "Uncategorized"
];

const PLAN_DEFAULTS = {
  monthlyIncomeUsd: 2000,
  exchangeRate: 58,
  displayCurrency: "USD",
  biweeklyIncomeUsd: 1000,
  biweeklyBillsUsd: 400,
  biweeklySavingsUsd: 500
};

const STARTER_BILLS = [
  { name: "Google", amountUsd: 2, amountPhp: 116, dueLabel: "18", paymentAccount: "US Bank Credit", isAutopay: true },
  { name: "Microsoft", amountUsd: 10, amountPhp: 580, dueLabel: "7", paymentAccount: "US Bank Credit", isAutopay: true },
  { name: "Discord", amountUsd: 10, amountPhp: 580, dueLabel: "7", paymentAccount: "US Bank Credit", isAutopay: true },
  { name: "ChatGPT", amountUsd: 20, amountPhp: 1160, dueLabel: "28", paymentAccount: "US Bank Credit", isAutopay: true },
  { name: "Railway", amountUsd: 5, amountPhp: 290, dueLabel: "4", paymentAccount: "US Bank Credit", isAutopay: true },
  { name: "Namecheap", amountUsd: 1.5, amountPhp: 87, dueLabel: "4", paymentAccount: "US Bank Credit", isAutopay: true },
  { name: "Spotify", amountUsd: 2.91, amountPhp: 169, dueLabel: "28", paymentAccount: "GCash", isAutopay: true },
  { name: "Globe", amountUsd: 25.86, amountPhp: 1500, dueLabel: "11", paymentAccount: "RCBC Flex", isAutopay: true },
  { name: "Converge", amountUsd: 43.1, amountPhp: 2500, dueLabel: "28", paymentAccount: "", isAutopay: false },
  { name: "House", amountUsd: 689.66, amountPhp: 40000, dueLabel: "Saturday", paymentAccount: "", isAutopay: false }
];

const STARTER_GOALS = [
  {
    name: "PC Build - Phase 1",
    currency: "USD",
    targetAmount: 1400,
    savedAmount: 1320.4,
    category: "PC Build",
    note: "CPU, motherboard, and RAM."
  },
  {
    name: "PC Build - Phase 2",
    currency: "USD",
    targetAmount: 2850,
    savedAmount: 0,
    category: "PC Build",
    note: "GPU, main monitor, and PSU."
  },
  {
    name: "PC Build - Phase 3",
    currency: "USD",
    targetAmount: 1650,
    savedAmount: 140,
    category: "PC Build",
    note: "Extra monitors, case, and cooling."
  },
  {
    name: "PH Reserve",
    currency: "PHP",
    targetAmount: 500000,
    savedAmount: 77500,
    category: "Reserve",
    note: "Large one-time obligations reserve from the workbook."
  }
];

const ACCOUNT_TYPE_SET = new Set(FINANCE_ACCOUNT_TYPES);
const TRANSACTION_KIND_SET = new Set(["income", "expense"]);
const CURRENCY_SET = new Set(["USD", "PHP"]);
const DEFAULT_COLOR = "#34d399";
const EXCHANGE_RATE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const TOKEN_ALGORITHM = "aes-256-gcm";

let poolPromise = null;
let schemaReadyPromise = null;

const getDatabaseUrl = () => process.env.FINANCE_DATABASE_URL
  || process.env.DATABASE_URL
  || process.env.MYSQL_URL
  || process.env.MYSQL_PUBLIC_URL
  || "";
const isConfigured = () => Boolean(getDatabaseUrl());

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const getPool = async () => {
  if (!isConfigured()) return null;

  if (!poolPromise) {
    poolPromise = Promise.resolve(mysql.createPool({
      uri: getDatabaseUrl(),
      connectionLimit: 4,
      waitForConnections: true,
      enableKeepAlive: true
    }));
  }

  return poolPromise;
};

const runMigration = async (pool, sql) => {
  try {
    await pool.query(sql);
  } catch (err) {
    if (![1060, 1061, 1062].includes(err?.errno)) throw err;
  }
};

const ensureFinanceSchema = async () => {
  const pool = await getPool();
  if (!pool) return null;

  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS personal_finance_settings (
          setting_key VARCHAR(80) PRIMARY KEY,
          setting_value VARCHAR(500) NOT NULL,
          updated_at DATETIME(3) NOT NULL
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS personal_finance_connections (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          provider VARCHAR(32) NOT NULL,
          institution_id VARCHAR(120) NULL,
          institution_name VARCHAR(160) NOT NULL DEFAULT '',
          item_id VARCHAR(160) NULL,
          encrypted_access_token TEXT NULL,
          sync_cursor TEXT NULL,
          status VARCHAR(32) NOT NULL DEFAULT 'active',
          last_synced_at DATETIME(3) NULL,
          created_at DATETIME(3) NOT NULL,
          updated_at DATETIME(3) NOT NULL,
          UNIQUE KEY personal_finance_connections_item_idx (provider, item_id),
          INDEX personal_finance_connections_provider_idx (provider),
          INDEX personal_finance_connections_status_idx (status)
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS personal_finance_accounts (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(80) NOT NULL,
          account_type VARCHAR(32) NOT NULL DEFAULT 'checking',
          opening_balance DECIMAL(13,2) NOT NULL DEFAULT 0,
          currency CHAR(3) NOT NULL DEFAULT 'USD',
          current_balance DECIMAL(13,2) NULL,
          available_balance DECIMAL(13,2) NULL,
          external_provider VARCHAR(32) NULL,
          external_account_id VARCHAR(160) NULL,
          connection_id BIGINT UNSIGNED NULL,
          color VARCHAR(16) NOT NULL DEFAULT '#34d399',
          is_archived TINYINT(1) NOT NULL DEFAULT 0,
          created_at DATETIME(3) NOT NULL,
          updated_at DATETIME(3) NOT NULL,
          UNIQUE KEY personal_finance_accounts_external_idx (external_provider, external_account_id),
          INDEX personal_finance_accounts_connection_idx (connection_id),
          INDEX personal_finance_accounts_archived_idx (is_archived)
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS personal_finance_transactions (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          transaction_date DATE NOT NULL,
          kind VARCHAR(16) NOT NULL,
          account_id BIGINT UNSIGNED NULL,
          category VARCHAR(80) NOT NULL DEFAULT 'Uncategorized',
          merchant VARCHAR(120) NOT NULL DEFAULT '',
          note VARCHAR(300) NOT NULL DEFAULT '',
          amount DECIMAL(13,2) NOT NULL,
          currency CHAR(3) NOT NULL DEFAULT 'USD',
          external_provider VARCHAR(32) NULL,
          external_transaction_id VARCHAR(180) NULL,
          pending TINYINT(1) NOT NULL DEFAULT 0,
          created_at DATETIME(3) NOT NULL,
          updated_at DATETIME(3) NOT NULL,
          UNIQUE KEY personal_finance_transactions_external_idx (external_provider, external_transaction_id),
          INDEX personal_finance_transactions_date_idx (transaction_date DESC),
          INDEX personal_finance_transactions_kind_idx (kind),
          INDEX personal_finance_transactions_account_idx (account_id),
          INDEX personal_finance_transactions_category_idx (category)
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS personal_finance_budgets (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          budget_month CHAR(7) NOT NULL,
          category VARCHAR(80) NOT NULL,
          amount DECIMAL(13,2) NOT NULL,
          currency CHAR(3) NOT NULL DEFAULT 'USD',
          created_at DATETIME(3) NOT NULL,
          updated_at DATETIME(3) NOT NULL,
          UNIQUE KEY personal_finance_budgets_month_category_idx (budget_month, category)
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS personal_finance_recurring_bills (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(120) NOT NULL,
          amount_usd DECIMAL(13,2) NOT NULL DEFAULT 0,
          amount_php DECIMAL(13,2) NOT NULL DEFAULT 0,
          due_label VARCHAR(40) NOT NULL DEFAULT '',
          payment_account VARCHAR(80) NOT NULL DEFAULT '',
          is_paid TINYINT(1) NOT NULL DEFAULT 0,
          is_autopay TINYINT(1) NOT NULL DEFAULT 0,
          display_order INT NOT NULL DEFAULT 0,
          created_at DATETIME(3) NOT NULL,
          updated_at DATETIME(3) NOT NULL,
          UNIQUE KEY personal_finance_recurring_name_idx (name),
          INDEX personal_finance_recurring_due_idx (due_label)
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS personal_finance_goals (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(120) NOT NULL,
          currency CHAR(3) NOT NULL DEFAULT 'USD',
          target_amount DECIMAL(13,2) NOT NULL DEFAULT 0,
          saved_amount DECIMAL(13,2) NOT NULL DEFAULT 0,
          category VARCHAR(80) NOT NULL DEFAULT '',
          note VARCHAR(300) NOT NULL DEFAULT '',
          display_order INT NOT NULL DEFAULT 0,
          created_at DATETIME(3) NOT NULL,
          updated_at DATETIME(3) NOT NULL,
          UNIQUE KEY personal_finance_goals_name_idx (name)
        )
      `);

      await runMigration(pool, "ALTER TABLE personal_finance_transactions ADD COLUMN currency CHAR(3) NOT NULL DEFAULT 'USD'");
      await runMigration(pool, "ALTER TABLE personal_finance_budgets ADD COLUMN currency CHAR(3) NOT NULL DEFAULT 'USD'");
      await runMigration(pool, "ALTER TABLE personal_finance_accounts ADD COLUMN currency CHAR(3) NOT NULL DEFAULT 'USD'");
      await runMigration(pool, "ALTER TABLE personal_finance_accounts ADD COLUMN current_balance DECIMAL(13,2) NULL");
      await runMigration(pool, "ALTER TABLE personal_finance_accounts ADD COLUMN available_balance DECIMAL(13,2) NULL");
      await runMigration(pool, "ALTER TABLE personal_finance_accounts ADD COLUMN external_provider VARCHAR(32) NULL");
      await runMigration(pool, "ALTER TABLE personal_finance_accounts ADD COLUMN external_account_id VARCHAR(160) NULL");
      await runMigration(pool, "ALTER TABLE personal_finance_accounts ADD COLUMN connection_id BIGINT UNSIGNED NULL");
      await runMigration(pool, "ALTER TABLE personal_finance_accounts ADD UNIQUE KEY personal_finance_accounts_external_idx (external_provider, external_account_id)");
      await runMigration(pool, "ALTER TABLE personal_finance_accounts ADD INDEX personal_finance_accounts_connection_idx (connection_id)");
      await runMigration(pool, "ALTER TABLE personal_finance_transactions ADD COLUMN external_provider VARCHAR(32) NULL");
      await runMigration(pool, "ALTER TABLE personal_finance_transactions ADD COLUMN external_transaction_id VARCHAR(180) NULL");
      await runMigration(pool, "ALTER TABLE personal_finance_transactions ADD COLUMN pending TINYINT(1) NOT NULL DEFAULT 0");
      await runMigration(pool, "ALTER TABLE personal_finance_transactions ADD UNIQUE KEY personal_finance_transactions_external_idx (external_provider, external_transaction_id)");
    })();
  }

  await schemaReadyPromise;
  return pool;
};

function requirePool(pool) {
  if (!pool) throw appError("Finance database is not configured.", 503);
  return pool;
}

function cleanText(value, maxLength, fallback = "") {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  return (text || fallback).slice(0, maxLength);
}

function cleanKind(value) {
  const kind = String(value || "").toLowerCase();
  if (!TRANSACTION_KIND_SET.has(kind)) throw appError("Choose income or expense.");
  return kind;
}

function cleanAccountType(value) {
  const type = String(value || "").toLowerCase();
  return ACCOUNT_TYPE_SET.has(type) ? type : "checking";
}

function cleanCurrency(value) {
  const currency = String(value || "").toUpperCase();
  return CURRENCY_SET.has(currency) ? currency : "USD";
}

function cleanProvider(value) {
  const provider = String(value || "").toLowerCase().trim();
  if (!["plaid", "finverse"].includes(provider)) throw appError("Connection provider is invalid.");
  return provider;
}

function getTokenSecret() {
  const secret = process.env.FINANCE_TOKEN_SECRET
    || process.env.AUTH_SECRET
    || process.env.NEXTAUTH_SECRET
    || "";
  if (!secret) throw appError("FINANCE_TOKEN_SECRET or AUTH_SECRET is required for linked account storage.", 503);
  return crypto.createHash("sha256").update(secret).digest();
}

function encryptSecret(value) {
  const plainText = String(value || "");
  if (!plainText) return "";

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(TOKEN_ALGORITHM, getTokenSecret(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

function decryptSecret(value) {
  const encryptedValue = String(value || "");
  if (!encryptedValue) return "";

  const [ivText, tagText, encryptedText] = encryptedValue.split(".");
  if (!ivText || !tagText || !encryptedText) throw appError("Stored account token is invalid.", 500);

  const decipher = crypto.createDecipheriv(
    TOKEN_ALGORITHM,
    getTokenSecret(),
    Buffer.from(ivText, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

function stableFinanceUserId(value) {
  return `finance_${crypto
    .createHash("sha256")
    .update(String(value || FINANCE_OWNER_EMAIL).toLowerCase())
    .digest("hex")
    .slice(0, 32)}`;
}

function plaidBaseUrl() {
  const env = String(process.env.PLAID_ENV || "sandbox").toLowerCase();
  if (env === "production") return "https://production.plaid.com";
  if (env === "development") return "https://development.plaid.com";
  return "https://sandbox.plaid.com";
}

function requirePlaidConfig() {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!clientId || !secret) {
    throw appError("Plaid is not configured. Add PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV.", 503);
  }
  return { clientId, secret };
}

function finverseBaseUrl() {
  const env = String(process.env.FINVERSE_ENV || "sandbox").toLowerCase();
  const rawUrl = process.env.FINVERSE_LINK_URL
    || process.env.FINVERSE_BASE_URL
    || (env === "production" || env === "prod"
      ? "https://api.prod.finverse.net/"
      : "https://api.sandbox.finverse.net/");

  try {
    const url = new URL(rawUrl);
    if (!["https:", "http:"].includes(url.protocol)) throw new Error("Invalid protocol");
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw appError("FINVERSE_LINK_URL must be a valid Finverse API base URL.", 503);
  }
}

function requireFinverseConfig() {
  const clientId = process.env.FINVERSE_CLIENT_ID;
  const clientSecret = process.env.FINVERSE_CLIENT_SECRET;
  const redirectUri = process.env.FINVERSE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw appError("Finverse needs FINVERSE_CLIENT_ID, FINVERSE_CLIENT_SECRET, and FINVERSE_REDIRECT_URI.", 503);
  }

  return { clientId, clientSecret, redirectUri };
}

async function plaidRequest(endpoint, data = {}) {
  const { clientId, secret } = requirePlaidConfig();
  const response = await fetch(`${plaidBaseUrl()}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      secret,
      ...data
    })
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload?.error_code) {
    const message = payload?.error_message || payload?.display_message || "Plaid request failed.";
    throw appError(message, response.status || 502);
  }

  return payload;
}

function externalApiErrorMessage(payload, fallback) {
  if (!payload || typeof payload !== "object") return fallback;
  return payload?.error?.message
    || payload?.error?.details
    || payload?.error_description
    || payload?.error
    || payload?.message
    || fallback;
}

async function finverseRequest(endpoint, { body, accessToken = "", form = false } = {}) {
  const response = await fetch(`${finverseBaseUrl()}${endpoint}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
    },
    body: form ? body : JSON.stringify(body || {})
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw appError(externalApiErrorMessage(payload, "Finverse request failed."), response.status || 502);
  }

  return payload;
}

async function getFinverseCustomerAccessToken() {
  const { clientId, clientSecret } = requireFinverseConfig();
  const payload = await finverseRequest("/auth/customer/token", {
    body: {
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials"
    }
  });

  if (!payload?.access_token) throw appError("Finverse did not return a customer access token.", 502);
  return payload.access_token;
}

function mapProviderAccountType(type, subtype) {
  const normalized = String(subtype || type || "").toLowerCase();
  if (normalized.includes("checking")) return "checking";
  if (normalized.includes("savings")) return "savings";
  if (normalized.includes("credit")) return "credit";
  if (normalized.includes("investment") || normalized.includes("brokerage")) return "investment";
  if (normalized.includes("loan") || normalized.includes("mortgage")) return "loan";
  return "other";
}

function colorForProvider(provider) {
  return provider === "finverse" ? "#fbbf24" : "#22d3ee";
}

function cleanColor(value) {
  const color = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : DEFAULT_COLOR;
}

function cleanId(value, label = "ID") {
  if (value === "" || value == null) return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw appError(`${label} is invalid.`);
  return id;
}

function cleanDate(value) {
  const date = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw appError("Enter a valid date.");
  return date;
}

function cleanMonth(value, fallback = getCurrentMonth()) {
  const month = String(value || "").trim();
  if (/^\d{4}-\d{2}$/.test(month)) return month;
  return fallback;
}

function cleanSignedAmount(value, label = "Amount") {
  const amount = Number(value);
  if (!Number.isFinite(amount) || Math.abs(amount) > 999999999) {
    throw appError(`${label} must be a valid number.`);
  }

  return Math.round(amount * 100) / 100;
}

function cleanPositiveAmount(value, label = "Amount") {
  const amount = cleanSignedAmount(value, label);
  if (amount <= 0) throw appError(`${label} must be greater than zero.`);
  return amount;
}

function cleanOptionalAmount(value, label = "Amount") {
  if (value === "" || value == null) return 0;
  return cleanSignedAmount(value, label);
}

function cleanBoolean(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function toMoney(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
}

function formatDateOnly(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function settingNumber(settings, key, fallback) {
  const value = Number(settings[key]);
  return Number.isFinite(value) ? value : fallback;
}

function settingDate(settings, key) {
  const value = settings[key] ? new Date(settings[key]) : null;
  return value && !Number.isNaN(value.getTime()) ? value : null;
}

async function fetchUsdPhpRate() {
  const response = await fetch("https://api.frankfurter.dev/v2/rate/USD/PHP", {
    headers: { Accept: "application/json" },
    next: { revalidate: 60 * 60 * 12 }
  });

  if (!response.ok) throw appError("Unable to refresh USD/PHP exchange rate.", 502);

  const payload = await response.json();
  const rate = Number(payload?.rate);

  if (!Number.isFinite(rate) || rate <= 0) {
    throw appError("Exchange rate provider returned an invalid rate.", 502);
  }

  return {
    rate: toMoney(rate),
    date: cleanText(payload?.date, 20),
    source: "Frankfurter"
  };
}

async function refreshExchangeRateIfStale(pool, settings, force = false) {
  const updatedAt = settingDate(settings, "exchangeRateUpdatedAt");
  const isFresh = updatedAt && Date.now() - updatedAt.getTime() < EXCHANGE_RATE_MAX_AGE_MS;

  if (!force && isFresh) return settings;

  try {
    const rate = await fetchUsdPhpRate();
    const now = new Date().toISOString();
    await Promise.all([
      upsertSetting(pool, "exchangeRate", rate.rate),
      upsertSetting(pool, "exchangeRateUpdatedAt", now),
      upsertSetting(pool, "exchangeRateDate", rate.date),
      upsertSetting(pool, "exchangeRateSource", rate.source)
    ]);

    return {
      ...settings,
      exchangeRate: String(rate.rate),
      exchangeRateUpdatedAt: now,
      exchangeRateDate: rate.date,
      exchangeRateSource: rate.source
    };
  } catch (error) {
    if (force) throw error;
    return settings;
  }
}

export function getCurrentMonth() {
  return new Date().toISOString().slice(0, 7);
}

export function addMonths(month, offset) {
  const [year, monthIndex] = cleanMonth(month).split("-").map(Number);
  const date = new Date(Date.UTC(year, monthIndex - 1 + offset, 1));
  return date.toISOString().slice(0, 7);
}

function convertToUsd(amount, currency, exchangeRate) {
  const value = toMoney(amount);
  return currency === "PHP" ? toMoney(value / exchangeRate) : value;
}

function normalizeMatchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function hasTextMatch(first, second) {
  const left = normalizeMatchText(first);
  const right = normalizeMatchText(second);
  if (!left || !right) return false;
  if (left.includes(right) || right.includes(left)) return true;

  const rightTokens = right.split(" ").filter((token) => token.length >= 3);
  if (rightTokens.length === 0) return false;
  return rightTokens.every((token) => left.includes(token));
}

const MATCH_FEE_WORDS = new Set(["fee", "fees", "charge", "charges", "maintenance", "service"]);

function matchTokens(value) {
  return normalizeMatchText(value).split(" ").filter(Boolean);
}

function hasMatchToken(value, tokens) {
  return matchTokens(value).some((token) => tokens.has(token));
}

function billAllowsFeeTransaction(bill, transaction) {
  const transactionText = [transaction.merchant, transaction.note, transaction.category].filter(Boolean).join(" ");
  const transactionLooksLikeFee = hasMatchToken(transactionText, MATCH_FEE_WORDS);
  if (!transactionLooksLikeFee) return true;
  return hasMatchToken(bill.name, MATCH_FEE_WORDS);
}

function dueDayFromLabel(dueLabel) {
  const text = String(dueLabel || "").trim().toLowerCase();
  const exactDay = text.match(/^([1-9]|[12][0-9]|3[01])(?:st|nd|rd|th)?$/);
  const looseDay = text.match(/\b([1-9]|[12][0-9]|3[01])\b/);
  const day = Number(exactDay?.[1] || looseDay?.[1] || 0);
  return day >= 1 && day <= 31 ? day : null;
}

function billDueDateForMonth(dueLabel, month) {
  const day = dueDayFromLabel(dueLabel);
  if (!day) return null;

  const [year, monthNumber] = String(month || "").split("-").map(Number);
  if (!year || !monthNumber) return null;

  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return new Date(Date.UTC(year, monthNumber - 1, Math.min(day, lastDay), 12));
}

function distanceInDays(firstDate, secondDate) {
  if (!firstDate || !secondDate) return 0;
  return Math.abs(Math.round((firstDate.getTime() - secondDate.getTime()) / 86400000));
}

function transactionAmountUsd(transaction, exchangeRate) {
  return convertToUsd(transaction.amount, transaction.currency, exchangeRate);
}

function billAmountUsd(bill, exchangeRate) {
  const usd = toMoney(bill.amountUsd);
  if (usd > 0) return usd;
  return convertToUsd(bill.amountPhp, "PHP", exchangeRate);
}

function isCloseAmount(firstAmount, secondAmount) {
  const first = Math.abs(Number(firstAmount || 0));
  const second = Math.abs(Number(secondAmount || 0));
  if (!first || !second) return false;

  const tolerance = Math.max(0.25, Math.min(5, Math.min(first, second) * 0.05));
  return Math.abs(first - second) <= tolerance;
}

function scoreRecurringBillTransaction(bill, transaction, exchangeRate, month) {
  if (transaction.kind !== "expense" || transaction.pending) return null;

  const expectedAmountUsd = billAmountUsd(bill, exchangeRate);
  const actualAmountUsd = transactionAmountUsd(transaction, exchangeRate);
  const amountMatched = isCloseAmount(expectedAmountUsd, actualAmountUsd);

  const merchantText = [transaction.merchant, transaction.note, transaction.category].filter(Boolean).join(" ");
  const sourceText = [transaction.accountName, transaction.institutionName, transaction.provider].filter(Boolean).join(" ");
  const nameMatched = hasTextMatch(merchantText, bill.name);
  const sourceMatched = bill.paymentAccount ? hasTextMatch(sourceText, bill.paymentAccount) : false;

  if (!nameMatched || !billAllowsFeeTransaction(bill, transaction)) return null;

  const transactionDate = new Date(`${transaction.date}T12:00:00Z`);
  const dueDate = billDueDateForMonth(bill.dueLabel, month);
  const dateDistance = dueDate ? distanceInDays(transactionDate, dueDate) : 0;
  const dateScore = dueDate ? (dateDistance <= 7 ? 2 : dateDistance <= 14 ? 1 : -1) : 0;

  return {
    score: (nameMatched ? 5 : 0) + (amountMatched ? 2 : 0) + (sourceMatched ? 3 : 0) + dateScore,
    dateDistance,
    transaction
  };
}

function findRecurringBillMatch(bill, transactions, exchangeRate, month) {
  const matches = transactions
    .map((transaction) => scoreRecurringBillTransaction(bill, transaction, exchangeRate, month))
    .filter(Boolean)
    .sort((first, second) => second.score - first.score || first.dateDistance - second.dateDistance);

  return matches[0]?.transaction || null;
}

function attachRecurringBillMatches(recurringBills, transactions, exchangeRate, month) {
  const usedTransactionIds = new Set();

  return recurringBills.map((bill) => {
    const availableTransactions = transactions.filter((transaction) => !usedTransactionIds.has(transaction.id));
    const matchedTransaction = findRecurringBillMatch(bill, availableTransactions, exchangeRate, month);
    if (matchedTransaction) usedTransactionIds.add(matchedTransaction.id);

    const compactMatch = matchedTransaction
      ? {
          id: matchedTransaction.id,
          date: matchedTransaction.date,
          merchant: matchedTransaction.merchant || matchedTransaction.category,
          amount: matchedTransaction.amount,
          currency: matchedTransaction.currency,
          accountName: matchedTransaction.accountName,
          institutionName: matchedTransaction.institutionName,
          provider: matchedTransaction.provider
        }
      : null;

    return {
      ...bill,
      isManuallyPaid: bill.isPaid,
      isPaid: Boolean(bill.isPaid || compactMatch),
      paidSource: bill.isPaid ? "manual" : compactMatch ? "transaction" : "",
      matchedTransaction: compactMatch
    };
  });
}

function mapTransaction(row) {
  return {
    id: Number(row.id),
    date: formatDateOnly(row.transaction_date),
    kind: row.kind,
    accountId: row.account_id ? Number(row.account_id) : null,
    accountName: row.account_name || "",
    accountType: row.account_type || "",
    accountColor: row.account_color || DEFAULT_COLOR,
    institutionName: row.institution_name || "",
    category: row.category || "Uncategorized",
    merchant: row.merchant || "",
    note: row.note || "",
    amount: toMoney(row.amount),
    currency: row.currency || "USD",
    provider: row.external_provider || "",
    externalId: row.external_transaction_id || "",
    pending: Boolean(row.pending),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at)
  };
}

function mapConnection(row) {
  return {
    id: Number(row.id),
    provider: row.provider,
    institutionId: row.institution_id || "",
    institutionName: row.institution_name || row.provider,
    status: row.status || "active",
    lastSyncedAt: row.last_synced_at instanceof Date ? row.last_synced_at.toISOString() : row.last_synced_at || null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at)
  };
}

function buildEmptyDashboard(month) {
  return {
    configured: false,
    month,
    accounts: [],
    connections: [],
    transactions: [],
    allTransactions: [],
    budgets: [],
    recurringBills: [],
    goals: [],
    categories: FINANCE_DEFAULT_CATEGORIES,
    categorySpend: [],
    monthlySeries: [],
    starterAvailable: true,
    plan: {
      ...PLAN_DEFAULTS,
      monthlyIncomePhp: PLAN_DEFAULTS.monthlyIncomeUsd * PLAN_DEFAULTS.exchangeRate,
      biweeklyRemainingUsd: PLAN_DEFAULTS.biweeklyIncomeUsd - PLAN_DEFAULTS.biweeklyBillsUsd - PLAN_DEFAULTS.biweeklySavingsUsd,
      recurringUsd: 0,
      recurringPhp: 0,
      recurringRemainingUsd: PLAN_DEFAULTS.monthlyIncomeUsd,
      exchangeRateUpdatedAt: null,
      exchangeRateDate: "",
      exchangeRateSource: ""
    },
    summary: {
      incomeUsd: 0,
      expensesUsd: 0,
      netUsd: 0,
      budgetTotalUsd: 0,
      budgetUsedUsd: 0,
      budgetRemainingUsd: 0,
      totalBalanceUsd: 0,
      savingsRate: 0,
      unpaidBills: 0,
      dueSoonBills: 0
    }
  };
}

export async function getFinanceDashboard({ month } = {}) {
  const safeMonth = cleanMonth(month);
  const pool = await ensureFinanceSchema();
  if (!pool) return buildEmptyDashboard(safeMonth);

  const monthStart = `${safeMonth}-01`;
  const nextMonthStart = `${addMonths(safeMonth, 1)}-01`;
  const seriesStart = `${addMonths(safeMonth, -5)}-01`;

  const [
    settingsResult,
    connectionsResult,
    accountsResult,
    transactionsResult,
    allTransactionsResult,
    budgetsResult,
    recurringResult,
    goalsResult,
    categoriesResult,
    seriesResult
  ] = await Promise.all([
    pool.query("SELECT setting_key, setting_value FROM personal_finance_settings"),
    pool.query(`
      SELECT id, provider, institution_id, institution_name, status, last_synced_at, created_at, updated_at
      FROM personal_finance_connections
      ORDER BY updated_at DESC, id DESC
    `),
    pool.query(`
      SELECT
        a.id,
        a.name,
        a.account_type,
        a.opening_balance,
        a.currency,
        a.current_balance,
        a.available_balance,
        a.external_provider,
        a.external_account_id,
        a.connection_id,
        a.color,
        a.created_at,
        a.updated_at,
        c.institution_name,
        COALESCE(SUM(
          CASE
            WHEN t.kind = 'income' AND t.currency = 'USD' THEN t.amount
            WHEN t.kind = 'expense' AND t.currency = 'USD' THEN -t.amount
            ELSE 0
          END
        ), 0) AS transaction_usd,
        COALESCE(SUM(
          CASE
            WHEN t.kind = 'income' AND t.currency = 'PHP' THEN t.amount
            WHEN t.kind = 'expense' AND t.currency = 'PHP' THEN -t.amount
            ELSE 0
          END
        ), 0) AS transaction_php
      FROM personal_finance_accounts a
      LEFT JOIN personal_finance_connections c
        ON c.id = a.connection_id
      LEFT JOIN personal_finance_transactions t
        ON t.account_id = a.id
      WHERE a.is_archived = 0
      GROUP BY
        a.id,
        a.name,
        a.account_type,
        a.opening_balance,
        a.currency,
        a.current_balance,
        a.available_balance,
        a.external_provider,
        a.external_account_id,
        a.connection_id,
        a.color,
        a.created_at,
        a.updated_at,
        c.institution_name
      ORDER BY a.name ASC
    `),
    pool.query(`
      SELECT
        t.id,
        DATE_FORMAT(t.transaction_date, '%Y-%m-%d') AS transaction_date,
        t.kind,
        t.account_id,
        t.category,
        t.merchant,
        t.note,
        t.amount,
        t.currency,
        t.external_provider,
        t.external_transaction_id,
        t.pending,
        t.created_at,
        t.updated_at,
        a.name AS account_name,
        a.account_type AS account_type,
        a.color AS account_color,
        c.institution_name
      FROM personal_finance_transactions t
      LEFT JOIN personal_finance_accounts a
        ON a.id = t.account_id
      LEFT JOIN personal_finance_connections c
        ON c.id = a.connection_id
      WHERE t.transaction_date >= ?
        AND t.transaction_date < ?
      ORDER BY t.transaction_date DESC, t.id DESC
      LIMIT 500
    `, [monthStart, nextMonthStart]),
    pool.query(`
      SELECT
        t.id,
        DATE_FORMAT(t.transaction_date, '%Y-%m-%d') AS transaction_date,
        t.kind,
        t.account_id,
        t.category,
        t.merchant,
        t.note,
        t.amount,
        t.currency,
        t.external_provider,
        t.external_transaction_id,
        t.pending,
        t.created_at,
        t.updated_at,
        a.name AS account_name,
        a.account_type AS account_type,
        a.color AS account_color,
        c.institution_name
      FROM personal_finance_transactions t
      LEFT JOIN personal_finance_accounts a
        ON a.id = t.account_id
      LEFT JOIN personal_finance_connections c
        ON c.id = a.connection_id
      ORDER BY t.transaction_date DESC, t.id DESC
    `),
    pool.query(`
      SELECT id, budget_month, category, amount, currency, created_at, updated_at
      FROM personal_finance_budgets
      WHERE budget_month = ?
      ORDER BY category ASC
    `, [safeMonth]),
    pool.query(`
      SELECT id, name, amount_usd, amount_php, due_label, payment_account, is_paid, is_autopay, display_order, created_at, updated_at
      FROM personal_finance_recurring_bills
      ORDER BY display_order ASC, id ASC
    `),
    pool.query(`
      SELECT id, name, currency, target_amount, saved_amount, category, note, display_order, created_at, updated_at
      FROM personal_finance_goals
      ORDER BY display_order ASC, id ASC
    `),
    pool.query(`
      SELECT category FROM personal_finance_transactions WHERE category != '' GROUP BY category
      UNION
      SELECT category FROM personal_finance_budgets WHERE category != '' GROUP BY category
      UNION
      SELECT category FROM personal_finance_goals WHERE category != '' GROUP BY category
      ORDER BY category ASC
    `),
    pool.query(`
      SELECT
        DATE_FORMAT(transaction_date, '%Y-%m') AS budget_month,
        SUM(CASE
          WHEN kind = 'income' AND currency = 'USD' THEN amount
          ELSE 0
        END) AS income_usd,
        SUM(CASE
          WHEN kind = 'income' AND currency = 'PHP' THEN amount
          ELSE 0
        END) AS income_php,
        SUM(CASE
          WHEN kind = 'expense' AND currency = 'USD' THEN amount
          ELSE 0
        END) AS expenses_usd,
        SUM(CASE
          WHEN kind = 'expense' AND currency = 'PHP' THEN amount
          ELSE 0
        END) AS expenses_php
      FROM personal_finance_transactions
      WHERE transaction_date >= ?
        AND transaction_date < ?
      GROUP BY budget_month
      ORDER BY budget_month ASC
    `, [seriesStart, nextMonthStart])
  ]);

  const [settingsRows] = settingsResult;
  const [connectionRows] = connectionsResult;
  const [accountRows] = accountsResult;
  const [transactionRows] = transactionsResult;
  const [allTransactionRows] = allTransactionsResult;
  const [budgetRows] = budgetsResult;
  const [recurringRows] = recurringResult;
  const [goalRows] = goalsResult;
  const [categoryRows] = categoriesResult;
  const [seriesRows] = seriesResult;

  let settings = Object.fromEntries(settingsRows.map((row) => [row.setting_key, row.setting_value]));
  settings = await refreshExchangeRateIfStale(pool, settings);
  const exchangeRate = Math.max(1, settingNumber(settings, "exchangeRate", PLAN_DEFAULTS.exchangeRate));
  const displayCurrency = cleanCurrency(settings.displayCurrency || PLAN_DEFAULTS.displayCurrency);
  const plan = {
    monthlyIncomeUsd: settingNumber(settings, "monthlyIncomeUsd", PLAN_DEFAULTS.monthlyIncomeUsd),
    exchangeRate,
    displayCurrency,
    biweeklyIncomeUsd: settingNumber(settings, "biweeklyIncomeUsd", PLAN_DEFAULTS.biweeklyIncomeUsd),
    biweeklyBillsUsd: settingNumber(settings, "biweeklyBillsUsd", PLAN_DEFAULTS.biweeklyBillsUsd),
    biweeklySavingsUsd: settingNumber(settings, "biweeklySavingsUsd", PLAN_DEFAULTS.biweeklySavingsUsd),
    exchangeRateUpdatedAt: settings.exchangeRateUpdatedAt || null,
    exchangeRateDate: settings.exchangeRateDate || "",
    exchangeRateSource: settings.exchangeRateSource || ""
  };

  const connections = connectionRows.map(mapConnection);
  const accounts = accountRows.map((row) => {
    const openingBalance = toMoney(row.opening_balance);
    const transactionTotal = toMoney(toMoney(row.transaction_usd) + (toMoney(row.transaction_php) / exchangeRate));
    const currency = cleanCurrency(row.currency || "USD");
    const hasLinkedBalance = row.current_balance !== null && row.current_balance !== undefined;
    const nativeCurrentBalance = hasLinkedBalance ? toMoney(row.current_balance) : toMoney(openingBalance + transactionTotal);
    const nativeAvailableBalance = row.available_balance !== null && row.available_balance !== undefined
      ? toMoney(row.available_balance)
      : null;
    const isLiability = ["credit", "loan"].includes(row.account_type);
    const rawCurrentBalance = hasLinkedBalance
      ? convertToUsd(nativeCurrentBalance, currency, exchangeRate)
      : toMoney(openingBalance + transactionTotal);
    const currentBalance = isLiability ? toMoney(-Math.abs(rawCurrentBalance)) : toMoney(rawCurrentBalance);
    return {
      id: Number(row.id),
      name: row.name,
      type: row.account_type,
      openingBalance,
      transactionTotal,
      currentBalance,
      nativeCurrentBalance,
      availableBalance: nativeAvailableBalance === null ? null : convertToUsd(nativeAvailableBalance, currency, exchangeRate),
      nativeAvailableBalance,
      currency,
      provider: row.external_provider || "",
      externalAccountId: row.external_account_id || "",
      connectionId: row.connection_id ? Number(row.connection_id) : null,
      institutionName: row.institution_name || "",
      isLinked: Boolean(row.external_provider && row.external_account_id),
      color: row.color || DEFAULT_COLOR
    };
  });

  const transactions = transactionRows.map(mapTransaction);
  const allTransactions = allTransactionRows.map(mapTransaction);
  const budgets = budgetRows.map((row) => ({
    id: Number(row.id),
    month: row.budget_month,
    category: row.category,
    amount: toMoney(row.amount),
    currency: row.currency || "USD",
    amountUsd: convertToUsd(row.amount, row.currency || "USD", exchangeRate)
  }));

  const rawRecurringBills = recurringRows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    amountUsd: toMoney(row.amount_usd),
    amountPhp: toMoney(row.amount_php),
    dueLabel: row.due_label || "",
    paymentAccount: row.payment_account || "",
    isPaid: Boolean(row.is_paid),
    isAutopay: Boolean(row.is_autopay),
    displayOrder: Number(row.display_order || 0)
  }));
  const recurringBills = attachRecurringBillMatches(rawRecurringBills, transactions, exchangeRate, safeMonth);

  const goals = goalRows.map((row) => {
    const targetAmount = toMoney(row.target_amount);
    const savedAmount = toMoney(row.saved_amount);
    return {
      id: Number(row.id),
      name: row.name,
      currency: row.currency || "USD",
      targetAmount,
      savedAmount,
      category: row.category || "",
      note: row.note || "",
      displayOrder: Number(row.display_order || 0),
      remaining: toMoney(targetAmount - savedAmount),
      percent: targetAmount > 0 ? Math.min(999, Math.round((savedAmount / targetAmount) * 100)) : 0
    };
  });

  const incomeUsd = toMoney(transactions
    .filter((transaction) => transaction.kind === "income")
    .reduce((sum, transaction) => sum + convertToUsd(transaction.amount, transaction.currency, exchangeRate), 0));
  const expensesUsd = toMoney(transactions
    .filter((transaction) => transaction.kind === "expense")
    .reduce((sum, transaction) => sum + convertToUsd(transaction.amount, transaction.currency, exchangeRate), 0));
  const budgetTotalUsd = toMoney(budgets.reduce((sum, budget) => sum + budget.amountUsd, 0));

  const spendByCategory = {};
  for (const transaction of transactions) {
    if (transaction.kind !== "expense") continue;
    const category = transaction.category || "Uncategorized";
    spendByCategory[category] = toMoney((spendByCategory[category] || 0) + convertToUsd(transaction.amount, transaction.currency, exchangeRate));
  }

  const budgetByCategory = Object.fromEntries(budgets.map((budget) => [budget.category, budget]));
  const categoryNames = Array.from(new Set([
    ...budgets.map((budget) => budget.category),
    ...Object.keys(spendByCategory)
  ])).sort((a, b) => a.localeCompare(b));

  const categorySpend = categoryNames.map((category) => {
    const spent = toMoney(spendByCategory[category] || 0);
    const budget = budgetByCategory[category] || null;
    const budgetAmount = toMoney(budget?.amountUsd || 0);
    return {
      id: budget?.id || null,
      category,
      spentUsd: spent,
      budgetUsd: budgetAmount,
      remainingUsd: toMoney(budgetAmount - spent),
      percent: budgetAmount > 0 ? Math.min(999, Math.round((spent / budgetAmount) * 100)) : 0
    };
  });

  const allCategories = Array.from(new Set([
    ...FINANCE_DEFAULT_CATEGORIES,
    ...categoryRows.map((row) => row.category).filter(Boolean)
  ])).sort((a, b) => a.localeCompare(b));

  const seriesByMonth = Object.fromEntries(seriesRows.map((row) => [
    row.budget_month,
    {
      income: toMoney(toMoney(row.income_usd) + (toMoney(row.income_php) / exchangeRate)),
      expenses: toMoney(toMoney(row.expenses_usd) + (toMoney(row.expenses_php) / exchangeRate))
    }
  ]));

  const monthlySeries = Array.from({ length: 6 }, (_, index) => {
    const seriesMonth = addMonths(safeMonth, index - 5);
    const values = seriesByMonth[seriesMonth] || { income: 0, expenses: 0 };
    return {
      month: seriesMonth,
      incomeUsd: values.income,
      expensesUsd: values.expenses,
      netUsd: toMoney(values.income - values.expenses)
    };
  });

  const recurringUsd = toMoney(recurringBills.reduce((sum, bill) => sum + bill.amountUsd, 0));
  const recurringPhp = toMoney(recurringBills.reduce((sum, bill) => sum + bill.amountPhp, 0));
  const dueSoonBills = recurringBills.filter((bill) => {
    if (bill.isPaid) return false;
    const day = Number(bill.dueLabel);
    if (!Number.isInteger(day)) return false;
    const today = new Date();
    return day >= today.getDate() && day <= today.getDate() + 7;
  }).length;

  const enrichedPlan = {
    ...plan,
    monthlyIncomePhp: toMoney(plan.monthlyIncomeUsd * exchangeRate),
    biweeklyRemainingUsd: toMoney(plan.biweeklyIncomeUsd - plan.biweeklyBillsUsd - plan.biweeklySavingsUsd),
    recurringUsd,
    recurringPhp,
    recurringRemainingUsd: toMoney(plan.monthlyIncomeUsd - recurringUsd)
  };

  return {
    configured: true,
    month: safeMonth,
    accounts,
    connections,
    transactions,
    allTransactions,
    budgets,
    recurringBills,
    goals,
    categories: allCategories,
    categorySpend,
    monthlySeries,
    starterAvailable: recurringBills.length === 0 && goals.length === 0,
    plan: enrichedPlan,
    summary: {
      incomeUsd,
      expensesUsd,
      netUsd: toMoney(incomeUsd - expensesUsd),
      budgetTotalUsd,
      budgetUsedUsd: expensesUsd,
      budgetRemainingUsd: toMoney(budgetTotalUsd - expensesUsd),
      totalBalanceUsd: toMoney(accounts.reduce((sum, account) => sum + account.currentBalance, 0)),
      savingsRate: incomeUsd > 0 ? Math.round(((incomeUsd - expensesUsd) / incomeUsd) * 100) : 0,
      unpaidBills: recurringBills.filter((bill) => !bill.isPaid).length,
      dueSoonBills
    }
  };
}

async function upsertSetting(pool, key, value) {
  await pool.query(
    `INSERT INTO personal_finance_settings (setting_key, setting_value, updated_at)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       setting_value = VALUES(setting_value),
       updated_at = VALUES(updated_at)`,
    [key, String(value), new Date()]
  );
}

export async function updateFinancePlan(data) {
  const pool = requirePool(await ensureFinanceSchema());
  const values = {
    monthlyIncomeUsd: cleanPositiveAmount(data?.monthlyIncomeUsd, "Monthly income"),
    biweeklyIncomeUsd: cleanPositiveAmount(data?.biweeklyIncomeUsd, "Bi-weekly income"),
    biweeklyBillsUsd: cleanOptionalAmount(data?.biweeklyBillsUsd, "Bi-weekly bills"),
    biweeklySavingsUsd: cleanOptionalAmount(data?.biweeklySavingsUsd, "Bi-weekly savings")
  };

  await Promise.all(Object.entries(values).map(([key, value]) => upsertSetting(pool, key, value)));
  return values;
}

export async function updateFinanceDisplayCurrency(currency) {
  const pool = requirePool(await ensureFinanceSchema());
  const displayCurrency = cleanCurrency(currency);
  await upsertSetting(pool, "displayCurrency", displayCurrency);
  return { displayCurrency };
}

export async function refreshFinanceExchangeRate() {
  const pool = requirePool(await ensureFinanceSchema());
  const [settingsRows] = await pool.query("SELECT setting_key, setting_value FROM personal_finance_settings");
  const settings = Object.fromEntries(settingsRows.map((row) => [row.setting_key, row.setting_value]));
  const refreshed = await refreshExchangeRateIfStale(pool, settings, true);
  return {
    exchangeRate: Number(refreshed.exchangeRate),
    exchangeRateUpdatedAt: refreshed.exchangeRateUpdatedAt,
    exchangeRateDate: refreshed.exchangeRateDate,
    exchangeRateSource: refreshed.exchangeRateSource
  };
}

export async function seedFinanceStarter() {
  const pool = requirePool(await ensureFinanceSchema());
  const now = new Date();

  await Promise.all(Object.entries(PLAN_DEFAULTS).map(([key, value]) => upsertSetting(pool, key, value)));

  for (const [index, bill] of STARTER_BILLS.entries()) {
    await pool.query(
      `INSERT INTO personal_finance_recurring_bills
         (name, amount_usd, amount_php, due_label, payment_account, is_paid, is_autopay, display_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         amount_usd = VALUES(amount_usd),
         amount_php = VALUES(amount_php),
         due_label = VALUES(due_label),
         payment_account = VALUES(payment_account),
         is_autopay = VALUES(is_autopay),
         display_order = VALUES(display_order),
         updated_at = VALUES(updated_at)`,
      [
        bill.name,
        bill.amountUsd,
        bill.amountPhp,
        bill.dueLabel,
        bill.paymentAccount,
        bill.isAutopay ? 1 : 0,
        index + 1,
        now,
        now
      ]
    );
  }

  for (const [index, goal] of STARTER_GOALS.entries()) {
    await pool.query(
      `INSERT INTO personal_finance_goals
         (name, currency, target_amount, saved_amount, category, note, display_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         currency = VALUES(currency),
         target_amount = VALUES(target_amount),
         saved_amount = VALUES(saved_amount),
         category = VALUES(category),
         note = VALUES(note),
         display_order = VALUES(display_order),
         updated_at = VALUES(updated_at)`,
      [
        goal.name,
        goal.currency,
        goal.targetAmount,
        goal.savedAmount,
        goal.category,
        goal.note,
        index + 1,
        now,
        now
      ]
    );
  }

  return { bills: STARTER_BILLS.length, goals: STARTER_GOALS.length };
}

export async function createFinanceTransaction(data) {
  const pool = requirePool(await ensureFinanceSchema());
  const now = new Date();
  const transactionDate = cleanDate(data?.date);
  const kind = cleanKind(data?.kind);
  const accountId = cleanId(data?.accountId, "Account");
  const category = cleanText(data?.category, 80, "Uncategorized");
  const merchant = cleanText(data?.merchant, 120);
  const note = cleanText(data?.note, 300);
  const amount = cleanPositiveAmount(data?.amount);
  const currency = cleanCurrency(data?.currency);

  const [result] = await pool.query(
    `INSERT INTO personal_finance_transactions
       (transaction_date, kind, account_id, category, merchant, note, amount, currency, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [transactionDate, kind, accountId, category, merchant, note, amount, currency, now, now]
  );

  return { id: Number(result.insertId) };
}

export async function updateFinanceTransaction(id, data) {
  const pool = requirePool(await ensureFinanceSchema());
  const transactionId = cleanId(id, "Transaction");
  const transactionDate = cleanDate(data?.date);
  const kind = cleanKind(data?.kind);
  const accountId = cleanId(data?.accountId, "Account");
  const category = cleanText(data?.category, 80, "Uncategorized");
  const merchant = cleanText(data?.merchant, 120);
  const note = cleanText(data?.note, 300);
  const amount = cleanPositiveAmount(data?.amount);
  const currency = cleanCurrency(data?.currency);

  await pool.query(
    `UPDATE personal_finance_transactions
     SET transaction_date = ?,
         kind = ?,
         account_id = ?,
         category = ?,
         merchant = ?,
         note = ?,
         amount = ?,
         currency = ?,
         updated_at = ?
     WHERE id = ?`,
    [transactionDate, kind, accountId, category, merchant, note, amount, currency, new Date(), transactionId]
  );

  return { id: transactionId };
}

export async function deleteFinanceTransaction(id) {
  const pool = requirePool(await ensureFinanceSchema());
  const transactionId = cleanId(id, "Transaction");
  await pool.query("DELETE FROM personal_finance_transactions WHERE id = ?", [transactionId]);
  return { id: transactionId };
}

export async function createFinanceAccount(data) {
  const pool = requirePool(await ensureFinanceSchema());
  const now = new Date();
  const name = cleanText(data?.name, 80);
  if (!name) throw appError("Account name is required.");

  const accountType = cleanAccountType(data?.type);
  const openingBalance = cleanSignedAmount(data?.openingBalance || 0, "Opening balance");
  const color = cleanColor(data?.color);

  const [result] = await pool.query(
    `INSERT INTO personal_finance_accounts
       (name, account_type, opening_balance, color, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [name, accountType, openingBalance, color, now, now]
  );

  return { id: Number(result.insertId) };
}

export async function updateFinanceAccount(id, data) {
  const pool = requirePool(await ensureFinanceSchema());
  const accountId = cleanId(id, "Account");
  const name = cleanText(data?.name, 80);
  if (!name) throw appError("Account name is required.");

  const accountType = cleanAccountType(data?.type);
  const openingBalance = cleanSignedAmount(data?.openingBalance || 0, "Opening balance");
  const color = cleanColor(data?.color);

  await pool.query(
    `UPDATE personal_finance_accounts
     SET name = ?,
         account_type = ?,
         opening_balance = ?,
         color = ?,
         updated_at = ?
     WHERE id = ?`,
    [name, accountType, openingBalance, color, new Date(), accountId]
  );

  return { id: accountId };
}

export async function archiveFinanceAccount(id) {
  const pool = requirePool(await ensureFinanceSchema());
  const accountId = cleanId(id, "Account");
  await pool.query(
    "UPDATE personal_finance_accounts SET is_archived = 1, updated_at = ? WHERE id = ?",
    [new Date(), accountId]
  );
  return { id: accountId };
}

export async function upsertFinanceBudget(data) {
  const pool = requirePool(await ensureFinanceSchema());
  const now = new Date();
  const budgetMonth = cleanMonth(data?.month);
  const category = cleanText(data?.category, 80);
  if (!category) throw appError("Budget category is required.");

  const amount = cleanPositiveAmount(data?.amount, "Budget");
  const currency = cleanCurrency(data?.currency);

  const [result] = await pool.query(
    `INSERT INTO personal_finance_budgets
       (budget_month, category, amount, currency, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       amount = VALUES(amount),
       currency = VALUES(currency),
       updated_at = VALUES(updated_at)`,
    [budgetMonth, category, amount, currency, now, now]
  );

  return { id: Number(result.insertId || 0), month: budgetMonth, category };
}

export async function deleteFinanceBudget(id) {
  const pool = requirePool(await ensureFinanceSchema());
  const budgetId = cleanId(id, "Budget");
  await pool.query("DELETE FROM personal_finance_budgets WHERE id = ?", [budgetId]);
  return { id: budgetId };
}

export async function upsertFinanceBill(data) {
  const pool = requirePool(await ensureFinanceSchema());
  const now = new Date();
  const id = cleanId(data?.id, "Bill");
  const name = cleanText(data?.name, 120);
  if (!name) throw appError("Bill name is required.");

  const amountUsd = cleanOptionalAmount(data?.amountUsd, "USD amount");
  const amountPhp = cleanOptionalAmount(data?.amountPhp, "PHP amount");
  const dueLabel = cleanText(data?.dueLabel, 40);
  const paymentAccount = cleanText(data?.paymentAccount, 80);
  const isPaid = cleanBoolean(data?.isPaid);
  const isAutopay = cleanBoolean(data?.isAutopay);

  if (id) {
    await pool.query(
      `UPDATE personal_finance_recurring_bills
       SET name = ?,
           amount_usd = ?,
           amount_php = ?,
           due_label = ?,
           payment_account = ?,
           is_paid = ?,
           is_autopay = ?,
           updated_at = ?
       WHERE id = ?`,
      [name, amountUsd, amountPhp, dueLabel, paymentAccount, isPaid ? 1 : 0, isAutopay ? 1 : 0, now, id]
    );
    return { id };
  }

  const [result] = await pool.query(
    `INSERT INTO personal_finance_recurring_bills
       (name, amount_usd, amount_php, due_label, payment_account, is_paid, is_autopay, display_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 999, ?, ?)
     ON DUPLICATE KEY UPDATE
       amount_usd = VALUES(amount_usd),
       amount_php = VALUES(amount_php),
       due_label = VALUES(due_label),
       payment_account = VALUES(payment_account),
       is_paid = VALUES(is_paid),
       is_autopay = VALUES(is_autopay),
       updated_at = VALUES(updated_at)`,
    [name, amountUsd, amountPhp, dueLabel, paymentAccount, isPaid ? 1 : 0, isAutopay ? 1 : 0, now, now]
  );

  return { id: Number(result.insertId || 0) };
}

export async function toggleFinanceBillPaid(id, isPaid) {
  const pool = requirePool(await ensureFinanceSchema());
  const billId = cleanId(id, "Bill");
  await pool.query(
    "UPDATE personal_finance_recurring_bills SET is_paid = ?, updated_at = ? WHERE id = ?",
    [cleanBoolean(isPaid) ? 1 : 0, new Date(), billId]
  );
  return { id: billId };
}

export async function deleteFinanceBill(id) {
  const pool = requirePool(await ensureFinanceSchema());
  const billId = cleanId(id, "Bill");
  await pool.query("DELETE FROM personal_finance_recurring_bills WHERE id = ?", [billId]);
  return { id: billId };
}

export async function upsertFinanceGoal(data) {
  const pool = requirePool(await ensureFinanceSchema());
  const now = new Date();
  const id = cleanId(data?.id, "Goal");
  const name = cleanText(data?.name, 120);
  if (!name) throw appError("Goal name is required.");

  const currency = cleanCurrency(data?.currency);
  const targetAmount = cleanPositiveAmount(data?.targetAmount, "Goal target");
  const savedAmount = cleanOptionalAmount(data?.savedAmount, "Saved amount");
  const category = cleanText(data?.category, 80);
  const note = cleanText(data?.note, 300);

  if (id) {
    await pool.query(
      `UPDATE personal_finance_goals
       SET name = ?,
           currency = ?,
           target_amount = ?,
           saved_amount = ?,
           category = ?,
           note = ?,
           updated_at = ?
       WHERE id = ?`,
      [name, currency, targetAmount, savedAmount, category, note, now, id]
    );
    return { id };
  }

  const [result] = await pool.query(
    `INSERT INTO personal_finance_goals
       (name, currency, target_amount, saved_amount, category, note, display_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 999, ?, ?)
     ON DUPLICATE KEY UPDATE
       currency = VALUES(currency),
       target_amount = VALUES(target_amount),
       saved_amount = VALUES(saved_amount),
       category = VALUES(category),
       note = VALUES(note),
       updated_at = VALUES(updated_at)`,
    [name, currency, targetAmount, savedAmount, category, note, now, now]
  );

  return { id: Number(result.insertId || 0) };
}

export async function deleteFinanceGoal(id) {
  const pool = requirePool(await ensureFinanceSchema());
  const goalId = cleanId(id, "Goal");
  await pool.query("DELETE FROM personal_finance_goals WHERE id = ?", [goalId]);
  return { id: goalId };
}

export async function createPlaidLinkToken(email) {
  requirePlaidConfig();

  const products = String(process.env.PLAID_PRODUCTS || "transactions")
    .split(",")
    .map((product) => product.trim())
    .filter(Boolean);
  const countryCodes = String(process.env.PLAID_COUNTRY_CODES || "US")
    .split(",")
    .map((country) => country.trim().toUpperCase())
    .filter(Boolean);
  const body = {
    client_name: process.env.PLAID_CLIENT_NAME || "Laurence Finance",
    language: "en",
    products,
    country_codes: countryCodes,
    user: {
      client_user_id: stableFinanceUserId(email)
    },
    account_filters: {
      depository: { account_subtypes: ["checking", "savings"] },
      credit: { account_subtypes: ["credit card"] }
    }
  };

  if (process.env.PLAID_REDIRECT_URI) body.redirect_uri = process.env.PLAID_REDIRECT_URI;

  const payload = await plaidRequest("/link/token/create", body);
  return {
    linkToken: payload.link_token,
    expiration: payload.expiration || null,
    environment: String(process.env.PLAID_ENV || "sandbox").toLowerCase()
  };
}

export async function exchangePlaidPublicToken(data) {
  const pool = requirePool(await ensureFinanceSchema());
  const publicToken = cleanText(data?.publicToken, 800);
  if (!publicToken) throw appError("Plaid public token is missing.");

  const metadata = data?.metadata || {};
  const institution = metadata?.institution || {};
  const exchanged = await plaidRequest("/item/public_token/exchange", {
    public_token: publicToken
  });

  const accessToken = exchanged?.access_token;
  const itemId = cleanText(exchanged?.item_id, 160);
  if (!accessToken || !itemId) throw appError("Plaid did not return a usable account token.", 502);

  const now = new Date();
  const provider = "plaid";
  const institutionId = cleanText(institution?.institution_id || metadata?.institution_id, 120);
  const institutionName = cleanText(institution?.name || metadata?.institution_name || "Plaid account", 160, "Plaid account");

  const [result] = await pool.query(
    `INSERT INTO personal_finance_connections
       (provider, institution_id, institution_name, item_id, encrypted_access_token, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
     ON DUPLICATE KEY UPDATE
       institution_id = VALUES(institution_id),
       institution_name = VALUES(institution_name),
       encrypted_access_token = VALUES(encrypted_access_token),
       status = 'active',
       updated_at = VALUES(updated_at)`,
    [provider, institutionId || null, institutionName, itemId, encryptSecret(accessToken), now, now]
  );

  const insertedConnectionId = Number(result.insertId || 0);
  const connectionId = insertedConnectionId || await getConnectionIdByItem(pool, provider, itemId);
  const synced = await syncPlaidConnection(pool, connectionId, accessToken);
  return { id: connectionId, ...synced };
}

export async function syncFinanceConnection(id) {
  const pool = requirePool(await ensureFinanceSchema());
  const connectionId = cleanId(id, "Connection");
  const [rows] = await pool.query(
    `SELECT id, provider, encrypted_access_token, sync_cursor
     FROM personal_finance_connections
     WHERE id = ?
     LIMIT 1`,
    [connectionId]
  );
  const connection = rows[0];
  if (!connection) throw appError("Connection was not found.", 404);

  const provider = cleanProvider(connection.provider);
  if (provider === "plaid") return syncPlaidConnection(pool, connectionId);

  throw appError("Finverse sync needs your Finverse app credentials and endpoint details before it can pull balances and transactions.", 503);
}

export async function createFinverseLink(email) {
  const { clientId, redirectUri } = requireFinverseConfig();
  const customerAccessToken = await getFinverseCustomerAccessToken();
  const countries = String(process.env.FINVERSE_COUNTRIES || "PHL")
    .split(",")
    .map((country) => country.trim().toUpperCase())
    .filter(Boolean);
  const productsRequested = String(process.env.FINVERSE_PRODUCTS || "ACCOUNTS,TRANSACTIONS")
    .split(",")
    .map((product) => product.trim().toUpperCase())
    .filter(Boolean);

  const payload = await finverseRequest("/link/token", {
    accessToken: customerAccessToken,
    body: {
      client_id: clientId,
      user_id: stableFinanceUserId(email),
      redirect_uri: redirectUri,
      state: crypto.randomBytes(16).toString("hex"),
      response_mode: "query",
      response_type: "code",
      grant_type: "client_credentials",
      ui_mode: "redirect",
      countries,
      products_requested: productsRequested
    }
  });

  if (!payload?.link_url) throw appError("Finverse did not return a Link URL.", 502);

  return {
    url: payload.link_url,
    expiresIn: payload.expires_in || null
  };
}

export async function exchangeFinverseAuthorizationCode(code) {
  const pool = requirePool(await ensureFinanceSchema());
  const authorizationCode = cleanText(code, 800);
  const { clientId, redirectUri } = requireFinverseConfig();

  if (!authorizationCode) throw appError("Finverse authorization code is missing.");
  const customerAccessToken = await getFinverseCustomerAccessToken();

  const body = new URLSearchParams({
    client_id: clientId,
    code: authorizationCode,
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  });

  const payload = await finverseRequest("/auth/token", {
    accessToken: customerAccessToken,
    form: true,
    body
  });

  const token = payload?.access_token
    || payload?.login_identity_token
    || payload?.token
    || payload?.id_token
    || "";
  if (!token) throw appError("Finverse did not return a token payload the app can store.", 502);

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex").slice(0, 48);
  const itemId = cleanText(
    payload?.login_identity_id
      || payload?.login_identity?.id
      || payload?.customer_id
      || tokenHash,
    160,
    tokenHash
  );
  const institutionName = cleanText(payload?.institution_name || payload?.bank_name || "Finverse", 160, "Finverse");
  const now = new Date();

  const [result] = await pool.query(
    `INSERT INTO personal_finance_connections
       (provider, institution_name, item_id, encrypted_access_token, status, created_at, updated_at)
     VALUES ('finverse', ?, ?, ?, 'linked', ?, ?)
     ON DUPLICATE KEY UPDATE
       institution_name = VALUES(institution_name),
       encrypted_access_token = VALUES(encrypted_access_token),
       status = 'linked',
       updated_at = VALUES(updated_at)`,
    [institutionName, itemId, encryptSecret(JSON.stringify(payload)), now, now]
  );

  const insertedConnectionId = Number(result.insertId || 0);
  const connectionId = insertedConnectionId || await getConnectionIdByItem(pool, "finverse", itemId);
  return { id: connectionId, status: "linked" };
}

async function getConnectionIdByItem(pool, provider, itemId) {
  const [rows] = await pool.query(
    "SELECT id FROM personal_finance_connections WHERE provider = ? AND item_id = ? LIMIT 1",
    [provider, itemId]
  );
  return Number(rows[0]?.id || 0);
}

async function getAccountIdByProvider(pool, provider, accountId) {
  const [rows] = await pool.query(
    "SELECT id FROM personal_finance_accounts WHERE external_provider = ? AND external_account_id = ? LIMIT 1",
    [provider, accountId]
  );
  return Number(rows[0]?.id || 0);
}

async function syncPlaidConnection(pool, connectionId, accessTokenOverride = "") {
  const [connectionRows] = await pool.query(
    `SELECT id, institution_name, encrypted_access_token, sync_cursor
     FROM personal_finance_connections
     WHERE id = ?
     LIMIT 1`,
    [connectionId]
  );
  const connection = connectionRows[0];
  if (!connection) throw appError("Plaid connection was not found.", 404);

  const accessToken = accessTokenOverride || decryptSecret(connection.encrypted_access_token);
  const accountSync = await syncPlaidAccounts(pool, connectionId, accessToken, connection.institution_name || "Plaid");
  let transactionSync = { added: 0, modified: 0, removed: 0 };

  try {
    transactionSync = await syncPlaidTransactions(pool, connectionId, accessToken, connection.sync_cursor || null);
    await pool.query(
      "UPDATE personal_finance_connections SET status = 'active', last_synced_at = ?, updated_at = ? WHERE id = ?",
      [new Date(), new Date(), connectionId]
    );
  } catch (error) {
    await pool.query(
      "UPDATE personal_finance_connections SET status = 'needs_sync', updated_at = ? WHERE id = ?",
      [new Date(), connectionId]
    );
    throw error;
  }

  return {
    accounts: accountSync.accounts,
    transactions: transactionSync
  };
}

async function syncPlaidAccounts(pool, connectionId, accessToken, fallbackInstitutionName) {
  const payload = await plaidRequest("/accounts/balance/get", {
    access_token: accessToken
  });
  const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
  const now = new Date();
  let saved = 0;

  if (payload?.item?.institution_id) {
    await pool.query(
      `UPDATE personal_finance_connections
       SET institution_id = COALESCE(institution_id, ?),
           updated_at = ?
       WHERE id = ?`,
      [cleanText(payload.item.institution_id, 120), now, connectionId]
    );
  }

  for (const account of accounts) {
    const balances = account?.balances || {};
    const externalAccountId = cleanText(account?.account_id, 160);
    if (!externalAccountId) continue;

    const currency = cleanCurrency(balances?.iso_currency_code || "USD");
    const name = cleanText(account?.official_name || account?.name || fallbackInstitutionName, 80, fallbackInstitutionName);
    const accountType = mapProviderAccountType(account?.type, account?.subtype);
    const currentBalance = toMoney(balances?.current ?? 0);
    const availableBalance = balances?.available === null || balances?.available === undefined
      ? null
      : toMoney(balances.available);

    await pool.query(
      `INSERT INTO personal_finance_accounts
         (name, account_type, opening_balance, currency, current_balance, available_balance, external_provider, external_account_id, connection_id, color, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?, ?, 'plaid', ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         account_type = VALUES(account_type),
         currency = VALUES(currency),
         current_balance = VALUES(current_balance),
         available_balance = VALUES(available_balance),
         connection_id = VALUES(connection_id),
         color = VALUES(color),
         is_archived = 0,
         updated_at = VALUES(updated_at)`,
      [
        name,
        accountType,
        currency,
        currentBalance,
        availableBalance,
        externalAccountId,
        connectionId,
        colorForProvider("plaid"),
        now,
        now
      ]
    );
    saved += 1;
  }

  return { accounts: saved };
}

async function syncPlaidTransactions(pool, connectionId, accessToken, cursor) {
  let nextCursor = cursor || null;
  let hasMore = true;
  let added = 0;
  let modified = 0;
  let removed = 0;

  while (hasMore) {
    const payload = await plaidRequest("/transactions/sync", {
      access_token: accessToken,
      cursor: nextCursor,
      count: 500
    });

    for (const transaction of [...(payload.added || []), ...(payload.modified || [])]) {
      const wasModified = (payload.modified || []).some((item) => item.transaction_id === transaction.transaction_id);
      await upsertPlaidTransaction(pool, transaction);
      if (wasModified) modified += 1;
      else added += 1;
    }

    for (const transaction of payload.removed || []) {
      const externalTransactionId = cleanText(transaction?.transaction_id, 180);
      if (!externalTransactionId) continue;
      await pool.query(
        "DELETE FROM personal_finance_transactions WHERE external_provider = 'plaid' AND external_transaction_id = ?",
        [externalTransactionId]
      );
      removed += 1;
    }

    nextCursor = payload.next_cursor || nextCursor;
    hasMore = Boolean(payload.has_more);
  }

  await pool.query(
    "UPDATE personal_finance_connections SET sync_cursor = ?, last_synced_at = ?, updated_at = ? WHERE id = ?",
    [nextCursor, new Date(), new Date(), connectionId]
  );

  return { added, modified, removed };
}

async function upsertPlaidTransaction(pool, transaction) {
  const externalTransactionId = cleanText(transaction?.transaction_id, 180);
  if (!externalTransactionId) return;

  const externalAccountId = cleanText(transaction?.account_id, 160);
  const accountId = externalAccountId ? await getAccountIdByProvider(pool, "plaid", externalAccountId) : null;
  const plaidAmount = Number(transaction?.amount || 0);
  const kind = plaidAmount < 0 ? "income" : "expense";
  const category = cleanText(
    humanizeCategory(transaction?.personal_finance_category?.primary)
      || transaction?.category?.[0]
      || transaction?.category
      || "Uncategorized",
    80,
    "Uncategorized"
  );
  const merchant = cleanText(transaction?.merchant_name || transaction?.name || "", 120);
  const amount = toMoney(Math.abs(plaidAmount));
  const currency = cleanCurrency(transaction?.iso_currency_code || "USD");
  const date = cleanDate(transaction?.date || new Date().toISOString().slice(0, 10));
  const now = new Date();

  await pool.query(
    `INSERT INTO personal_finance_transactions
       (transaction_date, kind, account_id, category, merchant, note, amount, currency, external_provider, external_transaction_id, pending, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '', ?, ?, 'plaid', ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       transaction_date = VALUES(transaction_date),
       kind = VALUES(kind),
       account_id = VALUES(account_id),
       category = VALUES(category),
       merchant = VALUES(merchant),
       amount = VALUES(amount),
       currency = VALUES(currency),
       pending = VALUES(pending),
       updated_at = VALUES(updated_at)`,
    [
      date,
      kind,
      accountId || null,
      category,
      merchant,
      amount,
      currency,
      externalTransactionId,
      transaction?.pending ? 1 : 0,
      now,
      now
    ]
  );
}

function humanizeCategory(value) {
  const category = String(value || "").trim();
  if (!category) return "";
  return category
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
