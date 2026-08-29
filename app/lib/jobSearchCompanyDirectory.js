import { cleanId, cleanText, ensureJobSearchSchema, requirePool } from "./jobSearchDb.js";
import { normalizeCompanyName, probeCompanyAts } from "./jobSearchCompanyProbe.js";
// From atsTypes.js specifically, NOT atsResolver.js — this file is reachable
// from page.js (getCompanyDirectoryStats, shown on the Overview tab), and
// atsResolver.js imports `playwright` at module scope. That import chain
// once reached the main web app's server bundle this way and broke its
// production build — see atsTypes.js for the full story.
import { SUBMITTABLE_ATS_TYPES } from "./jobSearchAdapters/atsTypes.js";

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

// Every company on a submittable ATS — jobSearchDirectPoll.js polls exactly
// this list every worker run. smartrecruiters is deliberately excluded here
// (recognized but never polled/submitted to — see atsResolver.js).
export async function listPollableCompanies() {
  const pool = requirePool(await ensureJobSearchSchema());
  const [rows] = await pool.query(
    "SELECT * FROM job_search_known_companies WHERE ats_type IN (?) ORDER BY company_name ASC",
    [[...SUBMITTABLE_ATS_TYPES]]
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
    [[...SUBMITTABLE_ATS_TYPES]]
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
