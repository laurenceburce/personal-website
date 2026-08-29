// Polls every company in the directory that's confirmed to be on a
// submittable ATS (greenhouse/lever/ashby/workable — see
// jobSearchCompanyDirectory.js/atsResolver.js) straight from that platform's
// own API, the same pattern jobSearchAtsSources.js's fetch*Jobs functions
// were originally built for (back when a manually-curated watchlist decided
// what to poll). The difference now: the company list is entirely
// self-populated by jobSearchCompanyProbe.js as new names show up in Adzuna
// results, never typed in by hand. Every posting created this way already
// carries its real ats_type — no lazy per-posting resolution ever needed.
import { fetchAtsJobs } from "./jobSearchAtsSources.js";
import { listPollableCompanies, recordCompanyPollResult } from "./jobSearchCompanyDirectory.js";
import { upsertPosting } from "./jobSearchPostingsStore.js";

export async function runDirectPollPass() {
  const companies = await listPollableCompanies();
  let created = 0;
  let polled = 0;
  let errors = 0;

  for (const company of companies) {
    try {
      const jobs = await fetchAtsJobs({
        atsType: company.atsType,
        boardToken: company.boardToken,
        companyName: company.companyName
      });

      for (const job of jobs) {
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

  return { companiesTotal: companies.length, companiesPolled: polled, created, errors };
}
