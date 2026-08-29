import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { answerFreeText } from "../jobSearchLlm.js";
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
const MAX_LLM_ANSWERED_FIELDS = 5;

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
async function fillReactSelect(scope, input, value) {
  await input.click();
  await input.fill(String(value));

  const options = scope.locator(".select__option");
  try {
    await options.first().waitFor({ state: "visible", timeout: 3000 });
  } catch {
    await input.press("Escape").catch(() => {});
    return false;
  }

  // Only accept an exact (case-insensitive) match — never click the first
  // fuzzy suggestion for a field we were asked to fill precisely.
  const texts = await options.allInnerTexts().catch(() => []);
  const exactIndex = texts.findIndex((t) => t.trim().toLowerCase() === String(value).trim().toLowerCase());
  if (exactIndex < 0) {
    await input.press("Escape").catch(() => {});
    return false;
  }

  await options.nth(exactIndex).click();
  return true;
}

async function fillByWidget(scope, locator, widget, value) {
  switch (widget) {
    case "text":
    case "textarea":
      await locator.fill(String(value));
      return true;
    case "checkbox":
      if (value) await locator.check();
      else await locator.uncheck();
      return true;
    case "native-select":
      try {
        await locator.selectOption({ label: String(value) });
        return true;
      } catch {
        return false;
      }
    case "react-select":
      return fillReactSelect(scope, locator, value);
    default:
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

async function uploadResumeFile(scope, resumeBuffer, resumeFileName) {
  const fileInput = scope.locator("#resume");
  if (await fileInput.count().catch(() => 0) === 0) return false;

  const tempPath = join(tmpdir(), `job-search-resume-${Date.now()}-${resumeFileName || "resume.pdf"}`);
  await writeFile(tempPath, resumeBuffer);
  try {
    await fileInput.setInputFiles(tempPath);
    return true;
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

// Consent-style checkboxes (e.g. "I consent to collecting demographic data for
// EEO purposes") aren't a discrete answer — they gate submitting the EEO
// answers at all. Checked only when the profile actually has EEO data to
// submit; otherwise left alone and flagged for manual review like anything else.
function isEeoConsentCheckboxLabel(label) {
  return /consent/.test(label) && /(demographic|eeo|equal employment)/.test(label);
}

export async function submitGreenhouseApplication({ posting, profile, resumeBuffer, resumeFileName, dryRun = false, headless = true }) {
  const browser = await chromium.launch({ headless });
  const submittedAnswers = {};
  const manualReviewFields = [];
  let llmAnsweredCount = 0;
  let confirmationText = "";
  let screenshotBuffer = null;
  let status = "failed";
  let errorMessage = "";

  try {
    const page = await browser.newPage();
    await page.goto(posting.applyUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });

    const scope = await findFormScope(page);
    await scope.locator("label[for]").first().waitFor({ state: "visible", timeout: FORM_WAIT_TIMEOUT_MS });

    if (resumeBuffer) {
      const uploaded = await uploadResumeFile(scope, resumeBuffer, resumeFileName);
      if (!uploaded) manualReviewFields.push("Resume upload (no file input found)");
    }

    const fields = await collectLabeledFields(scope);

    for (const field of fields) {
      const widget = await classifyWidget(field.locator);
      if (widget === "file") continue; // resume/cover-letter handled separately

      if (widget === "checkbox" && isEeoConsentCheckboxLabel(field.normalizedLabel)) {
        const hasEeoData = Object.values(profile.eeoAnswers || {}).some(Boolean);
        if (hasEeoData) {
          await fillByWidget(scope, field.locator, widget, true);
          submittedAnswers[field.label] = true;
        } else if (field.required) {
          manualReviewFields.push(field.label);
        }
        continue;
      }

      // EEO/work-authorization: hard-mapped by exact stored text, never the LLM.
      if (isEeoLabel(field.normalizedLabel)) {
        const value = resolveEeoValue(field.normalizedLabel, profile.eeoAnswers);
        if (value && await fillByWidget(scope, field.locator, widget, value)) {
          submittedAnswers[field.label] = value;
        } else if (field.required) {
          manualReviewFields.push(field.label);
        }
        continue;
      }

      if (isWorkAuthLabel(field.normalizedLabel)) {
        const value = resolveWorkAuthValue(field.normalizedLabel, profile.workAuthorization);
        if (value && await fillByWidget(scope, field.locator, widget, value)) {
          submittedAnswers[field.label] = value;
        } else if (field.required) {
          manualReviewFields.push(field.label);
        }
        continue;
      }

      // Known profile field (name/email/phone/links/etc).
      const standardValue = resolveStandardField(field.normalizedLabel, profile);
      if (standardValue) {
        if (await fillByWidget(scope, field.locator, widget, standardValue)) {
          submittedAnswers[field.label] = standardValue;
        } else if (field.required) {
          manualReviewFields.push(field.label);
        }
        continue;
      }

      // Novel free-text question — LLM-assisted, capped, and only for plain
      // text/textarea widgets. Never used for a combobox/select/checkbox,
      // since guessing a value into a fixed option set risks submitting
      // something the model invented that doesn't match any real option.
      if ((widget === "text" || widget === "textarea") && llmAnsweredCount < MAX_LLM_ANSWERED_FIELDS) {
        const answer = await answerFreeText({ question: field.label, posting, profile }).catch(() => null);
        if (answer) {
          await field.locator.fill(answer);
          submittedAnswers[field.label] = answer;
          llmAnsweredCount += 1;
          continue;
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
      const submitButton = scope.locator('button[type="submit"], input[type="submit"]').first();
      await submitButton.click();
      await page.waitForTimeout(2500);
      confirmationText = (await page.locator("body").innerText().catch(() => "")).slice(0, 500);
      screenshotBuffer = await page.screenshot({ fullPage: true }).catch(() => screenshotBuffer);
      status = "submitted";
    }
  } catch (error) {
    errorMessage = error?.message || String(error);
    status = "failed";
  } finally {
    await browser.close();
  }

  return { status, submittedAnswers, manualReviewFields, confirmationText, screenshotBuffer, errorMessage };
}
