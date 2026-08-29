// Confirmed live against a real posting (jobs.lever.co/palantir/<id>/apply):
// standard fields are plain <input name="..."> (NOT label[for] pairs — Lever
// wraps <label><div class="application-label">text</div><div
// class="application-field">...input...</div></label>, an implicit
// association), while every custom question is a "card" whose exact schema
// (type/text/required/options) is embedded verbatim as JSON in a hidden
// <input name="cards[<id>][baseTemplate]">. Reading that JSON directly is far
// more reliable than scraping visible label text, so that's the approach here
// instead of Greenhouse's label[for]-based collectLabeledFields().
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
  resolveWorkAuthValue
} from "./profileMapping.js";

const NAV_TIMEOUT_MS = 30000;
const FORM_WAIT_TIMEOUT_MS = 15000;
const SUBMIT_SETTLE_TIMEOUT_MS = 10000;
const MAX_LLM_ANSWERED_FIELDS = 5;

const SUCCESS_TEXT_SIGNALS = /(thank you for applying|application (has been |was )?(successfully )?submitted|we('| ha)ve received your application|your application (has been|was) received)/i;
const ERROR_TEXT_SIGNALS = /(this field is required|please (enter|select|fill)|is required\b|error submitting|something went wrong)/i;

// Direct name-attribute map for Lever's standard fields — confirmed live,
// stable across postings (unlike custom "card" question ids, which are
// per-posting UUIDs).
const STANDARD_NAME_RESOLVERS = {
  name: (p) => p.fullName,
  email: (p) => p.email,
  phone: (p) => p.phone,
  location: (p) => [p.city, p.stateRegion].filter(Boolean).join(", "),
  org: (p) => p.workHistory?.[0]?.company,
  "urls[LinkedIn]": (p) => p.linkedinUrl,
  "urls[GitHub]": (p) => p.githubUrl,
  "urls[Portfolio]": (p) => p.portfolioUrl
};

async function uploadResumeFile(page, resumeBuffer, resumeFileName) {
  const fileInput = page.locator('input[type="file"][name="resume"]');
  if (await fileInput.count().catch(() => 0) === 0) return false;

  const tempPath = join(tmpdir(), `job-search-resume-${Date.now()}-${resumeFileName || "resume.pdf"}`);
  await writeFile(tempPath, resumeBuffer);
  try {
    // Lever's real file input is visually hidden behind a styled "Attach
    // Resume/CV" button — setInputFiles targets the element directly and
    // doesn't require it to be visible, confirmed live.
    await fileInput.setInputFiles(tempPath);
    return true;
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

// Reads every card's hidden baseTemplate JSON via the page's own DOM (not
// regex over raw HTML — the JSON is HTML-attribute-escaped and awkward to
// re-parse from text; page.evaluate() gets it pre-decoded for free).
async function collectCards(page) {
  return page.evaluate(() => {
    const inputs = document.querySelectorAll('input[name*="[baseTemplate]"]');
    const cards = [];
    for (const input of inputs) {
      const match = input.name.match(/^cards\[([^\]]+)\]\[baseTemplate\]$/);
      if (!match) continue;
      try {
        const schema = JSON.parse(input.value);
        cards.push({ cardId: match[1], text: schema.text || "", fields: schema.fields || [] });
      } catch {
        // Malformed/unexpected schema — skip this card rather than throw and
        // abort the whole application over one bad question.
      }
    }
    return cards;
  });
}

export async function submitLeverApplication({ posting, profile, resumeBuffer, resumeFileName, dryRun = false, headless = true }) {
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
    await page.locator('input[name="name"]').first().waitFor({ state: "visible", timeout: FORM_WAIT_TIMEOUT_MS });

    const blockerReason = await detectSubmissionBlocker(page);
    if (blockerReason) {
      screenshotBuffer = await page.screenshot({ fullPage: true }).catch(() => null);
      return { status: "blocked", submittedAnswers, manualReviewFields, confirmationText, screenshotBuffer, errorMessage: blockerReason };
    }

    if (resumeBuffer) {
      const uploaded = await uploadResumeFile(page, resumeBuffer, resumeFileName);
      if (!uploaded) manualReviewFields.push("Resume upload (no file input found)");
    }

    for (const [name, resolve] of Object.entries(STANDARD_NAME_RESOLVERS)) {
      const value = resolve(profile);
      if (!value) continue;
      const locator = page.locator(`input[name="${name.replace(/"/g, '\\"')}"]`).first();
      if (await locator.count().catch(() => 0) === 0) continue;
      // Track whether the fill actually landed — a swallowed error here used
      // to still record the field as answered, so a silently-failed fill on
      // a real identity field (name/email/phone) would never surface as a
      // problem before an actual submit attempt.
      const filled = await locator.fill(String(value)).then(() => true).catch(() => false);
      if (filled) submittedAnswers[name] = value;
      else manualReviewFields.push(name);
    }

    const cards = await collectCards(page);
    for (const card of cards) {
      for (let i = 0; i < card.fields.length; i++) {
        const field = card.fields[i];
        const fieldName = `cards[${card.cardId}][field${i}]`;
        const normalizedLabel = normalizeLabel(field.text);
        const required = Boolean(field.required);

        // Work-authorization questions render as a Yes/No radio pair here —
        // hard-mapped by exact stored text, never guessed, same as Greenhouse.
        if (field.type === "multiple-choice" && isWorkAuthLabel(normalizedLabel)) {
          const value = resolveWorkAuthValue(normalizedLabel, profile.workAuthorization);
          const radio = value
            ? page.locator(`input[type="radio"][name="${fieldName.replace(/"/g, '\\"')}"][value="${value}"]`)
            : null;
          const radioExists = value ? await radio.count().catch(() => 0) > 0 : false;
          const checked = radioExists ? await radio.check().then(() => true).catch(() => false) : false;
          if (checked) submittedAnswers[field.text] = value;
          else if (required) manualReviewFields.push(field.text);
          continue;
        }

        if (field.type === "multiple-choice" && isEeoLabel(normalizedLabel)) {
          const value = resolveEeoValue(normalizedLabel, profile.eeoAnswers);
          const radio = value
            ? page.locator(`input[type="radio"][name="${fieldName.replace(/"/g, '\\"')}"][value="${value}"]`)
            : null;
          const radioExists = value ? await radio.count().catch(() => 0) > 0 : false;
          const checked = radioExists ? await radio.check().then(() => true).catch(() => false) : false;
          if (checked) submittedAnswers[field.text] = value;
          else if (required) manualReviewFields.push(field.text);
          continue;
        }

        // Checkbox groups (multiple-select) and single-select dropdowns both
        // require picking from a fixed option set we have no principled way
        // to choose from (language skills, "how did you hear about us",
        // university attended, consent toggles, etc.) — never guessed, same
        // never-guess-into-a-fixed-option-set rule as Greenhouse's combobox
        // handling.
        if (field.type === "multiple-select" || field.type === "dropdown") {
          if (required) manualReviewFields.push(field.text);
          continue;
        }

        // Free-text (text/textarea) — LLM-assisted, capped, and metered
        // against the same daily budget as scoring/embedding, checked fresh
        // per field so it can't overshoot the cap by more than one in-flight
        // call (same pattern as jobSearchScoringPipeline.scorePosition()).
        if ((field.type === "text" || field.type === "textarea") && llmAnsweredCount < MAX_LLM_ANSWERED_FIELDS) {
          const usage = await getTodayLlmUsage();
          if (usage.totalCalls >= findSettings.maxLlmCallsPerDay) {
            if (required) manualReviewFields.push(field.text);
            continue;
          }

          const answer = await answerFreeText({ question: field.text, posting, profile }).catch(() => null);
          await incrementLlmUsage("score");
          if (answer) {
            const locator = page.locator(`[name="${fieldName.replace(/"/g, '\\"')}"]`).first();
            const filled = await locator.fill(answer).then(() => true).catch(() => false);
            if (filled) {
              submittedAnswers[field.text] = answer;
              llmAnsweredCount += 1;
              continue;
            }
          }
        }

        if (required) manualReviewFields.push(field.text);
      }
    }

    // Optional SMS/marketing consent — never opted into on the candidate's
    // behalf; left at its default (unchecked) either way.

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
