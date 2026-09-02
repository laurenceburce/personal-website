import { ensureJobSearchSchema, parseJsonColumn, requirePool, toJsonParam } from "./jobSearchDb.js";
import { countPostingsByStatus } from "./jobSearchPostingsStore.js";

// Live, single-row "what is the submit worker doing RIGHT NOW" state — see
// job_search_submit_progress's own comment in jobSearchDb.js for how this
// differs from job_search_submit_runs (history) and job_search_worker_status
// (heartbeat). Called from app/lib/jobSearchSubmitWorkerRun.js as it works
// through each posting; read from the web app via plain polling (see
// app/api/job-search/submit-progress/route.js) — an earlier SSE-push version
// of this turned out to be silently buffered by Railway's proxy in practice
// (confirmed live: updates never arrived until the connection closed), so
// this deliberately favors a dumb, provably-working poll over a fragile
// push. Only one submit-worker pass ever runs at a time (see
// scripts/job-search-submit-worker-server.mjs's isRunning guard), so the
// read-modify-write in beginProgressItem/finishProgressItem below never
// races against itself.
const ROW_ID = 1;
// Safety cap, not a normal-operation limit — SUBMIT_BATCH_LIMIT caps each
// phase at 20, so one pass never actually reaches this.
const MAX_ITEMS = 200;

function mapRow(row) {
  if (!row) {
    return {
      status: "idle", startedAt: null, finishedAt: null, submittingTotal: 0, autoApplyTotal: 0,
      processedCount: 0, currentPhase: null, currentItem: null, items: [], updatedAt: null
    };
  }
  return {
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    submittingTotal: Number(row.submitting_total),
    autoApplyTotal: Number(row.auto_apply_total),
    processedCount: Number(row.processed_count),
    currentPhase: row.current_phase,
    currentItem: parseJsonColumn(row.current_item, null),
    items: parseJsonColumn(row.items, []),
    updatedAt: row.updated_at
  };
}

export async function getSubmitProgress() {
  const pool = requirePool(await ensureJobSearchSchema());
  const [rows] = await pool.query("SELECT * FROM job_search_submit_progress WHERE id = ? LIMIT 1", [ROW_ID]);
  return mapRow(rows[0]);
}

// What the toolbar banner and Overview's Submit Worker card actually poll
// (see submit-progress/route.js) — progress plus live queue counts in one
// cheap round trip (a single-row SELECT and a small GROUP BY, same query
// worker-status/route.js's own comment already calls out as safe to poll
// often).
export async function getSubmitProgressSnapshot() {
  const [progress, statusCounts] = await Promise.all([
    getSubmitProgress(),
    countPostingsByStatus().catch(() => ({}))
  ]);
  return {
    ...progress,
    approvedWaitingCount: statusCounts.approved || 0,
    pendingReviewCount: statusCounts.pending_review || 0
  };
}

// Called once at the top of a pass, before either phase's queue is even
// fetched — clears the previous pass's item log so "this run" always means
// the one currently in flight (or the one that JUST finished, until the next
// pass starts). Each phase's own total is filled in separately (see
// setSubmittingTotal/setAutoApplyTotal below) once that phase's queue length
// is actually known.
export async function startSubmitRun() {
  const pool = requirePool(await ensureJobSearchSchema());
  const now = new Date();
  await pool.query(
    `UPDATE job_search_submit_progress
     SET status = 'running', started_at = ?, finished_at = NULL, submitting_total = 0, auto_apply_total = 0,
         processed_count = 0, current_phase = NULL, current_item = NULL, items = ?, updated_at = ?
     WHERE id = ?`,
    [now, toJsonParam([]), now, ROW_ID]
  );
}

export async function setSubmittingTotal(total) {
  const pool = requirePool(await ensureJobSearchSchema());
  await pool.query(
    "UPDATE job_search_submit_progress SET submitting_total = ?, updated_at = ? WHERE id = ?",
    [Number(total) || 0, new Date(), ROW_ID]
  );
}

export async function setAutoApplyTotal(total) {
  const pool = requirePool(await ensureJobSearchSchema());
  await pool.query(
    "UPDATE job_search_submit_progress SET auto_apply_total = ?, updated_at = ? WHERE id = ?",
    [Number(total) || 0, new Date(), ROW_ID]
  );
}

// Marks one posting as "currently being worked on" — appended to the run's
// item log AND set as current_item (the latter is just a convenience so a
// client doesn't have to scan the log for whatever's in_progress).
export async function beginProgressItem({ postingId, title, companyName, atsType, phase, liveSessionId = "" }) {
  const pool = requirePool(await ensureJobSearchSchema());
  const current = await getSubmitProgress();
  const item = {
    postingId, title, companyName, atsType: atsType || null, phase,
    liveSessionId: liveSessionId || null,
    status: "in_progress", startedAt: new Date().toISOString(), finishedAt: null
  };
  const items = [...(current.items || []), item].slice(-MAX_ITEMS);
  await pool.query(
    `UPDATE job_search_submit_progress
     SET current_phase = ?, current_item = ?, items = ?, updated_at = ?
     WHERE id = ?`,
    [phase, toJsonParam(item), toJsonParam(items), new Date(), ROW_ID]
  );
}

// Resolves the most recent in_progress entry for this posting to its final
// outcome. Also called from a catch block on an unexpected per-posting
// error (see jobSearchSubmitWorkerRun.js), so a crash mid-item doesn't leave
// it stuck showing "Working…" forever in the log.
export async function finishProgressItem({ postingId, status }) {
  const pool = requirePool(await ensureJobSearchSchema());
  const current = await getSubmitProgress();
  let resolved = false;
  const items = (current.items || []).map((it) => {
    if (resolved || it.postingId !== postingId || it.status !== "in_progress") return it;
    resolved = true;
    return { ...it, status, finishedAt: new Date().toISOString() };
  });
  await pool.query(
    `UPDATE job_search_submit_progress
     SET processed_count = processed_count + 1, current_item = NULL, items = ?, updated_at = ?
     WHERE id = ?`,
    [toJsonParam(items), new Date(), ROW_ID]
  );
}

export async function finishSubmitRun() {
  const pool = requirePool(await ensureJobSearchSchema());
  const now = new Date();
  await pool.query(
    `UPDATE job_search_submit_progress
     SET status = 'idle', current_phase = NULL, current_item = NULL, finished_at = ?, updated_at = ?
     WHERE id = ?`,
    [now, now, ROW_ID]
  );
}
