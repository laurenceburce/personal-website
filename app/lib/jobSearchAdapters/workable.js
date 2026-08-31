// Confirmed live against a real posting (apply.workable.com/<company>/j/<id>/apply):
// no bot-wall (unlike SmartRecruiters/iCIMS), standard fields are plain named
// inputs (firstname/lastname/email/headline/phone) with aria-labelledby
// pointing at a real label element — even more reliable than Greenhouse's
// label[for]. Custom questions are grouped differently depending on type:
// a plain text/textarea question is just aria-labelledby="QA_<id>_label";
// a checkbox (multi-select) question wraps its options in
// div[role="group"][aria-labelledby="<groupId>_label"]; a radio (single-select)
// question wraps its options in fieldset[role="radiogroup"][aria-labelledby].
import { findBestMemoryMatch, listAnswerMemoryForMatching, recordMemoryReuse } from "../jobSearchAnswerMemoryStore.js";
import { answerFreeText, chooseFromOptions } from "../jobSearchLlm.js";
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
  resolveManualOverride,
  resolveStandardFieldCandidates,
  resolveWorkAuthValue
} from "./profileMapping.js";
import { resumeFilePayload } from "./resumeFilePayload.js";
import { resumeUploadLikelyFailed } from "./resumeUploadCheck.js";

const NAV_TIMEOUT_MS = 30000;
const FORM_WAIT_TIMEOUT_MS = 15000;
const SUBMIT_SETTLE_TIMEOUT_MS = 10000;
// Raised from 5 after an audit pass — see greenhouse.js's identical constant
// for the reasoning (daily LLM usage has plenty of headroom; 5 was an
// arbitrary early-caution number, not a real cost/rate-limit ceiling). This
// is the one that was actually observed hitting the old ceiling live: a real
// Codurance posting had exactly 5 genuinely-answerable custom questions.
const MAX_LLM_ANSWERED_FIELDS = 15;

const SUCCESS_TEXT_SIGNALS = /(thank you for applying|application (has been |was )?(successfully )?submitted|we('| ha)ve received your application|your application (has been|was) received)/i;
const ERROR_TEXT_SIGNALS = /(this field is required|please (enter|select|fill)|is required\b|error submitting|something went wrong)/i;

// Confirmed live as a real, common form pattern: "years of experience with
// X" rendered as a RADIO group with numeric-range choices ("0-1", "1-3",
// "3-5", "5+", or a phrase like "Menos de 1 ano"/"1 a 3 anos") rather than a
// free-text box (a real Codurance posting had exactly this for both its
// ".NET/.NET Core" and "React/Next.js" experience questions — its own
// options were opaque internal IDs like "6427962", never usable directly,
// only their rendered option TEXT is meaningful). Detected generically by
// option shape, not by matching English/Portuguese/etc. question wording:
// experience-duration options are reliably number-heavy ("0-1 years", "1 a 3
// anos", "5+"), while a preference/logistics question's options (yes/no,
// agree/disagree, salary bands with currency symbols but no plain digit
// count) essentially never are. Deliberately conservative (half the options
// must contain a digit) so a mixed or ambiguous option set falls through to
// manual review rather than being guessed at.
function looksLikeExperienceDurationQuestion(options) {
  if (!Array.isArray(options) || options.length < 2) return false;
  const withDigits = options.filter((o) => /\d/.test(o.text || "")).length;
  return withDigits >= Math.ceil(options.length / 2);
}

const STANDARD_NAME_RESOLVERS = {
  // Read straight off the profile's own structured first/last name fields —
  // not derived by splitting a combined string. Splitting can't be made
  // reliable in general (a two-word first name is indistinguishable from a
  // first name plus a middle name once joined into one string), so the
  // profile captures First/Middle/Last as separate inputs to begin with —
  // see profileMapping.js and ProfileSettingsPanel.js.
  firstname: (p) => p.firstName || null,
  lastname: (p) => p.lastName || null,
  email: (p) => p.email,
  phone: (p) => p.phone,
  headline: (p) => p.workHistory?.[0]?.title
};

async function dismissCookieBanner(page) {
  await clickWithBrowserMouse(page, page.locator('button:has-text("Accept all")').first(), { timeout: 3000 }).catch(() => {});
}

// Standard/label-matched "field" questions were always filled with a plain
// .fill() regardless of q.tag — Playwright's .fill() throws on a real
// <select> (it isn't a text input), so a Country (or any other enum-like)
// field rendered as a native select could never be filled here at all, even
// when the profile had perfectly good data for it; it just silently failed
// and fell to manual review every time. Tries each candidate in turn (see
// resolveStandardFieldCandidates in profileMapping.js) since a select also
// needs its option label to actually match the form's own wording.
async function fillWorkableFieldValue(page, q, candidates) {
  const locator = page.locator(`[name="${q.name}"]`).first();
  for (const candidate of candidates) {
    const ok = q.tag === "select"
      ? await locator.selectOption({ label: String(candidate) }).then(() => true).catch(() => false)
      : await locator.fill(String(candidate)).then(() => true).catch(() => false);
    if (ok) return candidate;
  }
  return null;
}

async function uploadResumeFile(page, resumeBuffer, resumeFileName) {
  const fileInput = page.locator('input[type="file"]').first();
  if (await fileInput.count().catch(() => 0) === 0) return false;

  await fileInput.setInputFiles(resumeFilePayload(resumeBuffer, resumeFileName));
  // setInputFiles() only attaches the file to the DOM input — it says
  // nothing about whether Workable's own JS then actually uploaded it. See
  // resumeUploadCheck.js.
  return !(await resumeUploadLikelyFailed(page));
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

    // Each option's own wrapper carries a TWO-id aria-labelledby (confirmed
    // live: "<groupLabelId> <optionLabelId>") — the group's shared question
    // label first, then the option's own answer text second. Taking the
    // FIRST id (as this used to) means every option's "text" collapsed to
    // the group's own question label, identical across every option in the
    // group — silently breaking any exact-text match against it (EEO/
    // work-auth radio answers below, and the new experience-duration
    // handling), always falling through to manual review. The LAST id is
    // the option-specific one; for a wrapper with only a single id (no
    // separate option label), .pop() still returns that same one id, so
    // this doesn't regress a form shaped the old way.
    function optionLabelId(labelledBy) {
      const ids = (labelledBy || "").trim().split(/\s+/).filter(Boolean);
      return ids[ids.length - 1] || "";
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
          text: labelText(optionLabelId(c.closest('[role="checkbox"]')?.getAttribute("aria-labelledby")))
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
          text: labelText(optionLabelId(r.closest('[role="radio"]')?.getAttribute("aria-labelledby")))
        }))
      });
    }

    return results;
  }, Object.keys(STANDARD_NAME_RESOLVERS));
}

export async function submitWorkableApplication({ posting, profile, resumeBuffer, resumeFileName, resumeText = "", dryRun = false, headless = true }) {
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
    // Fetched once, reused for every question below — see
    // jobSearchAnswerMemoryStore.js's own comment on why this isn't a
    // per-field query.
    const memoryRows = await listAnswerMemoryForMatching().catch(() => []);

    for (const q of questions) {
      const normalizedLabel = normalizeLabel(q.label);

      // A human already answered this exact question for this exact posting
      // (see the Review Queue's "Answer & Retry" popup) — try it before any
      // auto-resolution strategy below. Not attempted for checkbox-group (a
      // multi-select — a single saved answer doesn't map cleanly onto
      // checking several boxes); "field" reuses fillWorkableFieldValue,
      // "radio-group" reuses the same option-text matching the EEO/work-auth
      // branch below already does.
      const manualOverride = resolveManualOverride(normalizedLabel, posting.manualReviewFields);
      if (manualOverride != null && q.kind !== "checkbox-group") {
        if (q.kind === "field") {
          const filledValue = await fillWorkableFieldValue(page, q, [manualOverride]);
          if (filledValue != null) {
            submittedAnswers[q.label || q.name] = filledValue;
            continue;
          }
        } else if (q.kind === "radio-group") {
          const match = q.options.find((o) => o.text.trim().toLowerCase() === manualOverride.toLowerCase());
          if (match) {
            const checked = await setCheckedWithBrowserMouse(page, page.locator(`input[type="radio"][name="${q.name}"][value="${match.value}"]`), true).then(() => true).catch(() => false);
            if (checked) {
              submittedAnswers[q.label] = match.text;
              continue;
            }
          }
        }
      }

      if (q.kind === "field") {
        // Standard field, keyed by its stable `name` attribute. These are
        // confirmed always plain text inputs on Workable (never a select),
        // so a single candidate is enough here.
        if (STANDARD_NAME_RESOLVERS[q.name]) {
          const value = STANDARD_NAME_RESOLVERS[q.name](profile);
          if (value) {
            const filledValue = await fillWorkableFieldValue(page, q, [value]);
            if (filledValue != null) {
              submittedAnswers[q.label || q.name] = filledValue;
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

        // Unlike the standard fields above, a custom field matched by label
        // text (country, phone, etc.) genuinely can be a native <select> —
        // fillWorkableFieldValue() handles that, and candidates covers
        // fields with more than one acceptable value (country name spelled
        // out vs. abbreviated, phone with/without its country code).
        const standardCandidates = resolveStandardFieldCandidates(normalizedLabel, profile, q.label);
        if (standardCandidates.length > 0) {
          const filledValue = await fillWorkableFieldValue(page, q, standardCandidates);
          if (filledValue != null) {
            submittedAnswers[q.label] = filledValue;
            continue;
          }
          if (q.required) manualReviewFields.push(q.label);
          continue;
        }

        // A similarly-worded question was answered by hand on a DIFFERENT
        // posting before (see the Review Queue's Memory tab / "Answer & Retry"
        // popup) — a human-verified past answer beats a fresh LLM guess, so
        // this is checked ahead of the free-text fallback below, for ANY tag
        // (including select — unlike the LLM branch right after this, which
        // deliberately excludes select to avoid inventing an option).
        if (memoryRows.length > 0) {
          const llmSettings = await getLlmFindSettings();
          const usage = await getTodayLlmUsage();
          if (usage.totalCalls < llmSettings.maxLlmCallsPerDay) {
            const memoryMatch = await findBestMemoryMatch(q.label, posting.companyName, memoryRows).catch(() => null);
            if (memoryMatch) {
              const filledValue = await fillWorkableFieldValue(page, q, [memoryMatch.answer]);
              if (filledValue != null) {
                submittedAnswers[q.label || q.name] = filledValue;
                await recordMemoryReuse(memoryMatch.id).catch(() => {});
                continue;
              }
            }
          }
        }

        if (q.tag !== "select" && llmAnsweredCount < MAX_LLM_ANSWERED_FIELDS) {
          const llmSettings = await getLlmFindSettings();
          const usage = await getTodayLlmUsage();
          if (usage.totalCalls >= llmSettings.maxLlmCallsPerDay) {
            if (q.required) manualReviewFields.push(q.label);
            continue;
          }
          const answer = await answerFreeText({ question: q.label, posting, profile, resumeText }).catch(() => null);
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
            const checked = await setCheckedWithBrowserMouse(page, page.locator(`input[type="radio"][name="${q.name}"][value="${match.value}"]`), true).then(() => true).catch(() => false);
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
            const checked = await setCheckedWithBrowserMouse(page, page.locator(`input[type="radio"][name="${q.name}"][value="${match.value}"]`), true).then(() => true).catch(() => false);
            if (checked) {
              submittedAnswers[q.label] = match.text;
              continue;
            }
          }
        }
        // Same memory check as the "field" kind above, adapted to a
        // radio-group's own option-text matching (identical mechanism the
        // EEO/work-auth branches right above already use).
        if (memoryRows.length > 0) {
          const llmSettings = await getLlmFindSettings();
          const usage = await getTodayLlmUsage();
          if (usage.totalCalls < llmSettings.maxLlmCallsPerDay) {
            const memoryMatch = await findBestMemoryMatch(q.label, posting.companyName, memoryRows).catch(() => null);
            const match = memoryMatch && q.options.find((o) => o.text.trim().toLowerCase() === memoryMatch.answer.toLowerCase());
            if (match) {
              const checked = await setCheckedWithBrowserMouse(page, page.locator(`input[type="radio"][name="${q.name}"][value="${match.value}"]`), true).then(() => true).catch(() => false);
              if (checked) {
                submittedAnswers[q.label] = match.text;
                await recordMemoryReuse(memoryMatch.id).catch(() => {});
                continue;
              }
            }
          }
        }

        // A years-of-experience-shaped question IS something the resume can
        // genuinely answer, unlike an arbitrary radio group — see
        // looksLikeExperienceDurationQuestion()'s own comment. Everything
        // else stays "never guessed": a preference/logistics question
        // (salary band, notice period, on-site-days willingness) has no
        // profile data backing an honest answer, and guessing one commits
        // the candidate to something they never actually agreed to.
        if (looksLikeExperienceDurationQuestion(q.options) && llmAnsweredCount < MAX_LLM_ANSWERED_FIELDS) {
          const llmSettings = await getLlmFindSettings();
          const usage = await getTodayLlmUsage();
          if (usage.totalCalls < llmSettings.maxLlmCallsPerDay) {
            const optionTexts = q.options.map((o) => o.text).filter(Boolean);
            const chosenText = await chooseFromOptions({ question: q.label, options: optionTexts, posting, profile, resumeText }).catch(() => null);
            await incrementLlmUsage("score");
            const match = chosenText && q.options.find((o) => o.text === chosenText);
            if (match) {
              const checked = await setCheckedWithBrowserMouse(page, page.locator(`input[type="radio"][name="${q.name}"][value="${match.value}"]`), true).then(() => true).catch(() => false);
              if (checked) {
                submittedAnswers[q.label] = match.text;
                llmAnsweredCount += 1;
                continue;
              }
            }
          }
        }
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

  // A screenshot is only worth its storage cost (~600KB/attempt, LONGBLOB,
  // never pruned — see jobSearchApplicationStore.js) when a human actually
  // needs to look at it: failed/needs_manual_review/blocked outcomes, where
  // it's the only way to see what the page actually looked like without
  // re-running Playwright. A successful submission already has
  // confirmationText as its receipt, so it doesn't need one too.
  if (status === "submitted") screenshotBuffer = null;

  return { status, submittedAnswers, manualReviewFields, confirmationText, screenshotBuffer, errorMessage };
}
