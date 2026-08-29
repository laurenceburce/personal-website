import { ensureJobSearchSchema, requirePool } from "./jobSearchDb.js";

// Same append-only-history reasoning as jobSearchDiscoveryRunStore.js — a
// run row is small (no blobs) and short-lived in usefulness, so it's
// simplest to cap it by count rather than adding a whole new settings field.
const MAX_RETAINED_RUNS = 200;

function mapRow(row) {
  return {
    id: Number(row.id),
    ranAt: row.ran_at,
    approvedTotal: Number(row.approved_total),
    submittedCount: Number(row.submitted_count),
    manualReviewCount: Number(row.manual_review_count),
    failedCount: Number(row.failed_count),
    autoApplyEnabled: Boolean(row.auto_apply_enabled),
    autoApplyEvaluated: Number(row.auto_apply_evaluated),
    autoAppliedCount: Number(row.auto_applied_count),
    autoSkippedCount: Number(row.auto_skipped_count),
    ok: Boolean(row.ok),
    error: row.error || "",
    createdAt: row.created_at
  };
}

// Called once per submit-worker cycle, only when the worker is actually
// enabled and runs its real work (see scripts/job-search-submit-worker.mjs)
// — a disabled run only touches job_search_worker_status's heartbeat, same
// convention as the poll worker's own discovery-run recording.
export async function recordSubmitRun({
  approvedTotal = 0,
  submittedCount = 0,
  manualReviewCount = 0,
  failedCount = 0,
  autoApplyEnabled = false,
  autoApplyEvaluated = 0,
  autoAppliedCount = 0,
  autoSkippedCount = 0,
  ok = true,
  error = ""
} = {}) {
  const pool = requirePool(await ensureJobSearchSchema());
  const now = new Date();

  await pool.query(
    `INSERT INTO job_search_submit_runs
       (ran_at, approved_total, submitted_count, manual_review_count, failed_count,
        auto_apply_enabled, auto_apply_evaluated, auto_applied_count, auto_skipped_count,
        ok, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      now, approvedTotal, submittedCount, manualReviewCount, failedCount,
      autoApplyEnabled ? 1 : 0, autoApplyEvaluated, autoAppliedCount, autoSkippedCount,
      ok ? 1 : 0, String(error).slice(0, 500), now
    ]
  );

  // Best-effort trim — never let a pruning hiccup fail the run recording
  // that already succeeded.
  await pool.query(
    `DELETE FROM job_search_submit_runs
     WHERE id NOT IN (SELECT id FROM (SELECT id FROM job_search_submit_runs ORDER BY ran_at DESC LIMIT ?) AS keep)`,
    [MAX_RETAINED_RUNS]
  ).catch(() => {});

  return { ok: true };
}

export async function listRecentSubmitRuns({ limit = 20 } = {}) {
  const pool = requirePool(await ensureJobSearchSchema());
  const [rows] = await pool.query(
    "SELECT * FROM job_search_submit_runs ORDER BY ran_at DESC LIMIT ?",
    [Number(limit) || 20]
  );
  return rows.map(mapRow);
}
