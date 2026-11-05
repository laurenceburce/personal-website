import crypto from "node:crypto";
import mysql from "mysql2/promise";
import {
  financeActivityWindow,
  financeProviderStatus,
  mapFinanceActivityAccount,
  normalizeFinanceCreditCardDue,
  validateFinanceTransactionInput,
} from "./financeActivity.mjs";
import { financePlanActivityRange } from "./financePlanActivity.mjs";
import {
  financeAccountDuplicateGroups,
  findFinanceAccountIdentityMatch,
  financeTransactionDuplicatePairs,
  remapFinancePlannerAccountIds,
  confirmedFinanceAccountGroups,
} from "./financeAccountIdentity.mjs";

export const FINANCE_OWNER_EMAIL = "laurenceburce@gmail.com";
export const FINANCE_BRANKAS_STATE_COOKIE = "finance_brankas_state";

export const FINANCE_ACCOUNT_TYPES = [
  "checking",
  "savings",
  "credit",
  "cash",
  "investment",
  "loan",
  "other",
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
  "Uncategorized",
];

const PLAN_DEFAULTS = {
  monthlyIncomeUsd: 2000,
  exchangeRate: 58,
  displayCurrency: "USD",
  biweeklyIncomeUsd: 1000,
  biweeklyBillsUsd: 400,
  biweeklySavingsUsd: 500,
};

const STARTER_BILLS = [
  {
    name: "Google",
    amountUsd: 2,
    amountPhp: 116,
    dueLabel: "18",
    paymentAccount: "US Bank Credit",
    isAutopay: true,
  },
  {
    name: "Microsoft",
    amountUsd: 10,
    amountPhp: 580,
    dueLabel: "7",
    paymentAccount: "US Bank Credit",
    isAutopay: true,
  },
  {
    name: "Discord",
    amountUsd: 10,
    amountPhp: 580,
    dueLabel: "7",
    paymentAccount: "US Bank Credit",
    isAutopay: true,
  },
  {
    name: "ChatGPT",
    amountUsd: 20,
    amountPhp: 1160,
    dueLabel: "28",
    paymentAccount: "US Bank Credit",
    isAutopay: true,
  },
  {
    name: "Railway",
    amountUsd: 5,
    amountPhp: 290,
    dueLabel: "4",
    paymentAccount: "US Bank Credit",
    isAutopay: true,
  },
  {
    name: "Namecheap",
    amountUsd: 1.5,
    amountPhp: 87,
    dueLabel: "4",
    paymentAccount: "US Bank Credit",
    isAutopay: true,
  },
  {
    name: "Spotify",
    amountUsd: 2.91,
    amountPhp: 169,
    dueLabel: "28",
    paymentAccount: "GCash",
    isAutopay: true,
  },
  {
    name: "Globe",
    amountUsd: 25.86,
    amountPhp: 1500,
    dueLabel: "11",
    paymentAccount: "RCBC Flex",
    isAutopay: true,
  },
  {
    name: "Converge",
    amountUsd: 43.1,
    amountPhp: 2500,
    dueLabel: "28",
    paymentAccount: "",
    isAutopay: false,
  },
  {
    name: "House",
    amountUsd: 689.66,
    amountPhp: 40000,
    dueLabel: "Saturday",
    paymentAccount: "",
    isAutopay: false,
  },
];

const STARTER_GOALS = [
  {
    name: "PC Build - Phase 1",
    currency: "USD",
    targetAmount: 1400,
    savedAmount: 1320.4,
    category: "PC Build",
    note: "CPU, motherboard, and RAM.",
  },
  {
    name: "PC Build - Phase 2",
    currency: "USD",
    targetAmount: 2850,
    savedAmount: 0,
    category: "PC Build",
    note: "GPU, main monitor, and PSU.",
  },
  {
    name: "PC Build - Phase 3",
    currency: "USD",
    targetAmount: 1650,
    savedAmount: 140,
    category: "PC Build",
    note: "Extra monitors, case, and cooling.",
  },
  {
    name: "PH Reserve",
    currency: "PHP",
    targetAmount: 500000,
    savedAmount: 77500,
    category: "Reserve",
    note: "Large one-time obligations reserve from the workbook.",
  },
];

const ACCOUNT_TYPE_SET = new Set(FINANCE_ACCOUNT_TYPES);
const TRANSACTION_KIND_SET = new Set(["income", "expense"]);
const CURRENCY_SET = new Set(["USD", "PHP"]);
const DEFAULT_COLOR = "#34d399";
const EXCHANGE_RATE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const TOKEN_ALGORITHM = "aes-256-gcm";
const PLAN_BANK_REFRESH_COOLDOWN_MS = 60_000;

let poolPromise = null;
let schemaReadyPromise = null;
let planBankRefreshPromise = null;
let planBankRefreshResult = null;
let planBankRefreshCompletedAt = 0;

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
    poolPromise = Promise.resolve(
      mysql.createPool({
        uri: getDatabaseUrl(),
        connectionLimit: 4,
        connectTimeout: 5000,
        waitForConnections: true,
        enableKeepAlive: true,
      }),
    );
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
          credit_card_due_json LONGTEXT NULL,
          credit_card_due_status VARCHAR(16) NOT NULL DEFAULT 'unavailable',
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

      await runMigration(
        pool,
        "ALTER TABLE personal_finance_transactions ADD COLUMN currency CHAR(3) NOT NULL DEFAULT 'USD'",
      );
      await runMigration(
        pool,
        "ALTER TABLE personal_finance_budgets ADD COLUMN currency CHAR(3) NOT NULL DEFAULT 'USD'",
      );
      await runMigration(
        pool,
        "ALTER TABLE personal_finance_accounts ADD COLUMN currency CHAR(3) NOT NULL DEFAULT 'USD'",
      );
      await runMigration(
        pool,
        "ALTER TABLE personal_finance_accounts ADD COLUMN current_balance DECIMAL(13,2) NULL",
      );
      await runMigration(
        pool,
        "ALTER TABLE personal_finance_accounts ADD COLUMN available_balance DECIMAL(13,2) NULL",
      );
      await runMigration(
        pool,
        "ALTER TABLE personal_finance_accounts ADD COLUMN credit_card_due_json LONGTEXT NULL",
      );
      await runMigration(
        pool,
        "ALTER TABLE personal_finance_accounts ADD COLUMN credit_card_due_status VARCHAR(16) NOT NULL DEFAULT 'unavailable'",
      );
      await runMigration(
        pool,
        "ALTER TABLE personal_finance_accounts ADD COLUMN external_provider VARCHAR(32) NULL",
      );
      await runMigration(
        pool,
        "ALTER TABLE personal_finance_accounts ADD COLUMN external_account_id VARCHAR(160) NULL",
      );
      await runMigration(
        pool,
        "ALTER TABLE personal_finance_accounts ADD COLUMN connection_id BIGINT UNSIGNED NULL",
      );
      await runMigration(
        pool,
        "ALTER TABLE personal_finance_accounts ADD COLUMN account_mask VARCHAR(16) NULL",
      );
      await runMigration(
        pool,
        "ALTER TABLE personal_finance_accounts ADD COLUMN official_name VARCHAR(160) NULL",
      );
      await runMigration(
        pool,
        "ALTER TABLE personal_finance_accounts ADD COLUMN persistent_account_id VARCHAR(160) NULL",
      );
      await runMigration(
        pool,
        "ALTER TABLE personal_finance_accounts ADD COLUMN is_sync_excluded TINYINT(1) NOT NULL DEFAULT 0",
      );
      await runMigration(
        pool,
        "ALTER TABLE personal_finance_accounts ADD COLUMN merged_into_account_id BIGINT UNSIGNED NULL",
      );
      await pool.query(`CREATE TABLE IF NOT EXISTS personal_finance_account_aliases (
        provider VARCHAR(32) NOT NULL, external_account_id VARCHAR(160) NOT NULL,
        account_id BIGINT UNSIGNED NOT NULL, connection_id BIGINT UNSIGNED NULL,
        created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
        PRIMARY KEY(provider, external_account_id), INDEX(account_id), INDEX(connection_id)
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS personal_finance_account_merges (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, source_account_id BIGINT UNSIGNED NOT NULL,
        canonical_account_id BIGINT UNSIGNED NOT NULL, identity_reason VARCHAR(80) NOT NULL,
        account_snapshot LONGTEXT NOT NULL, merged_at DATETIME(3) NOT NULL
      )`);
      await runMigration(
        pool,
        "ALTER TABLE personal_finance_accounts ADD UNIQUE KEY personal_finance_accounts_external_idx (external_provider, external_account_id)",
      );
      await runMigration(
        pool,
        "ALTER TABLE personal_finance_accounts ADD INDEX personal_finance_accounts_connection_idx (connection_id)",
      );
      await runMigration(
        pool,
        "ALTER TABLE personal_finance_transactions ADD COLUMN external_provider VARCHAR(32) NULL",
      );
      await runMigration(
        pool,
        "ALTER TABLE personal_finance_transactions ADD COLUMN external_transaction_id VARCHAR(180) NULL",
      );
      await runMigration(
        pool,
        "ALTER TABLE personal_finance_transactions ADD COLUMN pending TINYINT(1) NOT NULL DEFAULT 0",
      );
      await runMigration(
        pool,
        "ALTER TABLE personal_finance_transactions ADD COLUMN import_account_key VARCHAR(160) NULL",
      );
      await runMigration(
        pool,
        "ALTER TABLE personal_finance_transactions ADD COLUMN import_connection_id BIGINT UNSIGNED NULL",
      );
      await runMigration(
        pool,
        "ALTER TABLE personal_finance_transactions ADD COLUMN duplicate_of_id BIGINT UNSIGNED NULL",
      );
      await runMigration(
        pool,
        "ALTER TABLE personal_finance_transactions ADD COLUMN is_provider_removed TINYINT(1) NOT NULL DEFAULT 0",
      );
      await runMigration(
        pool,
        "ALTER TABLE personal_finance_transactions ADD UNIQUE KEY personal_finance_transactions_external_idx (external_provider, external_transaction_id)",
      );
    })().catch((error) => {
      schemaReadyPromise = null;
      throw error;
    });
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
  if (!["plaid", "brankas"].includes(provider)) throw appError("Connection provider is invalid.");
  return provider;
}

function getTokenSecret() {
  const secret =
    process.env.FINANCE_TOKEN_SECRET ||
    process.env.AUTH_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    "";
  if (!secret)
    throw appError(
      "FINANCE_TOKEN_SECRET or AUTH_SECRET is required for linked account storage.",
      503,
    );
  return crypto.createHash("sha256").update(secret).digest();
}

function encryptSecret(value) {
  const plainText = String(value || "");
  if (!plainText) return "";

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(TOKEN_ALGORITHM, getTokenSecret(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plainText, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted]
    .map((part) => part.toString("base64url"))
    .join(".");
}

function decryptSecret(value) {
  const encryptedValue = String(value || "");
  if (!encryptedValue) return "";

  const [ivText, tagText, encryptedText] = encryptedValue.split(".");
  if (!ivText || !tagText || !encryptedText)
    throw appError("Stored account token is invalid.", 500);

  const decipher = crypto.createDecipheriv(
    TOKEN_ALGORITHM,
    getTokenSecret(),
    Buffer.from(ivText, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final(),
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
    throw appError(
      "Plaid is not configured. Add PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV.",
      503,
    );
  }
  getTokenSecret();
  if (
    !["sandbox", "development", "production"].includes(
      String(process.env.PLAID_ENV || "sandbox").toLowerCase(),
    )
  ) {
    throw appError(
      "PLAID_ENV must be sandbox, development, or production.",
      503,
    );
  }
  return { clientId, secret };
}

function plaidTransactionsDaysRequested() {
  const requestedDays = Number(
    process.env.PLAID_TRANSACTIONS_DAYS_REQUESTED || 730,
  );
  if (!Number.isFinite(requestedDays)) return 730;
  return Math.max(1, Math.min(730, Math.round(requestedDays)));
}

function requireBrankasConfig() {
  const linkUrl =
    process.env.BRANKAS_LINK_URL || process.env.BRANKAS_STATIC_LINK_URL || "";
  const redirectUri = process.env.BRANKAS_REDIRECT_URI || "";

  if (!linkUrl) {
    throw appError(
      "Brankas is not configured. Add BRANKAS_LINK_URL from your Brankas Data/Statement dashboard.",
      503,
    );
  }

  try {
    const url = new URL(linkUrl);
    if (url.protocol !== "https:") throw new Error("Invalid protocol");
  } catch {
    throw appError("BRANKAS_LINK_URL must be a valid Brankas Link URL.", 503);
  }

  return { linkUrl, redirectUri };
}

function buildBrankasLinkUrl(email, state) {
  const { linkUrl, redirectUri } = requireBrankasConfig();
  const userId = stableFinanceUserId(email);
  let urlText = linkUrl
    .replaceAll("{redirect_uri}", encodeURIComponent(redirectUri))
    .replaceAll("{user_id}", encodeURIComponent(userId))
    .replaceAll("{state}", encodeURIComponent(state));

  if (process.env.BRANKAS_APPEND_QUERY_PARAMS === "true") {
    const url = new URL(urlText);
    if (redirectUri && !url.searchParams.has("redirect_uri")) url.searchParams.set("redirect_uri", redirectUri);
    if (!url.searchParams.has("user_id")) url.searchParams.set("user_id", userId);
    if (!url.searchParams.has("state")) url.searchParams.set("state", state);
    urlText = url.toString();
  }

  const url = new URL(urlText);
  url.searchParams.set("state", state);
  return url.toString();
}

function cleanCallbackParams(params) {
  return Object.fromEntries(
    Object.entries(params || {})
      .map(([key, value]) => [
        cleanText(key, 80),
        Array.isArray(value) ? value[0] : value,
      ])
      .filter(([key, value]) => key && value !== undefined && value !== null)
      .map(([key, value]) => [key, cleanText(value, 1000)]),
  );
}

async function plaidRequest(endpoint, data = {}) {
  const { clientId, secret } = requirePlaidConfig();
  const response = await fetch(`${plaidBaseUrl()}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      client_id: clientId,
      secret,
      ...data,
    }),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload?.error_code) {
    const message =
      payload?.error_message ||
      payload?.display_message ||
      "Plaid request failed.";
    throw Object.assign(appError(message, response.status || 502), {
      providerCode: typeof payload?.error_code === "string" ? payload.error_code : "",
    });
  }

  return payload;
}

function mapProviderAccountType(type, subtype) {
  const normalized = String(subtype || type || "").toLowerCase();
  if (String(type || "").toLowerCase() === "credit") return "credit";
  if (normalized.includes("checking")) return "checking";
  if (normalized.includes("savings")) return "savings";
  if (normalized.includes("credit")) return "credit";
  if (normalized.includes("investment") || normalized.includes("brokerage")) return "investment";
  if (normalized.includes("loan") || normalized.includes("mortgage")) return "loan";
  return "other";
}

function colorForProvider(provider) {
  return provider === "brankas" ? "#fbbf24" : "#22d3ee";
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
    next: { revalidate: 60 * 60 * 12 },
  });

  if (!response.ok)
    throw appError("Unable to refresh USD/PHP exchange rate.", 502);

  const payload = await response.json();
  const rate = Number(payload?.rate);

  if (!Number.isFinite(rate) || rate <= 0) {
    throw appError("Exchange rate provider returned an invalid rate.", 502);
  }

  return {
    rate: toMoney(rate),
    date: cleanText(payload?.date, 20),
    source: "Frankfurter",
  };
}

async function refreshExchangeRateIfStale(pool, settings, force = false) {
  const updatedAt = settingDate(settings, "exchangeRateUpdatedAt");
  const isFresh =
    updatedAt && Date.now() - updatedAt.getTime() < EXCHANGE_RATE_MAX_AGE_MS;

  if (!force && isFresh) return settings;

  try {
    const rate = await fetchUsdPhpRate();
    const now = new Date().toISOString();
    await Promise.all([
      upsertSetting(pool, "exchangeRate", rate.rate),
      upsertSetting(pool, "exchangeRateUpdatedAt", now),
      upsertSetting(pool, "exchangeRateDate", rate.date),
      upsertSetting(pool, "exchangeRateSource", rate.source),
    ]);

    return {
      ...settings,
      exchangeRate: String(rate.rate),
      exchangeRateUpdatedAt: now,
      exchangeRateDate: rate.date,
      exchangeRateSource: rate.source,
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

const MATCH_FEE_WORDS = new Set([
  "fee",
  "fees",
  "charge",
  "charges",
  "maintenance",
  "service",
]);

function matchTokens(value) {
  return normalizeMatchText(value).split(" ").filter(Boolean);
}

function hasMatchToken(value, tokens) {
  return matchTokens(value).some((token) => tokens.has(token));
}

function billAllowsFeeTransaction(bill, transaction) {
  const transactionText = [
    transaction.merchant,
    transaction.note,
    transaction.category,
  ]
    .filter(Boolean)
    .join(" ");
  const transactionLooksLikeFee = hasMatchToken(
    transactionText,
    MATCH_FEE_WORDS,
  );
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
  return Math.abs(
    Math.round((firstDate.getTime() - secondDate.getTime()) / 86400000),
  );
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

  const merchantText = [
    transaction.merchant,
    transaction.note,
    transaction.category,
  ]
    .filter(Boolean)
    .join(" ");
  const sourceText = [
    transaction.accountName,
    transaction.institutionName,
    transaction.provider,
  ]
    .filter(Boolean)
    .join(" ");
  const nameMatched = hasTextMatch(merchantText, bill.name);
  const sourceMatched = bill.paymentAccount
    ? hasTextMatch(sourceText, bill.paymentAccount)
    : false;

  if (!nameMatched || !billAllowsFeeTransaction(bill, transaction)) return null;

  const transactionDate = new Date(`${transaction.date}T12:00:00Z`);
  const dueDate = billDueDateForMonth(bill.dueLabel, month);
  const dateDistance = dueDate ? distanceInDays(transactionDate, dueDate) : 0;
  const dateScore = dueDate
    ? dateDistance <= 7
      ? 2
      : dateDistance <= 14
        ? 1
        : -1
    : 0;

  return {
    score:
      (nameMatched ? 5 : 0) +
      (amountMatched ? 2 : 0) +
      (sourceMatched ? 3 : 0) +
      dateScore,
    dateDistance,
    transaction,
  };
}

function findRecurringBillMatch(bill, transactions, exchangeRate, month) {
  const matches = transactions
    .map((transaction) =>
      scoreRecurringBillTransaction(bill, transaction, exchangeRate, month),
    )
    .filter(Boolean)
    .sort(
      (first, second) =>
        second.score - first.score || first.dateDistance - second.dateDistance,
    );

  return matches[0]?.transaction || null;
}

function attachRecurringBillMatches(
  recurringBills,
  transactions,
  exchangeRate,
  month,
) {
  const usedTransactionIds = new Set();

  return recurringBills.map((bill) => {
    const availableTransactions = transactions.filter(
      (transaction) => !usedTransactionIds.has(transaction.id),
    );
    const matchedTransaction = findRecurringBillMatch(
      bill,
      availableTransactions,
      exchangeRate,
      month,
    );
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
          provider: matchedTransaction.provider,
        }
      : null;

    return {
      ...bill,
      isManuallyPaid: bill.isPaid,
      isPaid: Boolean(bill.isPaid || compactMatch),
      paidSource: bill.isPaid ? "manual" : compactMatch ? "transaction" : "",
      matchedTransaction: compactMatch,
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
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : String(row.updated_at),
  };
}

function mapConnection(row) {
  return {
    id: Number(row.id),
    provider: row.provider,
    institutionId: row.institution_id || "",
    institutionName: row.institution_name || row.provider,
    status: row.status || "active",
    lastSyncedAt:
      row.last_synced_at instanceof Date
        ? row.last_synced_at.toISOString()
        : row.last_synced_at || null,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : String(row.updated_at),
  };
}

// Activity uses the existing account/transaction tables, independently of forecasts.
// Reading this snapshot never calls a bank provider or starts a background sync.
export async function getFinanceActivity({ month } = {}) {
  const window = financeActivityWindow(month);
  const empty = {
    configured: false,
    month: window.month,
    historyStart: window.historyStart,
    historyEnd: window.historyEnd,
    accounts: [],
    archivedAccounts: [],
    connections: [],
    transactions: [],
    categories: [...FINANCE_DEFAULT_CATEGORIES],
    providers: financeProviderStatus(),
    limitHit: false,
  };
  try {
    const database = await ensureFinanceSchema();
    if (!database)
      return {
        ...empty,
        warning:
          "Connect your finance database to record transactions and connect bank accounts.",
      };
    const [accountResult, connectionResult, transactionResult] =
      await Promise.all([
        database.query(
          `
        SELECT a.*, c.institution_name, c.status AS connection_status,
          (SELECT COALESCE(SUM(CASE WHEN t.kind = 'income' THEN t.amount ELSE -t.amount END), 0)
           FROM personal_finance_transactions t
           WHERE t.account_id = a.id AND t.currency = a.currency
             AND t.pending = 0 AND t.duplicate_of_id IS NULL AND t.is_provider_removed = 0 AND t.transaction_date <= ?) AS native_movement
        FROM personal_finance_accounts a
        LEFT JOIN personal_finance_connections c ON c.id = a.connection_id
        ORDER BY a.name, a.id
      `,
          [window.today],
        ),
        database.query(`SELECT id, provider, institution_id, institution_name, status, last_synced_at, created_at, updated_at
        FROM personal_finance_connections ORDER BY updated_at DESC, id DESC`),
        database.query(
          `
        SELECT t.*, DATE_FORMAT(t.transaction_date, '%Y-%m-%d') AS transaction_date,
          a.name AS account_name, a.account_type, a.color AS account_color, c.institution_name
        FROM personal_finance_transactions t
        LEFT JOIN personal_finance_accounts a ON a.id = t.account_id
        LEFT JOIN personal_finance_connections c ON c.id = a.connection_id
        WHERE t.duplicate_of_id IS NULL AND t.is_provider_removed = 0 AND t.transaction_date >= ? AND t.transaction_date < ?
        ORDER BY t.transaction_date DESC, t.id DESC LIMIT 5001
      `,
          [window.historyStart, window.nextMonthStart],
        ),
      ]);
    const accountRows = accountResult[0].filter(
      (row) => !row.is_archived && !row.merged_into_account_id,
    );
    const transactionRows = transactionResult[0];
    const accounts = accountRows.map(mapFinanceActivityAccount).filter(Boolean);
    const transactions = transactionRows
      .slice(0, 5000)
      .map(mapTransaction)
      .filter((row) => CURRENCY_SET.has(row.currency));
    const warnings = [];
    if (
      accounts.length !== accountRows.length ||
      transactions.length !== Math.min(transactionRows.length, 5000)
    )
      warnings.push(
        "Accounts or transactions outside USD and PHP are excluded from this workspace.",
      );
    const limitHit = transactionRows.length > 5000;
    if (limitHit)
      warnings.push(
        "Only the newest 5,000 transactions in this six-month window are loaded. Activity totals and charts may be incomplete.",
      );
    return {
      ...empty,
      configured: true,
      accounts,
      archivedAccounts: accountResult[0]
        .filter((row) => row.is_archived || row.merged_into_account_id)
        .map(mapFinanceActivityAccount)
        .filter(Boolean),
      connections: connectionResult[0].map(mapConnection),
      transactions,
      limitHit,
      categories: [
        ...new Set([
          ...FINANCE_DEFAULT_CATEGORIES,
          ...transactions.map((row) => row.category),
        ]),
      ].sort(),
      ...(warnings.length ? { warning: warnings.join(" ") } : {}),
    };
  } catch {
    return {
      ...empty,
      warning:
        "Your finance activity database is temporarily unavailable. Saved accounts and transactions have not been changed. Reload to try again.",
    };
  }
}

// Plans can span more than the overview's six months. Return every supported
// recorded flow in that bounded range without contacting or synchronizing banks.
export async function getFinancePlanActivity({ startDate, endDate } = {}) {
  const range = financePlanActivityRange({ startDate, endDate });
  const empty = {
    configured: false,
    ...range,
    transactions: [],
    creditCardPaymentTransactions: [],
    creditCardPaymentLimitHit: false,
    creditCardPaymentWarning: "",
    limitHit: false,
  };
  try {
    const database = await ensureFinanceSchema();
    if (!database)
      return {
        ...empty,
        warning:
          "Connect your finance database to include recorded transactions in this plan.",
      };
    const [rows] = await database.query(
      `
      SELECT t.*, DATE_FORMAT(t.transaction_date, '%Y-%m-%d') AS transaction_date,
        a.name AS account_name, a.account_type, a.color AS account_color, c.institution_name
      FROM personal_finance_transactions t
      LEFT JOIN personal_finance_accounts a ON a.id = t.account_id
      LEFT JOIN personal_finance_connections c ON c.id = a.connection_id
      WHERE t.duplicate_of_id IS NULL AND t.is_provider_removed = 0 AND t.transaction_date >= ? AND t.transaction_date <= ?
      ORDER BY t.transaction_date ASC, t.id ASC LIMIT 10001
    `,
      [range.from, range.to],
    );
    const selected = rows.slice(0, 10000).map(mapTransaction);
    const transactions = selected.filter((row) =>
      CURRENCY_SET.has(row.currency),
    );
    const limitHit = rows.length > 10000;
    const warnings = [];
    if (transactions.length !== selected.length)
      warnings.push(
        "Recorded transactions outside USD and PHP are excluded from this plan.",
      );
    if (limitHit)
      warnings.push(
        "Only the first 10,000 recorded transactions in this range are included. Plan balances may be incomplete.",
      );
    const creditCardPayments = await getFinanceCreditCardPaymentActivity(database, range);
    return {
      ...empty,
      configured: true,
      transactions,
      limitHit,
      ...creditCardPayments,
      ...(warnings.length ? { warning: warnings.join(" ") } : {}),
    };
  } catch {
    return {
      ...empty,
      warning:
        "Recorded transactions could not be loaded. Your saved records have not been changed; retry to include them in this plan.",
    };
  }
}

// Payment evidence can precede a plan's start (or post after its end). Keep it
// separate so earlier partial payments reduce a statement without becoming new
// visible cash flows in the selected date range.
async function getFinanceCreditCardPaymentActivity(database, range) {
  const empty = {
    creditCardPaymentTransactions: [],
    creditCardPaymentLimitHit: false,
    creditCardPaymentWarning: "",
  };
  try {
    const [cards] = await database.query(`SELECT a.id, a.credit_card_due_json
      FROM personal_finance_accounts a
      LEFT JOIN personal_finance_connections c ON c.id = a.connection_id
      WHERE a.account_type = 'credit' AND a.external_provider IS NOT NULL
        AND a.external_provider <> '' AND a.external_account_id IS NOT NULL
        AND a.external_account_id <> '' AND a.currency IN ('USD', 'PHP') AND a.credit_card_due_json IS NOT NULL
        AND a.is_archived = 0 AND a.is_sync_excluded = 0 AND a.merged_into_account_id IS NULL
        AND (c.status IS NULL OR c.status NOT IN ('disconnected', 'superseded'))`);
    const day = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
    const starts = [];
    let historyClamped = false;
    const today = financeActivityWindow().today;
    for (const card of cards) {
      const due = normalizeFinanceCreditCardDue(card.credit_card_due_json);
      // Earlier statement payments determine the unbilled portion of today's
      // balance even when only the next cycle falls in the selected plan.
      if (!due?.dueDate) continue;
      const earliest = ["1900-01-01", day(due.dueDate, -731)].sort().at(-1);
      const statementDate = due.lastStatementDate && due.lastStatementDate <= due.dueDate
        ? due.lastStatementDate : null;
      const start = statementDate || [
        day(due.dueDate, -3), day(range.from, -3), day(today, -3),
      ].sort()[0];
      if (start < earliest) historyClamped = true;
      starts.push([earliest, start].sort().at(-1));
    }
    if (!starts.length) return empty;
    const from = starts.sort()[0];
    const to = [range.to, today].sort().at(-1);
    const [rows] = await database.query(`
      SELECT t.*, DATE_FORMAT(t.transaction_date, '%Y-%m-%d') AS transaction_date,
        a.name AS account_name, a.account_type, a.color AS account_color, c.institution_name
      FROM personal_finance_transactions t
      LEFT JOIN personal_finance_accounts a ON a.id = t.account_id
      LEFT JOIN personal_finance_connections c ON c.id = a.connection_id
      WHERE t.duplicate_of_id IS NULL AND t.is_provider_removed = 0
        AND t.currency IN ('USD', 'PHP') AND t.pending = 0
        AND t.transaction_date >= ? AND t.transaction_date <= ?
      ORDER BY t.transaction_date ASC, t.id ASC LIMIT 10001`, [from, to]);
    const transactions = rows.slice(0, 10000).map(mapTransaction)
      .filter((row) => CURRENCY_SET.has(row.currency));
    const limitHit = rows.length > 10000;
    const warnings = [];
    if (historyClamped) warnings.push("Credit card payment matching uses at most two years of history before each due date.");
    if (limitHit) warnings.push("Only the first 10,000 transactions in the credit card payment history are available for matching.");
    return {
      creditCardPaymentTransactions: transactions,
      creditCardPaymentLimitHit: limitHit,
      creditCardPaymentWarning: warnings.length
        ? `${warnings.join(" ")} Some prior payments may be missing; review the remaining statement amounts.` : "",
    };
  } catch {
    return {
      ...empty,
      creditCardPaymentWarning: "Credit card payment history could not be loaded. Some prior payments may be missing; review the remaining statement amounts or refresh bank data to retry.",
    };
  }
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
      monthlyIncomePhp:
        PLAN_DEFAULTS.monthlyIncomeUsd * PLAN_DEFAULTS.exchangeRate,
      biweeklyRemainingUsd:
        PLAN_DEFAULTS.biweeklyIncomeUsd -
        PLAN_DEFAULTS.biweeklyBillsUsd -
        PLAN_DEFAULTS.biweeklySavingsUsd,
      recurringUsd: 0,
      recurringPhp: 0,
      recurringRemainingUsd: PLAN_DEFAULTS.monthlyIncomeUsd,
      exchangeRateUpdatedAt: null,
      exchangeRateDate: "",
      exchangeRateSource: "",
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
      dueSoonBills: 0,
    },
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
    seriesResult,
  ] = await Promise.all([
    pool.query(
      "SELECT setting_key, setting_value FROM personal_finance_settings",
    ),
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
        ON t.account_id = a.id AND t.duplicate_of_id IS NULL AND t.is_provider_removed = 0
      WHERE a.is_archived = 0 AND a.merged_into_account_id IS NULL
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
    pool.query(
      `
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
      WHERE t.duplicate_of_id IS NULL AND t.is_provider_removed = 0 AND t.transaction_date >= ?
        AND t.transaction_date < ?
      ORDER BY t.transaction_date DESC, t.id DESC
      LIMIT 500
    `,
      [monthStart, nextMonthStart],
    ),
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
      WHERE t.duplicate_of_id IS NULL AND t.is_provider_removed = 0
      ORDER BY t.transaction_date DESC, t.id DESC
    `),
    pool.query(
      `
      SELECT id, budget_month, category, amount, currency, created_at, updated_at
      FROM personal_finance_budgets
      WHERE budget_month = ?
      ORDER BY category ASC
    `,
      [safeMonth],
    ),
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
      SELECT category FROM personal_finance_transactions WHERE duplicate_of_id IS NULL AND is_provider_removed = 0 AND category != '' GROUP BY category
      UNION
      SELECT category FROM personal_finance_budgets WHERE category != '' GROUP BY category
      UNION
      SELECT category FROM personal_finance_goals WHERE category != '' GROUP BY category
      ORDER BY category ASC
    `),
    pool.query(
      `
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
      WHERE duplicate_of_id IS NULL AND is_provider_removed = 0 AND transaction_date >= ?
        AND transaction_date < ?
      GROUP BY budget_month
      ORDER BY budget_month ASC
    `,
      [seriesStart, nextMonthStart],
    ),
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

  let settings = Object.fromEntries(
    settingsRows.map((row) => [row.setting_key, row.setting_value]),
  );
  settings = await refreshExchangeRateIfStale(pool, settings);
  const exchangeRate = Math.max(
    1,
    settingNumber(settings, "exchangeRate", PLAN_DEFAULTS.exchangeRate),
  );
  const displayCurrency = cleanCurrency(
    settings.displayCurrency || PLAN_DEFAULTS.displayCurrency,
  );
  const plan = {
    monthlyIncomeUsd: settingNumber(
      settings,
      "monthlyIncomeUsd",
      PLAN_DEFAULTS.monthlyIncomeUsd,
    ),
    exchangeRate,
    displayCurrency,
    biweeklyIncomeUsd: settingNumber(
      settings,
      "biweeklyIncomeUsd",
      PLAN_DEFAULTS.biweeklyIncomeUsd,
    ),
    biweeklyBillsUsd: settingNumber(
      settings,
      "biweeklyBillsUsd",
      PLAN_DEFAULTS.biweeklyBillsUsd,
    ),
    biweeklySavingsUsd: settingNumber(
      settings,
      "biweeklySavingsUsd",
      PLAN_DEFAULTS.biweeklySavingsUsd,
    ),
    exchangeRateUpdatedAt: settings.exchangeRateUpdatedAt || null,
    exchangeRateDate: settings.exchangeRateDate || "",
    exchangeRateSource: settings.exchangeRateSource || "",
  };

  const connections = connectionRows.map(mapConnection);
  const accounts = accountRows.map((row) => {
    const openingBalance = toMoney(row.opening_balance);
    const transactionTotal = toMoney(
      toMoney(row.transaction_usd) +
        toMoney(row.transaction_php) / exchangeRate,
    );
    const currency = cleanCurrency(row.currency || "USD");
    const hasLinkedBalance =
      row.current_balance !== null && row.current_balance !== undefined;
    const nativeCurrentBalance = hasLinkedBalance
      ? toMoney(row.current_balance)
      : toMoney(openingBalance + transactionTotal);
    const nativeAvailableBalance =
      row.available_balance !== null && row.available_balance !== undefined
        ? toMoney(row.available_balance)
        : null;
    const isLiability = ["credit", "loan"].includes(row.account_type);
    const rawCurrentBalance = hasLinkedBalance
      ? convertToUsd(nativeCurrentBalance, currency, exchangeRate)
      : toMoney(openingBalance + transactionTotal);
    const currentBalance = isLiability
      ? toMoney(-Math.abs(rawCurrentBalance))
      : toMoney(rawCurrentBalance);
    return {
      id: Number(row.id),
      name: row.name,
      type: row.account_type,
      openingBalance,
      transactionTotal,
      currentBalance,
      nativeCurrentBalance,
      availableBalance:
        nativeAvailableBalance === null
          ? null
          : convertToUsd(nativeAvailableBalance, currency, exchangeRate),
      nativeAvailableBalance,
      currency,
      provider: row.external_provider || "",
      externalAccountId: row.external_account_id || "",
      connectionId: row.connection_id ? Number(row.connection_id) : null,
      institutionName: row.institution_name || "",
      isLinked: Boolean(row.external_provider && row.external_account_id),
      color: row.color || DEFAULT_COLOR,
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
    amountUsd: convertToUsd(row.amount, row.currency || "USD", exchangeRate),
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
    displayOrder: Number(row.display_order || 0),
  }));
  const recurringBills = attachRecurringBillMatches(
    rawRecurringBills,
    transactions,
    exchangeRate,
    safeMonth,
  );

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
      percent:
        targetAmount > 0
          ? Math.min(999, Math.round((savedAmount / targetAmount) * 100))
          : 0,
    };
  });

  const incomeUsd = toMoney(
    transactions
      .filter((transaction) => transaction.kind === "income")
      .reduce(
        (sum, transaction) =>
          sum +
          convertToUsd(transaction.amount, transaction.currency, exchangeRate),
        0,
      ),
  );
  const expensesUsd = toMoney(
    transactions
      .filter((transaction) => transaction.kind === "expense")
      .reduce(
        (sum, transaction) =>
          sum +
          convertToUsd(transaction.amount, transaction.currency, exchangeRate),
        0,
      ),
  );
  const budgetTotalUsd = toMoney(
    budgets.reduce((sum, budget) => sum + budget.amountUsd, 0),
  );

  const spendByCategory = {};
  for (const transaction of transactions) {
    if (transaction.kind !== "expense") continue;
    const category = transaction.category || "Uncategorized";
    spendByCategory[category] = toMoney(
      (spendByCategory[category] || 0) +
        convertToUsd(transaction.amount, transaction.currency, exchangeRate),
    );
  }

  const budgetByCategory = Object.fromEntries(
    budgets.map((budget) => [budget.category, budget]),
  );
  const categoryNames = Array.from(
    new Set([
      ...budgets.map((budget) => budget.category),
      ...Object.keys(spendByCategory),
    ]),
  ).sort((a, b) => a.localeCompare(b));

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
      percent:
        budgetAmount > 0
          ? Math.min(999, Math.round((spent / budgetAmount) * 100))
          : 0,
    };
  });

  const allCategories = Array.from(
    new Set([
      ...FINANCE_DEFAULT_CATEGORIES,
      ...categoryRows.map((row) => row.category).filter(Boolean),
    ]),
  ).sort((a, b) => a.localeCompare(b));

  const seriesByMonth = Object.fromEntries(
    seriesRows.map((row) => [
      row.budget_month,
      {
        income: toMoney(
          toMoney(row.income_usd) + toMoney(row.income_php) / exchangeRate,
        ),
        expenses: toMoney(
          toMoney(row.expenses_usd) + toMoney(row.expenses_php) / exchangeRate,
        ),
      },
    ]),
  );

  const monthlySeries = Array.from({ length: 6 }, (_, index) => {
    const seriesMonth = addMonths(safeMonth, index - 5);
    const values = seriesByMonth[seriesMonth] || { income: 0, expenses: 0 };
    return {
      month: seriesMonth,
      incomeUsd: values.income,
      expensesUsd: values.expenses,
      netUsd: toMoney(values.income - values.expenses),
    };
  });

  const recurringUsd = toMoney(
    recurringBills.reduce((sum, bill) => sum + bill.amountUsd, 0),
  );
  const recurringPhp = toMoney(
    recurringBills.reduce((sum, bill) => sum + bill.amountPhp, 0),
  );
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
    biweeklyRemainingUsd: toMoney(
      plan.biweeklyIncomeUsd - plan.biweeklyBillsUsd - plan.biweeklySavingsUsd,
    ),
    recurringUsd,
    recurringPhp,
    recurringRemainingUsd: toMoney(plan.monthlyIncomeUsd - recurringUsd),
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
      totalBalanceUsd: toMoney(
        accounts.reduce((sum, account) => sum + account.currentBalance, 0),
      ),
      savingsRate:
        incomeUsd > 0
          ? Math.round(((incomeUsd - expensesUsd) / incomeUsd) * 100)
          : 0,
      unpaidBills: recurringBills.filter((bill) => !bill.isPaid).length,
      dueSoonBills,
    },
  };
}

async function upsertSetting(pool, key, value) {
  await pool.query(
    `INSERT INTO personal_finance_settings (setting_key, setting_value, updated_at)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       setting_value = VALUES(setting_value),
       updated_at = VALUES(updated_at)`,
    [key, String(value), new Date()],
  );
}

export async function updateFinancePlan(data) {
  const pool = requirePool(await ensureFinanceSchema());
  const values = {
    monthlyIncomeUsd: cleanPositiveAmount(
      data?.monthlyIncomeUsd,
      "Monthly income",
    ),
    biweeklyIncomeUsd: cleanPositiveAmount(
      data?.biweeklyIncomeUsd,
      "Bi-weekly income",
    ),
    biweeklyBillsUsd: cleanOptionalAmount(
      data?.biweeklyBillsUsd,
      "Bi-weekly bills",
    ),
    biweeklySavingsUsd: cleanOptionalAmount(
      data?.biweeklySavingsUsd,
      "Bi-weekly savings",
    ),
  };

  await Promise.all(
    Object.entries(values).map(([key, value]) =>
      upsertSetting(pool, key, value),
    ),
  );
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
  const [settingsRows] = await pool.query(
    "SELECT setting_key, setting_value FROM personal_finance_settings",
  );
  const settings = Object.fromEntries(
    settingsRows.map((row) => [row.setting_key, row.setting_value]),
  );
  const refreshed = await refreshExchangeRateIfStale(pool, settings, true);
  return {
    exchangeRate: Number(refreshed.exchangeRate),
    exchangeRateUpdatedAt: refreshed.exchangeRateUpdatedAt,
    exchangeRateDate: refreshed.exchangeRateDate,
    exchangeRateSource: refreshed.exchangeRateSource,
  };
}

export async function seedFinanceStarter() {
  const pool = requirePool(await ensureFinanceSchema());
  const now = new Date();

  await Promise.all(
    Object.entries(PLAN_DEFAULTS).map(([key, value]) =>
      upsertSetting(pool, key, value),
    ),
  );

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
        now,
      ],
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
        now,
      ],
    );
  }

  return { bills: STARTER_BILLS.length, goals: STARTER_GOALS.length };
}

async function validateTransactionAccount(pool, accountId, currency) {
  if (accountId === null) return;
  const [accounts] = await pool.query(
    "SELECT id, currency FROM personal_finance_accounts WHERE id = ? AND is_archived = 0 AND merged_into_account_id IS NULL LIMIT 1",
    [accountId],
  );
  if (!accounts.length)
    throw appError(
      "The selected account is unavailable. Choose another account or leave it unassigned.",
      400,
    );
  if (accounts[0].currency !== currency)
    throw appError(
      "The transaction currency must match the account currency. Choose another account or leave it unassigned.",
      400,
    );
}

async function requireManualTransaction(pool, transactionId) {
  if (transactionId === null)
    throw appError("Choose a valid transaction.", 400);
  const [rows] = await pool.query(
    "SELECT id, external_provider, external_transaction_id FROM personal_finance_transactions WHERE id = ? LIMIT 1",
    [transactionId],
  );
  if (!rows.length) throw appError("Transaction was not found.", 404);
  if (rows[0].external_provider || rows[0].external_transaction_id)
    throw appError(
      "Bank-imported transactions are read-only. Correct the source record through your bank and sync again.",
      409,
    );
}

export async function createFinanceTransaction(data) {
  const clean = validateFinanceTransactionInput(data);
  const {
    date: transactionDate,
    kind,
    accountId,
    category,
    merchant,
    note,
    amount,
    currency,
  } = clean;
  const pool = requirePool(await ensureFinanceSchema());
  const now = new Date();
  await validateTransactionAccount(pool, accountId, currency);

  const [result] = await pool.query(
    `INSERT INTO personal_finance_transactions
       (transaction_date, kind, account_id, category, merchant, note, amount, currency, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      transactionDate,
      kind,
      accountId,
      category,
      merchant,
      note,
      amount,
      currency,
      now,
      now,
    ],
  );

  return { id: Number(result.insertId) };
}

export async function updateFinanceTransaction(id, data) {
  const clean = validateFinanceTransactionInput(data);
  const {
    date: transactionDate,
    kind,
    accountId,
    category,
    merchant,
    note,
    amount,
    currency,
  } = clean;
  const transactionId = cleanId(id, "Transaction");
  const pool = requirePool(await ensureFinanceSchema());
  await requireManualTransaction(pool, transactionId);
  await validateTransactionAccount(pool, accountId, currency);

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
     WHERE id = ? AND (external_provider IS NULL OR external_provider = '')
       AND (external_transaction_id IS NULL OR external_transaction_id = '')`,
    [
      transactionDate,
      kind,
      accountId,
      category,
      merchant,
      note,
      amount,
      currency,
      new Date(),
      transactionId,
    ],
  );

  return { id: transactionId };
}

export async function deleteFinanceTransaction(id) {
  const pool = requirePool(await ensureFinanceSchema());
  const transactionId = cleanId(id, "Transaction");
  await requireManualTransaction(pool, transactionId);
  await pool.query(
    "DELETE FROM personal_finance_transactions WHERE id = ? AND (external_provider IS NULL OR external_provider = '') AND (external_transaction_id IS NULL OR external_transaction_id = '')",
    [transactionId],
  );
  return { id: transactionId };
}

export async function createFinanceAccount(data) {
  const pool = requirePool(await ensureFinanceSchema());
  const now = new Date();
  const name = cleanText(data?.name, 80);
  if (!name) throw appError("Account name is required.");

  const accountType = cleanAccountType(data?.type);
  const openingBalance = cleanSignedAmount(
    data?.openingBalance || 0,
    "Opening balance",
  );
  const color = cleanColor(data?.color);
  const currency = String(data?.currency || "USD").toUpperCase();
  if (!CURRENCY_SET.has(currency))
    throw appError("Choose USD or PHP for this account.");

  const [result] = await pool.query(
    `INSERT INTO personal_finance_accounts
       (name, account_type, opening_balance, currency, color, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [name, accountType, openingBalance, currency, color, now, now],
  );

  return { id: Number(result.insertId) };
}

export async function updateFinanceAccount(id, data) {
  const pool = requirePool(await ensureFinanceSchema());
  const accountId = cleanId(id, "Account");
  const name = cleanText(data?.name, 80);
  if (!name) throw appError("Account name is required.");

  const accountType = cleanAccountType(data?.type);
  const openingBalance = cleanSignedAmount(
    data?.openingBalance || 0,
    "Opening balance",
  );
  const color = cleanColor(data?.color);

  await pool.query(
    `UPDATE personal_finance_accounts
     SET name = ?,
         account_type = ?,
         opening_balance = ?,
         color = ?,
         updated_at = ?
     WHERE id = ?`,
    [name, accountType, openingBalance, color, new Date(), accountId],
  );

  return { id: accountId };
}

export async function archiveFinanceAccount(id) {
  const pool = requirePool(await ensureFinanceSchema());
  const accountId = cleanId(id, "Account");
  const [rows] = await pool.query(
    "SELECT id FROM personal_finance_accounts WHERE id = ?",
    [accountId],
  );
  if (!rows.length) throw appError("Account was not found.", 404);
  await pool.query(
    "UPDATE personal_finance_accounts SET is_archived = 1, is_sync_excluded = 1, updated_at = ? WHERE id = ?",
    [new Date(), accountId],
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
    [budgetMonth, category, amount, currency, now, now],
  );

  return { id: Number(result.insertId || 0), month: budgetMonth, category };
}

export async function deleteFinanceBudget(id) {
  const pool = requirePool(await ensureFinanceSchema());
  const budgetId = cleanId(id, "Budget");
  await pool.query("DELETE FROM personal_finance_budgets WHERE id = ?", [
    budgetId,
  ]);
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
      [
        name,
        amountUsd,
        amountPhp,
        dueLabel,
        paymentAccount,
        isPaid ? 1 : 0,
        isAutopay ? 1 : 0,
        now,
        id,
      ],
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
    [
      name,
      amountUsd,
      amountPhp,
      dueLabel,
      paymentAccount,
      isPaid ? 1 : 0,
      isAutopay ? 1 : 0,
      now,
      now,
    ],
  );

  return { id: Number(result.insertId || 0) };
}

export async function toggleFinanceBillPaid(id, isPaid) {
  const pool = requirePool(await ensureFinanceSchema());
  const billId = cleanId(id, "Bill");
  await pool.query(
    "UPDATE personal_finance_recurring_bills SET is_paid = ?, updated_at = ? WHERE id = ?",
    [cleanBoolean(isPaid) ? 1 : 0, new Date(), billId],
  );
  return { id: billId };
}

export async function deleteFinanceBill(id) {
  const pool = requirePool(await ensureFinanceSchema());
  const billId = cleanId(id, "Bill");
  await pool.query(
    "DELETE FROM personal_finance_recurring_bills WHERE id = ?",
    [billId],
  );
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
      [name, currency, targetAmount, savedAmount, category, note, now, id],
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
    [name, currency, targetAmount, savedAmount, category, note, now, now],
  );

  return { id: Number(result.insertId || 0) };
}

export async function deleteFinanceGoal(id) {
  const pool = requirePool(await ensureFinanceSchema());
  const goalId = cleanId(id, "Goal");
  await pool.query("DELETE FROM personal_finance_goals WHERE id = ?", [goalId]);
  return { id: goalId };
}

export async function createPlaidLinkToken(email, data = {}) {
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
      client_user_id: stableFinanceUserId(email),
    },
    account_filters: {
      depository: { account_subtypes: ["checking", "savings"] },
      credit: { account_subtypes: ["credit card"] },
    },
    // Consent now, initialize only for a linked credit account. Checking-only
    // institutions remain available and do not initialize Liabilities.
    ...(products.includes("liabilities") ? {} : {
      additional_consented_products: ["liabilities"],
    }),
  };

  if (products.includes("transactions")) {
    body.transactions = {
      days_requested: plaidTransactionsDaysRequested(),
    };
  }

  const connectionId = cleanId(data?.connectionId, "Connection");
  if (connectionId) {
    const pool = requirePool(await ensureFinanceSchema());
    const [rows] = await pool.query(
      "SELECT provider, status, encrypted_access_token FROM personal_finance_connections WHERE id = ?",
      [connectionId],
    );
    const connection = rows[0];
    if (
      !connection ||
      connection.provider !== "plaid" ||
      ["disconnected", "superseded"].includes(connection.status) ||
      !connection.encrypted_access_token
    )
      throw appError("Choose an active Plaid connection to update.", 400);
    body.access_token = decryptSecret(connection.encrypted_access_token);
    body.update = { account_selection_enabled: true };
    delete body.products;
    delete body.transactions;
    body.additional_consented_products = ["liabilities"];
  }

  if (process.env.PLAID_REDIRECT_URI)
    body.redirect_uri = process.env.PLAID_REDIRECT_URI;

  let payload;
  try {
    payload = await plaidRequest("/link/token/create", body);
  } catch (error) {
    if (error.providerCode !== "INVALID_PRODUCT" ||
      !body.additional_consented_products?.includes("liabilities")) throw error;
    // Older deployments may not have Liabilities enabled for their API keys.
    // Keep their required products intact and retry without the enhancement.
    delete body.additional_consented_products;
    payload = await plaidRequest("/link/token/create", body);
  }
  return {
    linkToken: payload.link_token,
    expiration: payload.expiration || null,
    connectionId,
    environment: String(process.env.PLAID_ENV || "sandbox").toLowerCase(),
  };
}

export async function exchangePlaidPublicToken(data) {
  const pool = requirePool(await ensureFinanceSchema());
  const publicToken = cleanText(data?.publicToken, 800);
  if (!publicToken) throw appError("Plaid public token is missing.");

  const metadata = data?.metadata || {};
  const institution = metadata?.institution || {};
  const exchanged = await plaidRequest("/item/public_token/exchange", {
    public_token: publicToken,
  });

  const accessToken = exchanged?.access_token;
  const itemId = cleanText(exchanged?.item_id, 160);
  if (!accessToken || !itemId)
    throw appError("Plaid did not return a usable account token.", 502);

  const now = new Date();
  const provider = "plaid";
  const institutionId = cleanText(
    institution?.institution_id || metadata?.institution_id,
    120,
  );
  const institutionName = cleanText(
    institution?.name || metadata?.institution_name || "Plaid account",
    160,
    "Plaid account",
  );

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
    [
      provider,
      institutionId || null,
      institutionName,
      itemId,
      encryptSecret(accessToken),
      now,
      now,
    ],
  );

  const insertedConnectionId = Number(result.insertId || 0);
  const connectionId =
    insertedConnectionId ||
    (await getConnectionIdByItem(pool, provider, itemId));
  const synced = await syncPlaidConnection(pool, connectionId, accessToken);
  return { id: connectionId, ...synced };
}

export async function syncFinanceConnection(id) {
  const pool = requirePool(await ensureFinanceSchema());
  const connectionId = cleanId(id, "Connection");
  const [rows] = await pool.query(
    `SELECT id, provider, status, encrypted_access_token, sync_cursor
     FROM personal_finance_connections
     WHERE id = ?
     LIMIT 1`,
    [connectionId],
  );
  const connection = rows[0];
  if (!connection) throw appError("Connection was not found.", 404);
  if (
    ["disconnected", "superseded"].includes(connection.status) ||
    !connection.encrypted_access_token
  )
    throw appError(
      "This connection is unlinked. Connect it again before syncing.",
      409,
    );

  const provider = cleanProvider(connection.provider);
  if (provider === "plaid") return syncPlaidConnection(pool, connectionId);
  if (provider === "brankas") {
    throw appError(
      "Brankas connection is saved, but sync needs Brankas Data/Statement account and transaction endpoint details before it can pull balances and transactions.",
      503,
    );
  }

  throw appError("This connection provider cannot be synced yet.", 503);
}

/** Refresh bank sources used by plans without moving funds or changing plan settings. */
export function refreshFinancePlanBankData({ force = false } = {}) {
  if (planBankRefreshPromise) return planBankRefreshPromise;
  if (
    !force &&
    planBankRefreshResult &&
    Date.now() - planBankRefreshCompletedAt < PLAN_BANK_REFRESH_COOLDOWN_MS
  )
    return Promise.resolve({ ...planBankRefreshResult, cached: true });

  const refresh = (async () => {
    const pool = requirePool(await ensureFinanceSchema());
    const [connections] = await pool.query(
      `SELECT id, provider, status FROM personal_finance_connections
       WHERE provider IN ('plaid', 'brankas')
         AND status NOT IN ('disconnected', 'superseded')
         AND encrypted_access_token IS NOT NULL AND encrypted_access_token <> ''
       ORDER BY id`,
    );
    const eligible = connections.filter(
      (connection) =>
        Number.isSafeInteger(Number(connection.id)) &&
        Number(connection.id) > 0 &&
        !["disconnected", "superseded"].includes(connection.status),
    );
    const outcomes = await Promise.allSettled(
      eligible.map((connection) => {
        if (connection.provider !== "plaid")
          return Promise.reject(new Error("Unsupported plan bank refresh"));
        return syncFinanceConnection(Number(connection.id));
      }),
    );
    const syncedConnections = [];
    const errors = [];
    outcomes.forEach((outcome, index) => {
      const connection = eligible[index];
      const connectionId = Number(connection.id);
      if (outcome.status === "fulfilled") syncedConnections.push(connectionId);
      else
        errors.push({
          connectionId,
          message:
            connection.provider === "brankas"
              ? "Brankas balance and transaction syncing is not available yet. Its last known data is unchanged."
              : "Bank sync failed. The last known balances and transactions are still shown. Try refreshing again.",
        });
    });
    const result = {
      refreshedAt: syncedConnections.length ? new Date().toISOString() : null,
      syncedConnections,
      errors,
      cached: false,
    };
    planBankRefreshResult = result;
    planBankRefreshCompletedAt = Date.now();
    return result;
  })();
  planBankRefreshPromise = refresh.finally(() => {
    planBankRefreshPromise = null;
  });
  return planBankRefreshPromise;
}

export async function createBrankasLink(email) {
  getTokenSecret();
  const pool = requirePool(await ensureFinanceSchema());
  const state = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(state).digest("hex");
  const url = buildBrankasLinkUrl(email, state);
  await upsertSetting(
    pool,
    "brankasLinkState",
    JSON.stringify({ hash, expires: Date.now() + 10 * 60_000 }),
  );
  return {
    url,
    state,
    expiresIn: 600,
  };
}

export async function saveBrankasCallback(params, expectedState) {
  const pool = requirePool(await ensureFinanceSchema());
  const payload = cleanCallbackParams(params);
  const state = payload.state || "";
  if (
    !/^[a-f0-9]{64}$/.test(state) ||
    typeof expectedState !== "string" ||
    !/^[a-f0-9]{64}$/.test(expectedState) ||
    !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expectedState))
  ) {
    throw appError(
      "This bank authorization could not be verified. Start connecting Brankas again from Accounts.",
      400,
    );
  }
  const hash = crypto.createHash("sha256").update(state).digest("hex");
  const tokenSource =
    payload.code ||
    payload.consent_id ||
    payload.customer_id ||
    payload.request_id ||
    payload.reference_id;
  if (!tokenSource || tokenSource === "{}")
    throw appError("Brankas did not return a usable callback payload.", 400);

  const tokenHash = crypto
    .createHash("sha256")
    .update(tokenSource)
    .digest("hex")
    .slice(0, 48);
  const itemId = cleanText(
    payload.consent_id ||
      payload.customer_id ||
      payload.request_id ||
      payload.reference_id ||
      tokenHash,
    160,
    tokenHash,
  );
  const institutionName = cleanText(
    payload.institution_name ||
      payload.bank_name ||
      process.env.BRANKAS_INSTITUTION_NAME ||
      "Brankas",
    160,
    "Brankas",
  );
  const now = new Date();

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [stateRows] = await connection.query(
      "SELECT setting_value FROM personal_finance_settings WHERE setting_key = 'brankasLinkState' FOR UPDATE",
    );
    let storedState;
    try {
      storedState = JSON.parse(stateRows[0]?.setting_value || "null");
    } catch {
      /* Invalid state is rejected below. */
    }
    if (
      !storedState ||
      storedState.hash !== hash ||
      !Number.isFinite(storedState.expires) ||
      storedState.expires < Date.now()
    ) {
      throw appError(
        "This bank authorization expired or was already used. Start connecting Brankas again from Accounts.",
        400,
      );
    }
    const [result] = await connection.query(
      `INSERT INTO personal_finance_connections
       (provider, institution_name, item_id, encrypted_access_token, status, created_at, updated_at)
     VALUES ('brankas', ?, ?, ?, 'linked', ?, ?)
     ON DUPLICATE KEY UPDATE
       institution_name = VALUES(institution_name),
       encrypted_access_token = VALUES(encrypted_access_token),
       status = 'linked',
       updated_at = VALUES(updated_at)`,
      [
        institutionName,
        itemId,
        encryptSecret(JSON.stringify(payload)),
        now,
        now,
      ],
    );

    const insertedConnectionId = Number(result.insertId || 0);
    const connectionId =
      insertedConnectionId ||
      (await getConnectionIdByItem(connection, "brankas", itemId));
    await connection.query(
      "DELETE FROM personal_finance_settings WHERE setting_key = 'brankasLinkState'",
    );
    await connection.commit();
    return { id: connectionId, status: "linked" };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function getConnectionIdByItem(pool, provider, itemId) {
  const [rows] = await pool.query(
    "SELECT id FROM personal_finance_connections WHERE provider = ? AND item_id = ? LIMIT 1",
    [provider, itemId],
  );
  return Number(rows[0]?.id || 0);
}

async function getAccountIdByProvider(pool, provider, accountId) {
  const [rows] = await pool.query(
    `SELECT a.id FROM personal_finance_account_aliases x
     JOIN personal_finance_accounts a ON a.id = x.account_id
     WHERE x.provider = ? AND x.external_account_id = ?
     UNION ALL
     SELECT COALESCE(merged_into_account_id, id) AS id FROM personal_finance_accounts
     WHERE external_provider = ? AND external_account_id = ? LIMIT 1`,
    [provider, accountId, provider, accountId],
  );
  return Number(rows[0]?.id || 0);
}

async function syncPlaidConnection(
  pool,
  connectionId,
  accessTokenOverride = "",
) {
  const [connectionRows] = await pool.query(
    `SELECT id, institution_name, status, encrypted_access_token, sync_cursor
     FROM personal_finance_connections
     WHERE id = ?
     LIMIT 1`,
    [connectionId],
  );
  const connection = connectionRows[0];
  if (!connection) throw appError("Plaid connection was not found.", 404);
  if (
    ["disconnected", "superseded"].includes(connection.status) ||
    (!accessTokenOverride && !connection.encrypted_access_token)
  )
    throw appError(
      "This connection is unlinked. Connect it again before syncing.",
      409,
    );

  const accessToken =
    accessTokenOverride || decryptSecret(connection.encrypted_access_token);
  let accountSync = { accounts: 0 };
  let transactionSync = { added: 0, modified: 0, removed: 0 };

  try {
    accountSync = await syncPlaidAccounts(
      pool,
      connectionId,
      accessToken,
      connection.institution_name || "Plaid",
    );
    transactionSync = await syncPlaidTransactions(
      pool,
      connectionId,
      accessToken,
      connection.sync_cursor || null,
    );
    if (accountSync.creditAccountIds?.length)
      await syncPlaidCreditCardDues(pool, connectionId, accessToken, accountSync.creditAccountIds);
    await pool.query(
      "UPDATE personal_finance_connections SET status = 'active', last_synced_at = ?, updated_at = ? WHERE id = ? AND status NOT IN ('disconnected', 'superseded')",
      [new Date(), new Date(), connectionId],
    );
  } catch (error) {
    await pool.query(
      "UPDATE personal_finance_connections SET status = 'needs_sync', updated_at = ? WHERE id = ? AND status NOT IN ('disconnected', 'superseded')",
      [new Date(), connectionId],
    );
    throw error;
  }

  return {
    accounts: accountSync.accounts,
    transactions: transactionSync,
  };
}

async function syncPlaidAccounts(
  pool,
  connectionId,
  accessToken,
  fallbackInstitutionName,
) {
  const payload = await plaidRequest("/accounts/balance/get", {
    access_token: accessToken,
  });
  const database = await pool.getConnection();
  try {
    await database.beginTransaction();
    const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
    const now = new Date();
    if (payload?.item?.institution_id)
      await database.query(
        "UPDATE personal_finance_connections SET institution_id = COALESCE(institution_id, ?), updated_at = ? WHERE id = ?",
        [cleanText(payload.item.institution_id, 120), now, connectionId],
      );
    const [connectionRows] = await database.query(
      "SELECT institution_id, status FROM personal_finance_connections WHERE id = ? FOR UPDATE",
      [connectionId],
    );
    if (["disconnected", "superseded"].includes(connectionRows[0]?.status))
      throw appError(
        "This connection no longer syncs. Use the current bank connection.",
        409,
      );
    const institutionId =
      connectionRows[0]?.institution_id || payload?.item?.institution_id || "";
    let saved = 0;
    const seenAccounts = [];
    const creditAccountIds = [];
    for (const account of accounts) {
      const externalId = cleanText(account?.account_id, 160);
      const balances = account?.balances || {};
      const currency = String(
        balances.iso_currency_code || balances.unofficial_currency_code || "",
      ).toUpperCase();
      if (!externalId || !/^[A-Z]{3}$/.test(currency)) continue;
      const name = cleanText(
        account.official_name || account.name || fallbackInstitutionName,
        80,
        fallbackInstitutionName,
      );
      const type = mapProviderAccountType(account.type, account.subtype);
      const mask = cleanText(account.mask, 16);
      const official = cleanText(account.official_name || account.name, 160);
      const persistent = cleanText(account.persistent_account_id, 160);
      const current =
        balances.current == null ? null : toMoney(balances.current);
      const available =
        balances.available == null ? null : toMoney(balances.available);
      let accountId = await getAccountIdByProvider(
        database,
        "plaid",
        externalId,
      );
      if (!accountId) {
        const [existing] =
          await database.query(`SELECT a.*, c.institution_id FROM personal_finance_accounts a
        LEFT JOIN personal_finance_connections c ON c.id = a.connection_id WHERE a.external_provider = 'plaid'`);
        accountId = Number(
          findFinanceAccountIdentityMatch(
            {
              external_provider: "plaid",
              institution_id: institutionId,
              persistent_account_id: persistent,
              account_mask: mask,
              official_name: official,
              name,
              account_type: type,
              currency,
              connection_id: connectionId,
            },
            existing,
          )?.id || 0,
        );
      }
      if (accountId) {
        await database.query(
          `UPDATE personal_finance_accounts SET name = ?, account_type = ?, currency = ?,
        current_balance = ?, available_balance = ?, account_mask = ?, official_name = ?,
        persistent_account_id = COALESCE(NULLIF(?, ''), persistent_account_id),
        connection_id = GREATEST(COALESCE(connection_id, 0), ?),
        is_archived = IF(is_sync_excluded = 1, 1, 0), updated_at = ? WHERE id = ?`,
          [
            name,
            type,
            currency,
            current,
            available,
            mask || null,
            official || null,
            persistent,
            connectionId,
            now,
            accountId,
          ],
        );
      } else {
        const [result] = await database.query(
          `INSERT INTO personal_finance_accounts
        (name, account_type, opening_balance, currency, current_balance, available_balance,
         external_provider, external_account_id, connection_id, account_mask, official_name,
         persistent_account_id, color, created_at, updated_at)
        VALUES (?, ?, 0, ?, ?, ?, 'plaid', ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            name,
            type,
            currency,
            current,
            available,
            externalId,
            connectionId,
            mask || null,
            official || null,
            persistent || null,
            colorForProvider("plaid"),
            now,
            now,
          ],
        );
        accountId = Number(result.insertId);
      }
      await saveAccountAlias(database, externalId, accountId, connectionId);
      seenAccounts.push(accountId);
      if (type === "credit") {
        const [included] = await database.query(
          "SELECT is_sync_excluded FROM personal_finance_accounts WHERE id = ? AND connection_id = ?",
          [accountId, connectionId],
        );
        if (included[0] && !included[0].is_sync_excluded) creditAccountIds.push(externalId);
      }
      saved += 1;
    }
    await database.query(
      `UPDATE personal_finance_accounts SET is_archived = 1, updated_at = NOW(3)
    WHERE connection_id = ? AND external_provider = 'plaid' AND merged_into_account_id IS NULL
    ${seenAccounts.length ? `AND id NOT IN (${seenAccounts.map(() => "?").join(",")})` : ""}`,
      [connectionId, ...seenAccounts],
    );
    await database.commit();
    return { accounts: saved, creditAccountIds };
  } catch (error) {
    await database.rollback().catch(() => {});
    throw error;
  } finally {
    database.release();
  }
}

async function syncPlaidCreditCardDues(pool, connectionId, accessToken, externalIds) {
  let payload;
  try {
    payload = await plaidRequest("/liabilities/get", {
      access_token: accessToken,
      options: { account_ids: externalIds },
    });
  } catch {
    // Missing product consent, unsupported institutions, and temporary provider
    // failures must never prevent balances and transactions from refreshing.
    await pool.query(`UPDATE personal_finance_accounts
      SET credit_card_due_status = IF(credit_card_due_json IS NULL, 'unavailable', 'stale')
      WHERE connection_id = ? AND external_provider = 'plaid' AND account_type = 'credit'
        AND is_archived = 0 AND is_sync_excluded = 0 AND merged_into_account_id IS NULL`,
    [connectionId]);
    return;
  }
  const credit = Array.isArray(payload?.liabilities?.credit) ? payload.liabilities.credit : [];
  const database = await pool.getConnection();
  try {
    await database.beginTransaction();
    const [connections] = await database.query(
      "SELECT institution_id, status FROM personal_finance_connections WHERE id = ? FOR UPDATE",
      [connectionId],
    );
    if (["disconnected", "superseded"].includes(connections[0]?.status)) {
      await database.rollback();
      return;
    }
    await database.query(`UPDATE personal_finance_accounts
      SET credit_card_due_status = IF(credit_card_due_json IS NULL, 'unavailable', 'stale')
      WHERE connection_id = ? AND external_provider = 'plaid' AND account_type = 'credit'
        AND is_archived = 0 AND is_sync_excluded = 0 AND merged_into_account_id IS NULL`,
    [connectionId]);
    const syncedAt = new Date().toISOString();
    for (const card of credit) {
      if (!externalIds.includes(card?.account_id)) continue;
      const accountId = await getAccountIdByProvider(database, "plaid", card.account_id);
      if (!accountId) continue;
      const due = normalizeFinanceCreditCardDue({
        statementBalance: card.last_statement_balance,
        minimumPayment: card.minimum_payment_amount,
        dueDate: card.next_payment_due_date,
        lastStatementDate: card.last_statement_issue_date,
        lastPaymentDate: card.last_payment_date,
        lastPaymentAmount: card.last_payment_amount,
        syncedAt,
      });
      await database.query(`UPDATE personal_finance_accounts
        SET credit_card_due_json = ?, credit_card_due_status = 'current'
        WHERE id = ? AND connection_id = ? AND account_type = 'credit'
          AND is_archived = 0 AND is_sync_excluded = 0 AND merged_into_account_id IS NULL`,
      [JSON.stringify(due), accountId, connectionId]);
    }
    await database.commit();
  } catch (error) {
    await database.rollback();
    throw error;
  } finally {
    database.release();
  }
}

async function syncPlaidTransactions(pool, connectionId, accessToken, cursor) {
  let nextCursor = cursor || null;
  let hasMore = true;
  let added = 0;
  let modified = 0;
  let removed = 0;

  while (hasMore) {
    // Provider requests must finish before opening a database transaction.
    const payload = await plaidRequest("/transactions/sync", {
      access_token: accessToken,
      cursor: nextCursor,
      count: 500,
    });
    const pageCursor = payload.next_cursor || nextCursor;
    const pageHasMore = Boolean(payload.has_more);
    const database = await pool.getConnection();
    let pageAdded = 0;
    let pageModified = 0;
    let pageRemoved = 0;
    try {
      await database.beginTransaction();
      const [connectionRows] = await database.query(
        "SELECT status FROM personal_finance_connections WHERE id = ? FOR UPDATE",
        [connectionId],
      );
      if (
        !connectionRows.length ||
        ["disconnected", "superseded"].includes(connectionRows[0]?.status)
      )
        throw appError("This connection no longer syncs.", 409);
      // Different Items can import the same physical account. Serialize those
      // pages on canonical account IDs before reading or publishing their rows.
      const [linkedAccounts] = await database.query(
        `SELECT a.id FROM personal_finance_accounts a
        WHERE a.id IN (SELECT x.account_id FROM personal_finance_account_aliases x
          WHERE x.provider = 'plaid' AND x.connection_id = ?)
        ORDER BY a.id FOR UPDATE`,
        [connectionId],
      );
      const modifiedIds = new Set(
        (payload.modified || []).map((row) => row.transaction_id),
      );
      for (const transaction of [
        ...(payload.added || []),
        ...(payload.modified || []),
      ]) {
        const imported = await upsertPlaidTransaction(
          database,
          transaction,
          connectionId,
        );
        if (!imported) continue;
        if (modifiedIds.has(transaction.transaction_id)) pageModified += 1;
        else pageAdded += 1;
      }
      for (const transaction of payload.removed || []) {
        const externalTransactionId = cleanText(
          transaction?.transaction_id,
          180,
        );
        if (!externalTransactionId) continue;
        await markPlaidTransactionRemoved(
          database,
          externalTransactionId,
          connectionId,
        );
        pageRemoved += 1;
      }
      for (const account of linkedAccounts)
        await collapseDuplicateAccountTransactions(
          database,
          Number(account.id),
        );
      // Keep the original restart cursor until the complete pagination succeeds.
      // Earlier committed pages are replay-safe through provider IDs if a later
      // page fetch fails; the final page and cursor become visible together.
      if (!pageHasMore)
        await database.query(
          "UPDATE personal_finance_connections SET sync_cursor = ?, last_synced_at = ?, updated_at = ? WHERE id = ? AND status NOT IN ('disconnected', 'superseded')",
          [pageCursor, new Date(), new Date(), connectionId],
        );
      await database.commit();
    } catch (error) {
      await database.rollback().catch(() => {});
      throw error;
    } finally {
      database.release();
    }
    added += pageAdded;
    modified += pageModified;
    removed += pageRemoved;
    nextCursor = pageCursor;
    hasMore = pageHasMore;
  }
  return { added, modified, removed };
}

async function upsertPlaidTransaction(pool, transaction, connectionId) {
  const externalTransactionId = cleanText(transaction?.transaction_id, 180);
  if (!externalTransactionId) return;
  const currency = String(
    transaction?.iso_currency_code ||
      transaction?.unofficial_currency_code ||
      "",
  ).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return;

  const externalAccountId = cleanText(transaction?.account_id, 160);
  const accountId = externalAccountId
    ? await getAccountIdByProvider(pool, "plaid", externalAccountId)
    : null;
  if (accountId) {
    const [accountRows] = await pool.query(
      "SELECT is_sync_excluded FROM personal_finance_accounts WHERE id = ?",
      [accountId],
    );
    if (accountRows[0]?.is_sync_excluded) return;
  }
  const plaidAmount = Number(transaction?.amount || 0);
  const kind = plaidAmount < 0 ? "income" : "expense";
  const category = cleanText(
    humanizeCategory(transaction?.personal_finance_category?.primary) ||
      transaction?.category?.[0] ||
      transaction?.category ||
      "Uncategorized",
    80,
    "Uncategorized",
  );
  const merchant = cleanText(
    transaction?.merchant_name || transaction?.name || "",
    120,
  );
  const amount = toMoney(Math.abs(plaidAmount));
  const date = cleanDate(
    transaction?.date || new Date().toISOString().slice(0, 10),
  );
  const now = new Date();

  await pool.query(
    `INSERT INTO personal_finance_transactions
       (transaction_date, kind, account_id, category, merchant, note, amount, currency, external_provider, external_transaction_id, pending, import_account_key, import_connection_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '', ?, ?, 'plaid', ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       transaction_date = VALUES(transaction_date),
       kind = VALUES(kind),
       account_id = VALUES(account_id),
       category = VALUES(category),
       merchant = VALUES(merchant),
       amount = VALUES(amount),
       currency = VALUES(currency),
       pending = VALUES(pending),
       is_provider_removed = 0,
       import_account_key = VALUES(import_account_key),
       import_connection_id = VALUES(import_connection_id),
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
      externalAccountId,
      connectionId,
      now,
      now,
    ],
  );
  return true;
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

async function saveAccountAlias(database, externalId, accountId, connectionId) {
  await database.query(
    `INSERT INTO personal_finance_account_aliases
    (provider, external_account_id, account_id, connection_id, created_at, updated_at)
    VALUES ('plaid', ?, ?, ?, NOW(3), NOW(3))
    ON DUPLICATE KEY UPDATE account_id = VALUES(account_id), connection_id = VALUES(connection_id), updated_at = NOW(3)`,
    [externalId, accountId, connectionId],
  );
}

async function collapseDuplicateAccountTransactions(database, accountId) {
  const [rows] = await database.query(
    `SELECT *, DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transaction_date
    FROM personal_finance_transactions WHERE account_id = ? AND external_provider = 'plaid' AND is_provider_removed = 0
    ORDER BY id`,
    [accountId],
  );
  const duplicates = financeTransactionDuplicatePairs(rows);
  // One atomic update promotes surviving copies after removals without exposing a
  // transient double-counted snapshot between clearing and setting the flags.
  const cases = duplicates.map(() => "WHEN ? THEN ?").join(" ");
  await database.query(
    `UPDATE personal_finance_transactions SET duplicate_of_id = ${duplicates.length ? `CASE id ${cases} ELSE NULL END` : "NULL"}
    WHERE account_id = ? AND external_provider = 'plaid'`,
    [...duplicates.flatMap((pair) => [pair.id, pair.canonicalId]), accountId],
  );
  return duplicates.length;
}

/** Archive locally, retaining transaction history and planner references. */
export async function unlinkFinanceConnection(id) {
  const database = requirePool(await ensureFinanceSchema());
  const connectionId = cleanId(id, "Connection");
  const [rows] = await database.query(
    "SELECT provider, status, encrypted_access_token FROM personal_finance_connections WHERE id = ?",
    [connectionId],
  );
  const existing = rows[0];
  if (!existing) throw appError("Connection was not found.", 404);
  if (existing.status === "disconnected")
    return { id: connectionId, status: "disconnected" };
  if (existing.provider === "plaid" && existing.encrypted_access_token) {
    try {
      await plaidRequest("/item/remove", {
        access_token: decryptSecret(existing.encrypted_access_token),
      });
    } catch (error) {
      // A previously revoked token is already disconnected. Network errors remain retryable.
      if (
        !/INVALID_ACCESS_TOKEN|ITEM_NOT_FOUND|INVALID_ITEM|access token.*invalid/i.test(
          error.message || "",
        )
      )
        throw appError(
          "The bank connection could not be revoked. Try unlinking again.",
          502,
        );
    }
  }
  const transaction = await database.getConnection();
  try {
    await transaction.beginTransaction();
    await transaction.query(
      "UPDATE personal_finance_connections SET status = 'disconnected', encrypted_access_token = NULL, sync_cursor = NULL, updated_at = NOW(3) WHERE id = ?",
      [connectionId],
    );
    await transaction.query(
      "UPDATE personal_finance_accounts SET is_archived = 1, updated_at = NOW(3) WHERE connection_id = ?",
      [connectionId],
    );
    await transaction.commit();
    return { id: connectionId, status: "disconnected" };
  } catch (error) {
    await transaction.rollback().catch(() => {});
    throw error;
  } finally {
    transaction.release();
  }
}

async function readAccountIdentityRows(database, lock = false) {
  const [rows] =
    await database.query(`SELECT a.*, c.institution_id, c.status AS connection_status
    FROM personal_finance_accounts a LEFT JOIN personal_finance_connections c ON c.id = a.connection_id
    WHERE a.external_provider = 'plaid' ORDER BY a.id${lock ? " FOR UPDATE" : ""}`);
  return rows;
}

function publicAccountMergeGroup(group) {
  const account = group.accounts[0];
  return {
    canonicalId: group.canonicalId,
    duplicateIds: group.duplicateIds,
    reason: group.reason,
    name: account.name,
    type: account.account_type,
    currency: account.currency,
    mask: account.account_mask || "",
  };
}

/** Explicit repair action; preview does not mutate financial records or refresh balances. */
export async function repairDuplicateFinanceAccounts({
  preview = true,
  confirmedPairs = [],
} = {}) {
  const database = requirePool(await ensureFinanceSchema());
  const initial = await readAccountIdentityRows(database);
  const warnings = [];
  const refreshed = initial.map((row) => ({ ...row }));
  const [connections] =
    await database.query(`SELECT id, institution_id, status, encrypted_access_token
    FROM personal_finance_connections WHERE provider = 'plaid' AND status NOT IN ('disconnected', 'superseded')`);
  for (const connection of connections) {
    if (!connection.encrypted_access_token) continue;
    try {
      const payload = await plaidRequest("/accounts/get", {
        access_token: decryptSecret(connection.encrypted_access_token),
      });
      const institutionId =
        connection.institution_id || payload?.item?.institution_id || "";
      for (const account of payload.accounts || []) {
        const row = refreshed.find(
          (candidate) => candidate.external_account_id === account.account_id,
        );
        if (!row) continue;
        Object.assign(row, {
          institution_id: institutionId,
          account_mask: cleanText(account.mask, 16) || null,
          official_name:
            cleanText(account.official_name || account.name, 160) || null,
          persistent_account_id:
            cleanText(account.persistent_account_id, 160) || null,
        });
      }
    } catch {
      warnings.push(
        `Connection ${connection.id} could not refresh its identity details. Accounts without a confirmed match are kept separate.`,
      );
    }
  }
  let groups = financeAccountDuplicateGroups(refreshed);
  groups.push(
    ...confirmedFinanceAccountGroups(refreshed, confirmedPairs, groups),
  );
  let publicGroups = groups.map(publicAccountMergeGroup);
  if (preview !== false) {
    const matched = new Set(
      groups.flatMap((group) =>
        group.accounts.map((account) => Number(account.id)),
      ),
    );
    return {
      preview: true,
      groups: publicGroups,
      duplicateAccounts: groups.reduce(
        (sum, group) => sum + group.duplicateIds.length,
        0,
      ),
      warnings,
      unmatchedAccounts: refreshed
        .filter(
          (account) =>
            !matched.has(Number(account.id)) && !account.merged_into_account_id,
        )
        .map((account) => ({
          id: Number(account.id),
          name: account.name,
          officialName: account.official_name || "",
          type: account.account_type,
          currency: account.currency,
          mask: account.account_mask || "",
          institutionId: account.institution_id || "",
          connectionId: Number(account.connection_id),
          hasPersistentId: Boolean(account.persistent_account_id),
        })),
    };
  }
  const transaction = await database.getConnection();
  let duplicateTransactions = 0;
  const redundantConnectionIds = [];
  try {
    await transaction.beginTransaction();
    const lockedAccounts = await readAccountIdentityRows(transaction, true);
    // Provider reads happen outside the transaction. Re-read lifecycle flags
    // under lock so a concurrent local removal or unlink is never undone.
    const currentAccounts = lockedAccounts.map((row) => {
      const metadata = refreshed.find(
        (candidate) => Number(candidate.id) === Number(row.id),
      );
      return metadata
        ? {
            ...row,
            account_mask: metadata.account_mask,
            official_name: metadata.official_name,
            persistent_account_id: metadata.persistent_account_id,
          }
        : row;
    });
    groups = financeAccountDuplicateGroups(currentAccounts);
    groups.push(
      ...confirmedFinanceAccountGroups(currentAccounts, confirmedPairs, groups),
    );
    publicGroups = groups.map(publicAccountMergeGroup);
    for (const row of refreshed)
      await transaction.query(
        `UPDATE personal_finance_accounts
      SET account_mask = ?, official_name = ?, persistent_account_id = ? WHERE id = ?`,
        [
          row.account_mask || null,
          row.official_name || null,
          row.persistent_account_id || null,
          row.id,
        ],
      );
    // Establish provenance before moving rows, so two real same-day purchases are retained.
    await transaction.query(`UPDATE personal_finance_transactions t JOIN personal_finance_accounts a ON a.id = t.account_id
      SET t.import_account_key = a.external_account_id, t.import_connection_id = a.connection_id
      WHERE t.external_provider = 'plaid' AND t.import_account_key IS NULL`);
    const replacements = new Map();
    const affectedConnections = new Set();
    for (const group of groups) {
      const active = (account) =>
        !["disconnected", "superseded"].includes(account.connection_status);
      const latest = [...group.accounts].sort(
        (a, b) =>
          Number(active(b)) - Number(active(a)) ||
          Number(b.connection_id) - Number(a.connection_id) ||
          new Date(b.updated_at) - new Date(a.updated_at),
      )[0];
      const excluded = group.accounts.some(
        (account) => account.is_sync_excluded,
      );
      const archived =
        excluded ||
        !group.accounts.some(
          (account) => !account.is_archived && active(account),
        );
      const latestDue = group.accounts
        .map((account) => ({ account, due: normalizeFinanceCreditCardDue(account.credit_card_due_json) }))
        .filter(({ due }) => due)
        .sort((a, b) => (Date.parse(b.due.syncedAt) || 0) - (Date.parse(a.due.syncedAt) || 0))[0];
      for (const account of group.accounts) {
        if (account.connection_id)
          affectedConnections.add(Number(account.connection_id));
        if (account.external_account_id)
          await saveAccountAlias(
            transaction,
            account.external_account_id,
            group.canonicalId,
            account.connection_id,
          );
      }
      for (const duplicateId of group.duplicateIds) {
        replacements.set(duplicateId, group.canonicalId);
        const duplicate = group.accounts.find(
          (account) => Number(account.id) === duplicateId,
        );
        await transaction.query(
          `INSERT INTO personal_finance_account_merges
          (source_account_id, canonical_account_id, identity_reason, account_snapshot, merged_at)
          VALUES (?, ?, ?, ?, NOW(3))`,
          [
            duplicateId,
            group.canonicalId,
            group.reason,
            JSON.stringify(duplicate),
          ],
        );
        await transaction.query(
          "UPDATE personal_finance_transactions SET account_id = ? WHERE account_id = ?",
          [group.canonicalId, duplicateId],
        );
        await transaction.query(
          "UPDATE personal_finance_account_aliases SET account_id = ?, updated_at = NOW(3) WHERE account_id = ?",
          [group.canonicalId, duplicateId],
        );
        await transaction.query(
          "UPDATE personal_finance_accounts SET is_archived = 1, merged_into_account_id = ?, updated_at = NOW(3) WHERE id = ?",
          [group.canonicalId, duplicateId],
        );
      }
      await transaction.query(
        `UPDATE personal_finance_accounts SET connection_id = ?, current_balance = ?, available_balance = ?,
        account_mask = ?, official_name = ?, persistent_account_id = ?, credit_card_due_json = ?,
        credit_card_due_status = ?, is_sync_excluded = ?, is_archived = ?, updated_at = NOW(3) WHERE id = ?`,
        [
          latest.connection_id,
          latest.current_balance,
          latest.available_balance,
          latest.account_mask || null,
          latest.official_name || null,
          latest.persistent_account_id || null,
          latestDue ? JSON.stringify(latestDue.due) : null,
          latestDue ? latestDue.account.connection_id === latest.connection_id &&
            latestDue.account.credit_card_due_status === "current" ? "current" : "stale" : "unavailable",
          excluded ? 1 : 0,
          archived ? 1 : 0,
          group.canonicalId,
        ],
      );
      duplicateTransactions += await collapseDuplicateAccountTransactions(
        transaction,
        group.canonicalId,
      );
    }
    if (replacements.size) {
      try {
        const [planners] = await transaction.query(
          "SELECT document, revision FROM personal_finance_planner WHERE id = 1 FOR UPDATE",
        );
        if (planners[0]) {
          const original =
            typeof planners[0].document === "string"
              ? JSON.parse(planners[0].document)
              : planners[0].document;
          const remapped = remapFinancePlannerAccountIds(
            original,
            replacements,
          );
          if (JSON.stringify(remapped) !== JSON.stringify(original))
            await transaction.query(
              "UPDATE personal_finance_planner SET document = ?, revision = revision + 1, updated_at = NOW(3) WHERE id = 1",
              [JSON.stringify(remapped)],
            );
        }
      } catch (error) {
        if (error.errno !== 1146) throw error;
      }
    }
    for (const connectionId of affectedConnections) {
      const [active] = await transaction.query(
        "SELECT id FROM personal_finance_accounts WHERE connection_id = ? AND is_archived = 0 LIMIT 1",
        [connectionId],
      );
      if (!active.length) {
        await transaction.query(
          "UPDATE personal_finance_connections SET status = 'superseded', updated_at = NOW(3) WHERE id = ? AND status != 'disconnected'",
          [connectionId],
        );
        redundantConnectionIds.push(connectionId);
      }
    }
    await transaction.commit();
    return {
      preview: false,
      groups: publicGroups,
      mergedAccounts: replacements.size,
      duplicateTransactions,
      redundantConnectionIds,
      warnings,
    };
  } catch (error) {
    await transaction.rollback().catch(() => {});
    throw error;
  } finally {
    transaction.release();
  }
}

async function markPlaidTransactionRemoved(database, externalId, connectionId) {
  const [rows] = await database.query(
    `SELECT t.id, t.duplicate_of_id, a.connection_id AS owner_connection_id
    FROM personal_finance_transactions t LEFT JOIN personal_finance_accounts a ON a.id = t.account_id
    WHERE t.external_provider = 'plaid' AND t.external_transaction_id = ?`,
    [externalId],
  );
  const row = rows[0];
  if (!row) return;
  if (Number(row.owner_connection_id) === Number(connectionId)) {
    const canonical = Number(row.duplicate_of_id || row.id);
    await database.query(
      "UPDATE personal_finance_transactions SET is_provider_removed = 1, updated_at = NOW(3) WHERE id = ? OR duplicate_of_id = ?",
      [canonical, canonical],
    );
  } else {
    await database.query(
      "UPDATE personal_finance_transactions SET is_provider_removed = 1, updated_at = NOW(3) WHERE id = ?",
      [row.id],
    );
  }
}
