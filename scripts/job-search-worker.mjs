// Runs Adzuna keyword discovery, direct-polls every company the system has
// auto-discovered a supported ATS board for (see jobSearchCompanyDirectory.js
// — self-populating, never a manually-typed list), and scores whatever's
// new. Run-once script, meant to be triggered on a Railway Cron Schedule
// (see the plan doc for the recommended `*/15 * * * *` cadence) rather than
// looping internally.
import { getDatabaseSizeMb, getPool, isJobSearchDbConfigured } from "../app/lib/jobSearchDb.js";
import { runDiscoveryPass, shouldRunDiscovery } from "../app/lib/jobSearchDiscovery.js";
import { runDirectPollPass } from "../app/lib/jobSearchDirectPoll.js";
import { recordDiscoveryRun } from "../app/lib/jobSearchDiscoveryRunStore.js";
import { cleanupOldPostings } from "../app/lib/jobSearchPostingsStore.js";
import { scoreNewPostings } from "../app/lib/jobSearchScoringPipeline.js";
import { getFindSettings } from "../app/lib/jobSearchSettingsStore.js";
import { triggerSubmitWorker } from "../app/lib/jobSearchSubmitTrigger.js";
import { isWorkerEnabled, recordHeartbeat, recordWorkerRunResult } from "../app/lib/jobSearchWorkerStatusStore.js";

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
  // Written unconditionally, before the enabled check — this is what lets the
  // dashboard tell "Railway's cron stopped firing" apart from "deliberately
  // turned off" (see jobSearchWorkerStatusStore.js).
  await recordHeartbeat("poll");

  // Safety net #1: routine retention cleanup, every run, regardless of current
  // size or the enabled flag below — cheap when there's nothing to prune, and
  // keeps storage bounded continuously instead of only reacting once it's
  // already a problem. Pausing discovery/polling is not a reason to also let
  // retention lapse.
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
    const message =
      `Storage at ${dbSizeMb}MB is at/above the halt threshold (${STORAGE_HALT_MB}MB) even after cleanup. ` +
      "Skipping this poll run entirely to avoid a repeat of the storage incident — " +
      "increase JOB_SEARCH_STORAGE_HALT_MB (if your volume has more room), lower " +
      "the retention window in Job Find Settings, or resize the MySQL volume.";
    console.error(message);
    await recordWorkerRunResult("poll", { ok: false, error: message });
    process.exit(1);
  }

  if (!(await isWorkerEnabled("poll"))) {
    console.log("Poll worker is disabled (toggle it on from the Job Search dashboard's Overview tab) — skipping discovery/polling/scoring this run.");
  } else {
    // Discovery is throttled independently of this cron's own cadence (see
    // shouldRunDiscovery) since Adzuna's free tier is far more limited than a
    // direct ATS API would be — safe to check on every run regardless.
    let discoveryLog = "discovery not due yet";
    let discoveryRan = false;
    let discoverySkipReason = "not due yet";
    let discoveryFound = 0;
    let discoveryCreated = 0;
    let companiesProbed = 0;
    let companiesFound = 0;
    if (shouldRunDiscovery(findSettings)) {
      const result = await runDiscoveryPass(findSettings);
      if (result.ok) {
        discoveryRan = true;
        discoverySkipReason = "";
        discoveryFound = result.found;
        discoveryCreated = result.created;
        companiesProbed = result.companiesProbed;
        companiesFound = result.companiesFound;
        discoveryLog = `Adzuna (${findSettings.discoveryCountry}): ${result.found} found, ${result.created} new, ` +
          `${result.companiesProbed} new companies probed (${result.companiesFound} matched a supported ATS)`;
        console.log(`[discovery] ${discoveryLog}`);
      } else {
        discoverySkipReason = result.reason;
        discoveryLog = `skipped: ${result.reason}`;
        console.warn(`[discovery] ${discoveryLog}`);
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

    await recordDiscoveryRun({
      discoveryRan, discoverySkipReason, jobsFound: discoveryFound, jobsCreated: discoveryCreated,
      companiesProbed, companiesFound,
      directPollCompaniesTotal: directPoll.companiesTotal, directPollCompaniesPolled: directPoll.companiesPolled,
      directPollCreated: directPoll.created, directPollSkipped: directPoll.skipped, directPollErrors: directPoll.errors,
      jobsFoundByAts: directPoll.jobsFoundByAts, ok: true
    }).catch((error) => console.error("[discovery-run] Failed to record run history:", error?.message || error));

    console.log("Scoring new postings (hard filters -> embedding rank -> LLM rubric)...");
    const tally = await scoreNewPostings({ limit: 200 });
    if (findSettings.autoApplyEnabled) {
      await triggerSubmitWorker("pollScore");
    }
    console.log(
      `Scored ${tally.total}: ${tally.filteredOut} filtered out, ${tally.belowThreshold} below match threshold, ` +
      `${tally.pendingReview} pending review, ${tally.scoredLow} scored low, ` +
      `${tally.autoRejected} auto-rejected, ${tally.errors} errors` +
      (tally.budgetExceeded ? `, ${tally.budgetExceeded} deferred (daily LLM budget reached)` : "") + "."
    );

    await recordWorkerRunResult("poll", {
      ok: true,
      summary: `${discoveryLog}; direct-poll: ${directPoll.companiesPolled}/${directPoll.companiesTotal} companies, ${directPoll.created} new; scored ${tally.total} (${tally.pendingReview} pending review)`
    });
  }

  console.log("Poll run complete.");
} catch (error) {
  await recordWorkerRunResult("poll", { ok: false, error: error?.message || String(error) }).catch(() => {});
  throw error;
} finally {
  const pool = await getPool();
  if (pool) await pool.end();
}
