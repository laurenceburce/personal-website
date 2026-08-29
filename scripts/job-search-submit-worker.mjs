// Picks up every posting at status='approved', runs it through the matching
// ATS adapter, and records the result. Also runs auto-apply (see below) —
// this is the ONLY place that does, since it's the only Railway service
// actually provisioned with Playwright's browser binaries, via its own
// Docker image. Run-once script, meant to be triggered on a Railway Cron
// Schedule (see the plan doc for the recommended `*/10 * * * *` cadence)
// rather than looping internally.
import { submitApplication } from "../app/lib/jobSearchAdapters/index.js";
import { resolvePostingForSubmission } from "../app/lib/jobSearchAdapters/atsResolver.js";
import { evaluateAutoApply } from "../app/lib/jobSearchAutoApply.js";
import { insertApplicationAttempt } from "../app/lib/jobSearchApplicationStore.js";
import { getPool, isJobSearchDbConfigured } from "../app/lib/jobSearchDb.js";
import { listPostingsByStatus, updatePostingScore } from "../app/lib/jobSearchPostingsStore.js";
import { getDefaultResume, getFindSettings, getProfile, getResumeById } from "../app/lib/jobSearchSettingsStore.js";
import { recordSubmitRun } from "../app/lib/jobSearchSubmitRunStore.js";
import { isWorkerEnabled, recordHeartbeat, recordWorkerRunResult } from "../app/lib/jobSearchWorkerStatusStore.js";

if (!isJobSearchDbConfigured()) {
  console.error("JOB_SEARCH_DATABASE_URL, DATABASE_URL, or MYSQL_URL is required.");
  process.exit(1);
}

// Local-only escape hatch to watch the browser while debugging a new adapter —
// never set false on the Railway cron service.
const headless = process.env.JOB_SEARCH_PLAYWRIGHT_HEADLESS !== "false";

function toApplicationStatus(adapterStatus) {
  if (adapterStatus === "submitted") return "submitted";
  // 'blocked' (CAPTCHA/anti-bot puzzle/login wall — see blockerDetection.js)
  // is also routed to manual review here: automation correctly refused to
  // push through it, so a human finishing the application by hand is exactly
  // the right next step, same as an unanswerable required field.
  if (adapterStatus === "needs_manual_review" || adapterStatus === "blocked") return "needs_manual_review";
  if (adapterStatus === "unsupported_ats") return "unsupported_ats";
  return "failed";
}

try {
  // Written unconditionally, before the enabled check — this is what lets the
  // dashboard tell "Railway's cron stopped firing" apart from "deliberately
  // turned off" (see jobSearchWorkerStatusStore.js).
  await recordHeartbeat("submit");

  if (!(await isWorkerEnabled("submit"))) {
    console.log("Submit worker is disabled (toggle it on from the Job Search dashboard's Overview tab) — skipping this run.");
  } else {
    let submittedCount = 0;
    let manualReviewCount = 0;
    let failedCount = 0;
    let autoAppliedCount = 0;
    let autoSkippedCount = 0;

    // Highest-match jobs get submitted first when there's a backlog bigger than
    // one run's limit.
    const approved = await listPostingsByStatus("approved", { limit: 20, orderBy: "score" });
    console.log(`Found ${approved.length} approved posting(s) to submit.`);

    if (approved.length > 0) {
      const profile = await getProfile();
      const defaultResume = await getDefaultResume();
      const resumeWithBlob = defaultResume ? await getResumeById(defaultResume.id, { includeBlob: true }) : null;

      for (const posting of approved) {
        // Isolated per posting — matches scoreNewPostings' own pattern. Without
        // this, a single bad posting (a browser-launch failure, which happens
        // outside every adapter's own try/catch, or a transient DB error on the
        // insert/update below) would throw uncaught and abort the whole run,
        // leaving every remaining approved posting this run untouched.
        try {
          // A discovery-sourced posting is always tagged 'external' until
          // something resolves its real ATS — this is that resolution, shared
          // with the auto-apply path, so a human-approved posting doesn't
          // permanently report "unsupported ATS" just because nobody ever
          // looked. Cached on the posting row after the first attempt.
          const { atsType, applyUrl } = await resolvePostingForSubmission(posting);
          const resolvedPosting = { ...posting, atsType, applyUrl };

          console.log(`Submitting: "${posting.title}" at ${posting.companyName} (${atsType})...`);

          const result = await submitApplication(atsType, {
            posting: resolvedPosting,
            profile,
            resumeBuffer: resumeWithBlob?.fileBlob || null,
            resumeFileName: resumeWithBlob?.fileName || "resume.pdf",
            headless
          });

          const applicationStatus = toApplicationStatus(result.status);
          if (applicationStatus === "submitted") submittedCount += 1;
          else if (applicationStatus === "needs_manual_review") manualReviewCount += 1;
          else failedCount += 1;

          const outcomeMessage = result.manualReviewFields?.length
            ? `Needs manual review: ${result.manualReviewFields.join(", ")}`
            : result.errorMessage;

          await insertApplicationAttempt({
            postingId: posting.id,
            companyName: posting.companyName,
            jobTitle: posting.title,
            atsType,
            applyUrl,
            resumeId: defaultResume?.id || null,
            resumeLabel: defaultResume?.label || "",
            submittedAnswers: result.submittedAnswers,
            scoreSnapshot: {
              overall: posting.llmOverallScore,
              scamRiskScore: posting.scamRiskScore,
              scamRiskLevel: posting.scamRiskLevel
            },
            submissionStatus: applicationStatus,
            errorMessage: outcomeMessage,
            atsConfirmationText: result.confirmationText,
            screenshotBuffer: result.screenshotBuffer
          });

          await updatePostingScore(posting.id, {
            status: applicationStatus,
            // Carries WHY onto the posting itself (not just the application
            // row) so it can actually show up somewhere a human would act on
            // it again — see the Review Queue's Needs Manual Review/Failed
            // tabs. Only worth setting when it's not a plain success.
            ...(applicationStatus !== "submitted" ? { submissionNote: outcomeMessage } : {})
          });
          console.log(`  -> ${applicationStatus}`);
        } catch (error) {
          console.error(`  -> failed to process "${posting.title}" at ${posting.companyName}:`, error?.message || error);
        }
      }
    }

    // Auto-apply: opt-in, evaluated only for postings already sitting at
    // pending_review (scorePosting() itself deliberately never touches this —
    // see jobSearchScoringPipeline.js). A posting here already has its score/
    // match/scam fields persisted from scoring, so no extra context needs to
    // be attached before handing it to evaluateAutoApply().
    const findSettings = await getFindSettings();
    let pendingReviewCount = 0;
    if (findSettings.autoApplyEnabled) {
      const pendingReview = await listPostingsByStatus("pending_review", { limit: 20, orderBy: "score" });
      pendingReviewCount = pendingReview.length;
      console.log(`Auto-apply enabled — evaluating ${pendingReview.length} pending-review posting(s).`);

      if (pendingReview.length > 0) {
        const profile = await getProfile();
        for (const posting of pendingReview) {
          try {
            const result = await evaluateAutoApply({ posting, findSettings, profile });
            if (result.status === "submitted") autoAppliedCount += 1;
            else if (result.status === "skipped_auto_apply") autoSkippedCount += 1;
            await updatePostingScore(posting.id, {
              status: result.status,
              autoApplySkipReason: result.skipReason || null,
              decisionNote: result.skipDetail || (result.status === "submitted" ? "Auto-applied." : "")
            });
            console.log(`  auto-apply "${posting.title}" at ${posting.companyName} -> ${result.status}${result.skipReason ? ` (${result.skipReason})` : ""}`);
          } catch (error) {
            // Never lose a posting that already earned pending_review over an
            // auto-apply bug/infra error — worst case, a human sees it in the
            // review queue exactly like auto-apply was never on.
            console.error(`  auto-apply failed for "${posting.title}" at ${posting.companyName}:`, error?.message || error);
          }
        }
      }
    }

    await recordSubmitRun({
      approvedTotal: approved.length, submittedCount, manualReviewCount, failedCount,
      autoApplyEnabled: findSettings.autoApplyEnabled, autoApplyEvaluated: pendingReviewCount,
      autoAppliedCount, autoSkippedCount, ok: true
    }).catch((error) => console.error("[submit-run] Failed to record run history:", error?.message || error));

    await recordWorkerRunResult("submit", {
      ok: true,
      summary: `${approved.length} approved posting(s) processed (${submittedCount} submitted, ${manualReviewCount} need manual review), ${autoAppliedCount} auto-applied`
    });
    console.log("Submit run complete.");
  }
} catch (error) {
  await recordWorkerRunResult("submit", { ok: false, error: error?.message || String(error) }).catch(() => {});
  throw error;
} finally {
  const pool = await getPool();
  if (pool) await pool.end();
}
