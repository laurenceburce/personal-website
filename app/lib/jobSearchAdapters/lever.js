// Explicitly out of scope for this build — Greenhouse ships first per the plan.
export async function submitLeverApplication() {
  return {
    status: "unsupported_ats",
    submittedAnswers: {},
    manualReviewFields: [],
    confirmationText: "",
    screenshotBuffer: null,
    errorMessage: "Lever submission is not yet implemented."
  };
}
