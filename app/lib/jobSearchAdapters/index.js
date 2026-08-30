import { submitAshbyApplication } from "./ashby.js";
import { submitGreenhouseApplication } from "./greenhouse.js";
import { submitWorkableApplication } from "./workable.js";
// lever.js's submitLeverApplication is deliberately NOT imported/registered
// below — confirmed live (audit pass) that Lever now ships a real hCaptcha
// on its apply form platform-wide (tested across 5 unrelated companies, all
// 5 blocked), so every real attempt is guaranteed to fail. Same treatment as
// SmartRecruiters/iCIMS/Recruitee/Oracle Taleo — see atsTypes.js's
// SUBMITTABLE_ATS_TYPES comment. The file itself is left intact (working,
// correctly self-detects and reports the CAPTCHA via blockerDetection.js)
// rather than deleted, in case Lever ever drops it.

const ADAPTERS = {
  greenhouse: submitGreenhouseApplication,
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
