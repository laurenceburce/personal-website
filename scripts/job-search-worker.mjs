// Runs Adzuna keyword discovery, direct-polls every company the system has
// auto-discovered a supported ATS board for (see jobSearchCompanyDirectory.js
// — self-populating, never a manually-typed list), and scores whatever's
// new. Run-once script, meant to be triggered on a Railway Cron Schedule
// (see the plan doc for the recommended `*/15 * * * *` cadence) rather than
// looping internally.
import { getDatabaseSizeMb, getPool, isJobSearchDbConfigured } from "../app/lib/jobSearchDb.js";
import { runDiscoveryPass, shouldRunDiscovery } from "../app/lib/jobSearchDiscovery.js";
import { runDirectPollPass } from "../app/lib/jobSearchDirectPoll.js";
import { cleanupOldPostings } from "../app/lib/jobSearchPostingsStore.js";
import { scoreNewPostings } from "../app/lib/jobSearchScoringPipeline.js";
import { getFindSettings } from "../app/lib/jobSearchSettingsStore.js";

// Storage circuit breaker: this is a hard stop on inserting MORE data, checked
// after retention cleanup has already had a chance to free space. Default
// leaves real headroom under a 5GB volume, but any plan should set this to
// comfortably below its actual limit — see JOB_SEARCH_STORAGE_HALT_MB.
const STORAGE_HALT_MB = Number(process.env.JOB_SEARCH_STORAGE_HALT_MB) || 4500;

if (!isJobSearchDbConfigured()) {
  console.error("JOB_SEARCH_DATABASE_URL, DATABASE_URL, or MYSQL_URL is required.");
  process.exit(1);
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

  // Discovery is throttled independently of this cron's own cadence (see
  // shouldRunDiscovery) since Adzuna's free tier is far more limited than a
  // direct ATS API would be — safe to check on every run regardless.
  if (shouldRunDiscovery(findSettings)) {
    const result = await runDiscoveryPass(findSettings);
    if (result.ok) {
      console.log(
        `[discovery] Adzuna (${findSettings.discoveryCountry}): ${result.found} found, ${result.created} new, ` +
        `${result.companiesProbed} new companies probed (${result.companiesFound} matched a supported ATS).`
      );
    } else {
      console.warn(`[discovery] Skipped: ${result.reason}`);
    }
  }

  // Direct ATS polling has no meaningful free-tier budget to protect (unlike
  // Adzuna) — every known company's board is checked on every run, same
  // cadence the old watchlist used, just self-populated instead of typed in.
  const directPoll = await runDirectPollPass();
  if (directPoll.companiesTotal > 0) {
    console.log(
      `[direct-poll] ${directPoll.companiesPolled}/${directPoll.companiesTotal} companies polled directly, ` +
      `${directPoll.created} new posting(s), ${directPoll.skipped} irrelevant role(s) skipped, ${directPoll.errors} error(s).`
    );
  }

  console.log("Scoring new postings (hard filters -> embedding rank -> LLM rubric)...");
  const tally = await scoreNewPostings({ limit: 200 });
  console.log(
    `Scored ${tally.total}: ${tally.filteredOut} filtered out, ${tally.belowThreshold} below match threshold, ` +
    `${tally.pendingReview} pending review, ${tally.scoredLow} scored low, ${tally.autoSubmitted} auto-submitted, ` +
    `${tally.autoSkipped} auto-apply skipped, ${tally.errors} errors` +
    (tally.budgetExceeded ? `, ${tally.budgetExceeded} deferred (daily LLM budget reached)` : "") + "."
  );

  console.log("Poll run complete.");
} finally {
  const pool = await getPool();
  if (pool) await pool.end();
}
