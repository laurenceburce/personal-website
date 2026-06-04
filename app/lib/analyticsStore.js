import mysql from "mysql2/promise";

const TOTAL_VISITS_KEY = "total_visits";
const MAX_IDENTIFIED_RESULTS = 50;

let poolPromise = null;
let schemaReadyPromise = null;

const getDatabaseUrl = () => process.env.DATABASE_URL || process.env.MYSQL_URL || "";
const isConfigured = () => Boolean(getDatabaseUrl());

const cleanVisitorId = (visitorId) => (
  typeof visitorId === "string" && /^[a-zA-Z0-9_-]{16,80}$/.test(visitorId)
    ? visitorId
    : null
);

const cleanText = (value, maxLength) => String(value || "").trim().slice(0, maxLength);

const cleanEmail = (email) => {
  const value = cleanText(email, 200).toLowerCase();
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  return emailPattern.test(value) ? value : null;
};

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

const ensureSchema = async () => {
  const pool = await getPool();
  if (!pool) return null;

  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS portfolio_analytics_counters (
          counter_key VARCHAR(64) PRIMARY KEY,
          counter_value BIGINT UNSIGNED NOT NULL DEFAULT 0
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS portfolio_analytics_visitors (
          visitor_id VARCHAR(80) PRIMARY KEY,
          first_seen_at DATETIME(3) NOT NULL,
          last_seen_at DATETIME(3) NOT NULL
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS portfolio_analytics_identified_visitors (
          visitor_id VARCHAR(80) PRIMARY KEY,
          email VARCHAR(200) NOT NULL,
          name VARCHAR(120) NOT NULL DEFAULT '',
          last_seen_at DATETIME(3) NOT NULL,
          INDEX portfolio_analytics_identified_email_idx (email)
        )
      `);
    })();
  }

  await schemaReadyPromise;
  return pool;
};

const emptyStats = () => ({
  configured: false,
  totalVisits: 0,
  uniqueVisitors: 0,
  identifiedVisitors: 0
});

export async function getAnalyticsStats() {
  const pool = await ensureSchema();
  if (!pool) return emptyStats();

  const [[counterRows], [uniqueRows], [identifiedRows]] = await Promise.all([
    pool.query(
      "SELECT counter_value AS totalVisits FROM portfolio_analytics_counters WHERE counter_key = ?",
      [TOTAL_VISITS_KEY]
    ),
    pool.query("SELECT COUNT(*) AS uniqueVisitors FROM portfolio_analytics_visitors"),
    pool.query("SELECT COUNT(DISTINCT email) AS identifiedVisitors FROM portfolio_analytics_identified_visitors")
  ]);

  return {
    configured: true,
    totalVisits: Number(counterRows[0]?.totalVisits) || 0,
    uniqueVisitors: Number(uniqueRows[0]?.uniqueVisitors) || 0,
    identifiedVisitors: Number(identifiedRows[0]?.identifiedVisitors) || 0
  };
}

export async function recordVisit(visitorId) {
  const safeVisitorId = cleanVisitorId(visitorId);
  const pool = await ensureSchema();

  if (!safeVisitorId || !pool) return getAnalyticsStats();

  const now = new Date();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    await connection.query(
      `
        INSERT INTO portfolio_analytics_counters (counter_key, counter_value)
        VALUES (?, 1)
        ON DUPLICATE KEY UPDATE counter_value = counter_value + 1
      `,
      [TOTAL_VISITS_KEY]
    );
    await connection.query(
      `
        INSERT INTO portfolio_analytics_visitors (visitor_id, first_seen_at, last_seen_at)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE last_seen_at = VALUES(last_seen_at)
      `,
      [safeVisitorId, now, now]
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return getAnalyticsStats();
}

export async function identifyVisitor({ visitorId, email, name }) {
  const safeVisitorId = cleanVisitorId(visitorId);
  const safeEmail = cleanEmail(email);
  const pool = await ensureSchema();

  if (!safeVisitorId || !safeEmail || !pool) return getAnalyticsStats();

  const now = new Date();
  const safeName = cleanText(name, 120);

  await pool.query(
    `
      INSERT INTO portfolio_analytics_identified_visitors (visitor_id, email, name, last_seen_at)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        email = VALUES(email),
        name = VALUES(name),
        last_seen_at = VALUES(last_seen_at)
    `,
    [safeVisitorId, safeEmail, safeName, now]
  );

  return getAnalyticsStats();
}

export async function getIdentifiedVisitors() {
  const pool = await ensureSchema();
  if (!pool) {
    return {
      configured: false,
      visitors: []
    };
  }

  const [rows] = await pool.query(
    `
      SELECT visitor_id, email, name, last_seen_at
      FROM portfolio_analytics_identified_visitors
      ORDER BY last_seen_at DESC
      LIMIT ?
    `,
    [MAX_IDENTIFIED_RESULTS]
  );

  return {
    configured: true,
    visitors: rows.map((row) => ({
      visitorId: row.visitor_id,
      email: row.email,
      name: row.name || "",
      lastSeenAt: row.last_seen_at instanceof Date
        ? row.last_seen_at.toISOString()
        : String(row.last_seen_at)
    }))
  };
}
