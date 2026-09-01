import { cleanId, ensureJobSearchSchema, requirePool } from "./jobSearchDb.js";
import { mapApplicationRow } from "./jobSearchApplicationStore.js";

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

// Called once per submit-worker pass, only when the worker is actually
// enabled and runs its real work (see app/lib/jobSearchSubmitWorkerRun.js)
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

// Powers the notification bell's "Successfully applied to X jobs" / "X
// application(s) failed" popups (see NotificationsBell.js) AND the Overview
// tab's Submit Worker "Recent Runs" -> "Details" drill-down (see
// OverviewPanel.js's SubmitRunDetail) — same on-demand reconstruction as
// jobSearchDiscoveryRunStore's getDiscoveryRunDetails, since this table only
// ever stores a run's aggregate counts (see recordSubmitRun above), never
// the individual attempts themselves. Windowed by attempted_at (not
// submitted_at, which is null for anything that didn't succeed) between the
// previous run and this one.
//
// `applications` is every attempt in the window regardless of outcome (what
// "Details" wants: which jobs were actually in this run); `submitted`/
// `failed` are the same list pre-split, kept for NotificationsBell's two
// separate notification types. NOTE this can undercount slightly against
// the run's own aggregate totals in two ways, both edge cases: (1) an
// approved posting whose attempt crashed before insertApplicationAttempt
// was ever called (see jobSearchSubmitWorkerRun.js's outer catch) leaves no
// row at all; (2) an auto-apply candidate declined by the cheap, Playwright-
// free gate (evaluateCheapGates) or an unresolvable ATS is counted in
// autoSkippedCount but never gets an application row either, since nothing
// was actually attempted for it.
export async function getSubmitRunDetails(id) {
  const pool = requirePool(await ensureJobSearchSchema());
  const runId = cleanId(id, "Submit run");

  const [runRows] = await pool.query("SELECT * FROM job_search_submit_runs WHERE id = ? LIMIT 1", [runId]);
  if (!runRows[0]) return null;
  const run = mapRow(runRows[0]);

  const [prevRunRows] = await pool.query(
    "SELECT ran_at FROM job_search_submit_runs WHERE ran_at < ? ORDER BY ran_at DESC LIMIT 1",
    [run.ranAt]
  );
  const windowStart = prevRunRows[0]?.ran_at || new Date(new Date(run.ranAt).getTime() - 24 * 60 * 60 * 1000);
  const windowEnd = run.ranAt;

  const [appRows] = await pool.query(
    `SELECT a.*, p.status AS posting_status FROM job_search_applications a
     LEFT JOIN job_search_postings p ON p.id = a.posting_id
     WHERE a.attempted_at > ? AND a.attempted_at <= ? ORDER BY a.attempted_at DESC LIMIT 500`,
    [windowStart, windowEnd]
  );
  const applications = appRows.map(mapApplicationRow);

  return {
    run,
    applications,
    submitted: applications.filter((a) => a.submissionStatus === "submitted"),
    failed: applications.filter((a) => a.submissionStatus === "failed")
  };
}
