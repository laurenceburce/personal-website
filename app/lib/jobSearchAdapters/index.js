import { submitAshbyApplication } from "./ashby.js";
import { submitGreenhouseApplication } from "./greenhouse.js";
import { submitLeverApplication } from "./lever.js";
import { submitWorkableApplication } from "./workable.js";

const ADAPTERS = {
  greenhouse: submitGreenhouseApplication,
  lever: submitLeverApplication,
  ashby: submitAshbyApplication,
  workable: submitWorkableApplication
};

export async function submitApplication(atsType, params) {
  const adapter = ADAPTERS[atsType];
  if (!adapter) {
    return {
      status: "unsupported_ats",
      submittedAnswers: {},
      manualReviewFields: [],
      confirmationText: "",
      screenshotBuffer: null,
      errorMessage: `No adapter registered for ATS type "${atsType}".`
    };
  }
  return adapter(params);
}
