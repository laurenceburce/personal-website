// Opt-in, all-or-nothing gate evaluated only for postings that already
// cleared the ordinary human-review bar (scorePosting() reaching
// 'pending_review'). Every reason this declines to submit on its own is one
// of AUTO_APPLY_SKIP_REASONS, recorded on the posting — never a silent drop.
import { submitApplication } from "./jobSearchAdapters/index.js";
import { resolvePostingForSubmission, SUBMITTABLE_ATS_TYPES } from "./jobSearchAdapters/atsResolver.js";
import { insertApplicationAttempt } from "./jobSearchApplicationStore.js";
import { getDefaultResume, getResumeById } from "./jobSearchSettingsStore.js";

export const AUTO_APPLY_SKIP_REASONS = {
  UNSUPPORTED_ATS: "unsupported_ats",
  REQUIRED_FIELD_UNKNOWN: "required_field_unknown",
  CAPTCHA_OR_LOGIN_REQUIRED: "captcha_or_login_required",
  SCAM_RISK_TOO_HIGH: "scam_risk_too_high",
  SCORE_TOO_LOW: "score_too_low"
};

function hoursSince(date) {
  if (!date) return Infinity;
  return (Date.now() - new Date(date).getTime()) / (1000 * 60 * 60);
}

// Cheap gates first (no browser launch, no network) — Playwright/ATS
// resolution is only reached once a posting has already cleared every free
// check. "Minimum embedding match" and "fresh posting only" both fold into
// SCORE_TOO_LOW rather than inventing extra reason codes beyond the fixed
// five this system tracks — the decisionNote spells out which one actually
// applied.
function evaluateCheapGates(posting, findSettings) {
  if ((posting.llmOverallScore ?? 0) < findSettings.autoApplyMinScore) {
    return {
      reason: AUTO_APPLY_SKIP_REASONS.SCORE_TOO_LOW,
      detail: `LLM score ${posting.llmOverallScore ?? 0} is below the auto-apply minimum of ${findSettings.autoApplyMinScore}.`
    };
  }
  if (posting.embeddingSimilarity != null && posting.embeddingSimilarity < findSettings.autoApplyMinMatch) {
    return {
      reason: AUTO_APPLY_SKIP_REASONS.SCORE_TOO_LOW,
      detail: `Resume match ${posting.embeddingSimilarity.toFixed(2)} is below the auto-apply minimum of ${findSettings.autoApplyMinMatch}.`
    };
  }
  if ((posting.scamRiskScore ?? 0) > findSettings.autoApplyMaxScamRisk) {
    return {
      reason: AUTO_APPLY_SKIP_REASONS.SCAM_RISK_TOO_HIGH,
      detail: `Scam-risk score ${posting.scamRiskScore} exceeds the auto-apply maximum of ${findSettings.autoApplyMaxScamRisk}.`
    };
  }
  const ageHours = hoursSince(posting.postedAt);
  if (ageHours > findSettings.autoApplyMaxAgeHours) {
    return {
      reason: AUTO_APPLY_SKIP_REASONS.SCORE_TOO_LOW,
      detail: `Posted ${Math.round(ageHours)}h ago, older than auto-apply's ${findSettings.autoApplyMaxAgeHours}h freshness limit.`
    };
  }
  return null;
}

function adapterStatusToSkipReason(status) {
  if (status === "blocked") return AUTO_APPLY_SKIP_REASONS.CAPTCHA_OR_LOGIN_REQUIRED;
  if (status === "needs_manual_review") return AUTO_APPLY_SKIP_REASONS.REQUIRED_FIELD_UNKNOWN;
  if (status === "unsupported_ats") return AUTO_APPLY_SKIP_REASONS.UNSUPPORTED_ATS;
  return null; // 'submitted' / 'failed' / 'dry_run_ok' handled by the caller directly
}

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

  return { status: result.status === "submitted" ? "submitted" : "failed" };
}
