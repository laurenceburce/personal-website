import mysql from "mysql2/promise";

const MAX_BYTES = 1_000_000;
const RATE_CACHE_MS = 60 * 60 * 1000;
const MAX_AMOUNT = 999_999_999;
const DAY_MS = 86_400_000;
let pool;
let schemaPromise;
let rateCache;
let rateRequest;
let lastRateAttempt = 0;

function plannerError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function databaseUrl() {
  return process.env.FINANCE_DATABASE_URL || process.env.DATABASE_URL
    || process.env.MYSQL_URL || process.env.MYSQL_PUBLIC_URL || "";
}

function today() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function createDefaultFinancePlanner() {
  return {
    salary: { amount: 2000, currency: "USD", payFrequency: "biweekly", firstPayDate: today() },
    bills: [], allocations: [], plans: []
  };
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw plannerError(`${label} is required.`);
  return value;
}

function text(value, label, max, optional = false) {
  if (typeof value !== "string" || value.length > max) throw plannerError(`${label} must be text of at most ${max} characters.`);
  const clean = value.trim();
  if (!optional && !clean) throw plannerError(`${label} is required.`);
  return clean;
}

function amount(value, label, signed = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_AMOUNT || (!signed && value < 0)) {
    throw plannerError(`${label} must be a ${signed ? "valid" : "non-negative"} amount below one billion.`);
  }
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw plannerError(`${label} is invalid.`);
  return value;
}

function date(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw plannerError(`${label} must be a valid date.`);
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value || value < "1900-01-01" || value > "2200-12-31") {
    throw plannerError(`${label} must be a valid date between 1900 and 2200.`);
  }
  return value;
}

function boolean(value, label) {
  if (typeof value !== "boolean") throw plannerError(`${label} must be true or false.`);
  return value;
}

function rows(value, label, max, mapper) {
  if (!Array.isArray(value) || value.length > max) throw plannerError(`${label} must contain at most ${max} rows.`);
  const ids = new Set();
  return value.map((item, index) => {
    const entry = object(item, `${label} row ${index + 1}`);
    const id = text(entry.id, `${label} row ID`, 100);
    if (!/^[A-Za-z0-9_-]+$/.test(id) || ids.has(id)) throw plannerError(`${label} row IDs must be unique letters, numbers, dashes or underscores.`);
    ids.add(id);
    return { id, ...mapper(entry, index) };
  });
}

/** Normalize only known fields; never persist arbitrary caller properties. */
export function validateFinancePlanner(value) {
  const source = object(value, "Planner");
  if (Buffer.byteLength(JSON.stringify(source), "utf8") > MAX_BYTES) throw plannerError("The planner is too large. Export or remove older plans first.", 413);
  const salary = object(source.salary, "Salary");
  return {
    salary: {
      amount: amount(salary.amount, "Monthly salary"),
      currency: oneOf(salary.currency, ["USD", "PHP"], "Salary currency"),
      payFrequency: oneOf(salary.payFrequency, ["semimonthly", "biweekly"], "Pay frequency"),
      firstPayDate: date(salary.firstPayDate, "First payday")
    },
    bills: rows(source.bills, "Bills", 300, (bill) => {
      const cadence = oneOf(bill.cadence, ["monthly", "annual", "payday"], "Bill frequency");
      // Payday bills follow the salary schedule; discard any old fixed-date fields.
      const legacyDueDay = cadence === "payday" ? null : (bill.dueDay ?? null);
      if (legacyDueDay !== null && (!Number.isInteger(legacyDueDay) || legacyDueDay < 1 || legacyDueDay > 31)) throw plannerError("Bill due day must be between 1 and 31, or left open.");
      let dueDays = [];
      if (cadence === "monthly") {
        const inputDays = bill.dueDays === undefined ? (legacyDueDay === null ? [] : [legacyDueDay]) : bill.dueDays;
        if (!Array.isArray(inputDays) || inputDays.length > 31 || inputDays.some((day) => !Number.isInteger(day) || day < 1 || day > 31)) {
          throw plannerError("Choose up to two monthly due days between 1 and 31.");
        }
        dueDays = [...new Set(inputDays)].sort((a, b) => a - b);
        if (dueDays.length > 2) throw plannerError("Choose up to two monthly due days between 1 and 31.");
      }
      const dueDay = cadence === "monthly" ? (dueDays[0] ?? null) : legacyDueDay;
      if (cadence !== "payday" && (!Array.isArray(bill.dueMonths) || bill.dueMonths.length > 12 || bill.dueMonths.some((month) => !Number.isInteger(month) || month < 1 || month > 12))) {
        throw plannerError("Bill due months must be between 1 and 12.");
      }
      const dueMonths = cadence === "payday" ? [] : [...new Set(bill.dueMonths)].sort((a, b) => a - b);
      if (cadence === "annual" && !dueMonths.length) throw plannerError("Choose at least one due month for annual bills.");
      return {
        name: text(bill.name, "Bill item", 120), amount: amount(bill.amount, "Bill amount"),
        currency: oneOf(bill.currency, ["USD", "PHP"], "Bill currency"), cadence, dueDay, dueDays,
        savedAmount: cadence === "annual" ? amount(bill.savedAmount === undefined ? 0 : bill.savedAmount, "Saved amount") : 0,
        dueMonths: cadence === "annual" ? dueMonths : [],
        paymentMethod: text(bill.paymentMethod, "Payment method", 80, true),
        isAutopay: boolean(bill.isAutopay, "Automatic payment")
      };
    }),
    allocations: rows(source.allocations, "Spending allocations", 300, (allocation) => ({
      name: text(allocation.name, "Allocation name", 120), amount: amount(allocation.amount, "Allocation amount"),
      currency: oneOf(allocation.currency, ["USD", "PHP"], "Allocation currency"),
      kind: oneOf(allocation.kind, ["savings", "expense"], "Allocation kind")
    })),
    plans: rows(source.plans, "Budget plans", 50, (plan) => {
      const startDate = date(plan.startDate, "Plan start date");
      const endDate = date(plan.endDate, "Plan end date");
      if (endDate < startDate || (Date.parse(endDate) - Date.parse(startDate)) / DAY_MS > 731) {
        throw plannerError("Plan dates must be in order and no more than two years apart.");
      }
      return {
        name: text(plan.name, "Plan name", 120), startDate, endDate,
        openingUsd: amount(plan.openingUsd, "Opening USD balance", true),
        openingPhp: amount(plan.openingPhp, "Opening PHP balance", true),
        openingReserveUsd: amount(plan.openingReserveUsd === undefined ? 0 : plan.openingReserveUsd, "Opening annual reserve USD"),
        openingReservePhp: amount(plan.openingReservePhp === undefined ? 0 : plan.openingReservePhp, "Opening annual reserve PHP"),
        includeIncome: boolean(plan.includeIncome, "Include salary"),
        includeTransactions: plan.includeTransactions === undefined ? true : boolean(plan.includeTransactions, "Include recorded transactions"),
        includeAllocations: plan.includeAllocations === undefined ? true : boolean(plan.includeAllocations, "Include payday allocations"),
        includeAnnualReserve: plan.includeAnnualReserve === undefined ? true : boolean(plan.includeAnnualReserve, "Include annual reserves"),
        entries: rows(plan.entries, "Plan entries", 1000, (entry) => {
          const entryDate = date(entry.date, "Entry date");
          if (entryDate < startDate || entryDate > endDate) throw plannerError("Entry dates must be within the plan's date range.");
          return {
            date: entryDate, description: text(entry.description, "Entry description", 160),
            kind: oneOf(entry.kind, ["income", "expense", "conversion"], "Entry kind"),
            amount: amount(entry.amount, "Entry amount"), currency: oneOf(entry.currency, ["USD", "PHP"], "Entry currency")
          };
        })
      };
    })
  };
}

async function optionalQuery(connection, sql, params = []) {
  try {
    const [result] = await connection.query(sql, params);
    return result;
  } catch (error) {
    if (error?.errno === 1146) return [];
    throw error;
  }
}

function legacyRate(settings) {
  const rate = Number(settings.exchangeRate);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1000) return null;
  return {
    rate, date: /^\d{4}-\d{2}-\d{2}$/.test(settings.exchangeRateDate || "") ? settings.exchangeRateDate : "",
    fetchedAt: settings.exchangeRateUpdatedAt || null,
    source: settings.exchangeRateSource || "Previously saved rate", stale: true, error: null
  };
}

async function importLegacy(connection) {
  const document = createDefaultFinancePlanner();
  const settingsRows = await optionalQuery(connection, "SELECT setting_key, setting_value FROM personal_finance_settings");
  const settings = Object.fromEntries(settingsRows.map((row) => [row.setting_key, row.setting_value]));
  const monthlyIncome = Number(settings.monthlyIncomeUsd);
  if (Number.isFinite(monthlyIncome) && monthlyIncome >= 0 && monthlyIncome <= MAX_AMOUNT) document.salary.amount = monthlyIncome;
  const bills = await optionalQuery(connection, "SELECT id, name, amount_usd, amount_php, due_label, payment_account, is_autopay FROM personal_finance_recurring_bills ORDER BY display_order, id LIMIT 300");
  document.bills = bills.filter((bill) => !/^annual(?:\s+bills?)?$/i.test(bill.name.trim())).map((bill) => {
    const phpNative = /rcbc|gcash/i.test(bill.payment_account) || /^(spotify|globe|converge|house)$/i.test(bill.name.trim()) || Number(bill.amount_usd) <= 0;
    const dayMatch = String(bill.due_label || "").match(/^([1-9]|[12][0-9]|3[01])(?:st|nd|rd|th)?$/i);
    return {
      id: `legacy-${bill.id}`, name: bill.name, amount: Number(phpNative ? bill.amount_php : bill.amount_usd),
      currency: phpNative ? "PHP" : "USD", cadence: "monthly", dueDay: dayMatch ? Number(dayMatch[1]) : null,
      dueMonths: [], paymentMethod: bill.payment_account || "", isAutopay: Boolean(bill.is_autopay)
    };
  });
  return { document: validateFinancePlanner(document), exchangeRate: legacyRate(settings) };
}

async function ensureSchema() {
  const url = databaseUrl();
  if (!url) return null;
  if (!pool) pool = mysql.createPool({ uri: url, connectionLimit: 3, connectTimeout: 5000, waitForConnections: true, enableKeepAlive: true });
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS personal_finance_planner (
        id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
        document LONGTEXT NOT NULL,
        revision INT UNSIGNED NOT NULL DEFAULT 1,
        exchange_rate TEXT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL
      )`);
      const [existing] = await pool.query("SELECT id FROM personal_finance_planner WHERE id = 1");
      if (!existing.length) {
        const imported = await importLegacy(pool);
        await pool.execute("INSERT IGNORE INTO personal_finance_planner (id, document, revision, exchange_rate, created_at, updated_at) VALUES (1, ?, 1, ?, NOW(3), NOW(3))", [JSON.stringify(imported.document), imported.exchangeRate ? JSON.stringify(imported.exchangeRate) : null]);
      }
    })().catch((error) => { schemaPromise = null; throw error; });
  }
  await schemaPromise;
  return pool;
}

function parseStoredRate(value) {
  if (!value) return null;
  try {
    const stored = JSON.parse(value);
    if (!Number.isFinite(stored.rate) || stored.rate <= 0 || stored.rate > 1000) return null;
    return {
      rate: stored.rate, date: typeof stored.date === "string" ? stored.date : "",
      fetchedAt: typeof stored.fetchedAt === "string" ? stored.fetchedAt : null,
      source: typeof stored.source === "string" ? stored.source : "Previously saved rate",
      stale: !stored.fetchedAt || Date.now() - Date.parse(stored.fetchedAt) >= RATE_CACHE_MS, error: null
    };
  } catch { return null; }
}

const estimateRate = () => ({
  rate: 58, date: "", fetchedAt: null, source: "Planning estimate", stale: true,
  error: "A current exchange rate is unavailable. Conversions use an estimate until a refresh succeeds."
});

async function latestRate(connection = null, storedRate = null, force = false) {
  if (!rateCache && storedRate) rateCache = parseStoredRate(storedRate);
  if (!force && rateCache?.fetchedAt && !rateCache.stale && Date.now() - Date.parse(rateCache.fetchedAt) < RATE_CACHE_MS) return rateCache;
  if (rateRequest) return rateRequest;
  // An unavailable provider should not delay every keystroke or page reload.
  if (!force && Date.now() - lastRateAttempt < 60_000) return rateCache || estimateRate();
  rateRequest = (async () => {
    lastRateAttempt = Date.now();
    try {
      const response = await fetch("https://api.frankfurter.dev/v2/rate/usd/php", {
        cache: "no-store", signal: AbortSignal.timeout(6000), headers: { Accept: "application/json" }
      });
      if (!response.ok) throw new Error("Rate provider unavailable");
      const result = await response.json();
      if (result.base !== "USD" || result.quote !== "PHP" || typeof result.rate !== "number" || !Number.isFinite(result.rate) || result.rate <= 0 || result.rate > 1000 || !/^\d{4}-\d{2}-\d{2}$/.test(result.date || "")) throw new Error("Invalid exchange rate");
      rateCache = { rate: result.rate, date: result.date, fetchedAt: new Date().toISOString(), source: "Frankfurter · daily reference rate", stale: false, error: null };
      if (connection) await connection.execute("UPDATE personal_finance_planner SET exchange_rate = ? WHERE id = 1", [JSON.stringify(rateCache)]).catch(() => {});
      return rateCache;
    } catch {
      rateCache = rateCache ? { ...rateCache, stale: true, error: "Rate refresh failed. Conversions use the last available reference rate." } : estimateRate();
      return rateCache;
    } finally { rateRequest = null; }
  })();
  return rateRequest;
}

export async function getFinancePlanner() {
  try {
    const connection = await ensureSchema();
    if (!connection) return { configured: false, document: createDefaultFinancePlanner(), revision: 0, exchangeRate: await latestRate(), warning: "Connect MySQL to save your finance data and sync it across devices." };
    const [rows] = await connection.query("SELECT document, revision, exchange_rate FROM personal_finance_planner WHERE id = 1");
    if (!rows.length) throw new Error("Planner row unavailable");
    return {
      configured: true, document: validateFinancePlanner(JSON.parse(rows[0].document)), revision: Number(rows[0].revision),
      exchangeRate: await latestRate(connection, rows[0].exchange_rate)
    };
  } catch {
    return {
      configured: false, document: createDefaultFinancePlanner(), revision: 0, exchangeRate: await latestRate(),
      warning: "Your finance database is temporarily unavailable. Your saved data has not been changed. Reconnect MySQL and reload to continue."
    };
  }
}

export async function saveFinancePlanner(value, revision) {
  const document = validateFinancePlanner(value);
  if (!Number.isInteger(revision) || revision < 1 || revision > 4_294_967_294) throw plannerError("Reload the planner before saving.", 409);
  let database;
  try { database = await ensureSchema(); } catch { throw plannerError("Your finance database is unavailable. Reconnect MySQL and try again.", 503); }
  if (!database) throw plannerError("Connect MySQL before saving your finance planner.", 503);
  let connection;
  try {
    connection = await database.getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.query("SELECT revision, exchange_rate FROM personal_finance_planner WHERE id = 1 FOR UPDATE");
    if (!rows.length || Number(rows[0].revision) !== revision) throw plannerError("This planner changed on another device. Reload to get the latest data before saving.", 409);
    await connection.execute("UPDATE personal_finance_planner SET document = ?, revision = revision + 1, updated_at = NOW(3) WHERE id = 1", [JSON.stringify(document)]);
    await connection.commit();
    return { configured: true, document, revision: revision + 1, exchangeRate: await latestRate(database, rows[0].exchange_rate) };
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    if (error.status) throw error;
    throw plannerError("Your changes could not be saved. Check the database connection and try again.", 503);
  } finally { connection?.release(); }
}

export async function refreshPlannerExchangeRate() {
  let database;
  let storedRate;
  try {
    database = await ensureSchema();
    if (database) {
      const [rows] = await database.query("SELECT exchange_rate FROM personal_finance_planner WHERE id = 1");
      storedRate = rows[0]?.exchange_rate;
    }
  } catch { /* Reference-rate refresh also works while MySQL is unavailable. */ }
  return latestRate(database, storedRate, true);
}
