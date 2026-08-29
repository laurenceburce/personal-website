import { ensureJobSearchSchema, parseJsonColumn, requirePool, toJsonParam } from "./jobSearchDb.js";

// Append-only history, unlike everything else in this system that gets
// pruned by content-relevance (retention days, terminal statuses) — a run
// row is small (no blobs) and short-lived in usefulness, so it's simplest to
// just cap it by count rather than adding a whole new settings field for it.
const MAX_RETAINED_RUNS = 200;

function mapRow(row) {
  return {
    id: Number(row.id),
    ranAt: row.ran_at,
    discoveryRan: Boolean(row.discovery_ran),
    discoverySkipReason: row.discovery_skip_reason || "",
    jobsFound: Number(row.jobs_found),
    jobsCreated: Number(row.jobs_created),
    companiesProbed: Number(row.companies_probed),
    companiesFound: Number(row.companies_found),
    directPollCompaniesTotal: Number(row.direct_poll_companies_total),
    directPollCompaniesPolled: Number(row.direct_poll_companies_polled),
    directPollCreated: Number(row.direct_poll_created),
    directPollSkipped: Number(row.direct_poll_skipped),
    directPollErrors: Number(row.direct_poll_errors),
    jobsFoundByAts: parseJsonColumn(row.jobs_found_by_ats, {}),
    ok: Boolean(row.ok),
    error: row.error || "",
    createdAt: row.created_at
  };
}

// Called once per poll-worker cycle (cron or manual "Run Discovery Now") —
// every field defaults to a safe zero/empty so a caller only needs to pass
// what it actually has (a manual discovery-only trigger has no scoring
// tally to report, for instance).
export async function recordDiscoveryRun({
  discoveryRan = false,
  discoverySkipReason = "",
  jobsFound = 0,
  jobsCreated = 0,
  companiesProbed = 0,
  companiesFound = 0,
  directPollCompaniesTotal = 0,
  directPollCompaniesPolled = 0,
  directPollCreated = 0,
  directPollSkipped = 0,
  directPollErrors = 0,
  jobsFoundByAts = {},
  ok = true,
  error = ""
} = {}) {
  const pool = requirePool(await ensureJobSearchSchema());
  const now = new Date();

  await pool.query(
    `INSERT INTO job_search_discovery_runs
       (ran_at, discovery_ran, discovery_skip_reason, jobs_found, jobs_created,
        companies_probed, companies_found, direct_poll_companies_total, direct_poll_companies_polled,
        direct_poll_created, direct_poll_skipped, direct_poll_errors, jobs_found_by_ats, ok, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      now, discoveryRan ? 1 : 0, String(discoverySkipReason).slice(0, 200),
      jobsFound, jobsCreated, companiesProbed, companiesFound,
      directPollCompaniesTotal, directPollCompaniesPolled, directPollCreated, directPollSkipped, directPollErrors,
      toJsonParam(jobsFoundByAts), ok ? 1 : 0, String(error).slice(0, 500), now
    ]
  );

  // Best-effort trim — never let a pruning hiccup fail the run recording
  // that already succeeded.
  await pool.query(
    `DELETE FROM job_search_discovery_runs
     WHERE id NOT IN (SELECT id FROM (SELECT id FROM job_search_discovery_runs ORDER BY ran_at DESC LIMIT ?) AS keep)`,
    [MAX_RETAINED_RUNS]
  ).catch(() => {});

  return { ok: true };
}

export async function listRecentDiscoveryRuns({ limit = 20 } = {}) {
  const pool = requirePool(await ensureJobSearchSchema());
  const [rows] = await pool.query(
    "SELECT * FROM job_search_discovery_runs ORDER BY ran_at DESC LIMIT ?",
    [Number(limit) || 20]
  );
  return rows.map(mapRow);
}
