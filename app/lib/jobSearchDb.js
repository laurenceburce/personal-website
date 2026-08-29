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

export const runMigration = async (pool, sql) => {
  try {
    await pool.query(sql);
  } catch (err) {
    if (![1060, 1061, 1062].includes(err?.errno)) throw err;
  }
};

export const ensureJobSearchSchema = async () => {
  const pool = await getPool();
  if (!pool) return null;

  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS job_search_watchlist (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          company_name VARCHAR(160) NOT NULL,
          ats_type VARCHAR(16) NOT NULL,
          board_token VARCHAR(160) NOT NULL,
          is_active TINYINT(1) NOT NULL DEFAULT 1,
          last_polled_at DATETIME(3) NULL,
          last_poll_status VARCHAR(16) NOT NULL DEFAULT 'pending',
          last_poll_error VARCHAR(500) NOT NULL DEFAULT '',
          consecutive_failures INT NOT NULL DEFAULT 0,
          jobs_found_last_poll INT NOT NULL DEFAULT 0,
          created_at DATETIME(3) NOT NULL,
          updated_at DATETIME(3) NOT NULL,
          UNIQUE KEY job_search_watchlist_ats_token_idx (ats_type, board_token),
          INDEX job_search_watchlist_active_idx (is_active)
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS job_search_postings (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          watchlist_id BIGINT UNSIGNED NULL,
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
          description_html LONGTEXT NULL,
          description_text LONGTEXT NULL,
          apply_url VARCHAR(600) NOT NULL DEFAULT '',
          posted_at DATETIME(3) NULL,
          raw_json JSON NULL,
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

      await pool.query(`
        CREATE TABLE IF NOT EXISTS job_search_domain_cache (
          domain VARCHAR(255) PRIMARY KEY,
          age_days INT NULL,
          lookup_ok TINYINT(1) NOT NULL DEFAULT 0,
          checked_at DATETIME(3) NOT NULL
        )
      `);

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
    })();
  }

  await schemaReadyPromise;
  return pool;
};
