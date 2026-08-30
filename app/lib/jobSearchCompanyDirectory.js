import { cleanId, cleanText, ensureJobSearchSchema, requirePool } from "./jobSearchDb.js";
import { normalizeCompanyName, probeCompanyAts } from "./jobSearchCompanyProbe.js";
// From atsTypes.js specifically, NOT atsResolver.js — this file is reachable
// from page.js (getCompanyDirectoryStats, shown on the Overview tab), and
// atsResolver.js imports `playwright` at module scope. That import chain
// once reached the main web app's server bundle this way and broke its
// production build — see atsTypes.js for the full story.
import { POLLABLE_ATS_TYPES } from "./jobSearchAdapters/atsTypes.js";

function mapCompanyRow(row) {
  return {
    id: Number(row.id),
    companyName: row.company_name,
    normalizedName: row.normalized_name,
    atsType: row.ats_type,
    boardToken: row.board_token,
    lastProbedAt: row.last_probed_at,
    lastPolledAt: row.last_polled_at,
    lastPollStatus: row.last_poll_status,
    lastPollError: row.last_poll_error,
    jobsFoundLastPoll: Number(row.jobs_found_last_poll),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function getKnownCompany(companyName) {
  const pool = requirePool(await ensureJobSearchSchema());
  const normalized = normalizeCompanyName(companyName);
  if (!normalized) return null;
  const [rows] = await pool.query(
    "SELECT * FROM job_search_known_companies WHERE normalized_name = ? LIMIT 1",
    [normalized]
  );
  return rows[0] ? mapCompanyRow(rows[0]) : null;
}

// Separate from discoverNewCompanies()'s bulk slug-guessing flow below —
// this is for a company reached the OPPOSITE way: atsResolver.js already
// resolved one of its postings to a real Workday URL (a platform with no
// guessable public API, so probeCompanyAts() can never find it on its own —
// see atsTypes.js's POLLABLE_ATS_TYPES comment) and parsed out the exact
// tenant/datacenter/site boardToken from that real URL. Registering it here
// means jobSearchDirectPoll.js starts fetching the REST of that company's
// board on every poll after, not just the one posting that happened to come
// through Adzuna.
//
// Only ever fills an ats_type='unknown' gap, never overwrites an already-
// confirmed different platform — a same-named-but-different company (the
// exact false-positive shape already confirmed live for Workable/
// SmartRecruiters/Personio elsewhere in this codebase) could otherwise
// silently reassign a genuinely-probed Greenhouse/Lever/etc. company to
// Workday just because Adzuna happened to also surface an unrelated posting
// from a different company sharing that same display name.
export async function registerDiscoveredCompany({ companyName, atsType, boardToken }) {
  const pool = requirePool(await ensureJobSearchSchema());
  const normalized = normalizeCompanyName(companyName);
  if (!normalized || !atsType || !boardToken) return;
  const now = new Date();
  await pool.query(
    `INSERT INTO job_search_known_companies
       (company_name, normalized_name, ats_type, board_token, last_probed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       ats_type = IF(ats_type = 'unknown', VALUES(ats_type), ats_type),
       board_token = IF(ats_type = 'unknown', VALUES(board_token), board_token),
       last_probed_at = IF(ats_type = 'unknown', VALUES(last_probed_at), last_probed_at),
       updated_at = IF(ats_type = 'unknown', VALUES(updated_at), updated_at)`,
    [cleanText(companyName, 160), normalized, atsType, cleanText(boardToken, 160), now, now, now]
  );
}

// Every company on a POLLABLE ats — jobSearchDirectPoll.js polls exactly this
// list every worker run. This is deliberately broader than "submittable":
// Recruitee/Personio/Breezy HR/SmartRecruiters all have a confirmed public
// polling API but no submission adapter (see atsTypes.js — SmartRecruiters'
// bot-wall is specific to its apply FORM, unrelated to this read-only API),
// so their postings still flow into scoring/review for the human to apply to
// by hand. Workday is here too, reached only via atsResolver.js registering
// an already-resolved tenant, never via slug-guessing (see atsTypes.js's own
// POLLABLE_ATS_TYPES comment for the full explanation). iCIMS/Oracle Taleo
// are excluded — recognized but never polled/submitted to (see atsResolver.js
// and atsTypes.js for why no equivalent path exists for either).
export async function listPollableCompanies() {
  const pool = requirePool(await ensureJobSearchSchema());
  const [rows] = await pool.query(
    "SELECT * FROM job_search_known_companies WHERE ats_type IN (?) ORDER BY company_name ASC",
    [[...POLLABLE_ATS_TYPES]]
  );
  return rows.map(mapCompanyRow);
}

// Overview-tab summary only — deliberately not a management surface (no
// list/edit/delete here). Company discovery is fully automatic; there is
// nothing for a human to curate.
export async function getCompanyDirectoryStats() {
  const pool = requirePool(await ensureJobSearchSchema());
  const [totalRows] = await pool.query("SELECT COUNT(*) AS total FROM job_search_known_companies");
  const [pollableRows] = await pool.query(
    "SELECT COUNT(*) AS total FROM job_search_known_companies WHERE ats_type IN (?)",
    [[...POLLABLE_ATS_TYPES]]
  );
  return {
    totalProbed: Number(totalRows[0].total),
    pollableCompanies: Number(pollableRows[0].total)
  };
}

export async function recordCompanyPollResult(id, { ok, jobsFound = 0, error = "" }) {
  const pool = requirePool(await ensureJobSearchSchema());
  const companyId = cleanId(id, "Company");
  const now = new Date();
  await pool.query(
    `UPDATE job_search_known_companies
     SET last_polled_at = ?, last_poll_status = ?, last_poll_error = ?, jobs_found_last_poll = ?, updated_at = ?
     WHERE id = ?`,
    [now, ok ? "ok" : "error", cleanText(error, 500), Number(jobsFound) || 0, now, companyId]
  );
}

// Called for every distinct company name a fresh Adzuna discovery pass sees.
// A company already in the directory (found or not) is skipped instantly —
// this only ever spends real probe calls on genuinely new names.
//
// `limit` is a pathological-case safety valve, not a pacing mechanism —
// Greenhouse/Lever/Ashby/Workable/SmartRecruiters showed no rate limiting at
// all across dozens of consecutive live calls this session (unlike Adzuna's
// real, documented one), so there's no need to trickle new companies in
// slowly. It's set high enough that a normal batch (one discovery run tops
// out at 500 raw postings, and duplicates across those postings mean far
// fewer distinct companies than that) should never hit it — if it ever does,
// whatever's left over is simply not probed this run rather than queued, so
// the ceiling exists to bound worst-case runtime, not to spread work out.
// `concurrency` probes several companies at once (each company's own 5
// platform checks stay sequential and stop at the first hit, so this is
// concurrency across companies, not per-company).
export async function discoverNewCompanies(companyNames, { limit = 200, concurrency = 8 } = {}) {
  const pool = requirePool(await ensureJobSearchSchema());
  const seen = new Set();
  const toProbe = [];

  for (const rawName of companyNames) {
    if (toProbe.length >= limit) break;
    const companyName = cleanText(rawName, 160);
    if (!companyName) continue;
    const normalized = normalizeCompanyName(companyName);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);

    const [existing] = await pool.query(
      "SELECT id FROM job_search_known_companies WHERE normalized_name = ? LIMIT 1",
      [normalized]
    );
    if (existing[0]) continue; // already known (found or previously not_found) — never re-probed

    toProbe.push({ companyName, normalized });
  }

  let found = 0;
  for (let i = 0; i < toProbe.length; i += concurrency) {
    const batch = toProbe.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(async ({ companyName, normalized }) => {
      const hit = await probeCompanyAts(companyName).catch(() => null);
      const now = new Date();
      await pool.query(
        `INSERT INTO job_search_known_companies
           (company_name, normalized_name, ats_type, board_token, last_probed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE company_name = VALUES(company_name)`,
        [companyName, normalized, hit?.atsType || "unknown", hit?.boardToken || "", now, now, now]
      );
      return hit;
    }));
    found += results.filter(Boolean).length;
  }

  return { probed: toProbe.length, found };
}
