// Oracle Recruiting Cloud (Fusion) / Taleo — atsType "oracle_taleo" (see
// atsTypes.js's ATS_DOMAIN_PATTERNS; covers both the legacy taleo.net domain
// and the migrated oraclecloud.com one, same as the rest of this codebase
// treats them as one platform).
//
// This adapter is NOT confirmed live against a real tenant (no test tenant
// available) — everything below is written from documented Oracle Redwood/
// JET UI conventions (real <label> elements, WCAG aria-label/aria-labelledby
// fallbacks, a "Next"/"Continue" -> ... -> "Submit" wizard shape) rather than
// a specific site's actual DOM. Treat it as more conservative/unverified
// than greenhouse.js/ashby.js/workable.js/personio.js/breezy.js, and run a
// real dry-run (dryRun: true) against a live posting before trusting it
// unattended. Field collection is deliberately generic (label text -> the
// same profileMapping.js resolvers every other adapter uses) rather than
// hard-coded field names/ids, specifically because those aren't confirmed.
//
// The one real Oracle-specific problem this has to solve: almost every
// tenant requires a signed-in candidate before the apply form renders at
// all (see blockerDetection.js's LOGIN_WALL_SIGNALS) — unlike Greenhouse/
// Ashby/Workable/Personio/Breezy, which are all guest-apply. The fix here is
// deliberately NOT to script a third-party identity provider's own login
// page: Google/Microsoft/LinkedIn all actively challenge automated sign-in
// (MFA prompts, "this browser may not be secure", device verification) the
// exact same way they'd challenge real credential stuffing, regardless of
// whether the credentials are genuinely the account owner's — trying to
// script past that is fragile at best and not something this codebase
// should be teaching a browser to do. Instead, the adapter reuses a
// Playwright `storageState` (Oracle's own post-login session cookies)
// captured from ONE real, human-completed SSO sign-in — see
// scripts/job-search-oracle-login.mjs, which opens a real headed browser,
// lets a human complete whatever sign-in flow (SSO or otherwise) the tenant
// actually presents, and saves the resulting session, then the Job Search
// dashboard (User Settings -> "Oracle Recruiting Cloud sessions") stores it
// in job_search_oracle_sessions, keyed by tenant host — a login on one
// company's Oracle instance grants no access to another's, so this looks up
// whichever saved session matches the current posting's applyUrl host. The
// identity provider only ever sees a normal interactive login, never an
// automated one. If no session is saved for this tenant, or it has expired,
// this adapter falls straight into the same `blocked` status a genuine
// unhandled login wall already produces — never a guessed/typed credential.
import { answerFreeText, chooseFromOptions } from "../jobSearchLlm.js";
import { getOracleSessionForHost } from "../jobSearchOracleSessionStore.js";
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
const FORM_WAIT_TIMEOUT_MS = 20000;
const MAX_LLM_ANSWERED_FIELDS = 15;
// Oracle Fusion's wizard is typically My Information -> Experience ->
// Questionnaire -> Voluntary Disclosures/EEO -> Review, so 8 gives real
// headroom without letting a detection bug spin forever if "Next" is
// somehow always found.
const MAX_WIZARD_STEPS = 8;
// Confirmed-live-elsewhere ATS forms settle in under 10s; Oracle Fusion's
// own submit step is a full server-side candidate-application write (often
// shown behind a "Submitting your application..." interstitial), so this
// polls repeatedly for up to 30s instead of the single-shot
// networkidle+500ms check the other adapters use — see
// pollForSubmissionOutcome below, this is the "polling as fallback" half of
// this adapter.
const POLL_INTERVAL_MS = 1500;
const POLL_MAX_MS = 30000;

const SUCCESS_TEXT_SIGNALS = /(thank you for applying|thanks for applying|application (has been |was )?(successfully )?(submitted|sent)|we('| ha)ve received your application|your application (has been|was) received|your application (has been|was) successfully submitted|candidate profile (has been )?(created|updated))/i;
const ERROR_TEXT_SIGNALS = /(this field is required|please (enter|select|fill)|is required\b|error submitting|something went wrong|invalid|upload failed|failed to upload|session (has )?expired|please sign in)/i;
const NEXT_BUTTON_PATTERN = /^(next|continue|save and continue|next\s*:.*)$/i;
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

// A session captured once by a human via scripts/job-search-oracle-login.mjs
// and uploaded through the dashboard (see this file's header comment) is
// reused across every submission attempt for that tenant — signing in
// fresh, per application, would mean scripting the identity provider's
// login form, which this adapter deliberately never does. Returns null (not
// a throw) for a malformed applyUrl or no saved session — both are handled
// identically to a genuine login wall by the caller.
async function resolveOracleSession(applyUrl) {
  let host;
  try {
    host = new URL(applyUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  return getOracleSessionForHost(host);
}

async function waitForAnyForm(page) {
  await page.locator('form, [role="form"], input, textarea, select').first()
    .waitFor({ state: "visible", timeout: FORM_WAIT_TIMEOUT_MS });
}

async function openApplicationForm(page) {
  try {
    await waitForAnyForm(page);
  } catch {
    // Fall through — detectSubmissionBlocker() below will report the real
    // reason (login wall, CAPTCHA, or a page that never rendered a form).
  }

  const candidates = [
    page.getByRole("link", { name: /^apply( now| for this job)?$/i }).first(),
    page.getByRole("button", { name: /^apply( now| for this job)?$/i }).first()
  ];

  for (const candidate of candidates) {
    if ((await candidate.count().catch(() => 0)) === 0) continue;
    if (!(await candidate.isVisible().catch(() => false))) continue;
    // Already on a page with real form fields (candidate.count() above
    // matched an unrelated "Apply" link elsewhere on the page) — don't
    // navigate away from a form that's already open.
    const alreadyHasFields = await page.locator('input:visible, textarea:visible, select:visible').count().catch(() => 0);
    if (alreadyHasFields > 3) break;

    await clickWithBrowserMouse(page, candidate, { timeout: 5000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1000).catch(() => {});
    break;
  }

  await waitForAnyForm(page).catch(() => {});
}

// Deliberately generic (no hard-coded Oracle field ids/names — see this
// file's header comment for why): every input/textarea/select gets a label
// resolved through the standard accessible-form chain (label[for] ->
// wrapping <label> -> aria-labelledby -> aria-label -> placeholder), and is
// tagged with a throwaway data attribute so the exact same element can be
// re-selected from Playwright afterward regardless of whether it has a
// usable id/name of its own.
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
          options: radios.map((radio, i) => ({
            selector: `[data-jsf-idx="r${groupIdx}-${i}"]`,
            text: brief(radio.closest("label, li, .option") || radio) || radio.value
          })).filter((option) => option.text)
        });
        continue;
      }

      el.setAttribute("data-jsf-idx", String(idx));
      const selector = `[data-jsf-idx="${idx}"]`;
      idx += 1;

      if (type === "checkbox") {
        fields.push({ kind: "checkbox", label, required, selector });
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
  const locator = page.locator(field.selector).first();
  if (field.tag === "select") return selectOptionByText(locator, values);

  for (const value of values.filter(Boolean)) {
    const filled = await locator.fill(String(value)).then(() => true).catch(() => false);
    if (filled) return value;
  }
  return null;
}

async function shouldUseLlm(getLlmFindSettings) {
  const llmSettings = await getLlmFindSettings();
  const usage = await getTodayLlmUsage();
  return usage.totalCalls < llmSettings.maxLlmCallsPerDay;
}

async function fillStepFields(page, fields, ctx) {
  const { profile, posting, resumeText, submittedAnswers, manualReviewFields, llmState, getLlmFindSettings } = ctx;

  for (const field of fields) {
    const normalizedLabel = normalizeLabel(field.label);

    if (field.kind === "checkbox") {
      // Marketing/consent checkboxes ("email me updates", "SMS consent")
      // are opt-in, not a real application question — left unticked rather
      // than guessed at, same posture breezy.js takes for its own smsConsent
      // field.
      if (/consent|newsletter|subscribe|marketing/i.test(field.label)) continue;
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
        const radio = page.locator(match.selector).first();
        const checked = await setCheckedWithBrowserMouse(page, radio, true).then(() => true).catch(() => false);
        if (checked) {
          submittedAnswers[field.label] = match.text;
          continue;
        }
      }
      if (field.required) manualReviewFields.push(cleanLabel(field.label));
      continue;
    }

    const standardCandidates = resolveStandardFieldCandidates(normalizedLabel, profile, field.label);
    if (standardCandidates.length > 0) {
      const filledValue = await fillField(page, field, standardCandidates);
      if (filledValue != null) submittedAnswers[field.label] = filledValue;
      else if (field.required) manualReviewFields.push(field.label);
      continue;
    }

    if (isWorkAuthLabel(normalizedLabel)) {
      const value = resolveWorkAuthValue(normalizedLabel, profile?.workAuthorization);
      const filledValue = value ? await fillField(page, field, [value]) : null;
      if (filledValue != null) submittedAnswers[field.label] = filledValue;
      else if (field.required) manualReviewFields.push(field.label);
      continue;
    }

    if (isEeoLabel(normalizedLabel)) {
      const value = resolveEeoValue(normalizedLabel, profile?.eeoAnswers);
      const filledValue = value ? await fillField(page, field, [value]) : null;
      if (filledValue != null) submittedAnswers[field.label] = filledValue;
      else if (field.required) manualReviewFields.push(field.label);
      continue;
    }

    if (isCandidateLogisticsLabel(normalizedLabel)) {
      if (field.required) manualReviewFields.push(field.label);
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
      if (field.required) manualReviewFields.push(field.label);
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

    if (field.required) manualReviewFields.push(field.label);
  }
}

// blockerDetection.js's login-wall reason is always the exact fixed string
// "Application requires signing in / creating an account first." (see its
// LOGIN_WALL_SIGNALS) — matched here on "signing in"/"creating an account"
// rather than the ATS_DOMAIN_PATTERNS-style "sign in"/"create an account"
// phrasing, which would silently never match that actual string.
function blockedResult({ blockerReason, hasSession, submittedAnswers, manualReviewFields, confirmationText, screenshotBuffer }) {
  const loginRelated = /signing in|creating an account/i.test(blockerReason);
  return {
    status: "blocked",
    submittedAnswers,
    manualReviewFields,
    confirmationText,
    screenshotBuffer,
    errorMessage: !loginRelated
      ? blockerReason
      : hasSession
        ? `${blockerReason} The saved Oracle session for this tenant may have expired — rerun "node scripts/job-search-oracle-login.mjs" and re-upload it in the dashboard (User Settings -> "Oracle Recruiting Cloud sessions").`
        : `${blockerReason} No saved Oracle session found for this tenant — run "node scripts/job-search-oracle-login.mjs" once to sign in manually, then upload the resulting file in the dashboard (User Settings -> "Oracle Recruiting Cloud sessions").`
  };
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

// The "polling as fallback" half of this adapter — see this file's header
// and the MAX_WIZARD_STEPS/POLL_* constants above for why a single-shot
// check (what every other adapter uses) isn't trusted here: Oracle Fusion's
// own submit is a slower, often-interstitial-shown server write. Polls
// repeatedly instead of deciding off one snapshot; once the submit
// button/step disappears it gives the page one more short settle window
// (rather than assuming that alone means success) before treating silence
// as unconfirmed.
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

export async function submitOracleRecruitingApplication({ posting, profile, resumeBuffer, resumeFileName, resumeText = "", dryRun = false, headless = true }) {
  const session = await resolveOracleSession(posting.applyUrl).catch(() => null);
  const { browser, newPage } = await launchJobSearchBrowser({ headless });
  const submittedAnswers = {};
  const manualReviewFields = [];
  const llmState = { count: 0 };
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
    const page = await newPage(session ? { storageState: session.storageState } : undefined);
    await page.goto(posting.applyUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await openApplicationForm(page);

    const blockerReason = await detectSubmissionBlocker(page);
    if (blockerReason) {
      screenshotBuffer = await page.screenshot({ fullPage: true }).catch(() => null);
      return blockedResult({ blockerReason, hasSession: Boolean(session), submittedAnswers, manualReviewFields, confirmationText, screenshotBuffer });
    }

    let submitButton = null;
    let resumeAttempted = false;

    for (let step = 0; step < MAX_WIZARD_STEPS; step += 1) {
      if (!resumeAttempted) {
        const fileInput = page.locator('input[type="file"]').first();
        if ((await fileInput.count().catch(() => 0)) > 0) {
          resumeAttempted = true;
          if (resumeBuffer) {
            const uploaded = await fileInput.setInputFiles(resumeFilePayload(resumeBuffer, resumeFileName)).then(() => true).catch(() => false);
            if (uploaded && !(await resumeUploadLikelyFailed(page))) {
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
      await fillStepFields(page, fields, { profile, posting, resumeText, submittedAnswers, manualReviewFields, llmState, getLlmFindSettings });

      const action = await findPrimaryActionButton(page);
      if (!action) break;
      if (action.kind === "submit") {
        submitButton = action.locator;
        break;
      }

      await clickWithBrowserMouse(page, action.locator);
      await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(800).catch(() => {});

      // A "Next" click can itself land on a step gated behind a fresh login
      // wall (session-timeout mid-wizard) or surface a CAPTCHA that wasn't
      // present on step 1 — re-check every step, not just the first.
      const blockerAfterStep = await detectSubmissionBlocker(page);
      if (blockerAfterStep) {
        screenshotBuffer = await page.screenshot({ fullPage: true }).catch(() => null);
        return blockedResult({ blockerReason: blockerAfterStep, hasSession: Boolean(session), submittedAnswers, manualReviewFields, confirmationText, screenshotBuffer });
      }
    }

    if (!submitButton) {
      manualReviewFields.push('Could not find a final "Submit" step in this Oracle Recruiting Cloud wizard — it may use different step labels, or need more than the ' + MAX_WIZARD_STEPS + ' steps this adapter allows for.');
    }

    screenshotBuffer = await page.screenshot({ fullPage: true }).catch(() => null);

    if (manualReviewFields.length > 0) {
      status = "needs_manual_review";
    } else if (dryRun) {
      status = "dry_run_ok";
    } else {
      await clickWithBrowserMouse(page, submitButton);
      const outcome = await pollForSubmissionOutcome(page, submitButton);
      confirmationText = outcome.text;
      screenshotBuffer = await page.screenshot({ fullPage: true }).catch(() => screenshotBuffer);

      if (outcome.result === "success") {
        status = "submitted";
      } else if (outcome.result === "error") {
        status = "failed";
        errorMessage = "Clicking submit produced an error/validation signal on the page — check the screenshot before assuming this failed outright.";
      } else {
        status = "failed";
        errorMessage = outcome.result === "timeout"
          ? `Clicking submit did not produce a recognized confirmation within ${Math.round(POLL_MAX_MS / 1000)}s of polling — the form may still be processing. Check the screenshot before assuming this was submitted.`
          : "The submit step disappeared but no confirmation or error text was found afterward — check the screenshot before assuming this was submitted.";
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
