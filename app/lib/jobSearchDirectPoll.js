// Polls every company in the directory that's confirmed to be on a pollable
// ATS (submittable platforms plus polling-only ones like SmartRecruiters —
// see jobSearchCompanyDirectory.js/atsTypes.js) straight from that platform's own
// API, the same pattern jobSearchAtsSources.js's fetch*Jobs functions were
// originally built for (back when a manually-curated watchlist decided what
// to poll). The difference now: the company list is entirely self-populated
// by jobSearchCompanyProbe.js as new names show up in Adzuna results, never
// typed in by hand. Every posting created this way already carries its real
// ats_type — no lazy per-posting resolution ever needed.
//
// Unlike Adzuna (which only ever returns keyword-matched results in the
// first place — the `what_or` query narrows at the source), a company's ATS
// board has no such narrowing: fetchAtsJobs() returns EVERY open role at
// that company, software or not. A company only ends up in the directory
// because ONE of their postings once matched an Adzuna search (see
// jobSearchDiscovery.js), which says nothing about the other 50 roles on
// their board. Confirmed live: this was pulling baristas, servers, and
// veterinarians into the pipeline from companies whose one Adzuna-matched
// posting happened to be IT-adjacent. Hard-filtering here — before ever
// storing a row — is a deliberate deviation from Adzuna's own "store
// everything, even filtered_out, for auditability" behavior: that rationale
// was written for a keyword-narrowed source, not a company's entire
// unrelated business.
import { runHardFilters } from "./jobSearchHardFilters.js";
import { fetchAtsJobs } from "./jobSearchAtsSources.js";
import { listPollableCompanies, recordCompanyPollResult } from "./jobSearchCompanyDirectory.js";
import { upsertPosting } from "./jobSearchPostingsStore.js";
import { getFindSettings } from "./jobSearchSettingsStore.js";

// Companies are polled concurrently, not one at a time — confirmed live this
// matters a lot: 66 companies polled sequentially took ~76 seconds (each
// fetchAtsJobs call is its own full HTTP round-trip to a different company's
// board), long enough that a manual "Run Discovery Now" click looked hung
// well past when anyone would reasonably wait for it. Safe for the same
// reason jobSearchCompanyDirectory.discoverNewCompanies() already
// established for company probing: no platform showed real rate limiting
// across dozens of concurrent live calls this session (unlike Adzuna's own,
// documented one), and both upsertPosting() and recordCompanyPollResult()
// are already concurrency-safe per-row writes. Confirmed live: all 66 fired
// at once (no cap) finished the fetch step in ~3.6s with zero errors, but a
// cap is still worth keeping rather than going fully unbounded — the DB pool
// itself is capped at 4 connections (jobSearchDb.js), so throughput past
// that point comes from overlapping the fetches, not from more concurrent
// writes, and an uncapped company-level fan-out would grow without limit as
// the self-populating directory grows past its current ~66 companies. 20
// keeps the bulk of the win (~24s -> ~10s here) with a bounded worst case.
const DIRECT_POLL_CONCURRENCY = 20;

async function pollOneCompany(company, findSettings) {
  const outcome = { polled: 0, created: 0, skipped: 0, errors: 0, jobsFoundByAts: {} };
  try {
    const jobs = await fetchAtsJobs({
      atsType: company.atsType,
      boardToken: company.boardToken,
      companyName: company.companyName
    });

    outcome.jobsFoundByAts[company.atsType] = jobs.length;

    for (const job of jobs) {
      if (!runHardFilters(job, findSettings).passed) {
        outcome.skipped += 1;
        continue;
      }
      const result = await upsertPosting(job);
      if (result.isNew) outcome.created += 1;
    }

    await recordCompanyPollResult(company.id, { ok: true, jobsFound: jobs.length });
    outcome.polled = 1;
  } catch (error) {
    outcome.errors = 1;
    await recordCompanyPollResult(company.id, { ok: false, error: error?.message || String(error) }).catch(() => {});
  }
  return outcome;
}

export async function runDirectPollPass() {
  const companies = await listPollableCompanies();
  const findSettings = await getFindSettings();

  let created = 0;
  let polled = 0;
  let skipped = 0;
  let errors = 0;
  // Raw per-board totals (before hard-filtering) — powers the Overview tab's
  // "jobs found on each ATS" breakdown. Deliberately pre-filter: it answers
  // "how much is actually on these boards", not "how much was relevant",
  // which the skipped/created counters already cover in aggregate.
  const jobsFoundByAts = {};

  for (let i = 0; i < companies.length; i += DIRECT_POLL_CONCURRENCY) {
    const batch = companies.slice(i, i + DIRECT_POLL_CONCURRENCY);
    // Aggregated synchronously once each batch's Promise.all resolves —
    // never mutated from inside the concurrent tasks themselves, so there's
    // no question of a race on these shared counters.
    const results = await Promise.all(batch.map((company) => pollOneCompany(company, findSettings)));
    for (const outcome of results) {
      polled += outcome.polled;
      created += outcome.created;
      skipped += outcome.skipped;
      errors += outcome.errors;
      for (const [atsType, count] of Object.entries(outcome.jobsFoundByAts)) {
        jobsFoundByAts[atsType] = (jobsFoundByAts[atsType] || 0) + count;
      }
    }
  }

  return { companiesTotal: companies.length, companiesPolled: polled, created, skipped, errors, jobsFoundByAts };
}
