import { findBestMemoryMatch, listAnswerMemoryForMatching, recordMemoryReuse } from "../jobSearchAnswerMemoryStore.js";
import { answerFreeText, chooseFromOptions } from "../jobSearchLlm.js";
import { getFindSettings } from "../jobSearchSettingsStore.js";
import { getTodayLlmUsage, incrementLlmUsage } from "../jobSearchUsageStore.js";
import { clickWithBrowserMouse } from "./browserEngineClick.js";
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
const MAX_LLM_ANSWERED_FIELDS = 15;

const SUCCESS_TEXT_SIGNALS = /(thank you for applying|thanks for applying|application (has been |was )?(successfully )?(submitted|sent)|we('| ha)ve received your application|your application (has been|was) received)/i;
const ERROR_TEXT_SIGNALS = /(this field is required|please (enter|select|fill)|is required\b|error submitting|something went wrong|invalid|upload failed|failed to upload)/i;

function cssAttr(value) {
  return String(value || "").replace(/"/g, '\\"');
}

function cleanRequiredLabel(text) {
  return String(text || "")
    .replace(/\(\s*required\s*\)/ig, "")
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function profileLocation(profile) {
  return [profile?.city, profile?.stateRegion].filter(Boolean).join(", ");
}

function isCandidateLogisticsLabel(label, name) {
  const text = `${label} ${name || ""}`;
  return /\b(available from|availability|earliest start|start date|notice period|expected salary|salary expectation|desired salary|compensation expectation|time\s*zone|timezone)\b/.test(text);
}

function looksLikeExperienceDurationQuestion(options) {
  if (!Array.isArray(options) || options.length < 2) return false;
  const text = options.map((option) => option.text || "").join(" ");
  const withDigits = options.filter((option) => /\d/.test(option.text || "")).length;
  return /\b(year|years|experience)\b/i.test(text) && withDigits >= Math.ceil(options.length / 2);
}

async function waitForForm(page) {
  await page.locator('form input[name="email"], form #field-email').first()
    .waitFor({ state: "visible", timeout: FORM_WAIT_TIMEOUT_MS });
}

async function openApplicationForm(page) {
  try {
    await waitForForm(page);
    return;
  } catch {
    // Personio's feed URL lands on the job overview; the real form is behind
    // an "Apply for this job" link that navigates to /apply.
  }

  const candidates = [
    page.getByRole("link", { name: /apply for this job|apply/i }).first(),
    page.getByRole("button", { name: /apply for this job|apply/i }).first(),
    page.locator('a[href*="/apply"], button:has-text("Apply for this job"), a:has-text("Apply for this job")').first()
  ];

  for (const candidate of candidates) {
    if ((await candidate.count().catch(() => 0)) === 0) continue;
    if (!(await candidate.isVisible().catch(() => false))) continue;
    await clickWithBrowserMouse(page, candidate, { timeout: 5000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1000).catch(() => {});
    await waitForForm(page);
    return;
  }

  await waitForForm(page);
}

async function collectLabeledFields(page) {
  const labelHandles = await page.locator("form label[for]").all();
  const fields = [];

  for (const label of labelHandles) {
    const forId = await label.getAttribute("for").catch(() => null);
    if (!forId) continue;

    const locator = page.locator(`form [id="${cssAttr(forId)}"]`).first();
    if ((await locator.count().catch(() => 0)) === 0) continue;

    const tag = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
    const type = ((await locator.getAttribute("type").catch(() => "")) || "").toLowerCase();
    if (type === "file" || type === "hidden") continue;

    const name = await locator.getAttribute("name").catch(() => "");
    const rawLabel = ((await label.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    const labelText = name === "first_name"
      ? "First name"
      : name === "last_name"
        ? "Last name"
        : cleanRequiredLabel(rawLabel || await locator.getAttribute("placeholder").catch(() => "") || name);
    const required = /\*|\(\s*required\s*\)/i.test(rawLabel)
      || ["first_name", "last_name", "email"].includes(name)
      || await locator.evaluate((el) => Boolean(el.required || el.getAttribute("aria-required") === "true")).catch(() => false);

    fields.push({
      label: labelText,
      rawLabel,
      normalizedLabel: normalizeLabel(labelText || rawLabel),
      locator,
      name,
      tag,
      type,
      required
    });
  }

  return fields;
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

async function getSelectOptions(locator) {
  return locator.evaluate((select) => [...select.options]
    .map((option) => ({ value: option.value, text: option.textContent.trim() }))
    .filter((option) => option.value || !/please select/i.test(option.text))
    .filter((option) => option.value && option.text && !/please select/i.test(option.text))
  ).catch(() => []);
}

async function fillCandidates(field, candidates) {
  const values = Array.isArray(candidates) ? candidates : [candidates];
  if (field.tag === "select") return selectOptionByText(field.locator, values);

  for (const value of values.filter(Boolean)) {
    const filled = await field.locator.fill(String(value)).then(() => true).catch(() => false);
    if (filled) return value;
  }
  return null;
}

function namedCandidates(field, profile) {
  switch (field.name) {
    case "first_name": return [profile?.firstName];
    case "last_name": return [profile?.lastName];
    case "email": return [profile?.email];
    case "phone": return [profile?.phone];
    case "location": return [profileLocation(profile)];
    default: return [];
  }
}

async function uploadResumeFile(page, resumeBuffer, resumeFileName) {
  const fileInput = page.locator('input[type="file"][name="documents.cv"], #doc-input-cv').first();
  if ((await fileInput.count().catch(() => 0)) === 0) return { ok: false, reason: "no CV file input found" };

  await fileInput.setInputFiles(resumeFilePayload(resumeBuffer, resumeFileName));
  return (await resumeUploadLikelyFailed(page))
    ? { ok: false, reason: "could not confirm upload success" }
    : { ok: true };
}

async function shouldUseLlm(getLlmFindSettings) {
  const llmSettings = await getLlmFindSettings();
  const usage = await getTodayLlmUsage();
  return usage.totalCalls < llmSettings.maxLlmCallsPerDay;
}

export async function submitPersonioApplication({ posting, profile, resumeBuffer, resumeFileName, resumeText = "", dryRun = false, headless = true }) {
  const { browser, newPage } = await launchJobSearchBrowser({ headless });
  const submittedAnswers = {};
  const manualReviewFields = [];
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
    await openApplicationForm(page);

    const blockerReason = await detectSubmissionBlocker(page);
    if (blockerReason) {
      screenshotBuffer = await page.screenshot({ fullPage: true }).catch(() => null);
      return { status: "blocked", submittedAnswers, manualReviewFields, confirmationText, screenshotBuffer, errorMessage: blockerReason };
    }

    const cvInputExists = (await page.locator('input[type="file"][name="documents.cv"], #doc-input-cv').count().catch(() => 0)) > 0;
    if (resumeBuffer) {
      const uploadResult = await uploadResumeFile(page, resumeBuffer, resumeFileName);
      if (uploadResult.ok) submittedAnswers["CV"] = resumeFileName || "resume.pdf";
      else manualReviewFields.push(`CV upload (${uploadResult.reason})`);
    } else if (cvInputExists) {
      manualReviewFields.push("CV upload");
    }

    const fields = await collectLabeledFields(page);
    // Fetched once, reused for every field below — see
    // jobSearchAnswerMemoryStore.js's own comment on why this isn't a
    // per-field query.
    const memoryRows = await listAnswerMemoryForMatching().catch(() => []);

    for (const field of fields) {
      // A human already answered this exact question for this exact posting
      // (see the Review Queue's "Answer & Retry" popup) — try it before any
      // auto-resolution strategy below. Falls through to those on failure.
      const manualOverride = resolveManualOverride(field.normalizedLabel, posting.manualReviewFields);
      if (manualOverride != null) {
        const overrideFilled = await fillCandidates(field, manualOverrideCandidates(manualOverride));
        if (overrideFilled != null) {
          submittedAnswers[field.label] = overrideFilled;
          continue;
        }
      }

      let filledValue = await fillCandidates(field, namedCandidates(field, profile));
      if (filledValue != null) {
        submittedAnswers[field.label] = filledValue;
        continue;
      }

      if (isWorkAuthLabel(field.normalizedLabel)) {
        const value = resolveWorkAuthValue(field.normalizedLabel, profile?.workAuthorization);
        filledValue = value ? await fillCandidates(field, [value]) : null;
        if (filledValue != null) {
          submittedAnswers[field.label] = filledValue;
        } else if (field.required) {
          manualReviewFields.push(field.label);
        }
        continue;
      }

      if (isEeoLabel(field.normalizedLabel)) {
        const value = resolveEeoValue(field.normalizedLabel, profile?.eeoAnswers);
        filledValue = value ? await fillCandidates(field, [value]) : null;
        if (filledValue != null) {
          submittedAnswers[field.label] = filledValue;
        } else if (field.required) {
          manualReviewFields.push(field.label);
        }
        continue;
      }

      const standardCandidates = resolveStandardFieldCandidates(field.normalizedLabel, profile, field.rawLabel || field.label);
      if (standardCandidates.length > 0) {
        filledValue = await fillCandidates(field, standardCandidates);
        if (filledValue != null) {
          submittedAnswers[field.label] = filledValue;
        } else if (field.required) {
          manualReviewFields.push(field.label);
        }
        continue;
      }

      // A similarly-worded question was answered by hand on a DIFFERENT
      // posting before (see the Review Queue's Memory tab / "Answer & Retry"
      // popup) — a human-verified past answer beats a fresh LLM guess, so
      // this is checked ahead of the candidate-logistics exclusion below
      // (salary/notice-period/etc., normally always manual) and the free-text
      // fallback, reusing this file's own shouldUseLlm() budget check.
      if (memoryRows.length > 0 && await shouldUseLlm(getLlmFindSettings)) {
        const memoryMatch = await findBestMemoryMatch(field.label, posting.companyName, memoryRows).catch(() => null);
        if (memoryMatch) {
          filledValue = await fillCandidates(field, manualOverrideCandidates(memoryMatch.answer));
          if (filledValue != null) {
            submittedAnswers[field.label] = filledValue;
            await recordMemoryReuse(memoryMatch.id).catch(() => {});
            continue;
          }
        }
      }

      if (isCandidateLogisticsLabel(field.normalizedLabel, field.name)) {
        if (field.required) manualReviewFields.push(field.label);
        continue;
      }

      if (field.tag === "select") {
        const options = await getSelectOptions(field.locator);
        if (looksLikeExperienceDurationQuestion(options) && llmAnsweredCount < MAX_LLM_ANSWERED_FIELDS && await shouldUseLlm(getLlmFindSettings)) {
          const chosenText = await chooseFromOptions({
            question: field.label,
            options: options.map((option) => option.text),
            posting,
            profile,
            resumeText
          }).catch(() => null);
          await incrementLlmUsage("score");
          filledValue = chosenText ? await fillCandidates(field, [chosenText]) : null;
          if (filledValue != null) {
            submittedAnswers[field.label] = filledValue;
            llmAnsweredCount += 1;
            continue;
          }
        }
        if (field.required) manualReviewFields.push(field.label);
        continue;
      }

      if ((field.tag === "input" || field.tag === "textarea") && llmAnsweredCount < MAX_LLM_ANSWERED_FIELDS && await shouldUseLlm(getLlmFindSettings)) {
        const answer = await answerFreeText({ question: field.label, posting, profile, resumeText }).catch(() => null);
        await incrementLlmUsage("score");
        if (answer) {
          const filled = await field.locator.fill(answer).then(() => true).catch(() => false);
          if (filled) {
            submittedAnswers[field.label] = answer;
            llmAnsweredCount += 1;
            continue;
          }
        }
      }

      if (field.required) manualReviewFields.push(field.label);
    }

    screenshotBuffer = await page.screenshot({ fullPage: true }).catch(() => null);

    if (manualReviewFields.length > 0) {
      status = "needs_manual_review";
    } else if (dryRun) {
      status = "dry_run_ok";
    } else {
      const submitButton = page.locator('form button[type="submit"], button:has-text("Submit Application")').first();
      await clickWithBrowserMouse(page, submitButton);
      await page.waitForLoadState("networkidle", { timeout: SUBMIT_SETTLE_TIMEOUT_MS }).catch(() => {});
      await page.waitForTimeout(500);

      confirmationText = (await page.locator("body").innerText().catch(() => "")).slice(0, 500);
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

  if (status === "submitted") screenshotBuffer = null;

  return { status, submittedAnswers, manualReviewFields, confirmationText, screenshotBuffer, errorMessage };
}
