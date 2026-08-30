import { answerFreeText } from "../jobSearchLlm.js";
import { getFindSettings } from "../jobSearchSettingsStore.js";
import { getTodayLlmUsage, incrementLlmUsage } from "../jobSearchUsageStore.js";
import { clickWithBrowserMouse, setCheckedWithBrowserMouse } from "./browserEngineClick.js";
import { detectSubmissionBlocker } from "./blockerDetection.js";
import { launchJobSearchBrowser } from "./jobSearchBrowser.js";
import {
  isEeoLabel,
  isWorkAuthLabel,
  normalizeLabel,
  resolveEeoValue,
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

function cleanLabel(text) {
  return String(text || "")
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fullAddress(profile) {
  return [profile?.addressLine1, profile?.city, profile?.stateRegion, profile?.postalCode, profile?.country]
    .filter(Boolean)
    .join(", ");
}

async function waitForForm(page) {
  await page.locator('form input[name="cName"], form input[placeholder="Full Name"]').first()
    .waitFor({ state: "visible", timeout: FORM_WAIT_TIMEOUT_MS });
}

async function openApplicationForm(page) {
  try {
    await waitForForm(page);
    return;
  } catch {
    // Breezy feed URLs point at the job overview; the actual form sits at an
    // /apply route exposed by an Apply/Apply Now/Apply To Position CTA.
  }

  const count = await page.locator("a, button").count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const candidate = page.locator("a, button").nth(i);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const text = ((await candidate.innerText({ timeout: 1000 }).catch(() => "")) || "").trim();
    const href = await candidate.getAttribute("href").catch(() => "");
    if (!/\bapply\b/i.test(`${text} ${href}`)) continue;
    if (/linkedin|indeed|submit application/i.test(`${text} ${href}`)) continue;

    await clickWithBrowserMouse(page, candidate, { timeout: 5000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1000).catch(() => {});
    await waitForForm(page);
    return;
  }

  await waitForForm(page);
}

async function collectFields(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const brief = (el) => (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
    const previousHeading = (el) => {
      let current = el.previousElementSibling;
      while (current) {
        if (/^(H[1-6]|LABEL|LEGEND)$/i.test(current.tagName)) return brief(current);
        current = current.previousElementSibling;
      }
      const question = el.closest("li.question, .question");
      if (question) {
        const heading = question.querySelector("h1,h2,h3,h4,label,legend");
        if (heading) return brief(heading);
      }
      const salary = el.closest(".desired-salary");
      if (salary) return brief(salary.querySelector("h1,h2,h3,h4,label,legend")) || "Desired Salary";
      return "";
    };
    const standardLabels = {
      cName: "Full Name",
      cEmail: "Email Address",
      cPhoneNumber: "Phone Number",
      cAddress: "Address",
      cSummary: "Experience Summary",
      cCoverLetter: "Cover Letter",
      cSalary: "Desired Salary",
      salaryCurrency: "Salary Currency",
      smsConsent: "SMS consent"
    };
    const fields = [];
    const seenRadioNames = new Set();

    for (const el of document.querySelectorAll("input[name], textarea[name], select[name]")) {
      const type = (el.getAttribute("type") || "").toLowerCase();
      const name = el.getAttribute("name") || "";
      if (!name || name.startsWith("hp_") || type === "hidden" || type === "file") continue;
      if (!visible(el) && type !== "radio" && type !== "checkbox") continue;

      const tag = el.tagName.toLowerCase();
      const heading = previousHeading(el);
      const label = standardLabels[name] || heading || el.getAttribute("placeholder") || name;
      const required = Boolean(el.required)
        || el.getAttribute("aria-required") === "true"
        || /\*/.test(heading)
        || /\bng-invalid-required\b/.test(el.className || "");

      if (type === "radio") {
        if (seenRadioNames.has(name)) continue;
        seenRadioNames.add(name);
        const radios = [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`)];
        fields.push({
          kind: "radio-group",
          name,
          label,
          required: radios.some((radio) => Boolean(radio.required)),
          options: radios.map((radio) => ({
            value: radio.value,
            text: brief(radio.closest("label, li, .option") || radio)
          })).filter((option) => option.text)
        });
        continue;
      }

      fields.push({
        kind: type === "checkbox" ? "checkbox" : "field",
        name,
        tag,
        type,
        label,
        required,
        options: tag === "select"
          ? [...el.options].map((option) => ({ value: option.value, text: option.textContent.trim() })).filter((option) => option.value && option.text)
          : []
      });
    }

    return fields;
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

async function fillField(page, field, candidates) {
  const values = Array.isArray(candidates) ? candidates : [candidates];
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
    case "cName": return [profile?.fullName];
    case "cEmail": return [profile?.email];
    case "cPhoneNumber": return [profile?.phone];
    case "cAddress": return [fullAddress(profile)];
    case "cCoverLetter": return [profile?.coverLetterTemplate];
    default: return [];
  }
}

async function uploadResumeFile(page, resumeBuffer, resumeFileName) {
  const fileInput = page.locator('input[type="file"][name="cResume"], #main-attachment').first();
  if ((await fileInput.count().catch(() => 0)) === 0) return { ok: false, reason: "no resume file input found" };

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

export async function submitBreezyApplication({ posting, profile, resumeBuffer, resumeFileName, resumeText = "", dryRun = false, headless = true }) {
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

    const resumeRequired = await page.locator('input[type="file"][name="cResume"][required], #resume_required[value="true"]').count().catch(() => 0) > 0;
    const resumeInputExists = await page.locator('input[type="file"][name="cResume"], #main-attachment').count().catch(() => 0) > 0;
    if (resumeBuffer) {
      const uploadResult = await uploadResumeFile(page, resumeBuffer, resumeFileName);
      if (uploadResult.ok) submittedAnswers["Resume"] = resumeFileName || "resume.pdf";
      else manualReviewFields.push(`Resume upload (${uploadResult.reason})`);
    } else if (resumeRequired || resumeInputExists) {
      manualReviewFields.push("Resume upload");
    }

    const fields = await collectFields(page);

    for (const field of fields) {
      const normalizedLabel = normalizeLabel(field.label);

      if (field.kind === "checkbox") {
        if (field.name === "smsConsent") continue;
        if (field.required) manualReviewFields.push(cleanLabel(field.label));
        continue;
      }

      if (field.kind === "radio-group") {
        const value = isWorkAuthLabel(normalizedLabel)
          ? resolveWorkAuthValue(normalizedLabel, profile?.workAuthorization)
          : isEeoLabel(normalizedLabel)
            ? resolveEeoValue(normalizedLabel, profile?.eeoAnswers)
            : null;
        const match = value && field.options.find((option) => option.text.trim().toLowerCase() === value.toLowerCase());
        if (match) {
          const radio = page.locator(`input[type="radio"][name="${cssAttr(field.name)}"][value="${cssAttr(match.value)}"]`).first();
          const checked = await setCheckedWithBrowserMouse(page, radio, true).then(() => true).catch(() => false);
          if (checked) {
            submittedAnswers[field.label] = match.text;
            continue;
          }
        }
        if (field.required) manualReviewFields.push(cleanLabel(field.label));
        continue;
      }

      let filledValue = await fillField(page, field, namedCandidates(field, profile));
      if (filledValue != null) {
        submittedAnswers[field.label] = filledValue;
        continue;
      }

      if (field.name === "cSummary") {
        if (field.required) manualReviewFields.push(field.label);
        continue;
      }

      if (isWorkAuthLabel(normalizedLabel)) {
        const value = resolveWorkAuthValue(normalizedLabel, profile?.workAuthorization);
        filledValue = value ? await fillField(page, field, [value]) : null;
        if (filledValue != null) {
          submittedAnswers[field.label] = filledValue;
        } else if (field.required) {
          manualReviewFields.push(field.label);
        }
        continue;
      }

      if (isEeoLabel(normalizedLabel)) {
        const value = resolveEeoValue(normalizedLabel, profile?.eeoAnswers);
        filledValue = value ? await fillField(page, field, [value]) : null;
        if (filledValue != null) {
          submittedAnswers[field.label] = filledValue;
        } else if (field.required) {
          manualReviewFields.push(field.label);
        }
        continue;
      }

      const standardCandidates = resolveStandardFieldCandidates(normalizedLabel, profile, field.label);
      if (standardCandidates.length > 0) {
        filledValue = await fillField(page, field, standardCandidates);
        if (filledValue != null) {
          submittedAnswers[field.label] = filledValue;
        } else if (field.required) {
          manualReviewFields.push(field.label);
        }
        continue;
      }

      if (field.name === "cSalary" || field.name === "salaryCurrency" || /salary|compensation|notice period|available from|availability/i.test(field.label)) {
        if (field.required) manualReviewFields.push(field.label);
        continue;
      }

      if (field.tag === "select") {
        if (field.required) manualReviewFields.push(field.label);
        continue;
      }

      if (llmAnsweredCount < MAX_LLM_ANSWERED_FIELDS && await shouldUseLlm(getLlmFindSettings)) {
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

      if (field.required) manualReviewFields.push(field.label);
    }

    screenshotBuffer = await page.screenshot({ fullPage: true }).catch(() => null);

    if (manualReviewFields.length > 0) {
      status = "needs_manual_review";
    } else if (dryRun) {
      status = "dry_run_ok";
    } else {
      const submitButton = page.locator('button:has-text("Submit Application"), button[type="submit"]').first();
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
