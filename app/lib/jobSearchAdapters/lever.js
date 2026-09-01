// Lever forms are ordinary enough to submit after the account owner handles
// hCaptcha in the live relay. Standard fields are stable name= inputs; custom
// questions are encoded as hidden cards[...][baseTemplate] JSON, which gives
// exact question text, required flags, and option labels without scraping.
import { findBestMemoryMatch, findExactMemoryMatch, listAnswerMemoryForMatching, recordMemoryReuse } from "../jobSearchAnswerMemoryStore.js";
import { answerFreeText } from "../jobSearchLlm.js";
import { getFindSettings } from "../jobSearchSettingsStore.js";
import { getTodayLlmUsage, incrementLlmUsage } from "../jobSearchUsageStore.js";
import { clickWithBrowserMouse, setCheckedWithBrowserMouse } from "./browserEngineClick.js";
import { detectSubmissionBlocker, isHeldChallengeBlockerReason } from "./blockerDetection.js";
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

const SUCCESS_TEXT_SIGNALS = /(thank you for applying|thanks for applying|application (has been |was )?(successfully )?(submitted|sent)|we('| ha)ve received your application|your application (has been|was) received)/i;
const ERROR_TEXT_SIGNALS = /(this field is required|please (enter|select|fill)|is required\b|error submitting|something went wrong|invalid|upload failed|failed to upload|captcha)/i;

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
  return [profile?.city, profile?.stateRegion].filter(Boolean).join(", ");
}

const STANDARD_FIELDS = [
  { name: "name", label: "Full name", required: true, candidates: (p) => [p?.fullName] },
  { name: "email", label: "Email", required: true, candidates: (p) => [p?.email] },
  { name: "phone", label: "Phone", required: false, candidates: (p) => [p?.phone] },
  { name: "location", label: "Current location", required: true, candidates: (p) => [profileLocation(p)] },
  { name: "org", label: "Current company", required: false, candidates: (p) => [p?.workHistory?.[0]?.company] },
  { name: "urls[LinkedIn]", label: "LinkedIn URL", required: false, candidates: (p) => [p?.linkedinUrl] },
  { name: "urls[GitHub]", label: "GitHub URL", required: false, candidates: (p) => [p?.githubUrl] },
  { name: "urls[Portfolio]", label: "Portfolio URL", required: false, candidates: (p) => [p?.portfolioUrl] }
];

async function waitForForm(page) {
  await page.locator('input[name="name"], form input[name="email"]').first()
    .waitFor({ state: "visible", timeout: FORM_WAIT_TIMEOUT_MS });
}

async function resolveCurrentBlocker(page, posting, submittedAnswers) {
  const blockerReason = await detectSubmissionBlocker(page);
  if (!blockerReason) return { ok: true };
  if (isHeldChallengeBlockerReason(blockerReason)) {
    return resolveHeldChallenge({ page, scope: page, posting, submittedAnswers, blockerReason });
  }
  return { ok: false, errorMessage: blockerReason };
}

async function uploadResumeFile(page, resumeBuffer, resumeFileName) {
  const fileInput = page.locator('input[type="file"][name="resume"]').first();
  if ((await fileInput.count().catch(() => 0)) === 0) return { ok: false, reason: "no resume file input found" };

  const uploaded = await uploadResumeWithRetry(page, page, fileInput, resumeBuffer, resumeFileName);
  return uploaded ? { ok: true } : { ok: false, reason: "could not confirm upload success" };
}

async function collectCards(page) {
  return page.evaluate(() => {
    const inputs = document.querySelectorAll('input[name*="[baseTemplate]"]');
    const cards = [];
    for (const input of inputs) {
      const match = input.name.match(/^cards\[([^\]]+)\]\[baseTemplate\]$/);
      if (!match) continue;
      try {
        const schema = JSON.parse(input.value);
        cards.push({
          cardId: match[1],
          text: schema.text || "",
          fields: Array.isArray(schema.fields) ? schema.fields.map((field) => ({
            type: field.type || "",
            text: field.text || "",
            required: Boolean(field.required),
            options: Array.isArray(field.options)
              ? field.options.map((option) => ({ text: option.text || "", value: option.text || option.optionId || "" })).filter((option) => option.text)
              : []
          })) : []
        });
      } catch {
        // Skip malformed card JSON rather than losing the whole posting.
      }
    }
    return cards;
  });
}

async function selectOptionByText(locator, candidates) {
  const values = Array.isArray(candidates) ? candidates : [candidates];
  for (const candidate of values.filter(Boolean)) {
    const optionValue = await locator.evaluate((select, wanted) => {
      const normalizedWanted = String(wanted || "").trim().toLowerCase();
      const options = [...select.options];
      const exact = options.find((option) => option.textContent.trim().toLowerCase() === normalizedWanted);
      if (exact) return exact.value;
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

async function fillInput(locator, candidates) {
  const values = Array.isArray(candidates) ? candidates : [candidates];
  for (const value of values.filter(Boolean)) {
    const filled = await locator.fill(String(value)).then(() => true).catch(() => false);
    if (filled) return value;
  }
  return null;
}

function cardFieldName(cardId, index) {
  return `cards[${cardId}][field${index}]`;
}

function optionTexts(field) {
  return (field.options || []).map((option) => option.text).filter(Boolean);
}

async function fillCardField(page, fieldRef, candidates) {
  const { field, name } = fieldRef;
  const values = Array.isArray(candidates) ? candidates : [candidates];

  if (field.type === "multiple-choice") {
    const match = matchOptionByCandidates(field.options, values);
    if (!match) return null;
    const radio = page.locator(`input[type="radio"][name="${cssAttr(name)}"][value="${cssAttr(match.text)}"]`).first();
    const checked = await setCheckedWithBrowserMouse(page, radio, true).then(() => true).catch(() => false);
    return checked ? match.text : null;
  }

  if (field.type === "multiple-select") {
    const match = matchOptionByCandidates(field.options, values);
    if (!match) return null;
    const checkbox = page.locator(`input[type="checkbox"][name="${cssAttr(name)}"][value="${cssAttr(match.text)}"]`).first();
    const checked = await setCheckedWithBrowserMouse(page, checkbox, true).then(() => true).catch(() => false);
    return checked ? match.text : null;
  }

  if (field.type === "dropdown") {
    return selectOptionByText(page.locator(`select[name="${cssAttr(name)}"]`).first(), values);
  }

  if (field.type === "text" || field.type === "textarea") {
    return fillInput(page.locator(`[name="${cssAttr(name)}"]`).first(), values);
  }

  return null;
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

export async function submitLeverApplication({ posting, profile, resumeBuffer, resumeFileName, resumeText = "", dryRun = false, headless = true }) {
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

  function flagForReview(label, options = []) {
    const clean = cleanLabel(label);
    if (!clean || manualReviewSet.has(clean)) return;
    manualReviewSet.add(clean);
    manualReviewFields.push(clean);
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

    const resumeInputExists = (await page.locator('input[type="file"][name="resume"]').count().catch(() => 0)) > 0;
    if (resumeBuffer) {
      const uploadResult = await uploadResumeFile(page, resumeBuffer, resumeFileName);
      if (uploadResult.ok) submittedAnswers["Resume/CV"] = resumeFileName || "resume.pdf";
      else flagForReview(`Resume upload (${uploadResult.reason})`);
    } else if (resumeInputExists) {
      flagForReview("Resume/CV upload");
    }

    for (const field of STANDARD_FIELDS) {
      const locator = page.locator(`input[name="${cssAttr(field.name)}"]`).first();
      if ((await locator.count().catch(() => 0)) === 0) continue;
      const manualOverride = resolveManualOverride(normalizeLabel(field.label), posting.manualReviewFields);
      const candidates = manualOverride != null ? manualOverrideCandidates(manualOverride) : field.candidates(profile);
      const filled = await fillInput(locator, candidates);
      if (filled != null) submittedAnswers[field.label] = filled;
      else if (field.required) flagForReview(field.label);
    }

    const cards = await collectCards(page);
    const memoryRows = await listAnswerMemoryForMatching().catch(() => []);

    async function tryMemoryAnswer(fieldRef) {
      if (memoryRows.length === 0) return false;

      const fillMemoryMatch = async (memoryMatch) => {
        if (!memoryMatch) return false;
        const filledValue = await fillCardField(page, fieldRef, manualOverrideCandidates(memoryMatch.answer));
        if (filledValue == null) return false;
        submittedAnswers[fieldRef.label] = filledValue;
        await recordMemoryReuse(memoryMatch.id).catch(() => {});
        return true;
      };

      const exactMemoryMatch = findExactMemoryMatch(fieldRef.label, posting.companyName, memoryRows);
      if (await fillMemoryMatch(exactMemoryMatch)) return true;

      if (!(await shouldUseLlm(getLlmFindSettings))) return false;

      const memoryMatch = await findBestMemoryMatch(
        fieldRef.label,
        posting.companyName,
        memoryRows,
        { includeExact: !exactMemoryMatch }
      ).catch(() => null);
      return fillMemoryMatch(memoryMatch);
    }

    for (const card of cards) {
      for (let index = 0; index < card.fields.length; index += 1) {
        const field = card.fields[index];
        const name = cardFieldName(card.cardId, index);
        const label = cleanLabel(field.text || `${card.text} field ${index + 1}`);
        const normalizedLabel = normalizeLabel(label);
        const fieldRef = { field, name, label };
        const options = optionTexts(field);

        const manualOverride = resolveManualOverride(normalizedLabel, posting.manualReviewFields);
        if (manualOverride != null) {
          const filledValue = await fillCardField(page, fieldRef, manualOverrideCandidates(manualOverride));
          if (filledValue != null) {
            submittedAnswers[label] = filledValue;
            continue;
          }
        }

        if (isWorkAuthLabel(normalizedLabel)) {
          const value = resolveWorkAuthValue(normalizedLabel, profile?.workAuthorization);
          const filledValue = value ? await fillCardField(page, fieldRef, [value]) : null;
          if (filledValue != null) {
            submittedAnswers[label] = filledValue;
            continue;
          }
          if (await tryMemoryAnswer(fieldRef)) continue;
          flagForReview(label, options);
          continue;
        }

        if (isEeoLabel(normalizedLabel)) {
          const filledValue = await fillCardField(page, fieldRef, resolveEeoCandidates(normalizedLabel, profile?.eeoAnswers));
          if (filledValue != null) {
            submittedAnswers[label] = filledValue;
            continue;
          }
          if (await tryMemoryAnswer(fieldRef)) continue;
          flagForReview(label, options);
          continue;
        }

        const standardCandidates = resolveStandardFieldCandidates(normalizedLabel, profile, label);
        if (standardCandidates.length > 0) {
          const filledValue = await fillCardField(page, fieldRef, standardCandidates);
          if (filledValue != null) {
            submittedAnswers[label] = filledValue;
            continue;
          }
          if (await tryMemoryAnswer(fieldRef)) continue;
          if (field.required) flagForReview(label, options);
          continue;
        }

        if (await tryMemoryAnswer(fieldRef)) continue;

        if (field.type === "multiple-choice" || field.type === "multiple-select" || field.type === "dropdown") {
          if (field.required) flagForReview(label, options);
          continue;
        }

        if ((field.type === "text" || field.type === "textarea") && llmAnsweredCount < MAX_LLM_ANSWERED_FIELDS && await shouldUseLlm(getLlmFindSettings)) {
          const answer = await answerFreeText({ question: label, posting, profile, resumeText }).catch(() => null);
          await incrementLlmUsage("score");
          if (answer) {
            const filledValue = await fillCardField(page, fieldRef, [answer]);
            if (filledValue != null) {
              submittedAnswers[label] = filledValue;
              llmAnsweredCount += 1;
              continue;
            }
          }
        }

        if (field.required) flagForReview(label, options);
      }
    }

    if (manualReviewFields.length > 0) {
      status = "needs_manual_review";
    } else if (dryRun) {
      status = "dry_run_ok";
    } else {
      const outcome = await readOutcomeAfterSubmit({
        page,
        submitButton: page.locator('button[type="submit"], button:has-text("SUBMIT APPLICATION")').first(),
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
