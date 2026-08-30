import { cleanId, ensureJobSearchSchema, parseJsonColumn, requirePool, toJsonParam } from "./jobSearchDb.js";
import { mapPostingRow } from "./jobSearchPostingsStore.js";

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

// Powers the Overview tab's per-run "Details" popup. This table only ever
// stores aggregate counts (see recordDiscoveryRun above) — there's no
// per-run job/company list actually stored anywhere, so this reconstructs
// one entirely from existing timestamped tables instead of adding new
// storage.
//
// Bounded by the PREVIOUS run's ran_at (exclusive) through THIS run's own
// ran_at (inclusive) — NOT this run's ran_at through the next one's. Every
// row's ran_at is written by recordDiscoveryRun() only once runDiscoveryPass
// /runDirectPollPass have both already finished (see scripts/job-search-
// worker.mjs and the run/route.js "discoveryNow" action) — so all of a run's
// actual company/posting writes happen chronologically BEFORE its own
// ran_at, not after. Falls back to 24h before this run when there's no
// earlier row (the oldest run in the 200-row retention window).
//
// "New postings" (not "every posting found") — direct-poll alone re-
// touches every already-known posting on every company's board on every
// run (upsertPosting bumps last_seen_at regardless of whether it's new),
// so listing everything FOUND this run would mean thousands of unchanged
// rows on an ordinary run. created_at only advances the moment a posting
// is genuinely new, which is what's actually worth looking back at.
//
// "Companies checked" DOES mean every company actually polled this run
// (last_polled_at, not created_at) — direct-poll's own roster is small
// enough (currently ~80) that the full list is still reasonable to show,
// unlike postings.
export async function getDiscoveryRunDetails(id) {
  const pool = requirePool(await ensureJobSearchSchema());
  const runId = cleanId(id, "Discovery run");

  const [runRows] = await pool.query("SELECT * FROM job_search_discovery_runs WHERE id = ? LIMIT 1", [runId]);
  if (!runRows[0]) return null;
  const run = mapRow(runRows[0]);

  const [prevRunRows] = await pool.query(
    "SELECT ran_at FROM job_search_discovery_runs WHERE ran_at < ? ORDER BY ran_at DESC LIMIT 1",
    [run.ranAt]
  );
  const windowStart = prevRunRows[0]?.ran_at || new Date(new Date(run.ranAt).getTime() - 24 * 60 * 60 * 1000);
  const windowEnd = run.ranAt;

  // Safety caps (not a pacing mechanism) matching this codebase's existing
  // posture elsewhere (e.g. discovery's own 500-result ceiling) — a normal
  // run's new-postings/companies-checked counts are nowhere near this, so
  // it only ever bites a pathological case.
  const [postingRows] = await pool.query(
    `SELECT * FROM job_search_postings WHERE created_at > ? AND created_at <= ? ORDER BY created_at DESC LIMIT 500`,
    [windowStart, windowEnd]
  );
  const [companyRows] = await pool.query(
    `SELECT company_name, ats_type, board_token, jobs_found_last_poll, last_poll_status, last_poll_error
     FROM job_search_known_companies WHERE last_polled_at > ? AND last_polled_at <= ? ORDER BY company_name ASC LIMIT 500`,
    [windowStart, windowEnd]
  );

  return {
    run,
    newPostings: postingRows.map(mapPostingRow),
    companiesPolled: companyRows.map((row) => ({
      companyName: row.company_name,
      atsType: row.ats_type,
      boardToken: row.board_token,
      jobsFoundLastPoll: Number(row.jobs_found_last_poll),
      lastPollStatus: row.last_poll_status,
      lastPollError: row.last_poll_error
    }))
  };
}
