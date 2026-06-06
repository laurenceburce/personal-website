import mysql from "mysql2/promise";

const TOTAL_VISITS_KEY = "total_visits";
const MAX_IDENTIFIED_RESULTS = 50;
const SHARE_ID_PATTERN = /^[a-zA-Z0-9_-]{8,40}$/;

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

const cleanShareId = (shareId) => (
  typeof shareId === "string" && SHARE_ID_PATTERN.test(shareId)
    ? shareId
    : null
);

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
          auth_provider VARCHAR(40) NULL,
          profile_image VARCHAR(500) NULL,
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

      await pool.query(`
        CREATE TABLE IF NOT EXISTS portfolio_analytics_visits (
          id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          visitor_id  VARCHAR(80)  NOT NULL,
          visited_at  DATETIME(3)  NOT NULL,
          ip_address  VARCHAR(45)  NULL,
          country     VARCHAR(64)  NULL,
          city        VARCHAR(100) NULL,
          referrer    VARCHAR(500) NULL,
          device_type VARCHAR(20)  NULL,
          browser     VARCHAR(50)  NULL,
          referred_by_share_id VARCHAR(40) NULL,
          referred_by_ip_address VARCHAR(45) NULL,
          INDEX portfolio_analytics_visits_at_idx (visited_at DESC),
          INDEX portfolio_analytics_visits_visitor_idx (visitor_id)
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS portfolio_sketch_shares (
          share_id VARCHAR(40) PRIMARY KEY,
          creator_visitor_id VARCHAR(80) NULL,
          creator_ip_address VARCHAR(45) NULL,
          creator_ip_hash VARCHAR(16) NULL,
          payload_json LONGTEXT NOT NULL,
          created_at DATETIME(3) NOT NULL,
          INDEX portfolio_sketch_shares_created_idx (created_at DESC)
        )
      `);

      await runMigration(pool, "ALTER TABLE portfolio_analytics_visits ADD COLUMN ip_address VARCHAR(45) NULL AFTER visitor_id");
      await runMigration(pool, "ALTER TABLE portfolio_analytics_visits ADD COLUMN referred_by_share_id VARCHAR(40) NULL");
      await runMigration(pool, "ALTER TABLE portfolio_analytics_visits ADD COLUMN referred_by_ip_address VARCHAR(45) NULL");
      await runMigration(pool, "ALTER TABLE portfolio_analytics_identified_visitors ADD COLUMN auth_provider VARCHAR(40) NULL");
      await runMigration(pool, "ALTER TABLE portfolio_analytics_identified_visitors ADD COLUMN profile_image VARCHAR(500) NULL");

      await pool.query(`
        CREATE TABLE IF NOT EXISTS portfolio_chat_logs (
          id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          email        VARCHAR(200) NULL,
          user_message TEXT         NOT NULL,
          ai_response  TEXT         NOT NULL,
          model        VARCHAR(50)  NOT NULL DEFAULT '',
          ip_address   VARCHAR(45)  NULL,
          created_at   DATETIME(3)  NOT NULL,
          INDEX portfolio_chat_logs_email_idx (email),
          INDEX portfolio_chat_logs_created_idx (created_at DESC)
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

      // One-time data migration: rename old 'link_click' events to 'Section: Label' format.
      // Tracked by a counter key so it only ever runs once, even across server restarts.
      const LINK_MIGRATION_KEY = "link_events_migrated_v1";
      const [[migrationFlag]] = await pool.query(
        "SELECT counter_value FROM portfolio_analytics_counters WHERE counter_key = ? LIMIT 1",
        [LINK_MIGRATION_KEY]
      );

      if (!migrationFlag?.counter_value) {
        // Split old "Label | URL" value into new event_type + event_value.
        // Known sidebar/header labels get exact section names; everything else
        // falls back to "Link: <first 22 chars of label>".
        await pool.query(`
          UPDATE portfolio_analytics_events
          SET
            event_type = CASE
              WHEN event_value LIKE 'GitHub Profile | %'       THEN 'Sidebar: GitHub'
              WHEN event_value LIKE 'LinkedIn Profile | %'     THEN 'Sidebar: LinkedIn'
              WHEN event_value LIKE 'Email Laurence | %'       THEN 'Sidebar: Email'
              WHEN event_value LIKE 'Call Laurence | %'        THEN 'Sidebar: Phone'
              WHEN event_value LIKE 'Home | %'                 THEN 'Sidebar: Home'
              WHEN event_value LIKE 'Laurence Alec Burce | %'  THEN 'Sidebar: Home'
              WHEN event_value LIKE 'About | %'                THEN 'Sidebar: About'
              WHEN event_value LIKE 'Work Experience | %'      THEN 'Sidebar: Work Experience'
              WHEN event_value LIKE 'Education | %'            THEN 'Sidebar: Education'
              WHEN event_value LIKE 'Skills | %'               THEN 'Sidebar: Skills'
              WHEN event_value LIKE 'Projects | %'             THEN 'Sidebar: Projects'
              ELSE CONCAT('Link: ', LEFT(SUBSTRING_INDEX(event_value, ' | ', 1), 22))
            END,
            event_value = CASE
              WHEN INSTR(event_value, ' | ') > 0
                THEN SUBSTR(event_value, INSTR(event_value, ' | ') + 3)
              ELSE event_value
            END
          WHERE event_type = 'link_click'
        `);

        await pool.query(
          `INSERT INTO portfolio_analytics_counters (counter_key, counter_value) VALUES (?, 1)
           ON DUPLICATE KEY UPDATE counter_value = 1`,
          [LINK_MIGRATION_KEY]
        );
      }

      // v2 migration: fix label-only old events that landed in the ELSE branch of v1.
      // Those had no " | URL" separator, so LIKE patterns missed them and produced
      // "Link: Education" with event_value="Education". Reclassify to proper names.
      // Also promotes old 'download' and 'sketch_share_created' types to new format.
      const LINK_MIGRATION_V2_KEY = "link_events_migrated_v2";
      const [[migrationFlagV2]] = await pool.query(
        "SELECT counter_value FROM portfolio_analytics_counters WHERE counter_key = ? LIMIT 1",
        [LINK_MIGRATION_V2_KEY]
      );

      if (!migrationFlagV2?.counter_value) {
        // Fix misclassified nav/contact/download "Link: X" events
        await pool.query(`
          UPDATE portfolio_analytics_events
          SET
            event_type = CASE
              WHEN event_type = 'Link: About'               THEN 'Sidebar: About'
              WHEN event_type = 'Link: Work Experience'     THEN 'Sidebar: Work Experience'
              WHEN event_type = 'Link: Education'           THEN 'Sidebar: Education'
              WHEN event_type = 'Link: Skills'              THEN 'Sidebar: Skills'
              WHEN event_type = 'Link: Projects'            THEN 'Sidebar: Projects'
              WHEN event_type = 'Link: Home'                THEN 'Sidebar: Home'
              WHEN event_type = 'Link: Laurence Alec Burce' THEN 'Sidebar: Home'
              WHEN event_type = 'Link: GitHub Profile'      THEN 'Sidebar: GitHub'
              WHEN event_type = 'Link: LinkedIn Profile'    THEN 'Sidebar: LinkedIn'
              WHEN event_type = 'Link: Email Laurence'      THEN 'Sidebar: Email'
              WHEN event_type = 'Link: Call Laurence'       THEN 'Sidebar: Phone'
              WHEN event_type = 'Link: /api/download/resume' THEN 'Download: Resume'
              WHEN event_type = 'Link: Download Resume'     THEN 'Download: Resume'
              WHEN event_type = 'Link: Download Cover Letter' THEN 'Download: Cover Letter'
              ELSE event_type
            END,
            event_value = CASE
              WHEN event_type IN (
                'Link: About', 'Link: Work Experience', 'Link: Education',
                'Link: Skills', 'Link: Projects', 'Link: Home',
                'Link: Laurence Alec Burce', 'Link: GitHub Profile',
                'Link: LinkedIn Profile', 'Link: Email Laurence',
                'Link: Call Laurence', 'Link: Download Resume',
                'Link: Download Cover Letter'
              ) THEN ''
              ELSE event_value
            END
          WHERE event_type LIKE 'Link: %'
        `);

        await pool.query(`
          UPDATE portfolio_analytics_events
          SET
            event_type  = CONCAT('Download: ', event_value),
            event_value = ''
          WHERE event_type = 'download'
            AND event_value IN ('Resume', 'Cover Letter')
        `);

        await pool.query(`
          UPDATE portfolio_analytics_events
          SET event_type = 'Sketch: Share Created'
          WHERE event_type = 'sketch_share_created'
        `);

        await pool.query(
          `INSERT INTO portfolio_analytics_counters (counter_key, counter_value) VALUES (?, 1)
           ON DUPLICATE KEY UPDATE counter_value = 1`,
          [LINK_MIGRATION_V2_KEY]
        );
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
  topLinkClicks: [],
  downloadEvents: [],
  linkClickEvents: [],
  avgTimeOnPageSeconds: null,
  firstVisitAt: null
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
    [linkClickRows],
    [downloadEventRows],
    [linkClickEventRows],
    [timeRows],
    [firstVisitRows]
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
      SELECT
        CASE WHEN event_type = 'download' THEN event_value
             ELSE SUBSTR(event_type, 11) END AS file,
        COUNT(*) AS count
      FROM portfolio_analytics_events
      WHERE event_type = 'download' OR event_type LIKE 'Download: %'
      GROUP BY file ORDER BY count DESC LIMIT 10
    `),
    pool.query(`
      SELECT
        CASE WHEN event_type = 'link_click' THEN event_value
             ELSE CONCAT(event_type,
               CASE WHEN event_value != ''
                         AND event_value != SUBSTR(event_type, INSTR(event_type, ': ') + 2)
                    THEN CONCAT(' → ', event_value)
                    ELSE '' END)
        END AS link,
        COUNT(*) AS count
      FROM portfolio_analytics_events
      WHERE event_type = 'link_click'
         OR (event_type LIKE '%: %'
             AND event_type NOT LIKE 'Download: %'
             AND event_type NOT LIKE 'Sketch: %'
             AND event_type != 'time_on_page')
      GROUP BY link ORDER BY count DESC LIMIT 20
    `),
    pool.query(`
      SELECT
        CASE WHEN e.event_type = 'download' THEN e.event_value
             ELSE SUBSTR(e.event_type, 11) END AS file,
        e.created_at,
        e.visitor_id,
        iv.email,
        iv.name,
        iv.auth_provider
      FROM portfolio_analytics_events e
      LEFT JOIN portfolio_analytics_identified_visitors iv
        ON iv.visitor_id = e.visitor_id
      WHERE e.event_type = 'download' OR e.event_type LIKE 'Download: %'
      ORDER BY e.created_at DESC
      LIMIT 25
    `),
    pool.query(`
      SELECT
        CASE WHEN e.event_type = 'link_click' THEN e.event_value
             ELSE e.event_type END AS link,
        e.created_at,
        e.visitor_id,
        iv.email,
        iv.name,
        iv.auth_provider
      FROM portfolio_analytics_events e
      LEFT JOIN portfolio_analytics_identified_visitors iv
        ON iv.visitor_id = e.visitor_id
      WHERE e.event_type = 'link_click'
         OR (e.event_type LIKE '%: %'
             AND e.event_type NOT LIKE 'Download: %'
             AND e.event_type NOT LIKE 'Sketch: %'
             AND e.event_type != 'time_on_page')
      ORDER BY e.created_at DESC
      LIMIT 25
    `),
    pool.query(`
      SELECT AVG(CAST(event_value AS UNSIGNED)) AS avgSeconds
      FROM portfolio_analytics_events
      WHERE event_type = 'time_on_page'
        AND event_value REGEXP '^[0-9]+$'
        AND CAST(event_value AS UNSIGNED) BETWEEN 5 AND 3600
    `),
    pool.query(
      "SELECT MIN(first_seen_at) AS firstVisit FROM portfolio_analytics_visitors"
    )
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
    topLinkClicks: linkClickRows.map((r) => ({ link: r.link, count: Number(r.count) })),
    downloadEvents: downloadEventRows.map((r) => ({
      file: r.file,
      visitorId: r.visitor_id,
      email: r.email || null,
      name: r.name || "",
      authProvider: r.auth_provider || "",
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at)
    })),
    linkClickEvents: linkClickEventRows.map((r) => ({
      link: r.link,
      visitorId: r.visitor_id,
      email: r.email || null,
      name: r.name || "",
      authProvider: r.auth_provider || "",
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at)
    })),
    avgTimeOnPageSeconds: timeRows[0]?.avgSeconds != null ? Math.round(Number(timeRows[0].avgSeconds)) : null,
    firstVisitAt: firstVisitRows[0]?.firstVisit instanceof Date
      ? firstVisitRows[0].firstVisit.toISOString()
      : (firstVisitRows[0]?.firstVisit ? String(firstVisitRows[0].firstVisit) : null)
  };
}

export async function recordVisit(visitorId, meta = {}) {
  const safeVisitorId = cleanVisitorId(visitorId);
  const pool = await ensureSchema();

  if (!safeVisitorId || !pool) return getAnalyticsStats();

  const now = new Date();
  const {
    ipAddress = null,
    ipHash = null,
    country = null,
    city = null,
    referrer = null,
    deviceType = null,
    browser = null
  } = meta;
  const referredShareId = cleanShareId(meta.referredShareId);
  let referredByIpAddress = null;

  if (referredShareId) {
    const [shareRows] = await pool.query(
      "SELECT creator_ip_address FROM portfolio_sketch_shares WHERE share_id = ? LIMIT 1",
      [referredShareId]
    );
    referredByIpAddress = shareRows[0]?.creator_ip_address || null;
  }

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
    await connection.query(
      `INSERT INTO portfolio_analytics_visits
         (visitor_id, visited_at, ip_address, country, city, referrer, device_type, browser, referred_by_share_id, referred_by_ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [safeVisitorId, now, ipAddress, country, city, referrer, deviceType, browser, referredShareId, referredByIpAddress]
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

export async function identifyVisitor({ visitorId, email, name, authProvider, profileImage }) {
  const safeVisitorId = cleanVisitorId(visitorId);
  const safeEmail = cleanEmail(email);
  const pool = await ensureSchema();

  if (!safeVisitorId || !safeEmail || !pool) return getAnalyticsStats();

  const now = new Date();
  const safeName = cleanText(name, 120);
  const safeAuthProvider = cleanText(authProvider, 40);
  const safeProfileImage = cleanText(profileImage, 500);

  await pool.query(
    `INSERT INTO portfolio_analytics_identified_visitors
       (visitor_id, email, name, auth_provider, profile_image, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       email        = VALUES(email),
       name         = VALUES(name),
       auth_provider = COALESCE(VALUES(auth_provider), auth_provider),
       profile_image = COALESCE(VALUES(profile_image), profile_image),
       last_seen_at = VALUES(last_seen_at)`,
    [safeVisitorId, safeEmail, safeName, safeAuthProvider || null, safeProfileImage || null, now]
  );

  return getAnalyticsStats();
}

export async function createSketchShare({ shareId, visitorId, ipAddress, ipHash, payload }) {
  const safeShareId = cleanShareId(shareId);
  const safeVisitorId = cleanVisitorId(visitorId);
  const pool = await ensureSchema();

  if (!safeShareId || !pool || !payload) return null;

  await pool.query(
    `INSERT INTO portfolio_sketch_shares
       (share_id, creator_visitor_id, creator_ip_address, creator_ip_hash, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [safeShareId, safeVisitorId, ipAddress || null, ipHash || null, JSON.stringify(payload), new Date()]
  );

  if (safeVisitorId) {
    await recordEvent(safeVisitorId, "Sketch: Share Created", safeShareId);
  }

  return { shareId: safeShareId };
}

export async function logChatMessage({ email, userMessage, aiResponse, model, ipAddress }) {
  const pool = await ensureSchema();
  if (!pool) return;

  const safeEmail = cleanEmail(email) || null;
  const safeModel = cleanText(model, 50);
  const safeIp = typeof ipAddress === "string" ? ipAddress.slice(0, 45) : null;

  await pool.query(
    `INSERT INTO portfolio_chat_logs (email, user_message, ai_response, model, ip_address, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [safeEmail, String(userMessage || ""), String(aiResponse || ""), safeModel, safeIp, new Date()]
  );
}

export async function getChatLogs({ page = 1, pageSize = 50 } = {}) {
  const pool = await ensureSchema();
  if (!pool) return { logs: [], total: 0, page, pageSize };

  const offset = (Math.max(1, page) - 1) * pageSize;
  const [[[{ total }]], [rows]] = await Promise.all([
    pool.query("SELECT COUNT(*) AS total FROM portfolio_chat_logs"),
    pool.query(
      `SELECT id, email, user_message, ai_response, model, ip_address, created_at
       FROM portfolio_chat_logs
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [pageSize, offset]
    )
  ]);

  return {
    logs: rows.map((r) => ({
      id: Number(r.id),
      email: r.email || null,
      userMessage: r.user_message,
      aiResponse: r.ai_response,
      model: r.model,
      ipAddress: r.ip_address || null,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at)
    })),
    total: parseInt(String(total ?? 0), 10),
    page,
    pageSize
  };
}

export async function getSketchShare(shareId) {
  const safeShareId = cleanShareId(shareId);
  const pool = await ensureSchema();

  if (!safeShareId || !pool) return null;

  const [rows] = await pool.query(
    "SELECT share_id, payload_json FROM portfolio_sketch_shares WHERE share_id = ? LIMIT 1",
    [safeShareId]
  );

  const row = rows[0];
  if (!row) return null;

  try {
    return {
      shareId: row.share_id,
      payload: JSON.parse(row.payload_json)
    };
  } catch {
    return null;
  }
}

const PAGE_SIZE = 50;

export async function getVisitsList(page = 1) {
  const pool = await ensureSchema();
  if (!pool) return { visits: [], total: 0, page, pageSize: PAGE_SIZE };

  const offset = (Math.max(1, page) - 1) * PAGE_SIZE;

  const [[[{ total }]], [rows]] = await Promise.all([
    pool.query("SELECT COUNT(*) AS total FROM portfolio_analytics_visits"),
    pool.query(
      `SELECT
         v.id,
         v.visitor_id,
         v.visited_at,
         v.ip_address,
         v.country,
         v.city,
         v.referrer,
         v.device_type,
         v.browser,
         v.referred_by_share_id,
         v.referred_by_ip_address,
         iv.email,
         iv.name,
         iv.auth_provider,
         iv.profile_image,
         te.event_value AS time_on_page,
         se.event_value AS created_share_id
       FROM portfolio_analytics_visits v
       LEFT JOIN portfolio_analytics_identified_visitors iv
         ON iv.visitor_id = v.visitor_id
       LEFT JOIN portfolio_analytics_events te
         ON te.id = (
           SELECT id FROM portfolio_analytics_events
           WHERE visitor_id = v.visitor_id
             AND event_type = 'time_on_page'
             AND created_at >= v.visited_at
             AND created_at <= DATE_ADD(v.visited_at, INTERVAL 4 HOUR)
           ORDER BY created_at ASC
           LIMIT 1
         )
       LEFT JOIN portfolio_analytics_events se
         ON se.id = (
           SELECT id FROM portfolio_analytics_events
           WHERE visitor_id = v.visitor_id
             AND (event_type = 'sketch_share_created' OR event_type = 'Sketch: Share Created')
             AND created_at >= v.visited_at
             AND created_at <= DATE_ADD(v.visited_at, INTERVAL 4 HOUR)
           ORDER BY created_at ASC
           LIMIT 1
         )
       ORDER BY v.visited_at DESC
       LIMIT ? OFFSET ?`,
      [PAGE_SIZE, offset]
    )
  ]);

  const visits = rows.map((r) => ({
    id: Number(r.id),
    visitorId: r.visitor_id,
    visitedAt: r.visited_at instanceof Date ? r.visited_at.toISOString() : String(r.visited_at),
    ipAddress: r.ip_address || null,
    country: r.country || null,
    city: r.city || null,
    referrer: r.referrer || null,
    deviceType: r.device_type || null,
    browser: r.browser || null,
    referredByShareId: r.referred_by_share_id || null,
    referredByIpAddress: r.referred_by_ip_address || null,
    createdShareId: r.created_share_id || null,
    email: r.email || null,
    name: r.name || null,
    authProvider: r.auth_provider || null,
    profileImage: r.profile_image || null,
    timeOnPage: r.time_on_page ? Number(r.time_on_page) : null,
    clicks: []
  }));

  // Fetch all click events within each visit's 4-hour session window
  if (visits.length > 0) {
    const visitIds = visits.map((v) => v.id);
    const [eventRows] = await pool.query(
      `SELECT
         v.id          AS visit_id,
         e.id          AS event_id,
         e.event_type,
         e.event_value,
         e.created_at
       FROM portfolio_analytics_visits v
       JOIN portfolio_analytics_events e
         ON e.visitor_id = v.visitor_id
        AND e.created_at >= v.visited_at
        AND e.created_at <= DATE_ADD(v.visited_at, INTERVAL 4 HOUR)
        AND e.event_type != 'time_on_page'
       WHERE v.id IN (?)
       ORDER BY v.id, e.created_at ASC`,
      [visitIds]
    );

    const byVisitId = {};
    for (const e of eventRows) {
      const vid = Number(e.visit_id);
      if (!byVisitId[vid]) byVisitId[vid] = [];
      byVisitId[vid].push({
        id: Number(e.event_id),
        eventName: e.event_type,
        timestamp: e.created_at instanceof Date ? e.created_at.toISOString() : String(e.created_at),
        metadata: e.event_value || ""
      });
    }

    for (const visit of visits) {
      visit.clicks = byVisitId[visit.id] || [];
    }
  }

  return { visits, total: Number(total), page, pageSize: PAGE_SIZE };
}

export async function getIdentifiedVisitors() {
  const pool = await ensureSchema();
  if (!pool) return { configured: false, visitors: [] };

  const [rows] = await pool.query(
    `SELECT visitor_id, email, name, auth_provider, profile_image, last_seen_at
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
      authProvider: row.auth_provider || "",
      profileImage: row.profile_image || "",
      lastSeenAt: row.last_seen_at instanceof Date
        ? row.last_seen_at.toISOString()
        : String(row.last_seen_at)
    }))
  };
}
