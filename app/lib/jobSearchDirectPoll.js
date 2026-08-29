// Polls every company in the directory that's confirmed to be on a
// submittable ATS (greenhouse/lever/ashby/workable — see
// jobSearchCompanyDirectory.js/atsResolver.js) straight from that platform's
// own API, the same pattern jobSearchAtsSources.js's fetch*Jobs functions
// were originally built for (back when a manually-curated watchlist decided
// what to poll). The difference now: the company list is entirely
// self-populated by jobSearchCompanyProbe.js as new names show up in Adzuna
// results, never typed in by hand. Every posting created this way already
// carries its real ats_type — no lazy per-posting resolution ever needed.
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

  for (const company of companies) {
    try {
      const jobs = await fetchAtsJobs({
        atsType: company.atsType,
        boardToken: company.boardToken,
        companyName: company.companyName
      });

      jobsFoundByAts[company.atsType] = (jobsFoundByAts[company.atsType] || 0) + jobs.length;

      for (const job of jobs) {
        if (!runHardFilters(job, findSettings).passed) {
          skipped += 1;
          continue;
        }
        const result = await upsertPosting(job);
        if (result.isNew) created += 1;
      }

      await recordCompanyPollResult(company.id, { ok: true, jobsFound: jobs.length });
      polled += 1;
    } catch (error) {
      errors += 1;
      await recordCompanyPollResult(company.id, { ok: false, error: error?.message || String(error) }).catch(() => {});
    }
  }

  return { companiesTotal: companies.length, companiesPolled: polled, created, skipped, errors, jobsFoundByAts };
}
