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

const runMigration = async (pool, sql) => {
  try {
    await pool.query(sql);
  } catch (err) {
    // 1060 = duplicate column, 1061 = duplicate key — safe to ignore
    if (err?.errno !== 1060 && err?.errno !== 1061) throw err;
  }
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
          visitor_id    VARCHAR(80)   PRIMARY KEY,
          first_seen_at DATETIME(3)   NOT NULL,
          last_seen_at  DATETIME(3)   NOT NULL,
          ip_hash       VARCHAR(16)   NULL,
          country       VARCHAR(64)   NULL,
          city          VARCHAR(100)  NULL,
          referrer      VARCHAR(500)  NULL,
          device_type   VARCHAR(20)   NULL,
          browser       VARCHAR(50)   NULL
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS portfolio_analytics_identified_visitors (
          visitor_id   VARCHAR(80)  PRIMARY KEY,
          email        VARCHAR(200) NOT NULL,
          name         VARCHAR(120) NOT NULL DEFAULT '',
          last_seen_at DATETIME(3)  NOT NULL,
          INDEX portfolio_analytics_identified_email_idx (email)
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS portfolio_analytics_events (
          id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          visitor_id  VARCHAR(80)  NOT NULL,
          event_type  VARCHAR(50)  NOT NULL,
          event_value VARCHAR(200) NOT NULL DEFAULT '',
          created_at  DATETIME(3)  NOT NULL,
          INDEX portfolio_analytics_events_visitor_idx (visitor_id),
          INDEX portfolio_analytics_events_type_idx (event_type)
        )
      `);

      // Migrate existing visitors table to add new columns
      const migrations = [
        "ALTER TABLE portfolio_analytics_visitors ADD COLUMN ip_hash VARCHAR(16) NULL",
        "ALTER TABLE portfolio_analytics_visitors ADD COLUMN country VARCHAR(64) NULL",
        "ALTER TABLE portfolio_analytics_visitors ADD COLUMN city VARCHAR(100) NULL",
        "ALTER TABLE portfolio_analytics_visitors ADD COLUMN referrer VARCHAR(500) NULL",
        "ALTER TABLE portfolio_analytics_visitors ADD COLUMN device_type VARCHAR(20) NULL",
        "ALTER TABLE portfolio_analytics_visitors ADD COLUMN browser VARCHAR(50) NULL"
      ];

      for (const sql of migrations) {
        await runMigration(pool, sql);
      }
    })();
  }

  await schemaReadyPromise;
  return pool;
};

const emptyStats = () => ({
  configured: false,
  totalVisits: 0,
  uniqueVisitors: 0,
  identifiedVisitors: 0,
  topCountries: [],
  topReferrers: [],
  deviceBreakdown: [],
  browserBreakdown: [],
  topDownloads: [],
  avgTimeOnPageSeconds: null
});

export async function getAnalyticsStats() {
  const pool = await ensureSchema();
  if (!pool) return emptyStats();

  const [
    [counterRows],
    [uniqueRows],
    [identifiedRows],
    [countryRows],
    [referrerRows],
    [deviceRows],
    [browserRows],
    [downloadRows],
    [timeRows]
  ] = await Promise.all([
    pool.query(
      "SELECT counter_value AS totalVisits FROM portfolio_analytics_counters WHERE counter_key = ?",
      [TOTAL_VISITS_KEY]
    ),
    pool.query("SELECT COUNT(*) AS uniqueVisitors FROM portfolio_analytics_visitors"),
    pool.query("SELECT COUNT(DISTINCT email) AS identifiedVisitors FROM portfolio_analytics_identified_visitors"),
    pool.query(`
      SELECT country, COUNT(*) AS count
      FROM portfolio_analytics_visitors
      WHERE country IS NOT NULL AND country != ''
      GROUP BY country ORDER BY count DESC LIMIT 10
    `),
    pool.query(`
      SELECT referrer, COUNT(*) AS count
      FROM portfolio_analytics_visitors
      WHERE referrer IS NOT NULL AND referrer != ''
      GROUP BY referrer ORDER BY count DESC LIMIT 10
    `),
    pool.query(`
      SELECT device_type, COUNT(*) AS count
      FROM portfolio_analytics_visitors
      WHERE device_type IS NOT NULL
      GROUP BY device_type ORDER BY count DESC
    `),
    pool.query(`
      SELECT browser, COUNT(*) AS count
      FROM portfolio_analytics_visitors
      WHERE browser IS NOT NULL
      GROUP BY browser ORDER BY count DESC LIMIT 8
    `),
    pool.query(`
      SELECT event_value AS file, COUNT(*) AS count
      FROM portfolio_analytics_events
      WHERE event_type = 'download'
      GROUP BY event_value ORDER BY count DESC LIMIT 10
    `),
    pool.query(`
      SELECT AVG(CAST(event_value AS UNSIGNED)) AS avgSeconds
      FROM portfolio_analytics_events
      WHERE event_type = 'time_on_page'
        AND event_value REGEXP '^[0-9]+$'
        AND CAST(event_value AS UNSIGNED) BETWEEN 5 AND 3600
    `)
  ]);

  return {
    configured: true,
    totalVisits: Number(counterRows[0]?.totalVisits) || 0,
    uniqueVisitors: Number(uniqueRows[0]?.uniqueVisitors) || 0,
    identifiedVisitors: Number(identifiedRows[0]?.identifiedVisitors) || 0,
    topCountries: countryRows.map((r) => ({ country: r.country, count: Number(r.count) })),
    topReferrers: referrerRows.map((r) => ({ referrer: r.referrer, count: Number(r.count) })),
    deviceBreakdown: deviceRows.map((r) => ({ device: r.device_type, count: Number(r.count) })),
    browserBreakdown: browserRows.map((r) => ({ browser: r.browser, count: Number(r.count) })),
    topDownloads: downloadRows.map((r) => ({ file: r.file, count: Number(r.count) })),
    avgTimeOnPageSeconds: timeRows[0]?.avgSeconds != null ? Math.round(Number(timeRows[0].avgSeconds)) : null
  };
}

export async function recordVisit(visitorId, meta = {}) {
  const safeVisitorId = cleanVisitorId(visitorId);
  const pool = await ensureSchema();

  if (!safeVisitorId || !pool) return getAnalyticsStats();

  const now = new Date();
  const {
    ipHash = null,
    country = null,
    city = null,
    referrer = null,
    deviceType = null,
    browser = null
  } = meta;

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    await connection.query(
      `INSERT INTO portfolio_analytics_counters (counter_key, counter_value)
       VALUES (?, 1)
       ON DUPLICATE KEY UPDATE counter_value = counter_value + 1`,
      [TOTAL_VISITS_KEY]
    );
    await connection.query(
      `INSERT INTO portfolio_analytics_visitors
         (visitor_id, first_seen_at, last_seen_at, ip_hash, country, city, referrer, device_type, browser)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         last_seen_at  = VALUES(last_seen_at),
         ip_hash       = COALESCE(VALUES(ip_hash), ip_hash),
         country       = COALESCE(VALUES(country), country),
         city          = COALESCE(VALUES(city), city),
         referrer      = COALESCE(VALUES(referrer), referrer),
         device_type   = COALESCE(VALUES(device_type), device_type),
         browser       = COALESCE(VALUES(browser), browser)`,
      [safeVisitorId, now, now, ipHash, country, city, referrer, deviceType, browser]
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

export async function recordEvent(visitorId, eventType, eventValue) {
  const safeVisitorId = cleanVisitorId(visitorId);
  const pool = await ensureSchema();

  if (!safeVisitorId || !pool) return;

  const safeType = cleanText(eventType, 50);
  const safeValue = cleanText(eventValue, 200);

  if (!safeType) return;

  await pool.query(
    `INSERT INTO portfolio_analytics_events (visitor_id, event_type, event_value, created_at)
     VALUES (?, ?, ?, ?)`,
    [safeVisitorId, safeType, safeValue, new Date()]
  );
}

export async function identifyVisitor({ visitorId, email, name }) {
  const safeVisitorId = cleanVisitorId(visitorId);
  const safeEmail = cleanEmail(email);
  const pool = await ensureSchema();

  if (!safeVisitorId || !safeEmail || !pool) return getAnalyticsStats();

  const now = new Date();
  const safeName = cleanText(name, 120);

  await pool.query(
    `INSERT INTO portfolio_analytics_identified_visitors (visitor_id, email, name, last_seen_at)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       email        = VALUES(email),
       name         = VALUES(name),
       last_seen_at = VALUES(last_seen_at)`,
    [safeVisitorId, safeEmail, safeName, now]
  );

  return getAnalyticsStats();
}

export async function getIdentifiedVisitors() {
  const pool = await ensureSchema();
  if (!pool) return { configured: false, visitors: [] };

  const [rows] = await pool.query(
    `SELECT visitor_id, email, name, last_seen_at
     FROM portfolio_analytics_identified_visitors
     ORDER BY last_seen_at DESC
     LIMIT ?`,
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
