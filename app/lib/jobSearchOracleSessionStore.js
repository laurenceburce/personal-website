// CRUD for job_search_oracle_sessions — deliberately Playwright-free (see
// atsTypes.js's own header comment on why nothing reachable from the main
// app's page.js can import playwright) so listOracleSessions() is safe to
// call from app/job-search/page.js for the dashboard snapshot, same as
// listResumes(). getOracleSessionForHost() is the one function meant only
// for jobSearchAdapters/oracleFusion.js (already Playwright-touching) — it's
// the only place the real storage_state ever leaves this module.
import { appError, cleanId, cleanText, ensureJobSearchSchema, parseJsonColumn, requirePool, toJsonParam } from "./jobSearchDb.js";

// oraclecloud.com only — this store is specifically for oracle_fusion
// sessions (see atsTypes.js). Legacy Taleo (taleo.net) has no adapter and no
// session concept to store.
function cleanTenantHost(value) {
  const host = String(value || "").trim().toLowerCase();
  if (!/(^|\.)oraclecloud\.com$/i.test(host)) {
    throw appError('Tenant host must be an oraclecloud.com address (got "' + host + '").');
  }
  return host;
}

function mapSessionRow(row) {
  return {
    id: Number(row.id),
    tenantHost: row.tenant_host,
    label: row.label,
    fileName: row.file_name,
    capturedAt: row.captured_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Metadata only — never the raw storage_state (a live session credential),
// same posture jobSearchSettingsStore.js's listResumes() takes with resume
// blobs (see getResumeById's includeBlob opt-in there).
export async function listOracleSessions() {
  const pool = requirePool(await ensureJobSearchSchema());
  const [rows] = await pool.query(
    `SELECT id, tenant_host, label, file_name, captured_at, created_at, updated_at
     FROM job_search_oracle_sessions ORDER BY tenant_host ASC`
  );
  return rows.map(mapSessionRow);
}

// The only caller of this should be oracleFusion.js, looking up the session
// matching the current posting's applyUrl hostname. Returns null for no
// match — the adapter treats that identically to a genuine unauthenticated
// state (goes through the ordinary auth screen, then reports "blocked" if a
// code is required).
export async function getOracleSessionForHost(host) {
  const pool = requirePool(await ensureJobSearchSchema());
  const cleanedHost = String(host || "").trim().toLowerCase();
  if (!cleanedHost) return null;

  const [rows] = await pool.query(
    "SELECT storage_state, updated_at FROM job_search_oracle_sessions WHERE tenant_host = ? LIMIT 1",
    [cleanedHost]
  );
  if (!rows[0]) return null;

  return { storageState: parseJsonColumn(rows[0].storage_state), updatedAt: rows[0].updated_at };
}

// Upserts on tenant_host — re-uploading a session for a host you've already
// connected replaces it (the common case: the old one expired, you re-ran
// the connect script, and are uploading the fresh one).
export async function saveOracleSession({ tenantHost, label, fileName, storageState, capturedAt }) {
  const pool = requirePool(await ensureJobSearchSchema());
  const host = cleanTenantHost(tenantHost);

  if (!storageState || !Array.isArray(storageState.cookies)) {
    throw appError("That file doesn't look like a Playwright session (missing a cookies array).");
  }

  const now = new Date();
  const capturedAtDate = capturedAt && !Number.isNaN(new Date(capturedAt).getTime()) ? new Date(capturedAt) : null;

  await pool.query(
    `INSERT INTO job_search_oracle_sessions
       (tenant_host, label, file_name, storage_state, captured_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       label = VALUES(label), file_name = VALUES(file_name), storage_state = VALUES(storage_state),
       captured_at = VALUES(captured_at), updated_at = VALUES(updated_at)`,
    [host, cleanText(label, 160, host), cleanText(fileName, 255), toJsonParam(storageState), capturedAtDate, now, now]
  );

  return { tenantHost: host };
}

export async function deleteOracleSession(id) {
  const pool = requirePool(await ensureJobSearchSchema());
  const sessionId = cleanId(id, "Session");
  await pool.query("DELETE FROM job_search_oracle_sessions WHERE id = ?", [sessionId]);
  return { id: sessionId };
}
