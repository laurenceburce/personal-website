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
  normalizeLabel,
  resolveEeoCandidates,
  resolveManualOverride,
  resolveStandardFieldCandidates,
  resolveWorkAuthValue
} from "./profileMapping.js";
import { resumeFilePayload } from "./resumeFilePayload.js";

const NAV_TIMEOUT_MS = 30000;
const FORM_WAIT_TIMEOUT_MS = 15000;
const SUBMIT_OUTCOME_TIMEOUT_MS = 45000;
// Greenhouse renders some fields conditionally — confirmed live on GitLab's
// own EEO block: "Please identify your race" only enters the DOM AFTER "Are
// you Hispanic/Latino?" gets an answer. A single collectLabeledFields() scan
// up front misses anything that only appears as a side effect of an earlier
// answer, so the field loop below re-scans after each full pass and picks up
// whatever's newly there. Capped rather than looped until stable, so a form
// that (for whatever reason) never stops revealing "new" fields can't hang
// the adapter forever — every Greenhouse EEO cascade observed so far is one
// level deep, so this is generous headroom, not a tuned minimum.
const MAX_FIELD_DISCOVERY_PASSES = 5;
// Gives Greenhouse's own JS a moment to actually render a field it revealed
// as a side effect of the answer just filled in, before re-scanning for it —
// scanning immediately risks missing a field that's still mid-render.
const FIELD_DISCOVERY_SETTLE_MS = 400;
// Raised from 5 after an audit pass: daily LLM usage sits at ~120 calls
// against a 5000/day cap (jobSearchUsageStore.js), so 5 was an arbitrary
// early-caution number, not a cost/rate-limit necessity — and a form with
// more than 5 genuinely-answerable custom questions (confirmed live: a real
// Codurance/Workable posting had exactly 5) was hitting this ceiling and
// deferring the rest to manual review for no reason beyond the count.
const MAX_LLM_ANSWERED_FIELDS = 15;

// Confirmed against Greenhouse's own confirmation-page/inline-validation
// copy. Deliberately conservative — an unmatched confirmation page falls
// through to "still on the form" below rather than being guessed as success.
const SUCCESS_TEXT_SIGNALS = /(thank you for applying|application (has been |was )?(successfully )?submitted|we('| ha)ve received your application|your application (has been|was) received)/i;
const ERROR_TEXT_SIGNALS = /(this field is required|please (enter|select|fill)|required field|error submitting|something went wrong)/i;

// Real Greenhouse forms are embedded two ways: inline on boards.greenhouse.io /
// job-boards.greenhouse.io, or via <iframe src="...greenhouse.io/embed/job_app...">
// on a company's own branded careers domain (confirmed live against Asana's
// board). CareerPuck-backed postings add a third wrinkle: the page redirects
// away from Greenhouse first, then mounts the Greenhouse iframe a few seconds
// later. Deciding "page scope" immediately after domcontentloaded races that
// mount and leaves the worker waiting on top-level labels that will never
// exist, so this helper waits for a scope that actually contains fields.
async function findFormScope(page) {
  const deadline = Date.now() + FORM_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (await page.locator("label[for]").first().isVisible().catch(() => false)) return page;

    for (const frame of page.frames()) {
      if (frame === page.mainFrame() || !/greenhouse/i.test(frame.url())) continue;
      if (await frame.locator("label[for]").first().isVisible().catch(() => false)) return frame;
    }

    const blockerReason = await detectGreenhouseBlocker(page, page).catch(() => null);
    if (blockerReason) return page;

    await page.waitForTimeout(250);
  }

  throw new Error(`Greenhouse application form did not render within ${FORM_WAIT_TIMEOUT_MS}ms: no visible label[for] found in the page or Greenhouse iframe.`);
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
async function fillReactSelect(page, scope, input, value, debugLabel = null) {
  await clickWithBrowserMouse(page, input);
  await input.fill(String(value));

  const options = scope.locator(".select__option");
  try {
    await options.first().waitFor({ state: "visible", timeout: 3000 });
  } catch {
    await input.press("Escape").catch(() => {});
    if (debugLabel) console.log(`  [fill-debug] react-select "${debugLabel}": no options appeared for "${value}"`);
    return false;
  }

  // Only accept an exact (case-insensitive) match — never click the first
  // fuzzy suggestion for a field we were asked to fill precisely. Confirmed
  // live as a real miss, not theoretical: a "Country*" field built on
  // Greenhouse's own phone-style country-picker component renders its
  // options as "United States +1", not bare "United States" — a plain exact
  // match against every candidate ("United States", "USA", "US", ...) never
  // matched ANY of them, sending a resolvable field to manual review every
  // time. Stripping a trailing " +<digits>" (the calling code) before
  // re-checking catches that shape specifically — it does NOT loosen this
  // into a substring/fuzzy match (still rejects "United States Minor
  // Outlying Islands" for a "United States" candidate), it only strips one
  // specific, known suffix pattern.
  const target = String(value).trim().toLowerCase();
  const texts = await options.allInnerTexts().catch(() => []);
  const stripTrailingCallingCode = (t) => t.replace(/\s*\+\d+\s*$/, "").trim().toLowerCase();
  let exactIndex = texts.findIndex((t) => t.trim().toLowerCase() === target);
  if (exactIndex < 0) exactIndex = texts.findIndex((t) => stripTrailingCallingCode(t) === target);
  if (exactIndex < 0) {
    await input.press("Escape").catch(() => {});
    if (debugLabel) console.log(`  [fill-debug] react-select "${debugLabel}": no option matched "${value}" — saw: ${JSON.stringify(texts)}`);
    return false;
  }

  await clickWithBrowserMouse(page, options.nth(exactIndex));
  return true;
}

// Captures a select/react-select field's real available options at the
// point it's about to be flagged for manual review — only ever called
// there (never proactively for every field), so it adds no overhead to a
// field that resolves fine. Lets the Review Queue's "Answer & Retry" popup
// render an actual dropdown of real option text instead of a free-text box
// a typed answer might not exactly match — confirmed live this was exactly
// the gap: a saved answer of "None" silently matched nothing against a
// field whose only real options were "Yes"/"No", with no indication in the
// popup that it was even a dropdown.
async function captureFieldOptions(page, scope, locator, widget) {
  if (widget === "native-select") {
    const texts = await locator.locator("option").allInnerTexts().catch(() => []);
    return texts.map((t) => t.trim()).filter(Boolean);
  }
  if (widget === "react-select") {
    await clickWithBrowserMouse(page, locator).catch(() => {});
    const options = scope.locator(".select__option");
    try {
      await options.first().waitFor({ state: "visible", timeout: 2000 });
      const texts = await options.allInnerTexts();
      await locator.press("Escape").catch(() => {});
      return texts.map((t) => t.trim()).filter(Boolean);
    } catch {
      await locator.press("Escape").catch(() => {});
      return [];
    }
  }
  return [];
}

// `debugLabel`, when passed, logs exactly why a fill attempt failed —
// confirmed live this was needed: a field can look identical (same widget,
// same real "No" option, right next to others that filled fine) and still
// silently fail with nothing in the stored result to say why. Only ever
// passed by the manual-override/memory-match call sites below (the ones
// actually being debugged) — every other caller stays silent, matching
// this function's original behavior.
async function fillByWidget(page, scope, locator, widget, value, debugLabel = null) {
  switch (widget) {
    case "text":
    case "textarea":
      await locator.fill(String(value));
      return true;
    case "checkbox":
      await setCheckedWithBrowserMouse(page, locator, Boolean(value));
      return true;
    case "native-select":
      try {
        await locator.selectOption({ label: String(value) });
        return true;
      } catch (error) {
        if (debugLabel) {
          const optionTexts = await locator.locator("option").allInnerTexts().catch(() => []);
          console.log(`  [fill-debug] native-select "${debugLabel}": "${value}" didn't match — options: ${JSON.stringify(optionTexts)} (${error?.message || error})`);
        }
        return false;
      }
    case "react-select":
      return fillReactSelect(page, scope, locator, value, debugLabel);
    default:
      if (debugLabel) console.log(`  [fill-debug] "${debugLabel}": widget "${widget}" has no fill path here`);
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
    // Attribute selector rather than `#id` — this code runs in the Node/Playwright
    // context, not the browser, so the DOM's CSS.escape() isn't available here,
    // and an attribute-value selector sidesteps CSS id-escaping entirely.
    const locator = scope.locator(`[id="${forId.replace(/"/g, '\\"')}"]`);
    if (await locator.count().catch(() => 0) === 0) continue;
    const required = text.includes("*")
      || await locator.evaluate((el) => Boolean(el.required || el.getAttribute("aria-required") === "true")).catch(() => false);

    fields.push({ label: text, normalizedLabel: normalizeLabel(text), locator, forId, required });
  }

  return fields;
}

// resumeUploadCheck.js's shared check (scan the page for error TEXT) turned
// out to have a real blind spot specific to this widget, found only by
// repeatedly reproducing it live against a real posting: Greenhouse's own
// upload handler sometimes never issues the actual upload request at all —
// no thrown error, no rendered error text, no DOM change whatsoever, just
// silence (confirmed by polling the widget's DOM for 12s with zero change,
// and separately confirming zero requests to its S3 bucket in the network
// log for the SAME setInputFiles() call that, on other attempts, produced a
// real upload). There is no text to pattern-match against a failure like
// that. What IS reliably present on an actual success, and reliably absent
// on every failure mode seen here (that silent one AND a separately-
// reproduced "Cannot read properties of undefined (reading 'uploadFile')"
// crash) is the upload request itself — Greenhouse's own widget always does
// GET presigned_fields then POST the file straight to its S3 bucket — so
// that's checked directly instead of guessing from the DOM.
const RESUME_UPLOAD_READY_TIMEOUT_MS = 15000;
const RESUME_FILE_INPUT_TIMEOUT_MS = 10000;
const RESUME_UPLOAD_REQUEST_TIMEOUT_MS = 8000;
const RESUME_UPLOAD_CONFIRM_TIMEOUT_MS = 5000;

function compactErrorMessage(error) {
  return String(error?.message || error || "unknown error").replace(/\s+/g, " ").slice(0, 240);
}

function waitForResumeUploadReady(page) {
  return page.waitForResponse(
    (res) => res.request().method() === "GET"
      && /\/uncacheable_attributes\/presigned_fields(?:\?|$)/i.test(res.url())
      && res.ok(),
    { timeout: RESUME_UPLOAD_READY_TIMEOUT_MS }
  ).then(() => true).catch(() => false);
}

async function waitForResumeUploadConfirmation(page, scope, fileName) {
  const target = String(fileName || "").trim();
  if (!target) return false;
  const deadline = Date.now() + RESUME_UPLOAD_CONFIRM_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const text = await scope.locator("body").innerText().catch(() => "");
    if (text.includes(target)) return true;
    await page.waitForTimeout(250);
  }

  return false;
}

async function attemptResumeUpload(page, scope, fileInput, payload) {
  // Set up the wait BEFORE the triggering action — Playwright only sees
  // requests that happen after waitForResponse() is called, so creating the
  // promise first (not awaiting it until after setInputFiles) is what
  // avoids missing a very fast request.
  const uploadOk = page.waitForResponse(
    (res) => res.request().method() === "POST" && /amazonaws\.com/i.test(res.url()),
    { timeout: RESUME_UPLOAD_REQUEST_TIMEOUT_MS }
  ).then((res) => res.ok()).catch(() => false);

  try {
    await fileInput.setInputFiles(payload, { timeout: RESUME_FILE_INPUT_TIMEOUT_MS });
  } catch (error) {
    return { ok: false, reason: `setInputFiles failed: ${compactErrorMessage(error)}` };
  }

  if (!(await uploadOk)) {
    return { ok: false, reason: `no successful upload request seen within ${RESUME_UPLOAD_REQUEST_TIMEOUT_MS}ms` };
  }

  if (!(await waitForResumeUploadConfirmation(page, scope, payload.name))) {
    return { ok: false, reason: `upload request succeeded, but "${payload.name}" never appeared in the resume widget` };
  }

  return { ok: true };
}

async function clearResumeFileInput(page, fileInput) {
  await fileInput.setInputFiles([], { timeout: RESUME_FILE_INPUT_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(250);
}

async function uploadResumeFile(page, scope, resumeBuffer, resumeFileName, resumeUploadReady) {
  const fileInput = scope.locator('#resume, input[type="file"][accept*=".pdf"], input[type="file"]').first();
  const hasFileInput = await fileInput.waitFor({ state: "attached", timeout: RESUME_FILE_INPUT_TIMEOUT_MS }).then(() => true).catch(() => false);
  if (!hasFileInput) {
    return { ok: false, reason: "resume file input was not found" };
  }

  const uploadReady = resumeUploadReady ? await resumeUploadReady : false;
  if (!uploadReady) {
    console.log(`  [fill-debug] resume upload: Greenhouse presigned-fields setup was not observed within ${RESUME_UPLOAD_READY_TIMEOUT_MS}ms — attempting upload anyway`);
  }

  const payload = resumeFilePayload(resumeBuffer, resumeFileName);
  const firstAttempt = await attemptResumeUpload(page, scope, fileInput, payload);
  if (firstAttempt.ok) return { ok: true };

  console.log(`  [fill-debug] resume upload: ${firstAttempt.reason} — retrying setInputFiles once`);
  await clearResumeFileInput(page, fileInput);
  const secondAttempt = await attemptResumeUpload(page, scope, fileInput, payload);
  if (secondAttempt.ok) return { ok: true };

  console.log(`  [fill-debug] resume upload: retry also failed (${secondAttempt.reason}) — giving up, flagging for manual review`);
  return { ok: false, reason: secondAttempt.reason };
}

// Consent-style checkboxes (e.g. "I consent to collecting demographic data for
// EEO purposes") aren't a discrete answer — they gate submitting the EEO
// answers at all. Checked only when the profile actually has EEO data to
// submit; otherwise left alone and flagged for manual review like anything else.
function isEeoConsentCheckboxLabel(label) {
  return /consent/.test(label) && /(demographic|eeo|equal employment)/.test(label);
}

async function readSubmissionText(page, scope) {
  const scopeText = await scope.locator("body").innerText().catch(() => "");
  if (scope === page) return scopeText;

  const pageText = await page.locator("body").innerText().catch(() => "");
  return [scopeText, pageText].filter(Boolean).join("\n");
}

function submissionTextExcerpt(text) {
  const source = String(text || "");
  const signalIndexes = [source.search(SUCCESS_TEXT_SIGNALS), source.search(ERROR_TEXT_SIGNALS)].filter((index) => index >= 0);
  const start = signalIndexes.length > 0 ? Math.max(0, Math.min(...signalIndexes) - 160) : 0;
  return source.slice(start, start + 500);
}

async function isSubmitButtonBusy(submitButton) {
  return submitButton.evaluate((el) => {
    const text = `${el.innerText || ""} ${el.value || ""}`.trim();
    return Boolean(
      el.disabled
        || el.getAttribute("aria-disabled") === "true"
        || el.getAttribute("aria-busy") === "true"
        || /submitting|loading/i.test(text)
        || el.querySelector('[role="progressbar"], [class*="spinner" i], [class*="loading" i], [aria-label*="loading" i]')
    );
  }).catch(() => false);
}

async function waitForSubmitOutcome(page, scope, submitButton) {
  const startedAt = Date.now();
  const deadline = startedAt + SUBMIT_OUTCOME_TIMEOUT_MS;
  let lastText = await readSubmissionText(page, scope);
  let sawBusyState = false;
  let lastValidationCheckAt = 0;

  while (Date.now() < deadline) {
    if (SUCCESS_TEXT_SIGNALS.test(lastText)) return { state: "success", text: lastText };

    const blockerReason = await detectGreenhouseBlocker(page, scope).catch(() => null);
    if (blockerReason) return { state: "blocker", text: lastText, blockerReason };

    if (ERROR_TEXT_SIGNALS.test(lastText)) return { state: "validation", text: lastText };
    if (Date.now() - lastValidationCheckAt > 1000) {
      lastValidationCheckAt = Date.now();
      const invalidFields = await collectPostSubmitValidationFields(scope).catch(() => []);
      if (invalidFields.length > 0) return { state: "validation", text: lastText };
    }

    const stillOnFormPage = await submitButton.isVisible().catch(() => false);
    if (!stillOnFormPage) return { state: "changed", text: lastText };

    const busy = await isSubmitButtonBusy(submitButton);
    if (busy) {
      sawBusyState = true;
    } else if (sawBusyState) {
      sawBusyState = false;
    }

    await page.waitForTimeout(500);
    lastText = await readSubmissionText(page, scope);
  }

  return { state: "timeout", text: lastText };
}

async function collectPostSubmitValidationFields(scope) {
  const fields = await collectLabeledFields(scope).catch(() => []);
  const invalidFields = [];

  for (const field of fields) {
    const widget = await classifyWidget(field.locator).catch(() => "");
    const invalid = await field.locator.evaluate((el) => {
      const ariaInvalid = el.getAttribute("aria-invalid") === "true";
      const nativeInvalid = Boolean(el.willValidate && el.validity && !el.validity.valid);
      return ariaInvalid || nativeInvalid;
    }).catch(() => false);

    if (invalid) invalidFields.push({ ...field, widget });
  }

  return invalidFields;
}

async function detectGreenhouseBlocker(page, scope) {
  const scopes = [];
  const addScope = (candidate) => {
    if (candidate && !scopes.includes(candidate)) scopes.push(candidate);
  };

  addScope(scope);
  addScope(page);
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    addScope(frame);
  }

  for (const candidateScope of scopes) {
    const reason = await detectSubmissionBlocker(candidateScope).catch(() => null);
    if (reason) return reason;
  }

  return null;
}

export async function submitGreenhouseApplication({ posting, profile, resumeBuffer, resumeFileName, resumeText = "", dryRun = false, headless = true }) {
  const { browser, newPage } = await launchJobSearchBrowser({ headless });
  const submittedAnswers = {};
  const manualReviewFields = [];
  // Real available options for a select/react-select field, keyed by label
  // — see captureFieldOptions()'s own comment. Populated by flagForReview()
  // below, once page/scope exist.
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

  try {
    const page = await newPage();
    const resumeUploadReady = waitForResumeUploadReady(page);
    await page.goto(posting.applyUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });

    let scope = await findFormScope(page);
    let blockerReason = await detectGreenhouseBlocker(page, scope);
    let blockerResolutionCount = 0;
    while (blockerReason && blockerResolutionCount < 2) {
      if (isHeldChallengeBlockerReason(blockerReason)) {
        const challengeResult = await resolveHeldChallenge({ page, scope, posting, submittedAnswers, blockerReason });
        if (!challengeResult.ok) {
          return {
            status: "blocked",
            submittedAnswers,
            manualReviewFields,
            fieldOptions,
            confirmationText,
            errorMessage: challengeResult.errorMessage
          };
        }
        blockerResolutionCount += 1;
        scope = await findFormScope(page);
        blockerReason = await detectGreenhouseBlocker(page, scope);
      } else {
        return { status: "blocked", submittedAnswers, manualReviewFields, fieldOptions, confirmationText, errorMessage: blockerReason };
      }
    }
    if (blockerReason) {
      return { status: "blocked", submittedAnswers, manualReviewFields, fieldOptions, confirmationText, errorMessage: blockerReason };
    }

    if (resumeBuffer) {
      const uploadResult = await uploadResumeFile(page, scope, resumeBuffer, resumeFileName, resumeUploadReady);
      if (uploadResult.ok) submittedAnswers["Resume/CV"] = resumeFileName || "resume.pdf";
      else manualReviewFields.push(`Resume upload (${uploadResult.reason})`);
    } else if (await scope.locator('#resume, input[type="file"][accept*=".pdf"], input[type="file"]').first().count().catch(() => 0) > 0) {
      manualReviewFields.push("Resume upload (no default resume available)");
    }

    let fields = await collectLabeledFields(scope);
    // Every field[for] id already processed in an earlier discovery pass —
    // see MAX_FIELD_DISCOVERY_PASSES above. A re-scan reruns
    // collectLabeledFields() over the WHOLE form again (cheap; it's just
    // label[for] pairs), so this is what keeps a pass from redoing work on
    // fields that already resolved (or were already flagged) in a prior one.
    const processedForIds = new Set();
    // Fetched once, reused for every field below — see
    // jobSearchAnswerMemoryStore.js's own comment on why this isn't a
    // per-field query.
    const memoryRows = await listAnswerMemoryForMatching().catch(() => []);

    async function flagForReview(label, locator, widget, optionScope = scope) {
      if (!manualReviewFields.some((existing) => normalizeLabel(existing) === normalizeLabel(label))) {
        manualReviewFields.push(label);
      }
      const options = await captureFieldOptions(page, optionScope, locator, widget).catch(() => []);
      if (options.length > 0) fieldOptions[label] = options;
    }

    async function tryMemoryAnswer(field, widget) {
      if (memoryRows.length === 0) return false;

      const fillMemoryMatch = async (memoryMatch) => {
        if (!memoryMatch) return false;

        for (const candidate of manualOverrideCandidates(memoryMatch.answer)) {
          if (await fillByWidget(page, scope, field.locator, widget, candidate, field.label)) {
            submittedAnswers[field.label] = candidate;
            await recordMemoryReuse(memoryMatch.id).catch(() => {});
            return true;
          }
        }

        return false;
      };

      const exactMemoryMatch = findExactMemoryMatch(field.label, posting.companyName, memoryRows);
      if (await fillMemoryMatch(exactMemoryMatch)) return true;

      const llmSettings = await getLlmFindSettings();
      const usage = await getTodayLlmUsage();
      if (usage.totalCalls >= llmSettings.maxLlmCallsPerDay) return false;

      const memoryMatch = await findBestMemoryMatch(
        field.label,
        posting.companyName,
        memoryRows,
        { includeExact: !exactMemoryMatch }
      ).catch(() => null);
      return fillMemoryMatch(memoryMatch);
    }

    let discoveryPass = 0;
    while (fields.length > 0 && discoveryPass < MAX_FIELD_DISCOVERY_PASSES) {
      discoveryPass += 1;
      for (const field of fields) {
        processedForIds.add(field.forId);
        const widget = await classifyWidget(field.locator);
        if (widget === "file") continue; // resume/cover-letter handled separately

        // A human already answered this exact question for this exact posting
        // (see the Review Queue's "Answer & Retry" popup) — try it before any
        // auto-resolution strategy below. Falls through to those on failure
        // (e.g. the form's widget shape changed since the answer was saved),
        // rather than giving up on the field outright.
        const manualOverride = resolveManualOverride(field.normalizedLabel, posting.manualReviewFields);
        if (manualOverride != null) {
          let overrideFilled = null;
          for (const candidate of manualOverrideCandidates(manualOverride)) {
            if (await fillByWidget(page, scope, field.locator, widget, candidate, field.label)) {
              overrideFilled = candidate;
              break;
            }
          }
          if (overrideFilled != null) {
            submittedAnswers[field.label] = overrideFilled;
            continue;
          }
        }

        if (widget === "checkbox" && isEeoConsentCheckboxLabel(field.normalizedLabel)) {
          const hasEeoData = Object.values(profile.eeoAnswers || {}).some(Boolean);
          if (hasEeoData) {
            await fillByWidget(page, scope, field.locator, widget, true);
            submittedAnswers[field.label] = true;
          } else if (field.required) {
            manualReviewFields.push(field.label);
          }
          continue;
        }

        // EEO/work-authorization: hard-mapped by stored profile facts, never the LLM.
        //
        // Flagged for manual review on any failure to fill — NOT gated behind
        // field.required. Confirmed live this was a real gap: a "Are you
        // Hispanic/Latino?" EEO field carried no visible asterisk (EEO
        // questions are routinely framed as "voluntary"), so when
        // the old single-value EEO resolver returned the profile's raceEthnicity value (right
        // category, wrong shape — this specific field is yes/no, not a race
        // picklist) and the fill predictably failed, the old `else if
        // (field.required)` left it silently blank. Greenhouse's own
        // client-side validation still required SOME selection there before
        // allowing submit, so the posting fell all the way through to
        // "Failed: clicking submit did not produce a recognized confirmation"
        // — a real submission ATTEMPT with no clear reason, instead of a
        // needs_manual_review outcome naming the actual field. Worst case for
        // flagging a genuinely-optional field here is one unnecessary manual
        // review; worst case for not flagging it is exactly what happened.
        if (isEeoLabel(field.normalizedLabel)) {
          let filledValue = null;
          for (const candidate of resolveEeoCandidates(field.normalizedLabel, profile?.eeoAnswers)) {
            if (await fillByWidget(page, scope, field.locator, widget, candidate)) {
              filledValue = candidate;
              break;
            }
          }
          if (filledValue != null) {
            submittedAnswers[field.label] = filledValue;
            continue;
          }
          if (await tryMemoryAnswer(field, widget)) continue;
          await flagForReview(field.label, field.locator, widget);
          continue;
        }

        if (isWorkAuthLabel(field.normalizedLabel)) {
          const value = resolveWorkAuthValue(field.normalizedLabel, profile.workAuthorization);
          if (value && await fillByWidget(page, scope, field.locator, widget, value)) {
            submittedAnswers[field.label] = value;
            continue;
          }
          if (await tryMemoryAnswer(field, widget)) continue;
          await flagForReview(field.label, field.locator, widget);
          continue;
        }

        // Known profile field (name/email/phone/links/etc). Some fields have
        // more than one acceptable value (country name spelled out vs.
        // abbreviated, phone with/without its country code) —
        // resolveStandardFieldCandidates() returns them in priority order;
        // fillByWidget() already dispatches correctly per widget type, so
        // retrying candidates here is what actually lets a select succeed
        // instead of landing in manual review over a spelling mismatch.
        const standardCandidates = resolveStandardFieldCandidates(field.normalizedLabel, profile, field.label);
        if (standardCandidates.length > 0) {
          let filledValue = null;
          for (const candidate of standardCandidates) {
            if (await fillByWidget(page, scope, field.locator, widget, candidate)) {
              filledValue = candidate;
              break;
            }
          }
          if (filledValue != null) {
            submittedAnswers[field.label] = filledValue;
            continue;
          }
          if (await tryMemoryAnswer(field, widget)) continue;
          if (field.required) {
            await flagForReview(field.label, field.locator, widget);
          }
          continue;
        }

        // A similarly-worded question was answered by hand on a DIFFERENT
        // posting before (see the Review Queue's Memory tab / "Answer & Retry"
        // popup) — a human-verified past answer beats a fresh LLM guess, so
        // this is checked before the free-text fallback below, for any widget
        // type (not just text), reusing the exact same daily LLM-call budget
        // check the free-text branch already does right after this.
        if (await tryMemoryAnswer(field, widget)) continue;

        // Novel free-text question — LLM-assisted, capped, and only for plain
        // text/textarea widgets. Never used for a combobox/select/checkbox,
        // since guessing a value into a fixed option set risks submitting
        // something the model invented that doesn't match any real option.
        // Also metered against the same daily budget as scoring/embedding —
        // checked fresh per field (not cached across the loop) so it can't
        // overshoot the cap by more than one in-flight call, matching the same
        // pattern jobSearchScoringPipeline.scorePosting() uses.
        if ((widget === "text" || widget === "textarea") && llmAnsweredCount < MAX_LLM_ANSWERED_FIELDS) {
          const llmSettings = await getLlmFindSettings();
          const usage = await getTodayLlmUsage();
          if (usage.totalCalls >= llmSettings.maxLlmCallsPerDay) {
            manualReviewFields.push(field.label);
            continue;
          }

          const answer = await answerFreeText({ question: field.label, posting, profile, resumeText }).catch(() => null);
          await incrementLlmUsage("score");
          if (answer) {
            await field.locator.fill(answer);
            submittedAnswers[field.label] = answer;
            llmAnsweredCount += 1;
            continue;
          }
        }

        if (field.required) {
          await flagForReview(field.label, field.locator, widget);
          // Diagnostic for exactly the case that motivated this: a field that
          // stays stuck in manual review across repeated Answer & Retry
          // attempts despite a real answer being typed each time. If there WAS
          // a saved override, the "no options appeared"/"no option matched"
          // logs above already say why the fill itself failed; if there
          // wasn't one at all, this shows whether the label simply never
          // matched what's stored (see profileMapping.js's
          // resolveManualOverride) rather than guessing blind again.
          if (manualOverride != null) {
            console.log(`  [fill-debug] "${field.label}" still unresolved despite a saved override ("${manualOverride}") — see the fill-debug line above for why the fill itself failed.`);
          } else if ((posting.manualReviewFields || []).length > 0) {
            console.log(`  [fill-debug] "${field.label}" (normalized: "${field.normalizedLabel}") had no saved override match — saved labels were: ${JSON.stringify((posting.manualReviewFields || []).map((f) => f.label))}`);
          }
        }
      }

      // Re-scan for anything that just entered the DOM as a side effect of
      // a fill above (e.g. the EEO race question after Hispanic/Latino) —
      // see MAX_FIELD_DISCOVERY_PASSES's own comment.
      await page.waitForTimeout(FIELD_DISCOVERY_SETTLE_MS);
      const allFields = await collectLabeledFields(scope);
      fields = allFields.filter((f) => !processedForIds.has(f.forId));
      if (fields.length > 0) {
        console.log(`  [fill-debug] discovery pass ${discoveryPass}: ${fields.length} new field(s) appeared — ${JSON.stringify(fields.map((f) => f.label))}`);
      }
    }

    if (manualReviewFields.length > 0) {
      status = "needs_manual_review";
    } else if (dryRun) {
      status = "dry_run_ok";
    } else {
      let outcomeScope = scope;
      let submitButton = scope.locator('button[type="submit"], input[type="submit"]').first();
      await clickWithBrowserMouse(page, submitButton);

      // Greenhouse can leave the submit button in a loading state well after
      // networkidle would time out (confirmed live by a failed GitLab attempt),
      // so wait on page/form state instead of a fixed short delay.
      let submitOutcome = await waitForSubmitOutcome(page, outcomeScope, submitButton);
      confirmationText = submissionTextExcerpt(submitOutcome.text);

      let postSubmitBlockerReason = submitOutcome.blockerReason || await detectGreenhouseBlocker(page, outcomeScope);
      if (isHeldChallengeBlockerReason(postSubmitBlockerReason)) {
        const challengeResult = await resolveHeldChallenge({ page, scope: outcomeScope, posting, submittedAnswers, blockerReason: postSubmitBlockerReason });
        if (challengeResult.ok) {
          // outcomeScope/submitButton stay the same locators — Playwright
          // locators re-query live, so this correctly reflects wherever the
          // page ended up (still on the form, moved on to a confirmation
          // page, or — for a live CAPTCHA solve — wherever the account
          // owner's own clicks during the relay left it).
          submitOutcome = await waitForSubmitOutcome(page, outcomeScope, submitButton);
          confirmationText = submissionTextExcerpt(submitOutcome.text);
          postSubmitBlockerReason = submitOutcome.blockerReason || await detectGreenhouseBlocker(page, outcomeScope);
          if (isHeldChallengeBlockerReason(postSubmitBlockerReason)) {
            status = "blocked";
            errorMessage = "A held challenge was resolved, but the form is still asking for one. Check the answer and retry.";
          }
        } else {
          status = "blocked";
          errorMessage = challengeResult.errorMessage;
        }
      }

      const stillOnFormPage = await submitButton.isVisible().catch(() => false);
      const hasErrorSignal = ERROR_TEXT_SIGNALS.test(submitOutcome.text || "");
      const hasSuccessSignal = SUCCESS_TEXT_SIGNALS.test(submitOutcome.text || "");

      if (postSubmitBlockerReason) {
        status = "blocked";
        errorMessage = errorMessage || postSubmitBlockerReason;
      } else if (hasSuccessSignal || (!stillOnFormPage && !hasErrorSignal && submitOutcome.state !== "timeout")) {
        status = "submitted";
      } else {
        const invalidFields = await collectPostSubmitValidationFields(outcomeScope);
        for (const field of invalidFields) {
          await flagForReview(field.label, field.locator, field.widget, outcomeScope);
        }
      }

      if (status === "blocked") {
        // Keep the blocker reason set above.
      } else if (manualReviewFields.length > 0) {
        status = "needs_manual_review";
      } else if (submitOutcome.state === "timeout") {
        status = "failed";
        errorMessage = `Timed out after ${SUBMIT_OUTCOME_TIMEOUT_MS}ms waiting for Greenhouse to finish processing the submission. Review the posting manually before retrying.`;
      } else if (stillOnFormPage && !hasSuccessSignal) {
        status = "failed";
        errorMessage = "Clicking submit did not produce a recognized confirmation — the form may still be showing "
          + "the submit button or a validation error. Review the posting manually before assuming this was submitted.";
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

  return { status, submittedAnswers, manualReviewFields, fieldOptions, confirmationText, errorMessage };
}
