// Pure, Playwright-free auto-apply gate logic, split out of
// jobSearchAutoApply.js specifically so it's safe to import from the main
// web app (page.js, API routes) for a "what would auto-apply do next"
// preview. jobSearchAutoApply.js itself also imports submitApplication,
// which transitively imports `playwright` via the ATS adapters — confirmed
// live once already that importing anything from a Playwright-touching
// module (even just for an unrelated constant) can break the main app's
// production build outright, not just fail at the point of actually
// launching a browser (see atsTypes.js's own history, and the
// aa2f71a/2ea5d2f commits that fixed the first two instances of this exact
// class of bug). This file must never import from jobSearchAdapters/index.js,
// jobSearchAdapters/atsResolver.js, or jobSearchAutoApply.js itself.
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
// applied. Returns null when every gate passes (this posting would actually
// be attempted next), or { reason, detail } for whichever gate it fails.
export function evaluateCheapGates(posting, findSettings) {
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

export function adapterStatusToSkipReason(status) {
  if (status === "blocked") return AUTO_APPLY_SKIP_REASONS.CAPTCHA_OR_LOGIN_REQUIRED;
  if (status === "needs_manual_review") return AUTO_APPLY_SKIP_REASONS.REQUIRED_FIELD_UNKNOWN;
  if (status === "unsupported_ats") return AUTO_APPLY_SKIP_REASONS.UNSUPPORTED_ATS;
  return null; // 'submitted' / 'failed' / 'dry_run_ok' handled by the caller directly
}
