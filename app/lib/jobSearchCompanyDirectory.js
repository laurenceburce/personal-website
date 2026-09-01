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

// A company can now have more than one row (one per confirmed platform —
// see the (normalized_name, ats_type) unique key and probeCompanyAts()'s own
// comment), so "the known company" is no longer a single answer. Currently
// unused (nothing calls this) — kept only because a future single-row lookup
// might still want just the pollable rows for a name; if you're adding a
// caller, prefer a query scoped to what you actually need (e.g. join against
// POLLABLE_ATS_TYPES like listPollableCompanies() does) over resurrecting a
// "the" row picked arbitrarily out of several.
export async function getKnownCompany(companyName) {
  const pool = requirePool(await ensureJobSearchSchema());
  const normalized = normalizeCompanyName(companyName);
  if (!normalized) return [];
  const [rows] = await pool.query(
    "SELECT * FROM job_search_known_companies WHERE normalized_name = ? ORDER BY ats_type ASC",
    [normalized]
  );
  return rows.map(mapCompanyRow);
}

// Separate from discoverNewCompanies()'s bulk slug-guessing flow below —
// this is for a company reached the OPPOSITE way: atsResolver.js already
// resolved one of its postings to a real Workday/oracle_fusion URL (neither
// has a guessable public API, so probeCompanyAts() can never find either on
// its own — see atsTypes.js's POLLABLE_ATS_TYPES comment) and parsed out the
// exact tenant/board identifier from that real URL. Registering it here
// means jobSearchDirectPoll.js starts fetching the REST of that company's
// board on every poll after, not just the one posting that happened to come
// through Adzuna.
//
// Just adds this (company, platform) row if it isn't already known — never
// touches any OTHER platform's row already on file for this same company
// (the unique key is (normalized_name, ats_type), so those are separate rows
// entirely; see discoverNewCompanies() below for the matching multi-platform
// write path). Same accepted trade-off as that one: a different real company
// that happens to share this exact display name could get merged in under
// one normalized_name if it's ever independently found on another platform
// too — bounded risk, since every posting still goes through hard-filtering,
// scoring, and human review before anything is ever submitted.
export async function registerDiscoveredCompany({ companyName, atsType, boardToken }) {
  const pool = requirePool(await ensureJobSearchSchema());
  const normalized = normalizeCompanyName(companyName);
  if (!normalized || !atsType || !boardToken) return;
  const now = new Date();
  await pool.query(
    `INSERT INTO job_search_known_companies
       (company_name, normalized_name, ats_type, board_token, last_probed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE company_name = VALUES(company_name)`,
    [cleanText(companyName, 160), normalized, atsType, cleanText(boardToken, 160), now, now, now]
  );
}

// Every company on a POLLABLE ats — jobSearchDirectPoll.js polls exactly this
// list every worker run. This is deliberately broader than "submittable":
// SmartRecruiters still has a confirmed public polling API but no submission
// adapter (see atsTypes.js — its bot-wall is specific to the apply FORM,
// unrelated to this read-only API), so its postings still flow into scoring/
// review for the human to apply to by hand. Lever and Recruitee are
// submittable now because CAPTCHA is handled by the live relay; Personio and
// Breezy HR have direct non-CAPTCHA forms. Workday is here too, reached only
// via atsResolver.js registering an already-resolved tenant, never via
// slug-guessing (see atsTypes.js's own POLLABLE_ATS_TYPES comment for the
// full explanation). iCIMS/Oracle Taleo are excluded —
// recognized but never polled/submitted to (see atsResolver.js and atsTypes.js
// for why no equivalent path exists for either).
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
//
// COUNT(DISTINCT normalized_name), not COUNT(*) — a company can now have one
// row per confirmed platform, and this label says "companies", not
// "company/platform pairs". listPollableCompanies().length (what
// jobSearchDirectPoll.js actually iterates) is the row count, which is the
// more honest number for "how many polls will this run do" — this stat
// answers a different question ("how many distinct companies").
export async function getCompanyDirectoryStats() {
  const pool = requirePool(await ensureJobSearchSchema());
  const [totalRows] = await pool.query("SELECT COUNT(DISTINCT normalized_name) AS total FROM job_search_known_companies");
  const [pollableRows] = await pool.query(
    "SELECT COUNT(DISTINCT normalized_name) AS total FROM job_search_known_companies WHERE ats_type IN (?)",
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
// `concurrency` probes several companies at once (each company's own 8
// platform checks run concurrently too — see probeAllPlatforms — so this is
// concurrency across companies stacked on top of concurrency within one
// company's own probe, not a substitute for it).
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

  // `found` counts distinct COMPANIES that turned up at least one hit, not
  // total platform rows written — matches getCompanyDirectoryStats()'s own
  // "companies" framing and what the Overview tab's discovery-run history
  // already means by "companies found".
  let found = 0;
  for (let i = 0; i < toProbe.length; i += concurrency) {
    const batch = toProbe.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(async ({ companyName, normalized }) => {
      const hits = await probeCompanyAts(companyName).catch(() => []);
      const now = new Date();
      // Zero hits still gets exactly one row (ats_type stays its 'unknown'
      // default) — that's what makes the existence check above skip this
      // company on every future discovery pass instead of re-probing it
      // forever. One or more hits gets one row PER platform — see
      // probeAllPlatforms()'s own comment for why every genuine hit is kept
      // rather than picking a single winner.
      const rows = hits.length > 0
        ? hits.map((hit) => [companyName, normalized, hit.atsType, hit.boardToken, now, now, now])
        : [[companyName, normalized, "unknown", "", now, now, now]];
      for (const row of rows) {
        await pool.query(
          `INSERT INTO job_search_known_companies
             (company_name, normalized_name, ats_type, board_token, last_probed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE company_name = VALUES(company_name), board_token = VALUES(board_token)`,
          row
        );
      }
      return hits;
    }));
    found += results.filter((hits) => hits.length > 0).length;
  }

  return { probed: toProbe.length, found };
}
