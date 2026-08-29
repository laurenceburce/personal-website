// Confirmed live against a real posting (apply.workable.com/<company>/j/<id>/apply):
// no bot-wall (unlike SmartRecruiters/iCIMS), standard fields are plain named
// inputs (firstname/lastname/email/headline/phone) with aria-labelledby
// pointing at a real label element — even more reliable than Greenhouse's
// label[for]. Custom questions are grouped differently depending on type:
// a plain text/textarea question is just aria-labelledby="QA_<id>_label";
// a checkbox (multi-select) question wraps its options in
// div[role="group"][aria-labelledby="<groupId>_label"]; a radio (single-select)
// question wraps its options in fieldset[role="radiogroup"][aria-labelledby].
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { answerFreeText } from "../jobSearchLlm.js";
import { getFindSettings } from "../jobSearchSettingsStore.js";
import { getTodayLlmUsage, incrementLlmUsage } from "../jobSearchUsageStore.js";
import { detectSubmissionBlocker } from "./blockerDetection.js";
import {
  isEeoLabel,
  isWorkAuthLabel,
  normalizeLabel,
  resolveEeoValue,
  resolveStandardField,
  resolveWorkAuthValue
} from "./profileMapping.js";
import { resumeUploadLikelyFailed } from "./resumeUploadCheck.js";

const NAV_TIMEOUT_MS = 30000;
const FORM_WAIT_TIMEOUT_MS = 15000;
const SUBMIT_SETTLE_TIMEOUT_MS = 10000;
const MAX_LLM_ANSWERED_FIELDS = 5;

const SUCCESS_TEXT_SIGNALS = /(thank you for applying|application (has been |was )?(successfully )?submitted|we('| ha)ve received your application|your application (has been|was) received)/i;
const ERROR_TEXT_SIGNALS = /(this field is required|please (enter|select|fill)|is required\b|error submitting|something went wrong)/i;

const STANDARD_NAME_RESOLVERS = {
  firstname: (p) => p.fullName?.split(/\s+/)[0],
  lastname: (p) => p.fullName?.split(/\s+/).slice(1).join(" "),
  email: (p) => p.email,
  phone: (p) => p.phone,
  headline: (p) => p.workHistory?.[0]?.title
};

async function dismissCookieBanner(page) {
  await page.locator('button:has-text("Accept all")').first().click({ timeout: 3000 }).catch(() => {});
}

async function uploadResumeFile(page, resumeBuffer, resumeFileName) {
  const fileInput = page.locator('input[type="file"]').first();
  if (await fileInput.count().catch(() => 0) === 0) return false;

  const tempPath = join(tmpdir(), `job-search-resume-${Date.now()}-${resumeFileName || "resume.pdf"}`);
  await writeFile(tempPath, resumeBuffer);
  try {
    await fileInput.setInputFiles(tempPath);
    // setInputFiles() only attaches the file to the DOM input — it says
    // nothing about whether Workable's own JS then actually uploaded it. See
    // resumeUploadCheck.js.
    if (await resumeUploadLikelyFailed(page)) return false;
    return true;
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

// Reads the whole question structure via the page's own DOM rather than
// separate Playwright locator round-trips per field — cheaper and avoids
// re-deriving the group/option relationship from outside the browser.
async function collectQuestions(page) {
  return page.evaluate((standardFieldNames) => {
    function labelText(id) {
      return document.getElementById(id)?.innerText?.trim() || "";
    }

    const results = [];
    const seenNames = new Set();

    // Plain text/textarea/select questions and standard fields: a single
    // named input whose aria-labelledby points straight at its label.
    for (const el of document.querySelectorAll("input[name], textarea[name], select[name]")) {
      if (el.type === "checkbox" || el.type === "radio" || el.type === "file") continue;
      if (seenNames.has(el.name)) continue;
      const labelledBy = el.getAttribute("aria-labelledby");
      // Confirmed live: the phone field (an international-tel-input widget)
      // carries no aria-labelledby at all, unlike every other standard field
      // — falling back to its own `name` as the label is fine here since
      // standard fields are resolved by name, not by label text anyway.
      if (!labelledBy && !standardFieldNames.includes(el.name)) continue;
      seenNames.add(el.name);
      results.push({
        kind: "field",
        name: el.name,
        tag: el.tagName.toLowerCase(),
        required: Boolean(el.required),
        label: labelledBy ? labelText(labelledBy.split(" ")[0]) : el.name
      });
    }

    // Checkbox (multi-select) groups: shared ancestor div[role=group].
    for (const group of document.querySelectorAll('div[role="group"][aria-labelledby]')) {
      const groupLabelId = group.getAttribute("aria-labelledby");
      const checkboxes = [...group.querySelectorAll('input[type="checkbox"]')];
      if (!checkboxes.length) continue;
      results.push({
        kind: "checkbox-group",
        label: labelText(groupLabelId),
        required: checkboxes.some((c) => c.required),
        options: checkboxes.map((c) => ({
          name: c.name,
          text: labelText((c.closest('[role="checkbox"]')?.getAttribute("aria-labelledby") || "").split(" ")[0])
        }))
      });
    }

    // Radio (single-select) groups: shared ancestor fieldset[role=radiogroup].
    for (const group of document.querySelectorAll('fieldset[role="radiogroup"][aria-labelledby]')) {
      const groupLabelId = group.getAttribute("aria-labelledby");
      const radios = [...group.querySelectorAll('input[type="radio"]')];
      if (!radios.length) continue;
      results.push({
        kind: "radio-group",
        name: radios[0].name,
        label: labelText(groupLabelId),
        required: radios.some((r) => r.required),
        options: radios.map((r) => ({
          value: r.value,
          text: labelText((r.closest('[role="radio"]')?.getAttribute("aria-labelledby") || "").split(" ")[0])
        }))
      });
    }

    return results;
  }, Object.keys(STANDARD_NAME_RESOLVERS));
}

export async function submitWorkableApplication({ posting, profile, resumeBuffer, resumeFileName, dryRun = false, headless = true }) {
  const browser = await chromium.launch({ headless });
  const submittedAnswers = {};
  const manualReviewFields = [];
  let llmAnsweredCount = 0;
  let confirmationText = "";
  let screenshotBuffer = null;
  let status = "failed";
  let errorMessage = "";
  const findSettings = await getFindSettings();

  try {
    const page = await browser.newPage();
    await page.goto(posting.applyUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await page.locator('input[name="firstname"]').first().waitFor({ state: "visible", timeout: FORM_WAIT_TIMEOUT_MS });
    await dismissCookieBanner(page);

    const blockerReason = await detectSubmissionBlocker(page);
    if (blockerReason) {
      screenshotBuffer = await page.screenshot({ fullPage: true }).catch(() => null);
      return { status: "blocked", submittedAnswers, manualReviewFields, confirmationText, screenshotBuffer, errorMessage: blockerReason };
    }

    if (resumeBuffer) {
      const uploaded = await uploadResumeFile(page, resumeBuffer, resumeFileName);
      if (!uploaded) manualReviewFields.push("Resume upload (could not confirm success)");
    }

    const questions = await collectQuestions(page);

    for (const q of questions) {
      const normalizedLabel = normalizeLabel(q.label);

      if (q.kind === "field") {
        // Standard field, keyed by its stable `name` attribute.
        if (STANDARD_NAME_RESOLVERS[q.name]) {
          const value = STANDARD_NAME_RESOLVERS[q.name](profile);
          if (value) {
            const filled = await page.locator(`[name="${q.name}"]`).first().fill(String(value)).then(() => true).catch(() => false);
            if (filled) {
              submittedAnswers[q.label || q.name] = value;
              continue;
            }
            if (q.required) manualReviewFields.push(q.label || q.name);
            continue;
          }
        }

        if (isWorkAuthLabel(normalizedLabel) || isEeoLabel(normalizedLabel)) {
          // These render as radio/checkbox groups on every real Workable form
          // seen so far, never a plain text field — if one ever did show up
          // here, guessing free text into it would be worse than flagging it.
          if (q.required) manualReviewFields.push(q.label);
          continue;
        }

        const standardValue = resolveStandardField(normalizedLabel, profile);
        if (standardValue) {
          const filled = await page.locator(`[name="${q.name}"]`).first().fill(String(standardValue)).then(() => true).catch(() => false);
          if (filled) {
            submittedAnswers[q.label] = standardValue;
            continue;
          }
          if (q.required) manualReviewFields.push(q.label);
          continue;
        }

        if (q.tag !== "select" && llmAnsweredCount < MAX_LLM_ANSWERED_FIELDS) {
          const usage = await getTodayLlmUsage();
          if (usage.totalCalls >= findSettings.maxLlmCallsPerDay) {
            if (q.required) manualReviewFields.push(q.label);
            continue;
          }
          const answer = await answerFreeText({ question: q.label, posting, profile }).catch(() => null);
          await incrementLlmUsage("score");
          if (answer) {
            const filled = await page.locator(`[name="${q.name}"]`).first().fill(answer).then(() => true).catch(() => false);
            if (filled) {
              submittedAnswers[q.label] = answer;
              llmAnsweredCount += 1;
              continue;
            }
          }
        }

        if (q.required) manualReviewFields.push(q.label);
        continue;
      }

      if (q.kind === "radio-group") {
        if (isWorkAuthLabel(normalizedLabel)) {
          const value = resolveWorkAuthValue(normalizedLabel, profile.workAuthorization);
          const match = value && q.options.find((o) => o.text.trim().toLowerCase() === value.toLowerCase());
          if (match) {
            const checked = await page.locator(`input[type="radio"][name="${q.name}"][value="${match.value}"]`).check().then(() => true).catch(() => false);
            if (checked) {
              submittedAnswers[q.label] = match.text;
              continue;
            }
          }
        }
        if (isEeoLabel(normalizedLabel)) {
          const value = resolveEeoValue(normalizedLabel, profile.eeoAnswers);
          const match = value && q.options.find((o) => o.text.trim().toLowerCase() === value.toLowerCase());
          if (match) {
            const checked = await page.locator(`input[type="radio"][name="${q.name}"][value="${match.value}"]`).check().then(() => true).catch(() => false);
            if (checked) {
              submittedAnswers[q.label] = match.text;
              continue;
            }
          }
        }
        // Any other radio group is a fixed option set with no principled way
        // to choose — never guessed, same rule as every other adapter.
        if (q.required) manualReviewFields.push(q.label);
        continue;
      }

      if (q.kind === "checkbox-group") {
        // Multi-select fixed option sets — never guessed into.
        if (q.required) manualReviewFields.push(q.label);
        continue;
      }
    }

    screenshotBuffer = await page.screenshot({ fullPage: true }).catch(() => null);

    if (manualReviewFields.length > 0) {
      status = "needs_manual_review";
    } else if (dryRun) {
      status = "dry_run_ok";
    } else {
      const submitButton = page.locator('button:has-text("Submit application")').first();
      await submitButton.click();

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

  // A screenshot is only worth its storage cost (~600KB/attempt, LONGBLOB,
  // never pruned — see jobSearchApplicationStore.js) when a human actually
  // needs to look at it: failed/needs_manual_review/blocked outcomes, where
  // it's the only way to see what the page actually looked like without
  // re-running Playwright. A successful submission already has
  // confirmationText as its receipt, so it doesn't need one too.
  if (status === "submitted") screenshotBuffer = null;

  return { status, submittedAnswers, manualReviewFields, confirmationText, screenshotBuffer, errorMessage };
}
