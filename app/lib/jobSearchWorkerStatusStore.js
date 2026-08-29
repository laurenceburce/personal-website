import { ensureJobSearchSchema, requirePool } from "./jobSearchDb.js";

// The two Railway cron services this system runs as (see
// scripts/job-search-worker.mjs and scripts/job-search-submit-worker.mjs).
// Kept as a fixed pair, not an open-ended registry — a third worker would be
// a deliberate addition to this file, not user-configurable.
export const WORKER_NAMES = ["poll", "submit"];

function assertKnownWorker(workerName) {
  if (!WORKER_NAMES.includes(workerName)) {
    throw new Error(`Unknown worker: ${workerName}`);
  }
}

function mapRow(row) {
  return {
    workerName: row.worker_name,
    enabled: Boolean(row.enabled),
    lastCheckedAt: row.last_checked_at,
    observedIntervalMinutes: row.observed_interval_minutes == null ? null : Number(row.observed_interval_minutes),
    lastRunAt: row.last_run_at,
    lastRunOk: row.last_run_ok == null ? null : Boolean(row.last_run_ok),
    lastRunSummary: row.last_run_summary || "",
    lastError: row.last_error || "",
    updatedAt: row.updated_at
  };
}

// Called first thing, every run, REGARDLESS of the enabled flag — this is
// what lets the dashboard notice "the Railway cron itself stopped firing"
// (staleness) independently of "the worker is deliberately turned off". The
// interval is derived from the gap since the previous heartbeat, so there's
// no separate cron-schedule string to keep in sync by hand — it's always
// whatever cadence Railway is actually calling this on.
export async function recordHeartbeat(workerName) {
  assertKnownWorker(workerName);
  const pool = requirePool(await ensureJobSearchSchema());
  const now = new Date();

  const [rows] = await pool.query(
    "SELECT last_checked_at FROM job_search_worker_status WHERE worker_name = ? LIMIT 1",
    [workerName]
  );
  const previous = rows[0]?.last_checked_at ? new Date(rows[0].last_checked_at) : null;
  const observedIntervalMinutes = previous ? (now.getTime() - previous.getTime()) / 60000 : null;

  await pool.query(
    `UPDATE job_search_worker_status
     SET last_checked_at = ?, observed_interval_minutes = COALESCE(?, observed_interval_minutes), updated_at = ?
     WHERE worker_name = ?`,
    [now, observedIntervalMinutes, now, workerName]
  );
}

export async function isWorkerEnabled(workerName) {
  assertKnownWorker(workerName);
  const pool = requirePool(await ensureJobSearchSchema());
  const [rows] = await pool.query(
    "SELECT enabled FROM job_search_worker_status WHERE worker_name = ? LIMIT 1",
    [workerName]
  );
  // Fails open (defaults enabled) if the row is somehow missing — matches
  // this system's existing posture of "unconfigured means the safe default
  // that keeps things running", not a silent full stop.
  return rows[0] ? Boolean(rows[0].enabled) : true;
}

// Only called when the worker actually did its real work (not when a run was
// skipped for being disabled) — see the module comment on recordHeartbeat.
export async function recordWorkerRunResult(workerName, { ok, summary = "", error = "" }) {
  assertKnownWorker(workerName);
  const pool = requirePool(await ensureJobSearchSchema());
  const now = new Date();

  await pool.query(
    `UPDATE job_search_worker_status
     SET last_run_at = ?, last_run_ok = ?, last_run_summary = ?, last_error = ?, updated_at = ?
     WHERE worker_name = ?`,
    [now, ok ? 1 : 0, String(summary).slice(0, 500), String(error).slice(0, 500), now, workerName]
  );
}

export async function setWorkerEnabled(workerName, enabled) {
  assertKnownWorker(workerName);
  const pool = requirePool(await ensureJobSearchSchema());
  await pool.query(
    "UPDATE job_search_worker_status SET enabled = ?, updated_at = ? WHERE worker_name = ?",
    [enabled ? 1 : 0, new Date(), workerName]
  );
  return { workerName, enabled: Boolean(enabled) };
}

export async function getAllWorkerStatus() {
  const pool = requirePool(await ensureJobSearchSchema());
  const [rows] = await pool.query("SELECT * FROM job_search_worker_status");
  const byName = Object.fromEntries(rows.map((row) => [row.worker_name, mapRow(row)]));
  // Always returns both, in a fixed order, even if a row is somehow missing
  // (pre-migration data, a manual DB edit) — the dashboard shouldn't have to
  // null-check an entry that's supposed to always exist.
  return WORKER_NAMES.map((name) => byName[name] || {
    workerName: name, enabled: true, lastCheckedAt: null, observedIntervalMinutes: null,
    lastRunAt: null, lastRunOk: null, lastRunSummary: "", lastError: "", updatedAt: null
  });
}
