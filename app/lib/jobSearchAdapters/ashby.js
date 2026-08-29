// Confirmed live against a real posting (jobs.ashbyhq.com/ramp/<id>/application):
// Ashby DOES use label[for=id] pairs like Greenhouse, with stable ids for its
// handful of built-in fields (_systemfield_name/_systemfield_email/
// _systemfield_location/_systemfield_resume) and random per-posting UUIDs for
// custom questions. Two widget types are Ashby-specific and don't match
// Greenhouse's react-select/native-select vocabulary:
//   - "yes/no" questions render as a <button data-option="yes|no"> pair next
//     to a hidden, non-interactive <input type="checkbox"> — the buttons are
//     the real target, not the checkbox.
//   - location (and similar) fields are a role="combobox" autocomplete whose
//     results are DIVs with role="option" (not react-select's .select__option).
// This same live posting is also the one that surfaced a real reCAPTCHA
// (`g-recaptcha-response`) AND a separate "decode this and prove you're not a
// bot" text puzzle in the ordinary question flow — see blockerDetection.js,
// checked before any field is touched.
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

const NAV_TIMEOUT_MS = 30000;
const FORM_WAIT_TIMEOUT_MS = 15000;
const SUBMIT_SETTLE_TIMEOUT_MS = 10000;
const MAX_LLM_ANSWERED_FIELDS = 5;

const SUCCESS_TEXT_SIGNALS = /(thank you for applying|application (has been |was )?(successfully )?submitted|we('| ha)ve received your application|your application (has been|was) received)/i;
const ERROR_TEXT_SIGNALS = /(this field is required|please (enter|select|fill)|is required\b|error submitting|something went wrong)/i;

async function collectLabeledFields(page) {
  const labelHandles = await page.locator("label[for]").all();
  const fields = [];

  for (const label of labelHandles) {
    const forId = await label.getAttribute("for").catch(() => null);
    if (!forId) continue;
    const text = (await label.innerText().catch(() => "")) || "";
    const locator = page.locator(`[id="${forId.replace(/"/g, '\\"')}"]`);
    if (await locator.count().catch(() => 0) === 0) continue;

    // Confirmed live: Ashby marks required fields ONLY via the input's real
    // `required` IDL property, never a literal "*" in the label text (unlike
    // Greenhouse) — reading the boolean property (not getAttribute, which
    // returns "" for a valueless-but-present attribute, itself falsy) is the
    // only reliable signal here.
    const required = await locator.evaluate((el) => Boolean(el.required)).catch(() => false);

    fields.push({ label: text.replace(/\*\s*$/, "").trim(), normalizedLabel: normalizeLabel(text), locator, forId, required });
  }

  return fields;
}

async function classifyWidget(locator) {
  const tag = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
  if (tag === "select") return "native-select";
  if (tag === "textarea") return "textarea";
  const type = (await locator.getAttribute("type").catch(() => "")) || "";
  if (type === "file") return "file";
  if (type === "checkbox") return "yesno"; // Ashby's yes/no widget, confirmed live
  if (type === "radio") return "radio";
  const role = (await locator.getAttribute("role").catch(() => "")) || "";
  if (role === "combobox") return "autocomplete";
  return "text";
}

// The real clickable target for a yes/no question is a sibling <button
// data-option="yes|no">, not the (non-interactive) checkbox itself.
async function fillYesNo(page, locator, value) {
  const target = String(value).trim().toLowerCase() === "yes" ? "yes" : "no";
  const container = locator.locator("xpath=..");
  const button = container.locator(`button[data-option="${target}"]`);
  if (await button.count().catch(() => 0) === 0) return false;
  await button.click();
  return true;
}

// Ashby's autocomplete never offers an option matching a plain "City, State"
// string exactly (results always append region/country) — a prefix match is
// as strict as this widget can support without guessing between genuinely
// different places. No match at all still means "don't guess", not "closest".
async function fillAutocomplete(page, locator, value) {
  await locator.click();
  await locator.fill(String(value));

  const options = page.locator('[role="option"]');
  try {
    await options.first().waitFor({ state: "visible", timeout: 3000 });
  } catch {
    await locator.press("Escape").catch(() => {});
    return false;
  }

  const texts = await options.allInnerTexts().catch(() => []);
  const needle = String(value).trim().toLowerCase();
  const matchIndex = texts.findIndex((t) => t.trim().toLowerCase().startsWith(needle));
  if (matchIndex < 0) {
    await locator.press("Escape").catch(() => {});
    return false;
  }

  await options.nth(matchIndex).click();
  return true;
}

async function fillByWidget(page, locator, widget, value) {
  switch (widget) {
    case "text":
    case "textarea":
      await locator.fill(String(value));
      return true;
    case "native-select":
      try {
        await locator.selectOption({ label: String(value) });
        return true;
      } catch {
        return false;
      }
    case "yesno":
      return fillYesNo(page, locator, value);
    case "autocomplete":
      return fillAutocomplete(page, locator, value);
    case "radio": {
      const name = await locator.getAttribute("name").catch(() => null);
      if (!name) return false;
      const radio = page.locator(`input[type="radio"][name="${name.replace(/"/g, '\\"')}"][value="${String(value).replace(/"/g, '\\"')}"]`);
      if (await radio.count().catch(() => 0) === 0) return false;
      await radio.check();
      return true;
    }
    default:
      return false;
  }
}

const RESUME_UPLOAD_CONFIRM_TIMEOUT_MS = 15000;
const RESUME_UPLOAD_ERROR_TEXT = /failed to upload/i;

// setInputFiles() only attaches the File object to the DOM input — Ashby's
// own JS then asynchronously uploads it to its own storage, and THAT step
// can fail even when setInputFiles() itself never throws. Confirmed live: a
// real submission attempt showed exactly this — Playwright's setInputFiles()
// call succeeded, but Ashby's page then displayed an on-page "... failed to
// upload" toast that the adapter had no idea about, marked the field
// submitted anyway, and proceeded to fill the rest of the form and attempt
// to submit — which then failed minutes later with a confusing, seemingly
// unrelated timeout clicking the submit button (almost certainly because the
// still-visible error toast was covering it). A successful upload always
// renders a "Replace" button next to the attached filename — present, this
// is a positive, verifiable success signal, checked in a race against the
// error toast so whichever actually happens wins rather than always waiting
// out the full timeout.
async function uploadResumeAndVerify(page, filePath) {
  const fileInput = page.locator("#_systemfield_resume, input[type=\"file\"][name=\"resume\"]").first();
  if (await fileInput.count().catch(() => 0) === 0) return { ok: false, reason: "no file input found" };

  const replaceButton = page.getByRole("button", { name: "Replace" });
  const errorToast = page.getByText(RESUME_UPLOAD_ERROR_TEXT);

  for (let attempt = 1; attempt <= 2; attempt++) {
    await fileInput.setInputFiles(filePath);

    const outcome = await Promise.race([
      replaceButton.waitFor({ state: "visible", timeout: RESUME_UPLOAD_CONFIRM_TIMEOUT_MS }).then(() => "success").catch(() => "timeout"),
      errorToast.waitFor({ state: "visible", timeout: RESUME_UPLOAD_CONFIRM_TIMEOUT_MS }).then(() => "error").catch(() => "timeout")
    ]);

    if (outcome === "success") return { ok: true };
    if (attempt === 1) {
      // Best-effort dismiss so a lingering toast from this attempt can't be
      // mistaken for the retry's own outcome, or obscure the file input.
      await page.getByRole("button", { name: /close|dismiss/i }).first().click({ timeout: 1000 }).catch(() => {});
    }
  }

  return { ok: false, reason: "upload did not confirm after 2 attempts" };
}

export async function submitAshbyApplication({ posting, profile, resumeBuffer, resumeFileName, dryRun = false, headless = true }) {
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
    await page.locator("label[for]").first().waitFor({ state: "visible", timeout: FORM_WAIT_TIMEOUT_MS });

    const blockerReason = await detectSubmissionBlocker(page);
    if (blockerReason) {
      screenshotBuffer = await page.screenshot({ fullPage: true }).catch(() => null);
      return { status: "blocked", submittedAnswers, manualReviewFields, confirmationText, screenshotBuffer, errorMessage: blockerReason };
    }

    if (resumeBuffer) {
      const tempPath = join(tmpdir(), `job-search-resume-${Date.now()}-${resumeFileName || "resume.pdf"}`);
      await writeFile(tempPath, resumeBuffer);
      try {
        const uploadResult = await uploadResumeAndVerify(page, tempPath);
        if (uploadResult.ok) {
          submittedAnswers["Resume"] = resumeFileName || "resume.pdf";
        } else {
          manualReviewFields.push(`Resume upload (${uploadResult.reason})`);
        }
      } finally {
        await unlink(tempPath).catch(() => {});
      }
    }

    const fields = await collectLabeledFields(page);

    for (const field of fields) {
      if (field.forId === "_systemfield_resume") continue; // handled above

      const widget = await classifyWidget(field.locator);
      if (widget === "file") continue; // e.g. optional cover-letter file upload — not supported, never guessed

      if (isWorkAuthLabel(field.normalizedLabel)) {
        const value = resolveWorkAuthValue(field.normalizedLabel, profile.workAuthorization);
        if (value && await fillByWidget(page, field.locator, widget, value)) {
          submittedAnswers[field.label] = value;
        } else if (field.required) {
          manualReviewFields.push(field.label);
        }
        continue;
      }

      if (isEeoLabel(field.normalizedLabel)) {
        const value = resolveEeoValue(field.normalizedLabel, profile.eeoAnswers);
        if (value && await fillByWidget(page, field.locator, widget, value)) {
          submittedAnswers[field.label] = value;
        } else if (field.required) {
          manualReviewFields.push(field.label);
        }
        continue;
      }

      const standardValue = resolveStandardField(field.normalizedLabel, profile);
      if (standardValue) {
        if (await fillByWidget(page, field.locator, widget, standardValue)) {
          submittedAnswers[field.label] = standardValue;
        } else if (field.required) {
          manualReviewFields.push(field.label);
        }
        continue;
      }

      // Yes/no capability-style questions ("Do you have N years of experience
      // with X?") are a factual claim about the candidate, not a lookup — the
      // same reasoning that keeps EEO/work-auth hard-mapped and never
      // LLM-guessed applies here too, so these always go to manual review
      // rather than being answered by the LLM's best guess.
      if (widget === "yesno") {
        if (field.required) manualReviewFields.push(field.label);
        continue;
      }

      // Fixed option sets (dropdowns, autocompletes) with no known mapping —
      // never guessed into, same rule as Greenhouse's combobox/select handling.
      if (widget === "native-select" || widget === "autocomplete" || widget === "radio") {
        if (field.required) manualReviewFields.push(field.label);
        continue;
      }

      // Novel free-text question — LLM-assisted, capped, and metered against
      // the same daily budget as scoring/embedding.
      if ((widget === "text" || widget === "textarea") && llmAnsweredCount < MAX_LLM_ANSWERED_FIELDS) {
        const usage = await getTodayLlmUsage();
        if (usage.totalCalls >= findSettings.maxLlmCallsPerDay) {
          if (field.required) manualReviewFields.push(field.label);
          continue;
        }

        const answer = await answerFreeText({ question: field.label, posting, profile }).catch(() => null);
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
      const submitButton = page.locator('button[type="submit"]').first();
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
