import mysql from "mysql2/promise";

// This module (and everything else under app/lib/) is loaded two ways:
// 1. Bundled into the Next.js app (API routes, server components) via Next's own
//    module resolution — it does not care about Node's module system at all.
// 2. Imported directly by the standalone worker scripts under scripts/ via plain
//    `node scripts/job-search-worker.mjs`, which uses Node's native ESM loader.
// For (2) to work with `import`/`export` syntax in a plain `.js` file, the nearest
// package.json must declare "type": "module" — see app/lib/package.json.

const getDatabaseUrl = () => process.env.JOB_SEARCH_DATABASE_URL
  || process.env.DATABASE_URL
  || process.env.MYSQL_URL
  || process.env.MYSQL_PUBLIC_URL
  || "";

export const isJobSearchDbConfigured = () => Boolean(getDatabaseUrl());

let poolPromise = null;
let schemaReadyPromise = null;

export const getPool = async () => {
  if (!isJobSearchDbConfigured()) return null;

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

export function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function requirePool(pool) {
  if (!pool) throw appError("Job search database is not configured.", 503);
  return pool;
}

export function cleanId(value, label = "ID") {
  if (value === "" || value == null) return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw appError(`${label} is invalid.`);
  return id;
}

export function cleanText(value, maxLength, fallback = "") {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  return (text || fallback).slice(0, maxLength);
}

// MySQL's JSON column type does not auto-serialize on write — mysql2 needs a JSON
// string bound as the parameter. On read, drivers differ on whether the column
// comes back already parsed, so parseJsonColumn() below handles both cases.
export function toJsonParam(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export function parseJsonColumn(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// 1060/1061/1062 = duplicate column/key (idempotent ADD COLUMN/INDEX re-runs).
// 1091 = "can't DROP; check that it exists" (idempotent DROP COLUMN re-runs,
// e.g. against a table freshly created without the column in the first place).
export const runMigration = async (pool, sql) => {
  try {
    await pool.query(sql);
  } catch (err) {
    if (![1060, 1061, 1062, 1091].includes(err?.errno)) throw err;
  }
};

export const ensureJobSearchSchema = async () => {
  const pool = await getPool();
  if (!pool) return null;

  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS job_search_postings (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          ats_type VARCHAR(16) NOT NULL,
          board_token VARCHAR(160) NOT NULL,
          external_job_id VARCHAR(160) NOT NULL,
          company_name VARCHAR(160) NOT NULL,
          title VARCHAR(300) NOT NULL,
          department VARCHAR(160) NOT NULL DEFAULT '',
          location_text VARCHAR(300) NOT NULL DEFAULT '',
          remote_type VARCHAR(16) NOT NULL DEFAULT 'unknown',
          seniority_guess VARCHAR(24) NOT NULL DEFAULT 'unknown',
          salary_min INT NULL,
          salary_max INT NULL,
          salary_currency CHAR(3) NULL,
          description_text LONGTEXT NULL,
          apply_url VARCHAR(600) NOT NULL DEFAULT '',
          posted_at DATETIME(3) NULL,
          content_hash CHAR(64) NOT NULL DEFAULT '',
          status VARCHAR(24) NOT NULL DEFAULT 'new',
          filter_reasons JSON NULL,
          embedding JSON NULL,
          embedding_model VARCHAR(64) NULL,
          embedding_similarity FLOAT NULL,
          embedded_at DATETIME(3) NULL,
          llm_dimension_scores JSON NULL,
          llm_overall_score FLOAT NULL,
          llm_summary TEXT NULL,
          llm_concerns JSON NULL,
          llm_model VARCHAR(64) NULL,
          scored_at DATETIME(3) NULL,
          scam_risk_score INT NULL,
          scam_risk_level VARCHAR(12) NULL,
          scam_risk_flags JSON NULL,
          decided_at DATETIME(3) NULL,
          decided_by VARCHAR(160) NULL,
          decision_note VARCHAR(500) NOT NULL DEFAULT '',
          is_active TINYINT(1) NOT NULL DEFAULT 1,
          first_seen_at DATETIME(3) NOT NULL,
          last_seen_at DATETIME(3) NOT NULL,
          created_at DATETIME(3) NOT NULL,
          updated_at DATETIME(3) NOT NULL,
          UNIQUE KEY job_search_postings_natural_idx (ats_type, board_token, external_job_id),
          INDEX job_search_postings_status_idx (status),
          INDEX job_search_postings_active_idx (is_active),
          INDEX job_search_postings_company_idx (company_name)
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS job_search_resumes (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          label VARCHAR(120) NOT NULL DEFAULT 'Default',
          file_name VARCHAR(255) NOT NULL,
          mime_type VARCHAR(120) NOT NULL DEFAULT 'application/pdf',
          file_size INT NOT NULL DEFAULT 0,
          file_blob LONGBLOB NOT NULL,
          parsed_text LONGTEXT NULL,
          is_default TINYINT(1) NOT NULL DEFAULT 0,
          created_at DATETIME(3) NOT NULL,
          updated_at DATETIME(3) NOT NULL
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS job_search_profile (
          id TINYINT UNSIGNED PRIMARY KEY DEFAULT 1,
          full_name VARCHAR(160) NOT NULL DEFAULT '',
          email VARCHAR(160) NOT NULL DEFAULT '',
          phone VARCHAR(40) NOT NULL DEFAULT '',
          address_line1 VARCHAR(200) NOT NULL DEFAULT '',
          city VARCHAR(120) NOT NULL DEFAULT '',
          state_region VARCHAR(120) NOT NULL DEFAULT '',
          postal_code VARCHAR(20) NOT NULL DEFAULT '',
          country VARCHAR(120) NOT NULL DEFAULT '',
          linkedin_url VARCHAR(300) NOT NULL DEFAULT '',
          github_url VARCHAR(300) NOT NULL DEFAULT '',
          portfolio_url VARCHAR(300) NOT NULL DEFAULT '',
          other_links JSON NULL,
          work_history JSON NULL,
          education JSON NULL,
          work_authorization JSON NULL,
          eeo_answers JSON NULL,
          default_resume_id BIGINT UNSIGNED NULL,
          cover_letter_template LONGTEXT NULL,
          updated_at DATETIME(3) NOT NULL
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS job_search_find_settings (
          id TINYINT UNSIGNED PRIMARY KEY DEFAULT 1,
          title_keywords JSON NULL,
          exclude_keywords JSON NULL,
          locations JSON NULL,
          remote_preference VARCHAR(20) NOT NULL DEFAULT 'remote_friendly',
          seniority_levels JSON NULL,
          salary_floor_usd INT NULL,
          resume_match_threshold FLOAT NOT NULL DEFAULT 0.55,
          min_llm_score FLOAT NOT NULL DEFAULT 65,
          excluded_companies JSON NULL,
          profile_embedding JSON NULL,
          profile_embedding_model VARCHAR(64) NULL,
          profile_embedding_updated_at DATETIME(3) NULL,
          updated_at DATETIME(3) NOT NULL
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS job_search_applications (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          posting_id BIGINT UNSIGNED NOT NULL,
          company_name VARCHAR(160) NOT NULL,
          job_title VARCHAR(300) NOT NULL,
          ats_type VARCHAR(16) NOT NULL,
          apply_url VARCHAR(600) NOT NULL DEFAULT '',
          resume_id BIGINT UNSIGNED NULL,
          resume_label VARCHAR(120) NOT NULL DEFAULT '',
          submitted_answers JSON NULL,
          score_snapshot JSON NULL,
          submission_status VARCHAR(24) NOT NULL DEFAULT 'pending',
          error_message VARCHAR(500) NOT NULL DEFAULT '',
          ats_confirmation_text VARCHAR(500) NOT NULL DEFAULT '',
          screenshot LONGBLOB NULL,
          attempted_at DATETIME(3) NOT NULL,
          submitted_at DATETIME(3) NULL,
          created_at DATETIME(3) NOT NULL,
          updated_at DATETIME(3) NOT NULL,
          INDEX job_search_applications_posting_idx (posting_id),
          INDEX job_search_applications_status_idx (submission_status),
          INDEX job_search_applications_submitted_idx (submitted_at)
        )
      `);

      await runMigration(pool, "ALTER TABLE job_search_applications ADD COLUMN user_note VARCHAR(500) NOT NULL DEFAULT ''");
      await runMigration(pool, "ALTER TABLE job_search_find_settings ADD COLUMN max_posting_age_hours INT NULL");
      // description_html was never actually read anywhere (scoring/embedding/display
      // all use description_text) and stored the full raw HTML of every job listing —
      // this alone grew one table to 200MB across ~4,500 postings. Dropped for good.
      await runMigration(pool, "ALTER TABLE job_search_postings DROP COLUMN description_html");
      // raw_json stored the entire unprocessed ATS API object per posting (which,
      // for Greenhouse/Lever, redundantly re-embeds the full HTML description a
      // second time via JSON escaping) and was never read anywhere — every field
      // worth keeping is already extracted into its own column. At 9.4KB/row
      // average, larger than description_text itself, this was the single
      // biggest contributor to the storage incident.
      await runMigration(pool, "ALTER TABLE job_search_postings DROP COLUMN raw_json");

      await pool.query(`
        CREATE TABLE IF NOT EXISTS job_search_domain_cache (
          domain VARCHAR(255) PRIMARY KEY,
          age_days INT NULL,
          lookup_ok TINYINT(1) NOT NULL DEFAULT 0,
          checked_at DATETIME(3) NOT NULL
        )
      `);

      // One row per calendar day — a hard, code-enforced ceiling on Gemini spend
      // that's independent of whatever quota Google's dashboard allows, so a
      // runaway backlog or bug can't silently rack up cost even at a generous quota.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS job_search_llm_usage (
          usage_date DATE PRIMARY KEY,
          embed_calls INT NOT NULL DEFAULT 0,
          score_calls INT NOT NULL DEFAULT 0,
          updated_at DATETIME(3) NOT NULL
        )
      `);

      await runMigration(pool, "ALTER TABLE job_search_find_settings ADD COLUMN max_llm_calls_per_day INT NULL");
      await runMigration(pool, "ALTER TABLE job_search_find_settings ADD COLUMN retention_days INT NULL");

      // Keyword-based discovery (Adzuna) — finds postings without specifying
      // any company up front. Throttled independently of the poll cron's own
      // cadence via discovery_last_run_at, since the aggregator's free tier
      // is far more limited than a direct ATS API would be.
      await runMigration(pool, "ALTER TABLE job_search_find_settings ADD COLUMN discovery_enabled TINYINT(1) NOT NULL DEFAULT 0");
      await runMigration(pool, "ALTER TABLE job_search_find_settings ADD COLUMN discovery_location VARCHAR(160) NOT NULL DEFAULT ''");
      await runMigration(pool, "ALTER TABLE job_search_find_settings ADD COLUMN discovery_country VARCHAR(4) NOT NULL DEFAULT 'us'");
      await runMigration(pool, "ALTER TABLE job_search_find_settings ADD COLUMN discovery_interval_minutes INT NULL");
      await runMigration(pool, "ALTER TABLE job_search_find_settings ADD COLUMN discovery_last_run_at DATETIME(3) NULL");
      // discovery_max_results (a flat "how many results" count) was replaced
      // by paginating Adzuna's date-sorted results until they age past
      // max_posting_age_hours instead — the freshness window already
      // configured for the hard filter, rather than an unrelated number the
      // user had to separately guess at. See jobSearchDiscovery.js.
      await runMigration(pool, "ALTER TABLE job_search_find_settings DROP COLUMN discovery_max_results");

      // Watchlist fully removed — discovery (Adzuna) is now the sole posting
      // source. DROP TABLE IF EXISTS is natively idempotent; the column drop
      // goes through runMigration since a fresh install (table created without
      // the column above) would otherwise throw errno 1091 every time.
      await pool.query("DROP TABLE IF EXISTS job_search_watchlist");
      await runMigration(pool, "ALTER TABLE job_search_postings DROP COLUMN watchlist_id");

      // Auto-apply: opt-in, all-or-nothing gate evaluated (see
      // jobSearchAutoApply.js) only for postings that already cleared the
      // ordinary pending_review bar. Deliberately separate, generally
      // stricter thresholds from the base minLlmScore/resumeMatchThreshold
      // used for the human review queue — defaults applied at the code level
      // (see jobSearchSettingsStore.js) whenever a column is NULL.
      await runMigration(pool, "ALTER TABLE job_search_find_settings ADD COLUMN auto_apply_enabled TINYINT(1) NOT NULL DEFAULT 0");
      await runMigration(pool, "ALTER TABLE job_search_find_settings ADD COLUMN auto_apply_min_score FLOAT NULL");
      await runMigration(pool, "ALTER TABLE job_search_find_settings ADD COLUMN auto_apply_min_match FLOAT NULL");
      await runMigration(pool, "ALTER TABLE job_search_find_settings ADD COLUMN auto_apply_max_scam_risk INT NULL");
      await runMigration(pool, "ALTER TABLE job_search_find_settings ADD COLUMN auto_apply_max_age_hours INT NULL");
      // Recorded whenever auto-apply declines to submit on its own — never a
      // silent drop, always one of the fixed AUTO_APPLY_SKIP_REASONS.
      await runMigration(pool, "ALTER TABLE job_search_postings ADD COLUMN auto_apply_skip_reason VARCHAR(40) NULL");
      // Audit trail: did a human approve this, or did auto-apply submit it
      // with nobody in the loop? Surfaced as a badge in Applied Jobs.
      await runMigration(pool, "ALTER TABLE job_search_applications ADD COLUMN auto_applied TINYINT(1) NOT NULL DEFAULT 0");

      // Auto-discovered company -> ATS board directory (see
      // jobSearchCompanyProbe.js / jobSearchCompanyDirectory.js). Populated
      // entirely by the system itself as new company names show up in Adzuna
      // results — never manually curated, unlike the old watchlist. Once a
      // company is confirmed here on a submittable platform (greenhouse/
      // lever/ashby/workable), jobSearchDirectPoll.js polls its board
      // directly instead of waiting for Adzuna to maybe resurface it.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS job_search_known_companies (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          company_name VARCHAR(160) NOT NULL,
          normalized_name VARCHAR(160) NOT NULL,
          ats_type VARCHAR(24) NOT NULL DEFAULT 'unknown',
          board_token VARCHAR(160) NOT NULL DEFAULT '',
          last_probed_at DATETIME(3) NULL,
          last_polled_at DATETIME(3) NULL,
          last_poll_status VARCHAR(16) NOT NULL DEFAULT 'pending',
          last_poll_error VARCHAR(500) NOT NULL DEFAULT '',
          jobs_found_last_poll INT NOT NULL DEFAULT 0,
          created_at DATETIME(3) NOT NULL,
          updated_at DATETIME(3) NOT NULL,
          UNIQUE KEY job_search_known_companies_name_idx (normalized_name),
          INDEX job_search_known_companies_ats_idx (ats_type)
        )
      `);

      // Tracks the two Railway cron services (see scripts/job-search-worker.mjs
      // and scripts/job-search-submit-worker.mjs) so the dashboard can show a
      // real status instead of just hoping the cron is still firing.
      // last_checked_at is written unconditionally, first thing every run —
      // even when the worker is disabled — so "next expected run" can be
      // estimated from actual observed cadence and a stalled/removed Railway
      // cron shows up as staleness regardless of the enabled flag. last_run_at
      // and friends only update when the worker actually did its real work
      // (i.e. wasn't skipped for being disabled), so "last successful run"
      // means what it says.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS job_search_worker_status (
          worker_name VARCHAR(32) PRIMARY KEY,
          enabled TINYINT(1) NOT NULL DEFAULT 1,
          last_checked_at DATETIME(3) NULL,
          observed_interval_minutes FLOAT NULL,
          last_run_at DATETIME(3) NULL,
          last_run_ok TINYINT(1) NULL,
          last_run_summary VARCHAR(500) NOT NULL DEFAULT '',
          last_error VARCHAR(500) NOT NULL DEFAULT '',
          updated_at DATETIME(3) NOT NULL
        )
      `);

      // One row per poll-worker cycle (cron or manual "Run Discovery Now") —
      // powers the Overview tab's "Recent Discovery Runs" metrics view.
      // Deliberately separate from job_search_worker_status (a singleton
      // "current state" row per worker): this is an append-only history, so
      // it needs its own retention (see pruneOldDiscoveryRuns in
      // jobSearchDiscoveryRunStore.js) rather than being overwritten in place.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS job_search_discovery_runs (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          ran_at DATETIME(3) NOT NULL,
          discovery_ran TINYINT(1) NOT NULL DEFAULT 0,
          discovery_skip_reason VARCHAR(200) NOT NULL DEFAULT '',
          jobs_found INT NOT NULL DEFAULT 0,
          jobs_created INT NOT NULL DEFAULT 0,
          companies_probed INT NOT NULL DEFAULT 0,
          companies_found INT NOT NULL DEFAULT 0,
          direct_poll_companies_total INT NOT NULL DEFAULT 0,
          direct_poll_companies_polled INT NOT NULL DEFAULT 0,
          direct_poll_created INT NOT NULL DEFAULT 0,
          direct_poll_skipped INT NOT NULL DEFAULT 0,
          direct_poll_errors INT NOT NULL DEFAULT 0,
          jobs_found_by_ats JSON NULL,
          ok TINYINT(1) NOT NULL DEFAULT 1,
          error VARCHAR(500) NOT NULL DEFAULT '',
          created_at DATETIME(3) NOT NULL,
          INDEX job_search_discovery_runs_ran_at_idx (ran_at)
        )
      `);

      // One row per submit-worker cycle — the same append-only history
      // pattern as job_search_discovery_runs above, just for the other
      // cron service (see scripts/job-search-submit-worker.mjs). Only
      // written when the worker is actually enabled and runs its real work,
      // matching that table's own convention.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS job_search_submit_runs (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          ran_at DATETIME(3) NOT NULL,
          approved_total INT NOT NULL DEFAULT 0,
          submitted_count INT NOT NULL DEFAULT 0,
          manual_review_count INT NOT NULL DEFAULT 0,
          failed_count INT NOT NULL DEFAULT 0,
          auto_apply_enabled TINYINT(1) NOT NULL DEFAULT 0,
          auto_apply_evaluated INT NOT NULL DEFAULT 0,
          auto_applied_count INT NOT NULL DEFAULT 0,
          auto_skipped_count INT NOT NULL DEFAULT 0,
          ok TINYINT(1) NOT NULL DEFAULT 1,
          error VARCHAR(500) NOT NULL DEFAULT '',
          created_at DATETIME(3) NOT NULL,
          INDEX job_search_submit_runs_ran_at_idx (ran_at)
        )
      `);

      // A single free-text "Full Name" field can't be reliably split back
      // into first/middle/last for forms that ask for them separately —
      // confirmed live as a real, unfixable-by-heuristic problem: for one
      // real name, "Laurence Alec" is a two-word first name, "Moran"
      // (initial "M") is the middle name, and "Burce" is the last — no
      // "first word is first name, last word is last name" rule can ever
      // recover that boundary from the combined string alone, since a
      // parser has no way to know "Alec" belongs with "Laurence" rather
      // than with "Moran". Explicit fields, entered once, remove the
      // guessing entirely — see profileMapping.js. full_name is now a
      // DERIVED column (recomputed from these on every save, see
      // jobSearchSettingsStore.js's updateProfile()), kept so every
      // existing "Full Name" consumer (the LLM prompt, Lever's single
      // "name" field, etc.) still works unchanged.
      await runMigration(pool, "ALTER TABLE job_search_profile ADD COLUMN prefix VARCHAR(20) NOT NULL DEFAULT ''");
      await runMigration(pool, "ALTER TABLE job_search_profile ADD COLUMN first_name VARCHAR(120) NOT NULL DEFAULT ''");
      await runMigration(pool, "ALTER TABLE job_search_profile ADD COLUMN middle_name VARCHAR(120) NOT NULL DEFAULT ''");
      await runMigration(pool, "ALTER TABLE job_search_profile ADD COLUMN last_name VARCHAR(120) NOT NULL DEFAULT ''");
      await runMigration(pool, "ALTER TABLE job_search_profile ADD COLUMN suffix VARCHAR(20) NOT NULL DEFAULT ''");

      // Singleton settings rows always exist after schema init, so stores can
      // plain SELECT/UPDATE ... WHERE id = 1 without upsert branching.
      const now = new Date();
      await pool.query(
        "INSERT IGNORE INTO job_search_profile (id, updated_at) VALUES (1, ?)",
        [now]
      );
      await pool.query(
        "INSERT IGNORE INTO job_search_find_settings (id, updated_at) VALUES (1, ?)",
        [now]
      );
      await pool.query(
        "INSERT IGNORE INTO job_search_worker_status (worker_name, updated_at) VALUES ('poll', ?), ('submit', ?)",
        [now, now]
      );
    })();
  }

  await schemaReadyPromise;
  return pool;
};

// Storage circuit breaker: total size across every job_search_* table (and
// everything else sharing this database, e.g. finance) so the worker can check
// real headroom before inserting more data, rather than finding out via a
// mid-insert "table is full" error like the incident that motivated this.
export async function getDatabaseSizeMb() {
  const pool = requirePool(await ensureJobSearchSchema());
  const [rows] = await pool.query(
    "SELECT ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) AS mb FROM information_schema.tables WHERE table_schema = DATABASE()"
  );
  return Number(rows[0]?.mb || 0);
}
