// The submit-worker's actual work — one pass, called repeatedly by the
// event-driven server in scripts/job-search-submit-worker-server.mjs. This
// file deliberately does NOT manage the DB pool's lifecycle (no
// `pool.end()`) — the long-running server keeps the pool open across many
// calls, closing it only on its own shutdown. It also does NOT catch its own
// top-level error — it re-throws so the server can log it and stay up for
// the next trigger rather than this file deciding that for its caller.
//
// Picks up every posting at status='approved', runs it through the matching
// ATS adapter, and records the result. Also runs auto-apply (see below) —
// this is the ONLY place that does, since it's the only Playwright-capable
// code path in the whole system.
import { submitApplication } from "./jobSearchAdapters/index.js";
import { resolvePostingForSubmission } from "./jobSearchAdapters/atsResolver.js";
import { normalizeLabel } from "./jobSearchAdapters/profileMapping.js";
import { evaluateAutoApply } from "./jobSearchAutoApply.js";
import { insertApplicationAttempt } from "./jobSearchApplicationStore.js";
import { listPostingsByStatus, updatePostingScore } from "./jobSearchPostingsStore.js";
import { getDefaultResume, getFindSettings, getProfile, getResumeById } from "./jobSearchSettingsStore.js";
import {
  beginProgressItem, finishProgressItem, finishSubmitRun, setAutoApplyTotal, setSubmittingTotal, startSubmitRun
} from "./jobSearchSubmitProgressStore.js";
import { recordSubmitRun } from "./jobSearchSubmitRunStore.js";
import { isWorkerEnabled, recordHeartbeat, recordWorkerRunResult } from "./jobSearchWorkerStatusStore.js";

// Local-only escape hatch to watch the browser while debugging a new adapter —
// never set false on a real deployment.
const headless = process.env.JOB_SEARCH_PLAYWRIGHT_HEADLESS !== "false";
const SUBMIT_BATCH_LIMIT = 20;

function submitLiveSessionId(postingId) {
  return `submit-${postingId}`;
}

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

function structuredManualReviewFields({ labels, fieldOptions, posting, submittedAnswers }) {
  const previousAnswersByLabel = new Map(
    (posting.manualReviewFields || []).map((f) => [normalizeLabel(f.label), f.answer])
  );
  const submittedAnswersByLabel = new Map(
    Object.entries(submittedAnswers || {}).map(([label, answer]) => [normalizeLabel(label), answer])
  );

  return (labels || []).map((label) => ({
    label,
    answer: previousAnswersByLabel.get(normalizeLabel(label)) ?? submittedAnswersByLabel.get(normalizeLabel(label)) ?? null,
    // Real options captured off the live widget the moment this field
    // was flagged (select/dropdown/radio-group only — see each
    // adapter's flagForReview/captureFieldOptions). null for anything
    // not option-shaped, which the popup renders as a free-text box.
    options: fieldOptions?.[label] || null
  }));
}

export async function runSubmitWorkerPass({ includeAutoApply = true } = {}) {
  // Written unconditionally, before the enabled check — this is what lets the
  // dashboard tell "the worker stopped running" apart from "deliberately
  // turned off" (see jobSearchWorkerStatusStore.js).
  await recordHeartbeat("submit");

  if (!(await isWorkerEnabled("submit"))) {
    console.log("Submit worker is disabled (toggle it on from the Job Search dashboard's Overview tab) — skipping this run.");
    return { skipped: true };
  }

  let submittedCount = 0;
  let manualReviewCount = 0;
  let failedCount = 0;
  let autoAppliedCount = 0;
  let autoSkippedCount = 0;
  let needsRerun = false;

  // Best-effort throughout — see jobSearchSubmitProgressStore.js. Never let
  // a live-progress write fail the real work it's just narrating.
  await startSubmitRun().catch((error) => console.error("[submit-progress] startSubmitRun failed:", error?.message || error));

  // Highest-match jobs get submitted first when there's a backlog bigger than
  // one run's limit.
  const approved = await listPostingsByStatus("approved", { limit: SUBMIT_BATCH_LIMIT, orderBy: "score" });
  console.log(`Found ${approved.length} approved posting(s) to submit.`);
  if (approved.length >= SUBMIT_BATCH_LIMIT) needsRerun = true;
  await setSubmittingTotal(approved.length).catch(() => {});

  if (approved.length > 0) {
    const profile = await getProfile();
    const defaultResume = await getDefaultResume();
    const resumeWithBlob = defaultResume ? await getResumeById(defaultResume.id, { includeBlob: true }) : null;

    for (const posting of approved) {
      const liveSessionId = submitLiveSessionId(posting.id);
      // Isolated per posting — matches scoreNewPostings' own pattern. Without
      // this, a single bad posting (a browser-launch failure, which happens
      // outside every adapter's own try/catch, or a transient DB error on the
      // insert/update below) would throw uncaught and abort the whole run,
      // leaving every remaining approved posting this run untouched.
      await beginProgressItem({
        postingId: posting.id, title: posting.title, companyName: posting.companyName,
        atsType: posting.atsType, phase: "submitting", liveSessionId
      }).catch(() => {});

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
          resumeText: resumeWithBlob?.parsedText || "",
          headless,
          liveSessionId
        });

        const applicationStatus = toApplicationStatus(result.status);
        if (applicationStatus === "submitted") submittedCount += 1;
        else if (applicationStatus === "needs_manual_review") manualReviewCount += 1;
        else failedCount += 1;

        const outcomeMessage = result.manualReviewFields?.length
          ? `Needs manual review: ${result.manualReviewFields.join(", ")}`
          : result.errorMessage;

        // Structured counterpart of the joined outcomeMessage above — one
        // {label, answer} entry per field this attempt couldn't confidently
        // fill, powering the Review Queue's "Answer & Retry" popup (see
        // jobSearchAdapters/profileMapping.js's resolveManualOverride, which
        // reads this same array back on the next attempt). A label that was
        // already answered on a PRIOR attempt but shows up again here means
        // either it's genuinely new, or a saved answer's fill attempt failed
        // for some structural reason (e.g. the form's widget shape changed) —
        // either way, carry the previous answer forward rather than wiping it,
        // so the user doesn't lose what they already typed. Written even when
        // empty on a successful submit, so stale unanswered-field data doesn't
        // linger once a posting actually goes through.
        const structuredFields = structuredManualReviewFields({
          labels: result.manualReviewFields,
          fieldOptions: result.fieldOptions,
          posting,
          submittedAnswers: result.submittedAnswers
        });
        // A CAPTCHA/security/interstitial-style blocked attempt often has no
        // field list of its own; it should not erase answers the user already
        // saved for a prior "Answer & Retry" pass. Clearing is only correct
        // after a real submission succeeds. If the adapter finds a fresh set
        // of unresolved fields, write that; otherwise preserve what was
        // already on the posting for the next retry.
        const manualReviewFieldsForPosting = applicationStatus === "submitted"
          ? []
          : (structuredFields.length > 0 ? structuredFields : (posting.manualReviewFields || []));

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
          autoApplied: false
        });

        await updatePostingScore(posting.id, {
          status: applicationStatus,
          // Carries WHY onto the posting itself (not just the application
          // row) so it can actually show up somewhere a human would act on
          // it again — see the Review Queue's Needs Manual Review/Failed
          // tabs. Include an empty note on success too: otherwise a posting
          // that fails once and then succeeds on retry keeps displaying the
          // stale failure reason even though the latest state is submitted.
          submissionNote: applicationStatus === "submitted" ? "" : outcomeMessage,
          manualReviewFields: manualReviewFieldsForPosting
        });
        console.log(`  -> ${applicationStatus}`);
        await finishProgressItem({ postingId: posting.id, status: applicationStatus }).catch(() => {});
      } catch (error) {
        console.error(`  -> failed to process "${posting.title}" at ${posting.companyName}:`, error?.message || error);
        await finishProgressItem({ postingId: posting.id, status: "failed" }).catch(() => {});
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
  const autoApplyWillRun = includeAutoApply && findSettings.autoApplyEnabled;
  if (!includeAutoApply && findSettings.autoApplyEnabled) {
    console.log("Auto-apply enabled, but this trigger is approved-only — skipping auto-apply sweep for this pass.");
  }
  if (autoApplyWillRun) {
    const pendingReview = await listPostingsByStatus("pending_review", { limit: SUBMIT_BATCH_LIMIT, orderBy: "score" });
    pendingReviewCount = pendingReview.length;
    console.log(`Auto-apply enabled — evaluating ${pendingReview.length} pending-review posting(s).`);
    if (pendingReview.length >= SUBMIT_BATCH_LIMIT) needsRerun = true;
    await setAutoApplyTotal(pendingReview.length).catch(() => {});

    if (pendingReview.length > 0) {
      const profile = await getProfile();
      for (const posting of pendingReview) {
        const liveSessionId = submitLiveSessionId(posting.id);
        await beginProgressItem({
          postingId: posting.id, title: posting.title, companyName: posting.companyName,
          atsType: posting.atsType, phase: "auto_apply", liveSessionId
        }).catch(() => {});

        try {
          const result = await evaluateAutoApply({ posting, findSettings, profile, liveSessionId });
          if (result.status === "submitted") autoAppliedCount += 1;
          else autoSkippedCount += 1;

          const structuredFields = structuredManualReviewFields({
            labels: result.manualReviewFields,
            fieldOptions: result.fieldOptions,
            posting,
            submittedAnswers: result.submittedAnswers
          });
          const manualReviewFieldsForPosting = result.status === "submitted"
            ? []
            : (structuredFields.length > 0 ? structuredFields : (posting.manualReviewFields || []));

          const postingPatch = {
            status: result.status,
            autoApplySkipReason: result.skipReason || null,
            decisionNote: result.skipDetail || (result.status === "submitted" ? "Auto-applied." : "")
          };
          if (result.status === "submitted" || result.status === "needs_manual_review") {
            postingPatch.manualReviewFields = manualReviewFieldsForPosting;
          }
          await updatePostingScore(posting.id, postingPatch);
          console.log(`  auto-apply "${posting.title}" at ${posting.companyName} -> ${result.status}${result.skipReason ? ` (${result.skipReason})` : ""}`);
          await finishProgressItem({ postingId: posting.id, status: result.status }).catch(() => {});
        } catch (error) {
          // Never lose a posting that already earned pending_review over an
          // auto-apply bug/infra error — worst case, a human sees it in the
          // review queue exactly like auto-apply was never on.
          console.error(`  auto-apply failed for "${posting.title}" at ${posting.companyName}:`, error?.message || error);
          await finishProgressItem({ postingId: posting.id, status: "failed" }).catch(() => {});
        }
      }
    }
  }

  await finishSubmitRun().catch((error) => console.error("[submit-progress] finishSubmitRun failed:", error?.message || error));

  await recordSubmitRun({
    approvedTotal: approved.length, submittedCount, manualReviewCount, failedCount,
    autoApplyEnabled: autoApplyWillRun, autoApplyEvaluated: pendingReviewCount,
    autoAppliedCount, autoSkippedCount, ok: true
  }).catch((error) => console.error("[submit-run] Failed to record run history:", error?.message || error));

  const summary = {
    approvedTotal: approved.length, submittedCount, manualReviewCount, failedCount,
    autoAppliedCount, autoSkippedCount, needsRerun
  };

  await recordWorkerRunResult("submit", {
    ok: true,
    summary: `${approved.length} approved posting(s) processed (${submittedCount} submitted, ${manualReviewCount} need manual review), ${autoAppliedCount} auto-applied`
  });
  console.log("Submit run complete.");

  return summary;
}
