// Explicitly out of scope for this build — Greenhouse ships first per the plan.
export async function submitAshbyApplication() {
  return {
    status: "unsupported_ats",
    submittedAnswers: {},
    manualReviewFields: [],
    confirmationText: "",
    screenshotBuffer: null,
    errorMessage: "Ashby submission is not yet implemented."
  };
}
