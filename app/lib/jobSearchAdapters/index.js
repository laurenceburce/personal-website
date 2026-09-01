import { submitAshbyApplication } from "./ashby.js";
import { submitBreezyApplication } from "./breezy.js";
import { submitGreenhouseApplication } from "./greenhouse.js";
import { submitLeverApplication } from "./lever.js";
import { submitOracleFusionApplication } from "./oracleFusion.js";
import { submitPersonioApplication } from "./personio.js";
import { submitRecruiteeApplication } from "./recruitee.js";
import { submitWorkableApplication } from "./workable.js";

const ADAPTERS = {
  greenhouse: submitGreenhouseApplication,
  lever: submitLeverApplication,
  ashby: submitAshbyApplication,
  workable: submitWorkableApplication,
  recruitee: submitRecruiteeApplication,
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
