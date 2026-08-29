// Polls every active watchlist entry's ATS board, upserts/dedupes postings, and
// closes out anything that's been delisted since the last run. Run-once script,
// meant to be triggered on a Railway Cron Schedule (see the plan doc for the
// recommended `*/15 * * * *` cadence) rather than looping internally.
import { fetchAtsJobs } from "../app/lib/jobSearchAtsSources.js";
import { getPool, isJobSearchDbConfigured } from "../app/lib/jobSearchDb.js";
import { markStalePostingsClosed, upsertPosting } from "../app/lib/jobSearchPostingsStore.js";
import { scoreNewPostings } from "../app/lib/jobSearchScoringPipeline.js";
import { listWatchlist, recordPollResult } from "../app/lib/jobSearchWatchlistStore.js";

if (!isJobSearchDbConfigured()) {
  console.error("JOB_SEARCH_DATABASE_URL, DATABASE_URL, or MYSQL_URL is required.");
  process.exit(1);
}

async function pollWatchlistEntry(entry) {
  const pollStartedAt = new Date();

  try {
    const jobs = await fetchAtsJobs({
      atsType: entry.atsType,
      boardToken: entry.boardToken,
      companyName: entry.companyName
    });

    let created = 0;
    let reopened = 0;
    for (const job of jobs) {
      const result = await upsertPosting(entry.id, job);
      if (result.isNew) created += 1;
      if (result.reopened) reopened += 1;
    }

    const { closedCount } = await markStalePostingsClosed(entry.id, pollStartedAt);
    await recordPollResult(entry.id, { ok: true, jobsFound: jobs.length });

    console.log(
      `[${entry.atsType}] ${entry.companyName} (${entry.boardToken}): ${jobs.length} listed, ` +
      `${created} new, ${reopened} reopened, ${closedCount} closed.`
    );
  } catch (error) {
    await recordPollResult(entry.id, { ok: false, error: error?.message || String(error) });
    console.error(`[${entry.atsType}] ${entry.companyName} (${entry.boardToken}) failed: ${error?.message || error}`);
  }
}

try {
  const watchlist = await listWatchlist({ activeOnly: true });
  console.log(`Polling ${watchlist.length} active watchlist entries...`);

  for (const entry of watchlist) {
    await pollWatchlistEntry(entry);
  }

  console.log("Scoring new postings (hard filters -> embedding rank -> LLM rubric)...");
  const tally = await scoreNewPostings({ limit: 200 });
  console.log(
    `Scored ${tally.total}: ${tally.filteredOut} filtered out, ${tally.belowThreshold} below match threshold, ` +
    `${tally.pendingReview} pending review, ${tally.scoredLow} scored low, ${tally.errors} errors.`
  );

  console.log("Poll run complete.");
} finally {
  const pool = await getPool();
  if (pool) await pool.end();
}
