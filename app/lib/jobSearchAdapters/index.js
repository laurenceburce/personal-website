import { submitAshbyApplication } from "./ashby.js";
import { submitBreezyApplication } from "./breezy.js";
import { submitGreenhouseApplication } from "./greenhouse.js";
import { submitOracleFusionApplication } from "./oracleFusion.js";
import { submitPersonioApplication } from "./personio.js";
import { submitWorkableApplication } from "./workable.js";
// Lever remains polling-only. Its public postings API works, but the apply
// form is CAPTCHA-gated, so no submission adapter is registered here.

const ADAPTERS = {
  greenhouse: submitGreenhouseApplication,
  ashby: submitAshbyApplication,
  workable: submitWorkableApplication,
  personio: submitPersonioApplication,
  breezy: submitBreezyApplication,
  oracle_fusion: submitOracleFusionApplication
};

export async function submitApplication(atsType, params) {
  const adapter = ADAPTERS[atsType];
  if (!adapter) {
    return {
      status: "unsupported_ats",
      submittedAnswers: {},
      manualReviewFields: [],
      confirmationText: "",
      errorMessage: `No adapter registered for ATS type "${atsType}".`
    };
  }
  return adapter(params);
}
