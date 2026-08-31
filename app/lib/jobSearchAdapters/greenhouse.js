import { findBestMemoryMatch, listAnswerMemoryForMatching, recordMemoryReuse } from "../jobSearchAnswerMemoryStore.js";
import { answerFreeText } from "../jobSearchLlm.js";
import { getFindSettings } from "../jobSearchSettingsStore.js";
import { getTodayLlmUsage, incrementLlmUsage } from "../jobSearchUsageStore.js";
import { clickWithBrowserMouse, setCheckedWithBrowserMouse } from "./browserEngineClick.js";
import { detectSubmissionBlocker } from "./blockerDetection.js";
import { launchJobSearchBrowser } from "./jobSearchBrowser.js";
import {
  isEeoLabel,
  isWorkAuthLabel,
  manualOverrideCandidates,
  normalizeLabel,
  resolveEeoValue,
  resolveManualOverride,
  resolveStandardFieldCandidates,
  resolveWorkAuthValue
} from "./profileMapping.js";
import { resumeFilePayload } from "./resumeFilePayload.js";
import { resumeUploadLikelyFailed } from "./resumeUploadCheck.js";

const NAV_TIMEOUT_MS = 30000;
const FORM_WAIT_TIMEOUT_MS = 15000;
const SUBMIT_SETTLE_TIMEOUT_MS = 10000;
// Raised from 5 after an audit pass: daily LLM usage sits at ~120 calls
// against a 5000/day cap (jobSearchUsageStore.js), so 5 was an arbitrary
// early-caution number, not a cost/rate-limit necessity — and a form with
// more than 5 genuinely-answerable custom questions (confirmed live: a real
// Codurance/Workable posting had exactly 5) was hitting this ceiling and
// deferring the rest to manual review for no reason beyond the count.
const MAX_LLM_ANSWERED_FIELDS = 15;

// Confirmed against Greenhouse's own confirmation-page/inline-validation
// copy. Deliberately conservative — an unmatched confirmation page falls
// through to "still on the form" below rather than being guessed as success.
const SUCCESS_TEXT_SIGNALS = /(thank you for applying|application (has been |was )?(successfully )?submitted|we('| ha)ve received your application|your application (has been|was) received)/i;
const ERROR_TEXT_SIGNALS = /(this field is required|please (enter|select|fill)|is required\b|error submitting|something went wrong)/i;

// Real Greenhouse forms are embedded two ways: inline on boards.greenhouse.io /
// job-boards.greenhouse.io, or via <iframe src="...greenhouse.io/embed/job_app...">
// on a company's own branded careers domain (confirmed live against Asana's
// board) — frameLocator and Page expose the same .locator() API, so nothing
// downstream needs to branch on which one it got.
async function findFormScope(page) {
  const iframe = page.locator('iframe[src*="greenhouse"]').first();
  if (await iframe.count().catch(() => 0) > 0) {
    return page.frameLocator('iframe[src*="greenhouse"]').first();
  }
  return page;
}

// Confirmed live: standard fields (name/email/phone) are plain <input>, but
// most everything else — including ones that look like plain text fields, e.g.
// "Location (City)" — are a react-select-style combobox (role="combobox",
// aria-haspopup="true"). Widget type has to be detected per-field, not assumed
// from the label.
async function classifyWidget(locator) {
  const tag = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
  if (tag === "select") return "native-select";
  if (tag === "textarea") return "textarea";
  const type = (await locator.getAttribute("type").catch(() => "")) || "";
  if (type === "checkbox") return "checkbox";
  if (type === "radio") return "radio";
  if (type === "file") return "file";
  const role = (await locator.getAttribute("role").catch(() => "")) || "";
  const hasPopup = (await locator.getAttribute("aria-haspopup").catch(() => "")) === "true";
  if (role === "combobox" || hasPopup) return "react-select";
  return "text";
}

// react-select renders its option list only while open, scoped near the input
// that opened it — confirmed live that typing via .fill() correctly triggers
// its filtered option list (Playwright's fill dispatches a real input event).
async function fillReactSelect(page, scope, input, value, debugLabel = null) {
  await clickWithBrowserMouse(page, input);
  await input.fill(String(value));

  const options = scope.locator(".select__option");
  try {
    await options.first().waitFor({ state: "visible", timeout: 3000 });
  } catch {
    await input.press("Escape").catch(() => {});
    if (debugLabel) console.log(`  [fill-debug] react-select "${debugLabel}": no options appeared for "${value}"`);
    return false;
  }

  // Only accept an exact (case-insensitive) match — never click the first
  // fuzzy suggestion for a field we were asked to fill precisely. Confirmed
  // live as a real miss, not theoretical: a "Country*" field built on
  // Greenhouse's own phone-style country-picker component renders its
  // options as "United States +1", not bare "United States" — a plain exact
  // match against every candidate ("United States", "USA", "US", ...) never
  // matched ANY of them, sending a resolvable field to manual review every
  // time. Stripping a trailing " +<digits>" (the calling code) before
  // re-checking catches that shape specifically — it does NOT loosen this
  // into a substring/fuzzy match (still rejects "United States Minor
  // Outlying Islands" for a "United States" candidate), it only strips one
  // specific, known suffix pattern.
  const target = String(value).trim().toLowerCase();
  const texts = await options.allInnerTexts().catch(() => []);
  const stripTrailingCallingCode = (t) => t.replace(/\s*\+\d+\s*$/, "").trim().toLowerCase();
  let exactIndex = texts.findIndex((t) => t.trim().toLowerCase() === target);
  if (exactIndex < 0) exactIndex = texts.findIndex((t) => stripTrailingCallingCode(t) === target);
  if (exactIndex < 0) {
    await input.press("Escape").catch(() => {});
    if (debugLabel) console.log(`  [fill-debug] react-select "${debugLabel}": no option matched "${value}" — saw: ${JSON.stringify(texts)}`);
    return false;
  }

  await clickWithBrowserMouse(page, options.nth(exactIndex));
  return true;
}

// Captures a select/react-select field's real available options at the
// point it's about to be flagged for manual review — only ever called
// there (never proactively for every field), so it adds no overhead to a
// field that resolves fine. Lets the Review Queue's "Answer & Retry" popup
// render an actual dropdown of real option text instead of a free-text box
// a typed answer might not exactly match — confirmed live this was exactly
// the gap: a saved answer of "None" silently matched nothing against a
// field whose only real options were "Yes"/"No", with no indication in the
// popup that it was even a dropdown.
async function captureFieldOptions(page, scope, locator, widget) {
  if (widget === "native-select") {
    const texts = await locator.locator("option").allInnerTexts().catch(() => []);
    return texts.map((t) => t.trim()).filter(Boolean);
  }
  if (widget === "react-select") {
    await clickWithBrowserMouse(page, locator).catch(() => {});
    const options = scope.locator(".select__option");
    try {
      await options.first().waitFor({ state: "visible", timeout: 2000 });
      const texts = await options.allInnerTexts();
      await locator.press("Escape").catch(() => {});
      return texts.map((t) => t.trim()).filter(Boolean);
    } catch {
      await locator.press("Escape").catch(() => {});
      return [];
    }
  }
  return [];
}

// `debugLabel`, when passed, logs exactly why a fill attempt failed —
// confirmed live this was needed: a field can look identical (same widget,
// same real "No" option, right next to others that filled fine) and still
// silently fail with nothing in the stored result to say why. Only ever
// passed by the manual-override/memory-match call sites below (the ones
// actually being debugged) — every other caller stays silent, matching
// this function's original behavior.
async function fillByWidget(page, scope, locator, widget, value, debugLabel = null) {
  switch (widget) {
    case "text":
    case "textarea":
      await locator.fill(String(value));
      return true;
    case "checkbox":
      await setCheckedWithBrowserMouse(page, locator, Boolean(value));
      return true;
    case "native-select":
      try {
        await locator.selectOption({ label: String(value) });
        return true;
      } catch (error) {
        if (debugLabel) {
          const optionTexts = await locator.locator("option").allInnerTexts().catch(() => []);
          console.log(`  [fill-debug] native-select "${debugLabel}": "${value}" didn't match — options: ${JSON.stringify(optionTexts)} (${error?.message || error})`);
        }
        return false;
      }
    case "react-select":
      return fillReactSelect(page, scope, locator, value, debugLabel);
    default:
      if (debugLabel) console.log(`  [fill-debug] "${debugLabel}": widget "${widget}" has no fill path here`);
      return false;
  }
}

// Collects {label, normalizedLabel, locator, forId, required} for every
// label[for] pair in the form scope — the only reliable way to associate a
// field with its meaning, since custom question ids are unique per posting.
async function collectLabeledFields(scope) {
  const labelHandles = await scope.locator("label[for]").all();
  const fields = [];

  for (const label of labelHandles) {
    const forId = await label.getAttribute("for").catch(() => null);
    if (!forId) continue;
    const text = (await label.innerText().catch(() => "")) || "";
    const required = text.includes("*");
    // Attribute selector rather than `#id` — this code runs in the Node/Playwright
    // context, not the browser, so the DOM's CSS.escape() isn't available here,
    // and an attribute-value selector sidesteps CSS id-escaping entirely.
    const locator = scope.locator(`[id="${forId.replace(/"/g, '\\"')}"]`);
    if (await locator.count().catch(() => 0) === 0) continue;

    fields.push({ label: text, normalizedLabel: normalizeLabel(text), locator, forId, required });
  }

  return fields;
}

async function uploadResumeFile(page, scope, resumeBuffer, resumeFileName) {
  const fileInput = scope.locator("#resume");
  if (await fileInput.count().catch(() => 0) === 0) return false;

  await fileInput.setInputFiles(resumeFilePayload(resumeBuffer, resumeFileName));
  // setInputFiles() only attaches the file to the DOM input — it says
  // nothing about whether Greenhouse's own JS then actually uploaded it.
  // See resumeUploadCheck.js.
  return !(await resumeUploadLikelyFailed(page, scope));
}

// Consent-style checkboxes (e.g. "I consent to collecting demographic data for
// EEO purposes") aren't a discrete answer — they gate submitting the EEO
// answers at all. Checked only when the profile actually has EEO data to
// submit; otherwise left alone and flagged for manual review like anything else.
function isEeoConsentCheckboxLabel(label) {
  return /consent/.test(label) && /(demographic|eeo|equal employment)/.test(label);
}

export async function submitGreenhouseApplication({ posting, profile, resumeBuffer, resumeFileName, resumeText = "", dryRun = false, headless = true }) {
  const { browser, newPage } = await launchJobSearchBrowser({ headless });
  const submittedAnswers = {};
  const manualReviewFields = [];
  // Real available options for a select/react-select field, keyed by label
  // — see captureFieldOptions()'s own comment. Populated by flagForReview()
  // below, once page/scope exist.
  const fieldOptions = {};
  let llmAnsweredCount = 0;
  let confirmationText = "";
  let screenshotBuffer = null;
  let status = "failed";
  let errorMessage = "";
  let findSettings = null;
  const getLlmFindSettings = async () => {
    if (!findSettings) findSettings = await getFindSettings();
    return findSettings;
  };

  try {
    const page = await newPage();
    await page.goto(posting.applyUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });

    const scope = await findFormScope(page);
    await scope.locator("label[for]").first().waitFor({ state: "visible", timeout: FORM_WAIT_TIMEOUT_MS });

    const blockerReason = await detectSubmissionBlocker(scope);
    if (blockerReason) {
      screenshotBuffer = await page.screenshot({ fullPage: true }).catch(() => null);
      return { status: "blocked", submittedAnswers, manualReviewFields, fieldOptions, confirmationText, screenshotBuffer, errorMessage: blockerReason };
    }

    if (resumeBuffer) {
      const uploaded = await uploadResumeFile(page, scope, resumeBuffer, resumeFileName);
      if (!uploaded) manualReviewFields.push("Resume upload (could not confirm success)");
    }

    const fields = await collectLabeledFields(scope);
    // Fetched once, reused for every field below — see
    // jobSearchAnswerMemoryStore.js's own comment on why this isn't a
    // per-field query.
    const memoryRows = await listAnswerMemoryForMatching().catch(() => []);

    async function flagForReview(label, locator, widget) {
      manualReviewFields.push(label);
      const options = await captureFieldOptions(page, scope, locator, widget).catch(() => []);
      if (options.length > 0) fieldOptions[label] = options;
    }

    for (const field of fields) {
      const widget = await classifyWidget(field.locator);
      if (widget === "file") continue; // resume/cover-letter handled separately

      // A human already answered this exact question for this exact posting
      // (see the Review Queue's "Answer & Retry" popup) — try it before any
      // auto-resolution strategy below. Falls through to those on failure
      // (e.g. the form's widget shape changed since the answer was saved),
      // rather than giving up on the field outright.
      const manualOverride = resolveManualOverride(field.normalizedLabel, posting.manualReviewFields);
      if (manualOverride != null) {
        let overrideFilled = null;
        for (const candidate of manualOverrideCandidates(manualOverride)) {
          if (await fillByWidget(page, scope, field.locator, widget, candidate, field.label)) {
            overrideFilled = candidate;
            break;
          }
        }
        if (overrideFilled != null) {
          submittedAnswers[field.label] = overrideFilled;
          continue;
        }
      }

      if (widget === "checkbox" && isEeoConsentCheckboxLabel(field.normalizedLabel)) {
        const hasEeoData = Object.values(profile.eeoAnswers || {}).some(Boolean);
        if (hasEeoData) {
          await fillByWidget(page, scope, field.locator, widget, true);
          submittedAnswers[field.label] = true;
        } else if (field.required) {
          manualReviewFields.push(field.label);
        }
        continue;
      }

      // EEO/work-authorization: hard-mapped by exact stored text, never the LLM.
      //
      // Flagged for manual review on any failure to fill — NOT gated behind
      // field.required. Confirmed live this was a real gap: a "Are you
      // Hispanic/Latino?" EEO field carried no visible asterisk (EEO
      // questions are routinely framed as "voluntary"), so when
      // resolveEeoValue() returned the profile's raceEthnicity value (right
      // category, wrong shape — this specific field is yes/no, not a race
      // picklist) and the fill predictably failed, the old `else if
      // (field.required)` left it silently blank. Greenhouse's own
      // client-side validation still required SOME selection there before
      // allowing submit, so the posting fell all the way through to
      // "Failed: clicking submit did not produce a recognized confirmation"
      // — a real submission ATTEMPT with no clear reason, instead of a
      // needs_manual_review outcome naming the actual field. Worst case for
      // flagging a genuinely-optional field here is one unnecessary manual
      // review; worst case for not flagging it is exactly what happened.
      if (isEeoLabel(field.normalizedLabel)) {
        const value = resolveEeoValue(field.normalizedLabel, profile.eeoAnswers);
        if (value && await fillByWidget(page, scope, field.locator, widget, value)) {
          submittedAnswers[field.label] = value;
        } else {
          await flagForReview(field.label, field.locator, widget);
        }
        continue;
      }

      if (isWorkAuthLabel(field.normalizedLabel)) {
        const value = resolveWorkAuthValue(field.normalizedLabel, profile.workAuthorization);
        if (value && await fillByWidget(page, scope, field.locator, widget, value)) {
          submittedAnswers[field.label] = value;
        } else {
          await flagForReview(field.label, field.locator, widget);
        }
        continue;
      }

      // Known profile field (name/email/phone/links/etc). Some fields have
      // more than one acceptable value (country name spelled out vs.
      // abbreviated, phone with/without its country code) —
      // resolveStandardFieldCandidates() returns them in priority order;
      // fillByWidget() already dispatches correctly per widget type, so
      // retrying candidates here is what actually lets a select succeed
      // instead of landing in manual review over a spelling mismatch.
      const standardCandidates = resolveStandardFieldCandidates(field.normalizedLabel, profile, field.label);
      if (standardCandidates.length > 0) {
        let filledValue = null;
        for (const candidate of standardCandidates) {
          if (await fillByWidget(page, scope, field.locator, widget, candidate)) {
            filledValue = candidate;
            break;
          }
        }
        if (filledValue != null) {
          submittedAnswers[field.label] = filledValue;
        } else if (field.required) {
          await flagForReview(field.label, field.locator, widget);
        }
        continue;
      }

      // A similarly-worded question was answered by hand on a DIFFERENT
      // posting before (see the Review Queue's Memory tab / "Answer & Retry"
      // popup) — a human-verified past answer beats a fresh LLM guess, so
      // this is checked before the free-text fallback below, for any widget
      // type (not just text), reusing the exact same daily LLM-call budget
      // check the free-text branch already does right after this.
      if (memoryRows.length > 0) {
        const llmSettings = await getLlmFindSettings();
        const usage = await getTodayLlmUsage();
        if (usage.totalCalls < llmSettings.maxLlmCallsPerDay) {
          const memoryMatch = await findBestMemoryMatch(field.label, posting.companyName, memoryRows).catch(() => null);
          if (memoryMatch) {
            let memoryFilled = null;
            for (const candidate of manualOverrideCandidates(memoryMatch.answer)) {
              if (await fillByWidget(page, scope, field.locator, widget, candidate, field.label)) {
                memoryFilled = candidate;
                break;
              }
            }
            if (memoryFilled != null) {
              submittedAnswers[field.label] = memoryFilled;
              await recordMemoryReuse(memoryMatch.id).catch(() => {});
              continue;
            }
          }
        }
      }

      // Novel free-text question — LLM-assisted, capped, and only for plain
      // text/textarea widgets. Never used for a combobox/select/checkbox,
      // since guessing a value into a fixed option set risks submitting
      // something the model invented that doesn't match any real option.
      // Also metered against the same daily budget as scoring/embedding —
      // checked fresh per field (not cached across the loop) so it can't
      // overshoot the cap by more than one in-flight call, matching the same
      // pattern jobSearchScoringPipeline.scorePosting() uses.
      if ((widget === "text" || widget === "textarea") && llmAnsweredCount < MAX_LLM_ANSWERED_FIELDS) {
        const llmSettings = await getLlmFindSettings();
        const usage = await getTodayLlmUsage();
        if (usage.totalCalls >= llmSettings.maxLlmCallsPerDay) {
          manualReviewFields.push(field.label);
          continue;
        }

        const answer = await answerFreeText({ question: field.label, posting, profile, resumeText }).catch(() => null);
        await incrementLlmUsage("score");
        if (answer) {
          await field.locator.fill(answer);
          submittedAnswers[field.label] = answer;
          llmAnsweredCount += 1;
          continue;
        }
      }

      if (field.required) {
        await flagForReview(field.label, field.locator, widget);
        // Diagnostic for exactly the case that motivated this: a field that
        // stays stuck in manual review across repeated Answer & Retry
        // attempts despite a real answer being typed each time. If there WAS
        // a saved override, the "no options appeared"/"no option matched"
        // logs above already say why the fill itself failed; if there
        // wasn't one at all, this shows whether the label simply never
        // matched what's stored (see profileMapping.js's
        // resolveManualOverride) rather than guessing blind again.
        if (manualOverride != null) {
          console.log(`  [fill-debug] "${field.label}" still unresolved despite a saved override ("${manualOverride}") — see the fill-debug line above for why the fill itself failed.`);
        } else if ((posting.manualReviewFields || []).length > 0) {
          console.log(`  [fill-debug] "${field.label}" (normalized: "${field.normalizedLabel}") had no saved override match — saved labels were: ${JSON.stringify((posting.manualReviewFields || []).map((f) => f.label))}`);
        }
      }
    }

    screenshotBuffer = await page.screenshot({ fullPage: true }).catch(() => null);

    if (manualReviewFields.length > 0) {
      status = "needs_manual_review";
    } else if (dryRun) {
      status = "dry_run_ok";
    } else {
      const submitButton = scope.locator('button[type="submit"], input[type="submit"]').first();
      await clickWithBrowserMouse(page, submitButton);

      // Greenhouse either navigates to a confirmation page/state or re-renders
      // the same form with inline validation errors — wait for the network to
      // settle rather than assuming a fixed delay is enough, then actually
      // inspect what happened instead of blindly marking it submitted.
      await page.waitForLoadState("networkidle", { timeout: SUBMIT_SETTLE_TIMEOUT_MS }).catch(() => {});
      await page.waitForTimeout(500); // let inline validation errors finish rendering, if any

      // Read from `scope`, not always `page` — when the form is iframe-embedded,
      // the confirmation message renders inside the iframe, not the parent page.
      confirmationText = (await scope.locator("body").innerText().catch(() => "")).slice(0, 500);
      screenshotBuffer = await page.screenshot({ fullPage: true }).catch(() => screenshotBuffer);

      const stillOnFormPage = await submitButton.isVisible().catch(() => false);
      const hasErrorSignal = ERROR_TEXT_SIGNALS.test(confirmationText);
      const hasSuccessSignal = SUCCESS_TEXT_SIGNALS.test(confirmationText);

      if (hasErrorSignal || (stillOnFormPage && !hasSuccessSignal)) {
        status = "failed";
        errorMessage = "Clicking submit did not produce a recognized confirmation — the form may still be showing "
          + "the submit button or a validation error. Check the screenshot before assuming this was submitted.";
      } else {
        status = "submitted";
      }
    }
  } catch (error) {
    errorMessage = error?.message || String(error);
    status = "failed";
  } finally {
    await browser.close();
  }

  // A screenshot is only worth its storage cost (~600KB/attempt, LONGBLOB,
  // never pruned — see jobSearchApplicationStore.js) when a human actually
  // needs to look at it: failed/needs_manual_review/blocked outcomes, where
  // it's the only way to see what the page actually looked like without
  // re-running Playwright. A successful submission already has
  // confirmationText as its receipt, so it doesn't need one too.
  if (status === "submitted") screenshotBuffer = null;

  return { status, submittedAnswers, manualReviewFields, fieldOptions, confirmationText, screenshotBuffer, errorMessage };
}
