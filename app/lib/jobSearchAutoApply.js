// Opt-in, all-or-nothing gate evaluated only for postings that already
// cleared the ordinary human-review bar (scorePosting() reaching
// 'pending_review'). Every reason this declines to submit on its own is one
// of AUTO_APPLY_SKIP_REASONS, recorded on the posting — never a silent drop.
import { submitApplication } from "./jobSearchAdapters/index.js";
import { resolvePostingForSubmission, SUBMITTABLE_ATS_TYPES } from "./jobSearchAdapters/atsResolver.js";
import { insertApplicationAttempt } from "./jobSearchApplicationStore.js";
// The cheap, Playwright-free gate checks live in their own module — see its
// own doc-comment for why this split exists (short version: this file also
// imports submitApplication above, which transitively imports playwright,
// and the gate logic needs to be importable from the main web app without
// dragging that in too).
import { adapterStatusToSkipReason, AUTO_APPLY_SKIP_REASONS, evaluateCheapGates } from "./jobSearchAutoApplyGates.js";
import { getDefaultResume, getResumeById } from "./jobSearchSettingsStore.js";

export { AUTO_APPLY_SKIP_REASONS };

// Returns { status, skipReason?, skipDetail? } where status is one of
// 'submitted' | 'failed' | 'skipped_auto_apply'. Writes an applications-table
// row (auto_applied = true) whenever an adapter was actually invoked — never
// for the cheap-gate or unresolved-ATS skips, since nothing was attempted for
// those and there's nothing worth an audit-trail screenshot of.
export async function evaluateAutoApply({ posting, findSettings, profile }) {
  const cheapSkip = evaluateCheapGates(posting, findSettings);
  if (cheapSkip) {
    return { status: "skipped_auto_apply", skipReason: cheapSkip.reason, skipDetail: cheapSkip.detail };
  }

  // Resolves (and persists onto the posting row) whichever real ATS this
  // actually is, if not already known — shared with the manual submit-worker
  // so a human-approved posting gets the exact same resolution.
  const { atsType: resolvedAtsType, applyUrl: resolvedApplyUrl } = await resolvePostingForSubmission(posting);

  if (!SUBMITTABLE_ATS_TYPES.has(resolvedAtsType)) {
    // Covers both a fully-unresolved posting and a *recognized* but
    // non-submittable platform (SmartRecruiters, Workday, iCIMS, Oracle
    // Recruiting/Taleo — see atsResolver.js) identically: nothing was
    // attempted, so nothing worth an application-table row, just the skip
    // reason on the posting itself.
    return {
      status: "skipped_auto_apply",
      skipReason: AUTO_APPLY_SKIP_REASONS.UNSUPPORTED_ATS,
      skipDetail: resolvedAtsType === "external"
        ? "Could not resolve this posting to a supported ATS (Greenhouse, Lever, or Ashby)."
        : `Resolved to ${resolvedAtsType}, which has no submission adapter.`
    };
  }

  const defaultResume = await getDefaultResume();
  const resumeWithBlob = defaultResume ? await getResumeById(defaultResume.id, { includeBlob: true }) : null;
  const resolvedPosting = { ...posting, atsType: resolvedAtsType, applyUrl: resolvedApplyUrl };

  const result = await submitApplication(resolvedAtsType, {
    posting: resolvedPosting,
    profile,
    resumeBuffer: resumeWithBlob?.fileBlob || null,
    resumeFileName: resumeWithBlob?.fileName || "resume.pdf",
    // Already fetched above for the blob — parsedText comes along for free,
    // just wasn't threaded through before. Lets the LLM free-text fallback
    // see the resume's own skills/summary text, not just structured
    // work-history entries (see answerFreeText's own comment).
    resumeText: resumeWithBlob?.parsedText || "",
    headless: process.env.JOB_SEARCH_PLAYWRIGHT_HEADLESS !== "false"
  });

  const submissionStatus = result.status === "submitted" ? "submitted" : (adapterStatusToSkipReason(result.status) ? "skipped_auto_apply" : "failed");

  await insertApplicationAttempt({
    postingId: posting.id,
    companyName: posting.companyName,
    jobTitle: posting.title,
    atsType: resolvedAtsType,
    applyUrl: resolvedApplyUrl,
    resumeId: defaultResume?.id || null,
    resumeLabel: defaultResume?.label || "",
    submittedAnswers: result.submittedAnswers,
    scoreSnapshot: {
      overall: posting.llmOverallScore,
      similarity: posting.embeddingSimilarity,
      scamRiskScore: posting.scamRiskScore,
      scamRiskLevel: posting.scamRiskLevel
    },
    submissionStatus: submissionStatus === "skipped_auto_apply" ? (result.status === "blocked" ? "needs_manual_review" : result.status) : submissionStatus,
    errorMessage: result.manualReviewFields?.length
      ? `Auto-apply couldn't confidently answer: ${result.manualReviewFields.join(", ")}`
      : result.errorMessage,
    atsConfirmationText: result.confirmationText,
    screenshotBuffer: result.screenshotBuffer,
    autoApplied: true
  });

  const skipReason = adapterStatusToSkipReason(result.status);
  if (skipReason) {
    return {
      status: "skipped_auto_apply",
      skipReason,
      skipDetail: result.manualReviewFields?.length
        ? `Auto-apply couldn't confidently answer: ${result.manualReviewFields.join(", ")}`
        : (result.errorMessage || "").slice(0, 500)
    };
  }

  // A genuine adapter failure (not a skip, not a success) still needs its
  // reason recorded somewhere a human can see it — the caller writes
  // skipDetail into the posting's decision_note regardless of which status
  // this returns (see scripts/job-search-submit-worker.mjs), so without this
  // the posting row carried zero information about why it failed, same gap
  // the human-approval submission path had until this same fix.
  return {
    status: result.status === "submitted" ? "submitted" : "failed",
    skipDetail: result.status === "submitted" ? undefined : (result.errorMessage || "Submission failed.").slice(0, 500)
  };
}
