// Recruitee exposes a normal application form, but the platform can gate the
// final send behind hCaptcha. This adapter fills only fields it can justify,
// then uses the live relay if a challenge appears before or after submit.
import { findBestMemoryMatch, findExactMemoryMatch, listAnswerMemoryForMatching, recordMemoryReuse } from "../jobSearchAnswerMemoryStore.js";
import { answerFreeText } from "../jobSearchLlm.js";
import { getFindSettings } from "../jobSearchSettingsStore.js";
import { getTodayLlmUsage, incrementLlmUsage } from "../jobSearchUsageStore.js";
import { clickWithBrowserMouse, setCheckedWithBrowserMouse } from "./browserEngineClick.js";
import { detectSubmissionBlocker, isHeldChallengeBlockerReason } from "./blockerDetection.js";
import { requireApplicationFormReady } from "./formReadiness.js";
import { resolveHeldChallenge } from "./heldChallengeRelay.js";
import { launchJobSearchBrowser } from "./jobSearchBrowser.js";
import {
  isEeoLabel,
  isWorkAuthLabel,
  manualOverrideCandidates,
  matchOptionByCandidates,
  normalizeLabel,
  resolveEeoCandidates,
  resolveManualOverride,
  resolveStandardFieldCandidates,
  resolveWorkAuthValue
} from "./profileMapping.js";
import { uploadResumeWithRetry } from "./resumeUploadCheck.js";

const NAV_TIMEOUT_MS = 30000;
const FORM_WAIT_TIMEOUT_MS = 15000;
const SUBMIT_SETTLE_TIMEOUT_MS = 10000;
const MAX_LLM_ANSWERED_FIELDS = 15;

const SUCCESS_TEXT_SIGNALS = /(thank you for applying|thanks for applying|thank you for your application|thanks for your application|application (has been |was |is )?(successfully )?(submitted|received|sent)|we('| ha)ve received your application|we received your application|we got your application|your application (has been|was|is) received|application received)/i;
const ERROR_TEXT_SIGNALS = /(this field is required|please (enter|select|fill)|is required\b|error submitting|something went wrong|invalid|upload failed|failed to upload|captcha|invalid code|incorrect code|expired code|verification failed)/i;

function cssAttr(value) {
  return String(value || "").replace(/"/g, '\\"');
}

function cleanLabel(text) {
  return String(text || "")
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function profileLocation(profile) {
  return [profile?.city, profile?.stateRegion, profile?.country].filter(Boolean).join(", ");
}

function isCandidateLogisticsLabel(label, name) {
  const text = `${label} ${name || ""}`;
  return /\b(available from|availability|earliest start|start date|notice period|expected salary|salary expectation|desired salary|compensation expectation|time\s*zone|timezone)\b/.test(text);
}

async function waitForForm(page) {
  return requireApplicationFormReady(page, {
    platformName: "Recruitee",
    timeoutMs: FORM_WAIT_TIMEOUT_MS
  });
}

async function resolveCurrentBlocker(page, posting, submittedAnswers) {
  const blockerReason = await detectSubmissionBlocker(page);
  if (!blockerReason) return { ok: true };
  if (isHeldChallengeBlockerReason(blockerReason)) {
    return resolveHeldChallenge({ page, scope: page, posting, submittedAnswers, blockerReason });
  }
  return { ok: false, errorMessage: blockerReason };
}

async function collectFileFields(page) {
  return page.evaluate(() => {
    const text = (el) => (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
    return [...document.querySelectorAll('form input[type="file"]')].map((el) => ({
      name: el.getAttribute("name") || "",
      label: text((el.labels || [])[0]) || el.getAttribute("aria-label") || el.getAttribute("name") || "File upload",
      required: Boolean(el.required || el.getAttribute("aria-required") === "true") || /\*/.test(text((el.labels || [])[0]))
    }));
  });
}

async function collectFields(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const text = (el) => (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
    const fieldsetLabel = (el) => {
      const fieldset = el.closest("fieldset");
      if (fieldset) return text(fieldset.querySelector("legend"));
      const group = el.closest('[role="radiogroup"], [role="group"]');
      if (group) return group.getAttribute("aria-label") || text(group.querySelector("label, h1, h2, h3, h4"));
      return "";
    };
    const labelFor = (el) => text((el.labels || [])[0]) || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || "";
    const requiredFor = (el, labelText) => Boolean(el.required || el.getAttribute("aria-required") === "true") || /\*/.test(labelText);

    const fields = [];
    const seenRadioNames = new Set();
    for (const el of document.querySelectorAll("form input[name], form textarea[name], form select[name]")) {
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") || "").toLowerCase();
      const name = el.getAttribute("name") || "";
      if (!name || type === "hidden" || type === "file" || type === "submit" || type === "button") continue;
      if (!visible(el) && type !== "radio" && type !== "checkbox") continue;

      if (type === "radio") {
        if (seenRadioNames.has(name)) continue;
        seenRadioNames.add(name);
        const radios = [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`)];
        const groupLabel = fieldsetLabel(el) || text(el.closest(".form-field, .question, [data-qa]"));
        fields.push({
          kind: "radio-group",
          name,
          label: groupLabel || name,
          normalizedLabel: "",
          required: radios.some((radio) => requiredFor(radio, labelFor(radio))),
          options: radios.map((radio) => ({
            value: radio.value,
            text: labelFor(radio) || text(radio.closest("label, li, div")) || radio.value
          })).filter((option) => option.text)
        });
        continue;
      }

      const rawLabel = labelFor(el);
      fields.push({
        kind: type === "checkbox" ? "checkbox" : "field",
        name,
        tag,
        type,
        label: rawLabel,
        normalizedLabel: "",
        required: requiredFor(el, rawLabel),
        options: tag === "select"
          ? [...el.options].map((option) => ({ value: option.value, text: option.textContent.trim() })).filter((option) => option.value && option.text)
          : []
      });
    }

    return fields.map((field) => ({ ...field, label: field.label.replace(/\s+/g, " ").trim() }));
  });
}

async function selectOptionByText(locator, candidates) {
  const values = Array.isArray(candidates) ? candidates : [candidates];
  for (const candidate of values.filter(Boolean)) {
    const optionValue = await locator.evaluate((select, wanted) => {
      const clean = (text) => String(text || "").toLowerCase().replace(/\*/g, "").replace(/\[optional[^\]]*\]/g, "").replace(/\([^)]*\)/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
      const normalizedWanted = String(wanted || "").trim().toLowerCase();
      const normalizedCleanWanted = clean(wanted);
      const options = [...select.options];
      const exact = options.find((option) => option.textContent.trim().toLowerCase() === normalizedWanted);
      if (exact) return exact.value;
      const normalized = options.find((option) => clean(option.textContent) === normalizedCleanWanted);
      if (normalized) return normalized.value;
      const valueMatch = options.find((option) => String(option.value || "").trim().toLowerCase() === normalizedWanted);
      return valueMatch ? valueMatch.value : null;
    }, String(candidate)).catch(() => null);
    if (optionValue != null) {
      await locator.selectOption({ value: optionValue });
      return candidate;
    }
  }
  return null;
}

async function fillField(page, field, candidates) {
  const values = Array.isArray(candidates) ? candidates : [candidates];

  if (field.kind === "radio-group") {
    const match = matchOptionByCandidates(field.options, values);
    if (!match) return null;
    const radio = page.locator(`input[type="radio"][name="${cssAttr(field.name)}"][value="${cssAttr(match.value)}"]`).first();
    const checked = await setCheckedWithBrowserMouse(page, radio, true).then(() => true).catch(() => false);
    return checked ? match.text : null;
  }

  if (field.kind === "checkbox") {
    const wantsChecked = values.some((value) => /^(yes|true|checked|1)$/i.test(String(value || "").trim()));
    if (!wantsChecked) return null;
    const checkbox = page.locator(`input[type="checkbox"][name="${cssAttr(field.name)}"]`).first();
    const checked = await setCheckedWithBrowserMouse(page, checkbox, true).then(() => true).catch(() => false);
    return checked ? "Yes" : null;
  }

  const locator = page.locator(`[name="${cssAttr(field.name)}"]`).first();
  if (field.tag === "select") return selectOptionByText(locator, values);

  for (const value of values.filter(Boolean)) {
    const filled = await locator.fill(String(value)).then(() => true).catch(() => false);
    if (filled) return value;
  }
  return null;
}

function namedCandidates(field, profile) {
  switch (field.name) {
    case "candidate.name": return [profile?.fullName];
    case "candidate.email": return [profile?.email];
    case "candidate.phone": return [profile?.phone];
    case "candidate.location": return [profileLocation(profile)];
    default: return [];
  }
}

async function uploadResumeFile(page, resumeBuffer, resumeFileName) {
  const fileInput = page.locator('input[type="file"][name="candidate.cv"], input[type="file"][name*="resume" i], input[type="file"][name*="cv" i]').first();
  if ((await fileInput.count().catch(() => 0)) === 0) return { ok: false, reason: "no CV/resume file input found" };

  const uploaded = await uploadResumeWithRetry(page, page, fileInput, resumeBuffer, resumeFileName);
  return uploaded ? { ok: true } : { ok: false, reason: "could not confirm upload success" };
}

function captureFieldOptions(field) {
  if (!Array.isArray(field.options) || field.options.length === 0) return [];
  return field.options.map((option) => option.text).filter(Boolean);
}

async function shouldUseLlm(getLlmFindSettings) {
  try {
    const llmSettings = await getLlmFindSettings();
    const usage = await getTodayLlmUsage();
    return usage.totalCalls < llmSettings.maxLlmCallsPerDay;
  } catch {
    return false;
  }
}

async function readOutcomeAfterSubmit({ page, submitButton, posting, submittedAnswers }) {
  await clickWithBrowserMouse(page, submitButton);
  await page.waitForLoadState("networkidle", { timeout: SUBMIT_SETTLE_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(500);

  const blockerResult = await resolveCurrentBlocker(page, posting, submittedAnswers);
  if (!blockerResult.ok) {
    return { status: "blocked", confirmationText: "", errorMessage: blockerResult.errorMessage };
  }

  if (await submitButton.isVisible().catch(() => false)) {
    await clickWithBrowserMouse(page, submitButton);
    await page.waitForLoadState("networkidle", { timeout: SUBMIT_SETTLE_TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(500);
  }

  const confirmationText = (await page.locator("body").innerText().catch(() => "")).slice(0, 500);
  const stillOnFormPage = await submitButton.isVisible().catch(() => false);
  const hasErrorSignal = ERROR_TEXT_SIGNALS.test(confirmationText);
  const hasSuccessSignal = SUCCESS_TEXT_SIGNALS.test(confirmationText);

  if (hasErrorSignal || (stillOnFormPage && !hasSuccessSignal)) {
    return {
      status: "failed",
      confirmationText,
      errorMessage: "Clicking submit did not produce a recognized confirmation — the form may still be showing "
        + "the submit button or a validation error. Review the posting manually before assuming this was submitted."
    };
  }

  return { status: "submitted", confirmationText, errorMessage: "" };
}

export async function submitRecruiteeApplication({ posting, profile, resumeBuffer, resumeFileName, resumeText = "", dryRun = false, headless = true }) {
  const { browser, newPage } = await launchJobSearchBrowser({ headless });
  const submittedAnswers = {};
  const manualReviewFields = [];
  const manualReviewSet = new Set();
  const fieldOptions = {};
  let llmAnsweredCount = 0;
  let confirmationText = "";
  let status = "failed";
  let errorMessage = "";
  let findSettings = null;
  const getLlmFindSettings = async () => {
    if (!findSettings) findSettings = await getFindSettings();
    return findSettings;
  };

  function flagForReview(label, field) {
    const clean = cleanLabel(label);
    if (!clean || manualReviewSet.has(clean)) return;
    manualReviewSet.add(clean);
    manualReviewFields.push(clean);
    const options = captureFieldOptions(field);
    if (options.length > 0) fieldOptions[clean] = options;
  }

  try {
    const page = await newPage();
    await page.goto(posting.applyUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await waitForForm(page);

    const initialBlocker = await resolveCurrentBlocker(page, posting, submittedAnswers);
    if (!initialBlocker.ok) {
      return { status: "blocked", submittedAnswers, manualReviewFields, fieldOptions, confirmationText, errorMessage: initialBlocker.errorMessage };
    }

    const fileFields = await collectFileFields(page);
    const resumeField = fileFields.find((field) => /\b(cv|resume)\b/i.test(`${field.name} ${field.label}`));
    if (resumeBuffer && resumeField) {
      const uploadResult = await uploadResumeFile(page, resumeBuffer, resumeFileName);
      if (uploadResult.ok) submittedAnswers[cleanLabel(resumeField.label || "CV/resume")] = resumeFileName || "resume.pdf";
      else flagForReview(`${resumeField.label || "CV/resume"} (${uploadResult.reason})`, { options: [] });
    } else if (resumeField?.required) {
      flagForReview(resumeField.label || "CV/resume upload", { options: [] });
    }
    for (const fileField of fileFields) {
      if (fileField === resumeField) continue;
      if (fileField.required) flagForReview(fileField.label || fileField.name || "File upload", { options: [] });
    }

    const fields = (await collectFields(page)).map((field) => ({
      ...field,
      label: cleanLabel(field.label),
      normalizedLabel: normalizeLabel(field.label)
    }));
    const memoryRows = await listAnswerMemoryForMatching().catch(() => []);

    async function tryMemoryAnswer(field) {
      if (memoryRows.length === 0 || field.kind === "checkbox") return false;

      const fillMemoryMatch = async (memoryMatch) => {
        if (!memoryMatch) return false;
        const filledValue = await fillField(page, field, manualOverrideCandidates(memoryMatch.answer));
        if (filledValue == null) return false;
        submittedAnswers[field.label] = filledValue;
        await recordMemoryReuse(memoryMatch.id).catch(() => {});
        return true;
      };

      const exactMemoryMatch = findExactMemoryMatch(field.label, posting.companyName, memoryRows);
      if (await fillMemoryMatch(exactMemoryMatch)) return true;

      if (!(await shouldUseLlm(getLlmFindSettings))) return false;

      const memoryMatch = await findBestMemoryMatch(
        field.label,
        posting.companyName,
        memoryRows,
        { includeExact: !exactMemoryMatch }
      ).catch(() => null);
      return fillMemoryMatch(memoryMatch);
    }

    for (const field of fields) {
      const manualOverride = resolveManualOverride(field.normalizedLabel, posting.manualReviewFields);
      if (manualOverride != null && field.kind !== "checkbox") {
        const overrideFilled = await fillField(page, field, manualOverrideCandidates(manualOverride));
        if (overrideFilled != null) {
          submittedAnswers[field.label] = overrideFilled;
          continue;
        }
      }

      let filledValue = await fillField(page, field, namedCandidates(field, profile));
      if (filledValue != null) {
        submittedAnswers[field.label] = filledValue;
        continue;
      }

      if (field.kind === "checkbox") {
        if (field.required) flagForReview(field.label, field);
        continue;
      }

      if (isWorkAuthLabel(field.normalizedLabel)) {
        const value = resolveWorkAuthValue(field.normalizedLabel, profile?.workAuthorization);
        filledValue = value ? await fillField(page, field, [value]) : null;
        if (filledValue != null) {
          submittedAnswers[field.label] = filledValue;
          continue;
        }
        if (await tryMemoryAnswer(field)) continue;
        flagForReview(field.label, field);
        continue;
      }

      if (isEeoLabel(field.normalizedLabel)) {
        filledValue = await fillField(page, field, resolveEeoCandidates(field.normalizedLabel, profile?.eeoAnswers));
        if (filledValue != null) {
          submittedAnswers[field.label] = filledValue;
          continue;
        }
        if (await tryMemoryAnswer(field)) continue;
        flagForReview(field.label, field);
        continue;
      }

      const standardCandidates = resolveStandardFieldCandidates(
        field.normalizedLabel,
        profile,
        [field.label, field.name, field.kind, field.tag, field.type].filter(Boolean).join(" ")
      );
      if (standardCandidates.length > 0) {
        filledValue = await fillField(page, field, standardCandidates);
        if (filledValue != null) {
          submittedAnswers[field.label] = filledValue;
          continue;
        }
        if (await tryMemoryAnswer(field)) continue;
        if (field.required) flagForReview(field.label, field);
        continue;
      }

      if (await tryMemoryAnswer(field)) continue;

      if (isCandidateLogisticsLabel(field.normalizedLabel, field.name)) {
        if (field.required) flagForReview(field.label, field);
        continue;
      }

      if (field.kind === "radio-group" || field.tag === "select") {
        if (field.required) flagForReview(field.label, field);
        continue;
      }

      if ((field.tag === "input" || field.tag === "textarea") && llmAnsweredCount < MAX_LLM_ANSWERED_FIELDS && await shouldUseLlm(getLlmFindSettings)) {
        const answer = await answerFreeText({ question: field.label, posting, profile, resumeText }).catch(() => null);
        await incrementLlmUsage("score");
        if (answer) {
          filledValue = await fillField(page, field, [answer]);
          if (filledValue != null) {
            submittedAnswers[field.label] = filledValue;
            llmAnsweredCount += 1;
            continue;
          }
        }
      }

      if (field.required) flagForReview(field.label, field);
    }

    if (manualReviewFields.length > 0) {
      status = "needs_manual_review";
    } else if (dryRun) {
      status = "dry_run_ok";
    } else {
      const outcome = await readOutcomeAfterSubmit({
        page,
        submitButton: page.locator('form button[type="submit"], button:has-text("Send")').first(),
        posting,
        submittedAnswers
      });
      status = outcome.status;
      confirmationText = outcome.confirmationText;
      errorMessage = outcome.errorMessage;
    }
  } catch (error) {
    errorMessage = error?.message || String(error);
    status = "failed";
  } finally {
    await browser.close();
  }

  return { status, submittedAnswers, manualReviewFields, fieldOptions, confirmationText, errorMessage };
}
