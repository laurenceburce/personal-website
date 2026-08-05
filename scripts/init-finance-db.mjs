import mysql from "mysql2/promise";

const databaseUrl = process.env.FINANCE_DATABASE_URL
  || process.env.MYSQL_PUBLIC_URL
  || process.env.DATABASE_URL
  || process.env.MYSQL_URL;
const shouldSeed = process.argv.includes("--seed");

if (!databaseUrl) {
  console.error("DATABASE_URL or MYSQL_URL is required.");
  process.exit(1);
}

const starterBills = [
  ["Google", 2, 116, "18", "US Bank Credit", 1, 1],
  ["Microsoft", 10, 580, "7", "US Bank Credit", 1, 2],
  ["Discord", 10, 580, "7", "US Bank Credit", 1, 3],
  ["ChatGPT", 20, 1160, "28", "US Bank Credit", 1, 4],
  ["Railway", 5, 290, "4", "US Bank Credit", 1, 5],
  ["Namecheap", 1.5, 87, "4", "US Bank Credit", 1, 6],
  ["Spotify", 2.91, 169, "28", "GCash", 1, 7],
  ["Globe", 25.86, 1500, "11", "RCBC Flex", 1, 8],
  ["Converge", 43.1, 2500, "28", "", 0, 9],
  ["House", 689.66, 40000, "Saturday", "", 0, 10]
];

const starterGoals = [
  ["PC Build - Phase 1", "USD", 1400, 1320.4, "PC Build", "CPU, motherboard, and RAM.", 1],
  ["PC Build - Phase 2", "USD", 2850, 0, "PC Build", "GPU, main monitor, and PSU.", 2],
  ["PC Build - Phase 3", "USD", 1650, 140, "PC Build", "Extra monitors, case, and cooling.", 3],
  ["PH Reserve", "PHP", 500000, 77500, "Reserve", "Large one-time obligations reserve from the workbook.", 4]
];

const settings = {
  monthlyIncomeUsd: 2000,
  exchangeRate: 58,
  displayCurrency: "USD",
  biweeklyIncomeUsd: 1000,
  biweeklyBillsUsd: 400,
  biweeklySavingsUsd: 500
};

async function runMigration(pool, sql) {
  try {
    await pool.query(sql);
  } catch (err) {
    if (![1060, 1061, 1062].includes(err?.errno)) throw err;
  }
}

const pool = mysql.createPool({
  uri: databaseUrl,
  connectionLimit: 2,
  waitForConnections: true,
  enableKeepAlive: true
});

try {
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

  if (shouldSeed) {
    const now = new Date();

    for (const [key, value] of Object.entries(settings)) {
      await pool.query(
        `INSERT INTO personal_finance_settings (setting_key, setting_value, updated_at)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = VALUES(updated_at)`,
        [key, String(value), now]
      );
    }

    for (const bill of starterBills) {
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
        [...bill, now, now]
      );
    }

    for (const goal of starterGoals) {
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
        [...goal, now, now]
      );
    }
  }

  const [tables] = await pool.query(`
    SELECT table_name AS tableName
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_name LIKE 'personal_finance_%'
    ORDER BY table_name
  `);

  console.log(`Finance schema ready: ${tables.length} tables.`);
  if (shouldSeed) console.log(`Seeded starter bills: ${starterBills.length}; starter goals: ${starterGoals.length}.`);
} finally {
  await pool.end();
}
