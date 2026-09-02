// Oracle Recruiting Cloud (Fusion) — atsType "oracle_fusion" (the
// oraclecloud.com domain; NOT legacy Taleo/taleo.net, a genuinely different,
// older product that has never been live-tested and has no adapter here —
// see atsTypes.js).
//
// Confirmed live against Oracle's own real careers site
// (careers.oracle.com, which itself runs on Fusion, tenant
// eeho.fa.us2.oraclecloud.com): clicking a job's "Apply Now" does NOT hit a
// third-party SSO wall the way an earlier build of this adapter assumed —
// it's Oracle's own lightweight flow ("You don't need to have an account.
// Get started right away by using your email or phone number.") with just
// an email field, a honeypot field, and a terms checkbox. Clicking Next from
// there DOES require a one-time verification code emailed to that address
// ("Confirm Your Identity... The verification code was sent to this email
// address... When you get the code, type the code into the field to confirm
// your identity and complete your job application.") — confirmed live, a
// real code was sent to a real inbox during testing (never entered; no
// application was completed).
//
// This adapter never scripts that email/code exchange itself — reading
// someone's email is not something a headless worker can do, and this
// codebase's whole posture (see blockerDetection.js) is to report an
// identity check rather than try to get past it. Instead, the one-time
// connect step happens via scripts/job-search-oracle-connect.mjs: it drives
// the email+checkbox+Next steps automatically (none of that needs a human —
// there's no third-party identity provider involved, unlike the SSO case
// this adapter used to assume), then prompts a human, right there in the
// terminal, to read the emailed code and type it in. The resulting
// Playwright `storageState` is uploaded through the Job Search dashboard
// (User Settings -> "Oracle Recruiting Cloud sessions") and stored per
// tenant host in job_search_oracle_sessions — a verified session on one
// company's Oracle instance grants no access to another's. If no session is
// saved for a posting's tenant, or the saved one has expired (the auth
// screen still appears despite loading it), this reports `blocked` with
// guidance to (re)run the connect script — never a guessed/typed
// credential, and never an attempt to guess or brute-force the code itself.
//
// EVERYTHING PAST THE VERIFICATION-CODE SCREEN IS NOT CONFIRMED LIVE — live
// testing deliberately stopped at that screen rather than complete a real
// application (see the connect script's own header for why). The wizard-
// step/field-collection logic below is written from the one confirmed-live
// Oracle JET rendering convention seen so far (real `label[for]`s wrapping a
// `<span id="labelText-...">`, per this codebase's own probing of the email
// step's markup) plus the same conservative "never guess a required
// field" posture every other adapter here already takes. Dry-run this
// (dryRun: true) against a real posting before trusting it unattended, and
// treat it as less proven than greenhouse.js/ashby.js/workable.js/
// personio.js/breezy.js until it has a real successful submission behind it.
import { findBestMemoryMatch, findExactMemoryMatch, listAnswerMemoryForMatching, recordMemoryReuse } from "../jobSearchAnswerMemoryStore.js";
import { answerFreeText, chooseFromOptions } from "../jobSearchLlm.js";
import { getFindSettings } from "../jobSearchSettingsStore.js";
import { getTodayLlmUsage, incrementLlmUsage } from "../jobSearchUsageStore.js";
import { clickWithBrowserMouse } from "./browserEngineClick.js";
import { detectSubmissionBlocker, isHeldChallengeBlockerReason } from "./blockerDetection.js";
import { resolveHeldChallenge } from "./heldChallengeRelay.js";
import { launchJobSearchBrowser } from "./jobSearchBrowser.js";
import { getOracleSessionForHost } from "../jobSearchOracleSessionStore.js";
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
const MAX_LLM_ANSWERED_FIELDS = 15;
const MAX_WIZARD_STEPS = 8;
const POLL_INTERVAL_MS = 1500;
const POLL_MAX_MS = 30000;

const SUCCESS_TEXT_SIGNALS = /(thank you for applying|thanks for applying|thank you for your application|thanks for your application|application (has been |was |is )?(successfully )?(submitted|received|sent)|we('| ha)ve received your application|we received your application|we got your application|your application (has been|was|is) received|application received|your application (has been|was) successfully submitted)/i;
const ERROR_TEXT_SIGNALS = /(this field is required|please (enter|select|fill)|is required\b|error submitting|something went wrong|invalid|upload failed|failed to upload|invalid code|incorrect code|expired code|verification failed)/i;
// Confirmed-live exact wording from the auth screen (see this file's header)
// — matched here rather than relying on blockerDetection.js's
// LOGIN_WALL_SIGNALS, which was written for "sign in to apply"-style
// phrasing that doesn't appear anywhere on this screen.
const NEEDS_VERIFICATION_SIGNALS = /verification code|confirm your identity/i;
const NEXT_BUTTON_PATTERN = /^(next|continue|save and continue)$/i;
const SUBMIT_BUTTON_PATTERN = /^(submit application|submit|finish application|finish)$/i;

function cleanLabel(text) {
  return String(text || "").replace(/\*/g, "").replace(/\s+/g, " ").trim();
}

function isCandidateLogisticsLabel(label) {
  return /\b(available from|availability|earliest start|start date|notice period|expected salary|salary expectation|desired salary|compensation expectation|time\s*zone|timezone)\b/.test(label);
}

function looksLikeExperienceDurationQuestion(options) {
  if (!Array.isArray(options) || options.length < 2) return false;
  const text = options.map((option) => option.text || "").join(" ");
  const withDigits = options.filter((option) => /\d/.test(option.text || "")).length;
  return /\b(year|years|experience)\b/i.test(text) && withDigits >= Math.ceil(options.length / 2);
}

async function resolveOracleSession(applyUrl) {
  let host;
  try {
    host = new URL(applyUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  return getOracleSessionForHost(host);
}

function blockedResult({ blockerReason, hasSession, submittedAnswers, manualReviewFields, fieldOptions, confirmationText }) {
  return {
    status: "blocked",
    submittedAnswers,
    manualReviewFields,
    fieldOptions,
    confirmationText,
    errorMessage: hasSession
      ? `${blockerReason} The saved Oracle session for this tenant may have expired — rerun "node scripts/job-search-oracle-connect.mjs" and re-upload it in the dashboard (User Settings -> "Oracle Recruiting Cloud sessions").`
      : `${blockerReason} No saved Oracle session found for this tenant — run "node scripts/job-search-oracle-connect.mjs" once to connect it, then upload the resulting file in the dashboard (User Settings -> "Oracle Recruiting Cloud sessions").`
  };
}

// Same rendering convention confirmed live on the email/auth step's markup:
// real `<label for="id">` wrapping a `<span id="labelText-id">` with the
// visible text, plus aria-labelledby/aria-label as fallbacks for anything
// that doesn't follow that exact shape. Every matched control is tagged
// with a throwaway data attribute so it can be re-selected from Playwright
// afterward regardless of whether it has a usable id/name of its own.
async function collectFields(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const brief = (el) => (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();

    const labelForField = (el) => {
      if (el.id) {
        const byFor = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (byFor && brief(byFor)) return brief(byFor);
      }
      const wrapping = el.closest("label");
      if (wrapping && brief(wrapping)) return brief(wrapping);
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const text = labelledBy.split(/\s+/)
          .map((id) => brief(document.getElementById(id)))
          .filter(Boolean)
          .join(" ");
        if (text) return text;
      }
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
      return el.getAttribute("placeholder") || "";
    };

    const fields = [];
    const seenRadioNames = new Set();
    let idx = 0;

    for (const el of document.querySelectorAll("input, textarea, select")) {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (["hidden", "file", "submit", "button", "reset", "image"].includes(type)) continue;
      // Same honeypot naming confirmed live on the email step
      // ("honey-pot"/"honeypot") — never filled, on any step.
      if (/honey.?pot/i.test(el.getAttribute("name") || "") || /honeypot/i.test(el.getAttribute("aria-label") || "")) continue;
      if (!visible(el) && type !== "radio" && type !== "checkbox") continue;

      const rawLabel = labelForField(el);
      const name = el.getAttribute("name") || "";
      const label = rawLabel || name || `Field ${idx + 1}`;
      const required = Boolean(el.required)
        || el.getAttribute("aria-required") === "true"
        || /\*/.test(rawLabel);
      const tag = el.tagName.toLowerCase();

      if (type === "radio") {
        if (!name || seenRadioNames.has(name)) continue;
        seenRadioNames.add(name);
        const groupIdx = idx;
        idx += 1;
        const radios = [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`)];
        radios.forEach((radio, i) => radio.setAttribute("data-jsf-idx", `r${groupIdx}-${i}`));
        fields.push({
          kind: "radio-group",
          label,
          required: radios.some((radio) => Boolean(radio.required)),
          // Same zero-size-native-input pattern as the checkbox case below
          // may apply here too (unconfirmed for radios specifically, but
          // it's the one confirmed-live Oracle JET custom-control
          // convention seen so far) — each option carries its own
          // isZeroSizeInput/labelSelector rather than assuming either way.
          options: radios.map((radio, i) => {
            const radioBox = radio.getBoundingClientRect();
            return {
              selector: `[data-jsf-idx="r${groupIdx}-${i}"]`,
              labelSelector: radio.id ? `label[for="${CSS.escape(radio.id)}"]` : null,
              isZeroSizeInput: radioBox.width === 0 && radioBox.height === 0,
              text: brief(radio.closest("label, li, .option") || radio) || radio.value
            };
          }).filter((option) => option.text)
        });
        continue;
      }

      el.setAttribute("data-jsf-idx", String(idx));
      const selector = `[data-jsf-idx="${idx}"]`;
      // The one Oracle JET checkbox confirmed live (the terms-and-conditions
      // box on the email step) had a ZERO-size native input — a real click
      // has to land on its label instead. Recorded here per-field (not
      // assumed globally) since a later step's checkboxes may render
      // differently.
      const box = el.getBoundingClientRect();
      const isZeroSizeInput = type === "checkbox" && box.width === 0 && box.height === 0;
      const labelSelector = el.id ? `label[for="${CSS.escape(el.id)}"]` : null;
      idx += 1;

      if (type === "checkbox") {
        fields.push({ kind: "checkbox", label, required, selector, labelSelector, isZeroSizeInput });
        continue;
      }

      fields.push({
        kind: "field",
        tag,
        label,
        required,
        selector,
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
  const locator = page.locator(field.selector).first();
  if (field.tag === "select") return selectOptionByText(locator, values);

  for (const value of values.filter(Boolean)) {
    const filled = await locator.fill(String(value)).then(() => true).catch(() => false);
    if (filled) return value;
  }
  return null;
}

// A zero-size checkbox/radio input can't be clicked directly (no bounding
// box for CDP to target) — click the far-left edge of its label instead,
// before any embedded link text, via raw CDP dispatch. Confirmed live this
// is what actually toggles the one Oracle JET checkbox seen so far (see
// collectFields' isZeroSizeInput above, computed for both checkboxes and
// radio-group options since the same custom-control convention may apply to
// either); falls back to a normal click for anything that turns out NOT to
// be zero-size.
async function checkOracleControl(page, field) {
  if (!field.isZeroSizeInput) {
    const locator = page.locator(field.selector).first();
    const already = await locator.isChecked().catch(() => null);
    if (already === true) return true;
    return locator.check({ timeout: 5000 }).then(() => true).catch(() => false);
  }

  const labelLocator = field.labelSelector ? page.locator(field.labelSelector).first() : null;
  const box = await labelLocator?.boundingBox().catch(() => null);
  if (!box) return false;

  const client = await page.context().newCDPSession(page);
  const x = box.x + 10;
  const y = box.y + box.height / 2;
  try {
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0, clickCount: 0 });
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await page.waitForTimeout(50);
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    return true;
  } catch {
    return false;
  } finally {
    await client.detach().catch(() => {});
  }
}

async function shouldUseLlm(getLlmFindSettings) {
  const llmSettings = await getLlmFindSettings();
  const usage = await getTodayLlmUsage();
  return usage.totalCalls < llmSettings.maxLlmCallsPerDay;
}

// Captures a field's real available options at the point it's about to be
// flagged for manual review — see greenhouse.js's identical helper for the
// full reasoning. Oracle Fusion's radio-group and select-tag fields already
// carry `.options` from collectFields() — just read, no extra interaction.
function captureFieldOptions(field) {
  if (!Array.isArray(field.options) || field.options.length === 0) return [];
  return field.options.map((option) => option.text).filter(Boolean);
}

async function fillStepFields(page, fields, ctx) {
  const { profile, posting, resumeText, submittedAnswers, manualReviewFields, fieldOptions, llmState, getLlmFindSettings, memoryRows } = ctx;

  function flagForReview(label, field) {
    manualReviewFields.push(label);
    const options = captureFieldOptions(field);
    if (options.length > 0) fieldOptions[label] = options;
  }

  // A similarly-worded question was answered by hand on a DIFFERENT posting
  // before (see the Review Queue's Memory tab / "Answer & Retry" popup) — a
  // human-verified past answer beats manual review, so this is tried as a
  // last resort by EVERY resolution branch below (EEO/work-auth, a
  // matched-but-unfillable standard field, and the free-text fallback), not
  // just one of them — see greenhouse.js's identical helper for why this
  // needs to be its own function reused across branches rather than one
  // inline block the EEO/work-auth/standard-field paths skip straight past
  // on their way to flagForReview. Never attempted for a plain "checkbox"
  // kind, same exclusion the manual-override check above already applies.
  // An exact label match is tried first and, unlike the fuzzy embedding
  // match right after it, is never gated behind the daily LLM-call budget —
  // it costs no LLM call at all.
  async function tryMemoryAnswer(field) {
    if (memoryRows.length === 0 || field.kind === "checkbox") return false;

    const fillMemoryMatch = async (memoryMatch) => {
      if (!memoryMatch) return false;

      if (field.kind === "radio-group") {
        const match = matchOptionByCandidates(field.options, manualOverrideCandidates(memoryMatch.answer));
        if (!match || !(await checkOracleControl(page, match))) return false;
        submittedAnswers[field.label] = match.text;
        await recordMemoryReuse(memoryMatch.id).catch(() => {});
        return true;
      }

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
    const normalizedLabel = normalizeLabel(field.label);

    // A human already answered this exact question for this exact posting
    // (see the Review Queue's "Answer & Retry" popup) — try it before any
    // auto-resolution strategy below. Not attempted for checkbox kind (opt-in
    // consent/marketing controls, not a real question — see that branch's own
    // comment); radio-group reuses the same option-text matching the EEO/
    // work-auth branch below already does, everything else reuses fillField.
    const manualOverride = resolveManualOverride(normalizedLabel, posting.manualReviewFields);
    if (manualOverride != null && field.kind !== "checkbox") {
      if (field.kind === "radio-group") {
        const match = matchOptionByCandidates(field.options, manualOverrideCandidates(manualOverride));
        if (match && await checkOracleControl(page, match)) {
          submittedAnswers[field.label] = match.text;
          continue;
        }
      } else {
        const filledValue = await fillField(page, field, manualOverrideCandidates(manualOverride));
        if (filledValue != null) {
          submittedAnswers[field.label] = filledValue;
          continue;
        }
      }
    }

    if (field.kind === "checkbox") {
      // Marketing/consent checkboxes are opt-in, not a real application
      // question — left unticked rather than guessed at. The terms-and-
      // conditions box itself is handled by the connect script during the
      // one-time auth step, never re-encountered on a later wizard step.
      if (/consent|newsletter|subscribe|marketing/i.test(field.label)) continue;
      if (/terms and conditions|terms of use|privacy policy/i.test(field.label)) {
        const checked = await checkOracleControl(page, field);
        if (checked) submittedAnswers[field.label] = "Agreed";
        else if (field.required) manualReviewFields.push(cleanLabel(field.label));
        continue;
      }
      if (field.required) manualReviewFields.push(cleanLabel(field.label));
      continue;
    }

    if (field.kind === "radio-group") {
      // Tracked so the fallthrough below can flag this regardless of
      // field.required — see greenhouse.js's identical comment on why an
      // EEO/work-auth question needs that regardless of its visible
      // asterisk.
      const isEeoOrWorkAuth = isWorkAuthLabel(normalizedLabel) || isEeoLabel(normalizedLabel);
      const value = isWorkAuthLabel(normalizedLabel)
        ? resolveWorkAuthValue(normalizedLabel, profile?.workAuthorization)
        : isEeoLabel(normalizedLabel)
          ? null
          : null;
      const candidates = isEeoLabel(normalizedLabel)
        ? resolveEeoCandidates(normalizedLabel, profile?.eeoAnswers)
        : [value].filter(Boolean);
      const match = matchOptionByCandidates(field.options, candidates);
      if (match) {
        const checked = await checkOracleControl(page, match);
        if (checked) {
          submittedAnswers[field.label] = match.text;
          continue;
        }
      }
      if (await tryMemoryAnswer(field)) continue;
      if (field.required || isEeoOrWorkAuth) flagForReview(cleanLabel(field.label), field);
      continue;
    }

    const standardCandidates = resolveStandardFieldCandidates(
      normalizedLabel,
      profile,
      [field.label, field.selector, field.kind, field.tag].filter(Boolean).join(" ")
    );
    if (standardCandidates.length > 0) {
      const filledValue = await fillField(page, field, standardCandidates);
      if (filledValue != null) {
        submittedAnswers[field.label] = filledValue;
        continue;
      }
      if (await tryMemoryAnswer(field)) continue;
      if (field.required) flagForReview(field.label, field);
      continue;
    }

    // Flagged for manual review on any failure to fill — not gated behind
    // field.required. See greenhouse.js's identical comment: an EEO/work-
    // auth question routinely carries no visible asterisk (framed as
    // "voluntary") while the ATS's own client-side validation still
    // requires SOME selection before allowing submit.
    if (isWorkAuthLabel(normalizedLabel)) {
      const value = resolveWorkAuthValue(normalizedLabel, profile?.workAuthorization);
      const filledValue = value ? await fillField(page, field, [value]) : null;
      if (filledValue != null) {
        submittedAnswers[field.label] = filledValue;
        continue;
      }
      if (await tryMemoryAnswer(field)) continue;
      flagForReview(field.label, field);
      continue;
    }

    if (isEeoLabel(normalizedLabel)) {
      const filledValue = await fillField(page, field, resolveEeoCandidates(normalizedLabel, profile?.eeoAnswers));
      if (filledValue != null) {
        submittedAnswers[field.label] = filledValue;
        continue;
      }
      if (await tryMemoryAnswer(field)) continue;
      flagForReview(field.label, field);
      continue;
    }

    // A similarly-worded question was answered by hand on a DIFFERENT
    // posting before (see the Review Queue's Memory tab / "Answer & Retry"
    // popup) — a human-verified past answer beats a fresh LLM guess, so this
    // is checked ahead of the candidate-logistics exclusion below (normally
    // always manual) and the free-text/select-choice fallbacks further down.
    if (await tryMemoryAnswer(field)) continue;

    if (isCandidateLogisticsLabel(normalizedLabel)) {
      if (field.required) flagForReview(field.label, field);
      continue;
    }

    if (field.tag === "select") {
      if (looksLikeExperienceDurationQuestion(field.options) && llmState.count < MAX_LLM_ANSWERED_FIELDS && await shouldUseLlm(getLlmFindSettings)) {
        const chosenText = await chooseFromOptions({
          question: field.label,
          options: field.options.map((option) => option.text),
          posting,
          profile,
          resumeText
        }).catch(() => null);
        await incrementLlmUsage("score");
        const filledValue = chosenText ? await fillField(page, field, [chosenText]) : null;
        if (filledValue != null) {
          submittedAnswers[field.label] = filledValue;
          llmState.count += 1;
          continue;
        }
      }
      if (field.required) flagForReview(field.label, field);
      continue;
    }

    if (llmState.count < MAX_LLM_ANSWERED_FIELDS && await shouldUseLlm(getLlmFindSettings)) {
      const answer = await answerFreeText({ question: field.label, posting, profile, resumeText }).catch(() => null);
      await incrementLlmUsage("score");
      if (answer) {
        const filledValue = await fillField(page, field, [answer]);
        if (filledValue != null) {
          submittedAnswers[field.label] = filledValue;
          llmState.count += 1;
          continue;
        }
      }
    }

    if (field.required) flagForReview(field.label, field);
  }
}

async function findPrimaryActionButton(page) {
  const submitBtn = page.getByRole("button", { name: SUBMIT_BUTTON_PATTERN }).first();
  if (await submitBtn.count().catch(() => 0) > 0 && await submitBtn.isVisible().catch(() => false)) {
    return { locator: submitBtn, kind: "submit" };
  }
  const nextBtn = page.getByRole("button", { name: NEXT_BUTTON_PATTERN }).first();
  if (await nextBtn.count().catch(() => 0) > 0 && await nextBtn.isVisible().catch(() => false)) {
    return { locator: nextBtn, kind: "next" };
  }
  return null;
}

// Polls repeatedly instead of deciding off one snapshot (like every other
// adapter here does), since Oracle Fusion's own submit is a slower,
// server-side candidate-application write — see the wizard/poll constants
// above. Once the submit button/step disappears it gives the page one more
// short settle window before treating silence as unconfirmed, rather than
// assuming disappearance alone means success.
async function pollForSubmissionOutcome(page, submitButtonLocator) {
  const deadline = Date.now() + POLL_MAX_MS;
  let lastText = "";

  while (Date.now() < deadline) {
    await page.waitForTimeout(POLL_INTERVAL_MS).catch(() => {});
    lastText = (await page.locator("body").innerText().catch(() => "")).slice(0, 1000);
    if (SUCCESS_TEXT_SIGNALS.test(lastText)) return { result: "success", text: lastText };
    if (ERROR_TEXT_SIGNALS.test(lastText)) return { result: "error", text: lastText };

    const stillOnFormPage = await submitButtonLocator.isVisible().catch(() => false);
    if (!stillOnFormPage) {
      await page.waitForTimeout(POLL_INTERVAL_MS).catch(() => {});
      lastText = (await page.locator("body").innerText().catch(() => "")).slice(0, 1000);
      if (ERROR_TEXT_SIGNALS.test(lastText)) return { result: "error", text: lastText };
      if (SUCCESS_TEXT_SIGNALS.test(lastText)) return { result: "success", text: lastText };
      return { result: "unconfirmed", text: lastText };
    }
  }

  return { result: "timeout", text: lastText };
}

export async function submitOracleFusionApplication({ posting, profile, resumeBuffer, resumeFileName, resumeText = "", dryRun = false, headless = true }) {
  const session = await resolveOracleSession(posting.applyUrl).catch(() => null);
  const { browser, newPage } = await launchJobSearchBrowser({ headless });
  const submittedAnswers = {};
  const manualReviewFields = [];
  // Real available options for a select/radio-group field, keyed by label —
  // see captureFieldOptions()'s own comment near fillStepFields().
  const fieldOptions = {};
  const llmState = { count: 0 };
  let confirmationText = "";
  let status = "failed";
  let errorMessage = "";
  let findSettings = null;
  const getLlmFindSettings = async () => {
    if (!findSettings) findSettings = await getFindSettings();
    return findSettings;
  };

  try {
    const page = await newPage(session ? { storageState: session.storageState } : undefined);
    await page.goto(posting.applyUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(1500);

    const applyBtn = page.getByRole("button", { name: /apply now/i }).first();
    if (await applyBtn.count().catch(() => 0) > 0) {
      await clickWithBrowserMouse(page, applyBtn, { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }

    // A saved session should carry an already-verified identity straight
    // past the email/code screen (confirmed live: that screen only ever
    // appeared before any session existed) — if it's showing anyway, the
    // session is missing or expired. Checked before the shared
    // detectSubmissionBlocker(), whose LOGIN_WALL_SIGNALS doesn't recognize
    // this screen's actual wording (see this file's own NEEDS_VERIFICATION_
    // SIGNALS comment).
    //
    // Deliberately NOT routed through heldChallengeRelay.js like the generic
    // check just below — this is a per-TENANT identity gate that exists
    // before any application-specific session does, not a per-submission
    // challenge on a form that's otherwise ready to fill. This codebase
    // already has the right mechanism for it (scripts/job-search-oracle-
    // connect.mjs, run once per tenant — see this file's own header
    // comment); relaying it live here would mean re-doing that same
    // one-time step on every single submission instead of once per tenant.
    const earlyBodyText = await page.locator("body").innerText().catch(() => "");
    if (NEEDS_VERIFICATION_SIGNALS.test(earlyBodyText)) {
      return blockedResult({
        blockerReason: "This posting's tenant requires a one-time emailed verification code before applying.",
        hasSession: Boolean(session),
        submittedAnswers, manualReviewFields, fieldOptions, confirmationText
      });
    }

    const blockerReason = await detectSubmissionBlocker(page);
    if (blockerReason) {
      if (isHeldChallengeBlockerReason(blockerReason)) {
        const challengeResult = await resolveHeldChallenge({ page, scope: page, posting, submittedAnswers, blockerReason });
        if (!challengeResult.ok) {
          // Not routed through blockedResult() — that helper's guidance is
          // specifically about the Oracle-session/connect-script gate above,
          // which has nothing to do with a held-challenge relay timing out.
          return { status: "blocked", submittedAnswers, manualReviewFields, fieldOptions, confirmationText, errorMessage: challengeResult.errorMessage };
        }
      } else {
        return blockedResult({ blockerReason, hasSession: Boolean(session), submittedAnswers, manualReviewFields, fieldOptions, confirmationText });
      }
    }

    let submitButton = null;
    let resumeAttempted = false;
    // Fetched once for the whole submission (not once per wizard step) — see
    // jobSearchAnswerMemoryStore.js's own comment on why this isn't a
    // per-field query.
    const memoryRows = await listAnswerMemoryForMatching().catch(() => []);

    for (let step = 0; step < MAX_WIZARD_STEPS; step += 1) {
      if (!resumeAttempted) {
        const fileInput = page.locator('input[type="file"]').first();
        if ((await fileInput.count().catch(() => 0)) > 0) {
          resumeAttempted = true;
          if (resumeBuffer) {
            // One-retry safety net against a platform-side upload race — see
            // resumeUploadCheck.js. Kept wrapped in its own catch (matching
            // this call site's original behavior) so a thrown error here
            // flags manual review same as an unconfirmed upload, rather than
            // aborting the whole wizard step.
            const uploaded = await uploadResumeWithRetry(page, page, fileInput, resumeBuffer, resumeFileName).catch(() => false);
            if (uploaded) {
              submittedAnswers["Resume/CV"] = resumeFileName || "resume.pdf";
            } else {
              manualReviewFields.push("Resume/CV upload (could not confirm upload success)");
            }
          } else {
            manualReviewFields.push("Resume/CV upload");
          }
        }
      }

      const fields = await collectFields(page);
      await fillStepFields(page, fields, { profile, posting, resumeText, submittedAnswers, manualReviewFields, fieldOptions, llmState, getLlmFindSettings, memoryRows });

      const action = await findPrimaryActionButton(page);
      if (!action) break;
      if (action.kind === "submit") {
        submitButton = action.locator;
        break;
      }

      await clickWithBrowserMouse(page, action.locator);
      await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(800).catch(() => {});

      const blockerAfterStep = await detectSubmissionBlocker(page);
      if (blockerAfterStep) {
        if (isHeldChallengeBlockerReason(blockerAfterStep)) {
          const challengeResult = await resolveHeldChallenge({ page, scope: page, posting, submittedAnswers, blockerReason: blockerAfterStep });
          if (!challengeResult.ok) {
            return { status: "blocked", submittedAnswers, manualReviewFields, fieldOptions, confirmationText, errorMessage: challengeResult.errorMessage };
          }
        } else {
          return blockedResult({ blockerReason: blockerAfterStep, hasSession: Boolean(session), submittedAnswers, manualReviewFields, fieldOptions, confirmationText });
        }
      }
    }

    if (!submitButton) {
      manualReviewFields.push('Could not find a final "Submit" step in this Oracle Recruiting Cloud wizard — it may use different step labels, or need more than the ' + MAX_WIZARD_STEPS + ' steps this adapter allows for.');
    }

    if (manualReviewFields.length > 0) {
      status = "needs_manual_review";
    } else if (dryRun) {
      status = "dry_run_ok";
    } else {
      await clickWithBrowserMouse(page, submitButton);
      const outcome = await pollForSubmissionOutcome(page, submitButton);
      confirmationText = outcome.text;

      if (outcome.result === "success") {
        status = "submitted";
      } else if (outcome.result === "error") {
        status = "failed";
        errorMessage = "Clicking submit produced an error/validation signal on the page — review the posting manually before assuming this failed outright.";
      } else {
        status = "failed";
        errorMessage = outcome.result === "timeout"
          ? `Clicking submit did not produce a recognized confirmation within ${Math.round(POLL_MAX_MS / 1000)}s of polling — the form may still be processing. Review the posting manually before assuming this was submitted.`
          : "The submit step disappeared but no confirmation or error text was found afterward — review the posting manually before assuming this was submitted.";
      }
    }
  } catch (error) {
    errorMessage = error?.message || String(error);
    status = "failed";
  } finally {
    await browser.close();
  }

  return { status, submittedAnswers, manualReviewFields, fieldOptions, confirmationText, errorMessage };
}
