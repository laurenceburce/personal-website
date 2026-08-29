// Polls every active watchlist entry's ATS board, upserts/dedupes postings, and
// closes out anything that's been delisted since the last run. Run-once script,
// meant to be triggered on a Railway Cron Schedule (see the plan doc for the
// recommended `*/15 * * * *` cadence) rather than looping internally.
import { fetchAtsJobs } from "../app/lib/jobSearchAtsSources.js";
import { getDatabaseSizeMb, getPool, isJobSearchDbConfigured } from "../app/lib/jobSearchDb.js";
import { fetchAdzunaJobs, isAdzunaConfigured, shouldRunDiscovery } from "../app/lib/jobSearchDiscovery.js";
import { cleanupOldPostings, markStalePostingsClosed, upsertPosting } from "../app/lib/jobSearchPostingsStore.js";
import { scoreNewPostings } from "../app/lib/jobSearchScoringPipeline.js";
import { getFindSettings, markDiscoveryRun } from "../app/lib/jobSearchSettingsStore.js";
import { listWatchlist, recordPollResult } from "../app/lib/jobSearchWatchlistStore.js";

// Storage circuit breaker: this is a hard stop on inserting MORE data, checked
// after retention cleanup has already had a chance to free space. Default
// leaves real headroom under a 5GB volume, but any plan should set this to
// comfortably below its actual limit — see JOB_SEARCH_STORAGE_HALT_MB.
const STORAGE_HALT_MB = Number(process.env.JOB_SEARCH_STORAGE_HALT_MB) || 4500;

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

async function runDiscovery(findSettings) {
  if (!isAdzunaConfigured()) {
    console.warn("Discovery is enabled in Job Find Settings but ADZUNA_APP_ID/ADZUNA_APP_KEY are not set — skipping.");
    return;
  }

  try {
    const jobs = await fetchAdzunaJobs({
      keywords: findSettings.titleKeywords,
      location: findSettings.discoveryLocation,
      country: findSettings.discoveryCountry
    });

    let created = 0;
    for (const job of jobs) {
      const result = await upsertPosting(null, job);
      if (result.isNew) created += 1;
    }

    await markDiscoveryRun();
    console.log(`[discovery] Adzuna (${findSettings.discoveryCountry}): ${jobs.length} found, ${created} new.`);
  } catch (error) {
    console.error(`[discovery] Adzuna search failed: ${error?.message || error}`);
  }
}

try {
  // Safety net #1: routine retention cleanup, every run, regardless of current
  // size — cheap when there's nothing to prune, and keeps storage bounded
  // continuously instead of only reacting once it's already a problem.
  const findSettings = await getFindSettings();
  const { deletedCount, retentionDays } = await cleanupOldPostings(findSettings.retentionDays);
  if (deletedCount > 0) {
    console.log(`Retention cleanup: removed ${deletedCount} posting(s) older than ${retentionDays} days in a terminal status.`);
  }

  // Safety net #2: hard storage circuit breaker. Checked AFTER cleanup so a
  // large prune can rescue a run that would otherwise be skipped.
  const dbSizeMb = await getDatabaseSizeMb();
  console.log(`Job-search database usage: ${dbSizeMb} MB (halt threshold: ${STORAGE_HALT_MB} MB).`);
  if (dbSizeMb >= STORAGE_HALT_MB) {
    console.error(
      `Storage at ${dbSizeMb}MB is at/above the halt threshold (${STORAGE_HALT_MB}MB) even after cleanup. ` +
      "Skipping this poll run entirely to avoid a repeat of the storage incident — " +
      "increase JOB_SEARCH_STORAGE_HALT_MB (if your volume has more room), lower " +
      "the retention window in Job Find Settings, or resize the MySQL volume."
    );
    process.exit(1);
  }

  const watchlist = await listWatchlist({ activeOnly: true });
  console.log(`Polling ${watchlist.length} active watchlist entries...`);

  for (const entry of watchlist) {
    await pollWatchlistEntry(entry);
  }

  // Discovery is throttled independently of this cron's own cadence (see
  // shouldRunDiscovery) since Adzuna's free tier is far more limited than the
  // watchlist's ATS APIs — safe to check on every run regardless.
  if (shouldRunDiscovery(findSettings)) {
    await runDiscovery(findSettings);
  }

  console.log("Scoring new postings (hard filters -> embedding rank -> LLM rubric)...");
  const tally = await scoreNewPostings({ limit: 200 });
  console.log(
    `Scored ${tally.total}: ${tally.filteredOut} filtered out, ${tally.belowThreshold} below match threshold, ` +
    `${tally.pendingReview} pending review, ${tally.scoredLow} scored low, ${tally.errors} errors` +
    (tally.budgetExceeded ? `, ${tally.budgetExceeded} deferred (daily LLM budget reached)` : "") + "."
  );

  console.log("Poll run complete.");
} finally {
  const pool = await getPool();
  if (pool) await pool.end();
}
