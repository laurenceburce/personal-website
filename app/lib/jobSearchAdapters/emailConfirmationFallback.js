import { findEmailSubmissionConfirmation } from "../jobSearchEmailCode.js";

function formatEmailConfirmation(confirmation) {
  const parts = ["Submission confirmed by email"];
  if (confirmation?.from) parts.push(`from ${confirmation.from}`);
  if (confirmation?.subject) parts.push(`subject "${confirmation.subject}"`);
  if (confirmation?.receivedAt) parts.push(`received ${confirmation.receivedAt}`);
  return parts.join("; ").slice(0, 500);
}

export async function findSubmissionConfirmationEmailText(posting, attemptedAtMs) {
  if (process.env.JOB_SEARCH_EMAIL_CONFIRMATION_FALLBACK !== "true") return "";
  if (!attemptedAtMs) return "";

  try {
    const confirmation = await findEmailSubmissionConfirmation(posting, { sinceMs: attemptedAtMs });
    return formatEmailConfirmation(confirmation);
  } catch (error) {
    if (process.env.JOB_SEARCH_EMAIL_CONFIRMATION_DEBUG === "true") {
      console.log("[submit-email-confirmation]", error?.message || error);
    }
    return "";
  }
}
