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
import { findBestMemoryMatch, findExactMemoryMatch, listAnswerMemoryForMatching, recordMemoryReuse } from "../jobSearchAnswerMemoryStore.js";
import { answerFreeText } from "../jobSearchLlm.js";
import { getFindSettings } from "../jobSearchSettingsStore.js";
import { getTodayLlmUsage, incrementLlmUsage } from "../jobSearchUsageStore.js";
import { clickWithBrowserMouse, setCheckedWithBrowserMouse } from "./browserEngineClick.js";
import { detectSubmissionBlocker, isHeldChallengeBlockerReason } from "./blockerDetection.js";
import { findSubmissionConfirmationEmailText } from "./emailConfirmationFallback.js";
import { requireApplicationFormReady } from "./formReadiness.js";
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
const FIELD_COLLECTION_MAX_WAIT_MS = 4000;
// Raised from 5 after an audit pass — see greenhouse.js's identical constant
// for the reasoning (daily LLM usage has plenty of headroom; 5 was an
// arbitrary early-caution number, not a real cost/rate-limit ceiling).
const MAX_LLM_ANSWERED_FIELDS = 15;

const SUCCESS_TEXT_SIGNALS = /(thank you for applying|thanks for applying|thank you for your application|thanks for your application|application (has been |was |is )?(successfully )?(submitted|received|sent)|we('| ha)ve received your application|we received your application|we got your application|your application (has been|was|is) received|application received)/i;
const ERROR_TEXT_SIGNALS = /(this field is required|please (enter|select|fill)|is required\b|error submitting|something went wrong|invalid code|incorrect code|expired code|verification failed)/i;
const PROCESSING_TEXT_SIGNALS = /(we('| a)re updating your application|updating your application|submitting|processing|please wait)/i;

function cssAttr(value) {
  return String(value || "").replace(/[\\"]/g, "\\$&");
}

function compactErrorMessage(error) {
  return String(error?.message || error || "unknown error").replace(/\s+/g, " ").slice(0, 240);
}

async function waitForAshbyForm(page) {
  return requireApplicationFormReady(page, {
    platformName: "Ashby",
    timeoutMs: FORM_WAIT_TIMEOUT_MS
  });
}

async function collectLabeledFields(page) {
  const descriptors = await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const labelFor = (forId) => {
      if (!forId) return "";
      const label = [...document.querySelectorAll("label[for]")]
        .find((candidate) => candidate.getAttribute("for") === forId);
      return clean(label?.innerText || label?.textContent || "");
    };
    const optionLabel = (radio, index) => {
      const labelText = labelFor(radio.id);
      return labelText || clean(radio.closest("label, li, div")?.innerText || radio.value || `Option ${index + 1}`);
    };
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || "1") !== 0
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const labelledByText = (el) => clean((el.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .map((id) => clean(document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || ""))
      .filter(Boolean)
      .join(" "));
    const containerText = (el) => {
      const container = el.closest("fieldset, [role='group'], [role='radiogroup'], [class*='field' i], [class*='question' i]");
      if (!container) return "";
      return clean(container.querySelector("legend, label, [class*='label' i], [class*='question' i]")?.innerText || "");
    };
    const labelForControl = (el) => labelFor(el.id)
      || clean((el.labels || [])[0]?.innerText || "")
      || clean(el.closest("label")?.innerText || "")
      || labelledByText(el)
      || clean(el.getAttribute("aria-label"))
      || clean(el.getAttribute("placeholder"))
      || containerText(el)
      || clean(el.getAttribute("name"))
      || clean(el.id);
    const labelLooksRequired = (label) => {
      const text = typeof label === "string" ? clean(label) : clean(label?.innerText || label?.textContent || "");
      const className = typeof label === "string" ? "" : String(label?.className || "");
      return /\*/.test(text) || /(?:^|\s|_)required(?:_|\s|$)/i.test(className);
    };
    const requiredFor = (el, label) => Boolean(
      el?.required
        || el?.getAttribute("aria-required") === "true"
        || labelLooksRequired(label)
    );

    const fields = [];
    const seenTargets = new Set();

    for (const label of document.querySelectorAll("label[for]")) {
      const forId = label.getAttribute("for");
      if (!forId) continue;
      const text = clean(label.innerText || label.textContent);
      if (!text) continue;

      let target = document.getElementById(forId);
      let selectorKind = "id";
      if (!target) {
        target = document.querySelector(`[name="${CSS.escape(forId)}"]`);
        selectorKind = "name";
      }
      if (!target) continue;

      const type = (target.getAttribute("type") || "").toLowerCase();
      if (type === "radio") continue;

      const key = `${selectorKind}:${forId}`;
      if (seenTargets.has(key)) continue;
      seenTargets.add(key);

      fields.push({
        kind: "field",
        label: text.replace(/\*\s*$/, "").trim(),
        selectorKind,
        selectorValue: forId,
        forId: key,
        required: requiredFor(target, label)
      });
    }

    const seenRadioNames = new Set();
    let groupIndex = 0;
    for (const group of document.querySelectorAll("fieldset.ashby-application-form-input-radio-group, fieldset.ashby-application-form-input-checkbox-group")) {
      if (!visible(group)) continue;

      const questionLabel = group.querySelector("label.ashby-application-form-question-title, label[for]");
      const label = clean(questionLabel?.innerText || questionLabel?.textContent || "");
      if (!label) continue;

      const inputs = [...group.querySelectorAll('input[type="radio"], input[type="checkbox"]')];
      if (inputs.length === 0) continue;

      const kind = inputs.some((input) => (input.getAttribute("type") || "").toLowerCase() === "radio") ? "radio" : "checkbox-group";
      const radioName = kind === "radio" ? (inputs.find((input) => input.getAttribute("name"))?.getAttribute("name") || "") : "";
      if (radioName && seenRadioNames.has(radioName)) continue;

      const fieldPath = group.closest("[data-field-path]")?.getAttribute("data-field-path") || questionLabel?.getAttribute("for") || "";
      const selectorValue = fieldPath || `group-${groupIndex}`;
      const key = `${kind}:${selectorValue}`;
      if (seenTargets.has(key)) continue;

      group.setAttribute("data-jsf-ashby-group", selectorValue);
      groupIndex += 1;
      seenTargets.add(key);
      if (radioName) seenRadioNames.add(radioName);

      const options = inputs
        .map((input, index) => ({
          id: input.id || "",
          value: input.value || input.getAttribute("name") || "",
          text: optionLabel(input, index)
        }))
        .filter((option) => option.text || option.value);
      if (options.length === 0) continue;

      fields.push({
        kind,
        label: label.replace(/\*\s*$/, "").trim(),
        selectorKind: "group",
        selectorValue,
        radioName,
        forId: key,
        required: requiredFor(inputs[0], questionLabel),
        options
      });
    }

    for (const radio of document.querySelectorAll('input[type="radio"][name]')) {
      const name = radio.getAttribute("name") || "";
      if (!name || seenRadioNames.has(name)) continue;
      seenRadioNames.add(name);

      const radios = [...document.querySelectorAll('input[type="radio"][name]')]
        .filter((input) => input.getAttribute("name") === name);
      const baseName = name.includes("__") ? name.slice(name.indexOf("__") + 1) : name;
      const groupLabel = labelFor(name) || labelFor(baseName);
      if (!groupLabel) continue;

      const options = radios
        .map((input, index) => ({
          id: input.id || "",
          value: input.value || "",
          text: optionLabel(input, index)
        }))
        .filter((option) => option.text);
      if (options.length === 0) continue;

      fields.push({
        kind: "radio",
        label: groupLabel.replace(/\*\s*$/, "").trim(),
        radioName: name,
        forId: `radio:${name}`,
        required: radios.some((input) => Boolean(input.required)) || /\*/.test(groupLabel),
        options
      });
    }

    let fallbackIndex = 0;
    for (const target of document.querySelectorAll("input, textarea, select, [role='combobox'], [role='textbox'], [contenteditable='true']")) {
      const type = (target.getAttribute("type") || "").toLowerCase();
      const id = target.id || "";
      const name = target.getAttribute("name") || "";
      if (["hidden", "file", "submit", "button", "reset", "image"].includes(type)) continue;
      if (target.closest("fieldset.ashby-application-form-input-radio-group, fieldset.ashby-application-form-input-checkbox-group")) continue;
      if (/honey.?pot/i.test(name) || /honeypot/i.test(target.getAttribute("aria-label") || "")) continue;
      if (!visible(target) && type !== "checkbox") continue;
      if (type === "radio") continue;

      const selectorKind = id ? "id" : name ? "name" : "data";
      const selectorValue = id || name || `fallback-${fallbackIndex}`;
      const key = `${selectorKind}:${selectorValue}`;
      if (seenTargets.has(key)) continue;

      const label = labelForControl(target).replace(/\*\s*$/, "").trim();
      if (!label) continue;

      if (selectorKind === "data") {
        target.setAttribute("data-jsf-ashby-field", selectorValue);
        fallbackIndex += 1;
      }

      seenTargets.add(key);
      fields.push({
        kind: "field",
        label,
        selectorKind,
        selectorValue,
        forId: key,
        required: requiredFor(target, label)
      });
    }

    return fields;
  });

  return descriptors.map((field) => ({
    ...field,
    normalizedLabel: normalizeLabel(field.label),
    locator: field.kind === "radio"
      ? page.locator(`input[type="radio"][name="${cssAttr(field.radioName)}"]`).first()
      : field.kind === "checkbox-group"
        ? page.locator(`[data-jsf-ashby-group="${cssAttr(field.selectorValue)}"] input[type="checkbox"]`).first()
      : field.selectorKind === "data"
        ? page.locator(`[data-jsf-ashby-field="${cssAttr(field.selectorValue)}"]`).first()
        : field.selectorKind === "name"
          ? page.locator(`[name="${cssAttr(field.selectorValue)}"]`).first()
          : page.locator(`[id="${cssAttr(field.selectorValue)}"]`).first()
  }));
}

async function collectSettledLabeledFields(page) {
  const deadline = Date.now() + FIELD_COLLECTION_MAX_WAIT_MS;
  let bestFields = [];

  while (Date.now() < deadline) {
    const fields = await collectLabeledFields(page);
    if (fields.length >= bestFields.length) bestFields = fields;
    await page.waitForTimeout(400);
  }

  return bestFields;
}

async function classifyWidget(locator) {
  const tag = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
  if (tag === "select") return "native-select";
  if (tag === "textarea") return "textarea";
  const type = (await locator.getAttribute("type").catch(() => "")) || "";
  if (type === "file") return "file";
  if (type === "checkbox") {
    const isCheckboxGroup = await locator.evaluate((el) => Boolean(el.closest("fieldset.ashby-application-form-input-checkbox-group"))).catch(() => false);
    return isCheckboxGroup ? "checkbox-group" : "yesno";
  }
  if (type === "radio") return "radio";
  const role = (await locator.getAttribute("role").catch(() => "")) || "";
  if (role === "combobox") return "autocomplete";
  return "text";
}

// The real clickable target for a yes/no question is a sibling <button
// data-option="yes|no">, not the (non-interactive) checkbox itself.
//
// Only ever called today with something that should already cleanly mean
// yes or no (resolveWorkAuthValue/resolveEeoCandidates's own "Yes"/"No" strings —
// the LLM free-text path never reaches this widget at all, see the "always
// manual" comment below). But a manual-answer override or a memory-bank
// match is a human's own free-form text, and could be anything, e.g. "Yes, I
// have strong proficiency in..." — treating "not literally 'yes'" as "no"
// would silently click the WRONG button for that, not just fail to fill it.
// Explicit prefix match both ways; anything else declines rather than
// guessing.
async function fillYesNo(page, locator, value) {
  const normalized = String(value).trim().toLowerCase();
  const target = /^yes\b/.test(normalized) ? "yes" : /^no\b/.test(normalized) ? "no" : null;
  if (!target) return false;
  const container = locator.locator("xpath=..");
  const button = container.locator(`button[data-option="${target}"]`);
  if (await button.count().catch(() => 0) === 0) return false;
  await clickWithBrowserMouse(page, button);
  return true;
}

// Ashby's autocomplete never offers an option matching a plain "City, State"
// string exactly (results always append region/country) — a prefix match is
// as strict as this widget can support without guessing between genuinely
// different places. No match at all still means "don't guess", not "closest".
async function fillAutocomplete(page, locator, value) {
  await clickWithBrowserMouse(page, locator);
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

  await clickWithBrowserMouse(page, options.nth(matchIndex));
  return true;
}

async function radioOptions(page, locator) {
  const name = await locator.getAttribute("name").catch(() => null);
  if (!name) return [];

  return page.evaluate((radioName) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    return [...document.querySelectorAll('input[type="radio"][name]')]
      .filter((radio) => radio.getAttribute("name") === radioName)
      .map((radio, index) => {
        const label = radio.id
          ? [...document.querySelectorAll("label[for]")].find((candidate) => candidate.getAttribute("for") === radio.id)
          : null;
        return {
          id: radio.id || "",
          index,
          value: radio.value || "",
          text: clean(label?.innerText || label?.textContent || radio.closest("label, li, div")?.innerText || radio.value)
        };
      })
      .filter((option) => option.text || option.value);
  }, name).catch(() => []);
}

async function checkboxGroupOptions(locator) {
  return locator.evaluate((input) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const group = input.closest("fieldset.ashby-application-form-input-checkbox-group, [data-jsf-ashby-group]");
    if (!group) return [];

    return [...group.querySelectorAll('input[type="checkbox"]')]
      .map((checkbox, index) => {
        const label = checkbox.id
          ? [...document.querySelectorAll("label[for]")].find((candidate) => candidate.getAttribute("for") === checkbox.id)
          : null;
        return {
          id: checkbox.id || "",
          index,
          value: checkbox.value || "",
          name: checkbox.getAttribute("name") || "",
          text: clean(label?.innerText || label?.textContent || checkbox.closest("label, li, div")?.innerText || checkbox.getAttribute("name") || checkbox.value),
          checked: Boolean(checkbox.checked)
        };
      })
      .filter((option) => option.text || option.name || option.value);
  }).catch(() => []);
}

async function clickInputOption(page, input, option, checked = true) {
  if (option.id) {
    const label = page.locator(`label[for="${cssAttr(option.id)}"]`).first();
    if (await label.isVisible().catch(() => false)) {
      await clickWithBrowserMouse(page, label);
      const updated = await input.isChecked().catch(() => null);
      if (updated === Boolean(checked)) return true;
    }
  }

  await setCheckedWithBrowserMouse(page, input, checked);
  return (await input.isChecked().catch(() => null)) === Boolean(checked);
}

async function fillCheckboxGroup(page, locator, value) {
  const target = String(value || "").trim().toLowerCase();
  if (!target) return false;

  const options = await checkboxGroupOptions(locator);
  const match = options.find((option) => String(option.text || "").trim().toLowerCase() === target)
    || options.find((option) => String(option.name || "").trim().toLowerCase() === target)
    || options.find((option) => String(option.value || "").trim().toLowerCase() === target);
  if (!match) return false;

  const group = locator.locator("xpath=ancestor::*[@data-jsf-ashby-group][1]");
  const input = match.id
    ? page.locator(`[id="${cssAttr(match.id)}"]`).first()
    : group.locator('input[type="checkbox"]').nth(match.index);
  return clickInputOption(page, input, match, true);
}

// Captures a field's real available options at the point it's about to be
// flagged for manual review — see greenhouse.js's identical helper for the
// full reasoning. "autocomplete" is deliberately excluded: its result list
// depends on what's typed (a live location search), there's no fixed set to
// enumerate up front. Reads whatever string would actually succeed against
// this SAME widget's own fillByWidget branch below — for "radio" that's the
// raw `value` attribute (what the fill case matches on), not necessarily
// prettified label text.
async function captureFieldOptions(locator, widget, page) {
  if (widget === "native-select") {
    const texts = await locator.locator("option").allInnerTexts().catch(() => []);
    return texts.map((t) => t.trim()).filter(Boolean);
  }
  if (widget === "yesno") return ["Yes", "No"];
  if (widget === "radio") {
    const options = await radioOptions(page, locator);
    return options.map((option) => option.text || option.value).filter(Boolean);
  }
  if (widget === "checkbox-group") {
    const options = await checkboxGroupOptions(locator);
    return options.map((option) => option.text || option.name || option.value).filter(Boolean);
  }
  return [];
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
        const target = normalizeLabel(value);
        const optionValue = await locator.evaluate((select, normalizedTarget) => {
          const clean = (text) => String(text || "").toLowerCase().replace(/\*/g, "").replace(/\[optional[^\]]*\]/g, "").replace(/\([^)]*\)/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
          const match = [...select.options].find((option) => clean(option.textContent) === normalizedTarget);
          return match?.value || null;
        }, target).catch(() => null);
        if (optionValue != null) {
          await locator.selectOption({ value: optionValue });
          return true;
        }
        return false;
      }
    case "yesno":
      return fillYesNo(page, locator, value);
    case "checkbox-group":
      return fillCheckboxGroup(page, locator, value);
    case "autocomplete":
      return fillAutocomplete(page, locator, value);
    case "radio": {
      const name = await locator.getAttribute("name").catch(() => null);
      if (!name) return false;
      const target = String(value).trim().toLowerCase();
      const options = await radioOptions(page, locator);
      const match = options.find((option) => String(option.text || "").trim().toLowerCase() === target)
        || options.find((option) => option.value && String(option.value).trim().toLowerCase() === target);
      if (!match) return false;

      const radio = match.id
        ? page.locator(`[id="${cssAttr(match.id)}"]`).first()
        : page.locator(`input[type="radio"][name="${cssAttr(name)}"]`).nth(match.index);
      return clickInputOption(page, radio, match, true);
    }
    default:
      return false;
  }
}

async function fieldHasAnswer(locator, widget) {
  switch (widget) {
    case "text":
    case "textarea":
    case "autocomplete":
      return locator.evaluate((el) => Boolean(String(el.value || el.textContent || "").trim())).catch(() => false);
    case "native-select":
      return locator.evaluate((el) => Boolean(String(el.value || "").trim())).catch(() => false);
    case "yesno":
      return locator.evaluate((el) => {
        const root = el.closest(".ashby-application-form-input-yesno, .ashby-application-form-field-entry") || el.parentElement;
        return Boolean(root?.querySelector('button[aria-pressed="true"], input:checked'));
      }).catch(() => false);
    case "radio":
      return locator.evaluate((el) => {
        const name = el.getAttribute("name");
        return Boolean(name && document.querySelector(`input[type="radio"][name="${CSS.escape(name)}"]:checked`));
      }).catch(() => false);
    case "checkbox-group":
      return locator.evaluate((el) => {
        const group = el.closest("fieldset.ashby-application-form-input-checkbox-group, [data-jsf-ashby-group]");
        return Boolean(group?.querySelector('input[type="checkbox"]:checked'));
      }).catch(() => false);
    default:
      return true;
  }
}

async function collectUnansweredRequiredFields(page) {
  const fields = await collectSettledLabeledFields(page);
  const unanswered = [];

  for (const field of fields) {
    if (!field.required) continue;
    const widget = await classifyWidget(field.locator);
    if (widget === "file") continue;
    if (await fieldHasAnswer(field.locator, widget)) continue;
    unanswered.push({ ...field, widget });
  }

  return unanswered;
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
async function uploadResumeAndVerify(page, resumeBuffer, resumeFileName) {
  const fileInput = page.locator("#_systemfield_resume, input[type=\"file\"][name=\"resume\"]").first();
  if (await fileInput.count().catch(() => 0) === 0) return { ok: false, reason: "no file input found" };

  const replaceButton = page.getByRole("button", { name: "Replace" });
  const errorToast = page.getByText(RESUME_UPLOAD_ERROR_TEXT);

  for (let attempt = 1; attempt <= 2; attempt++) {
    await fileInput.setInputFiles(resumeFilePayload(resumeBuffer, resumeFileName));

    const outcome = await Promise.race([
      replaceButton.waitFor({ state: "visible", timeout: RESUME_UPLOAD_CONFIRM_TIMEOUT_MS }).then(() => "success").catch(() => "timeout"),
      errorToast.waitFor({ state: "visible", timeout: RESUME_UPLOAD_CONFIRM_TIMEOUT_MS }).then(() => "error").catch(() => "timeout")
    ]);

    if (outcome === "success") return { ok: true };
    if (attempt === 1) {
      // Best-effort dismiss so a lingering toast from this attempt can't be
      // mistaken for the retry's own outcome, or obscure the file input.
      await clickWithBrowserMouse(page, page.getByRole("button", { name: /close|dismiss/i }).first(), { timeout: 1000 }).catch(() => {});
    }
  }

  return { ok: false, reason: "upload did not confirm after 2 attempts" };
}

async function readSubmissionText(page) {
  return page.locator("body").innerText().catch(() => "");
}

function submissionTextExcerpt(text) {
  const source = String(text || "");
  const signalIndexes = [source.search(SUCCESS_TEXT_SIGNALS), source.search(ERROR_TEXT_SIGNALS)].filter((index) => index >= 0);
  const start = signalIndexes.length > 0 ? Math.max(0, Math.min(...signalIndexes) - 160) : 0;
  return source.slice(start, start + 500);
}

async function findVisibleSubmitButton(page) {
  const candidates = await page.locator('button[type="submit"], input[type="submit"], button:has-text("Submit")').all().catch(() => []);
  for (const candidate of candidates) {
    const visible = await candidate.isVisible().catch(() => false);
    const enabled = await candidate.isEnabled().catch(() => false);
    if (visible && enabled) return candidate;
  }
  return null;
}

async function clickSubmitOrReadBlocker(page, submitButton) {
  try {
    await clickWithBrowserMouse(page, submitButton);
    return { ok: true, blockerReason: "" };
  } catch (error) {
    const blockerReason = await detectSubmissionBlocker(page).catch(() => null);
    if (blockerReason) return { ok: false, blockerReason };
    return { ok: false, blockerReason: "", errorMessage: `Ashby submit button could not be clicked: ${compactErrorMessage(error)}` };
  }
}

async function isSubmitButtonBusy(submitButton) {
  return submitButton.evaluate((el) => {
    const text = `${el.innerText || ""} ${el.value || ""}`.trim();
    return Boolean(
      el.disabled
        || el.getAttribute("aria-disabled") === "true"
        || el.getAttribute("aria-busy") === "true"
        || /submitting|loading|processing/i.test(text)
        || el.querySelector('[role="progressbar"], [class*="spinner" i], [class*="loading" i], [aria-label*="loading" i]')
    );
  }).catch(() => false);
}

async function waitForAshbySubmitOutcome(page, submitButton) {
  const startedAt = Date.now();
  const deadline = startedAt + SUBMIT_OUTCOME_TIMEOUT_MS;
  let lastText = await readSubmissionText(page);
  let sawProcessingState = PROCESSING_TEXT_SIGNALS.test(lastText);

  while (Date.now() < deadline) {
    if (SUCCESS_TEXT_SIGNALS.test(lastText)) return { state: "success", text: lastText };
    if (ERROR_TEXT_SIGNALS.test(lastText)) return { state: "validation", text: lastText };

    const stillOnFormPage = await submitButton.isVisible().catch(() => false);
    if (!stillOnFormPage) {
      await page.waitForTimeout(1000);
      lastText = await readSubmissionText(page);
      if (SUCCESS_TEXT_SIGNALS.test(lastText)) return { state: "success", text: lastText };
      if (ERROR_TEXT_SIGNALS.test(lastText)) return { state: "validation", text: lastText };
      return { state: "changed", text: lastText };
    }

    const busy = await isSubmitButtonBusy(submitButton);
    if (busy || PROCESSING_TEXT_SIGNALS.test(lastText)) {
      sawProcessingState = true;
    } else if (sawProcessingState || Date.now() - startedAt > 5000) {
      await page.waitForTimeout(1000);
      lastText = await readSubmissionText(page);
      if (SUCCESS_TEXT_SIGNALS.test(lastText)) return { state: "success", text: lastText };
      if (ERROR_TEXT_SIGNALS.test(lastText)) return { state: "validation", text: lastText };
      if (!PROCESSING_TEXT_SIGNALS.test(lastText)) return { state: "settled_on_form", text: lastText };
    }

    await page.waitForTimeout(500);
    lastText = await readSubmissionText(page);
  }

  return { state: "timeout", text: lastText };
}

export async function submitAshbyApplication({ posting, profile, resumeBuffer, resumeFileName, resumeText = "", dryRun = false, headless = true }) {
  const { browser, newPage } = await launchJobSearchBrowser({ headless });
  const submittedAnswers = {};
  const manualReviewFields = [];
  // Real available options for a select/yesno/radio field, keyed by label —
  // see captureFieldOptions()'s own comment. Populated by flagForReview()
  // below, once `page` exists.
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
    await page.goto(posting.applyUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await waitForAshbyForm(page);

    const blockerReason = await detectSubmissionBlocker(page);
    if (blockerReason) {
      if (isHeldChallengeBlockerReason(blockerReason)) {
        const challengeResult = await resolveHeldChallenge({ page, scope: page, posting, submittedAnswers, blockerReason });
        if (!challengeResult.ok) {
          return { status: "blocked", submittedAnswers, manualReviewFields, fieldOptions, confirmationText, errorMessage: challengeResult.errorMessage };
        }
        // No separate iframe scope to re-acquire here (unlike Greenhouse's
        // findFormScope) — Ashby's form lives directly on `page`.
      } else {
        return { status: "blocked", submittedAnswers, manualReviewFields, fieldOptions, confirmationText, errorMessage: blockerReason };
      }
    }

    if (resumeBuffer) {
      const uploadResult = await uploadResumeAndVerify(page, resumeBuffer, resumeFileName);
      if (uploadResult.ok) {
        submittedAnswers["Resume"] = resumeFileName || "resume.pdf";
      } else {
        manualReviewFields.push(`Resume upload (${uploadResult.reason})`);
      }
    }

    const fields = await collectSettledLabeledFields(page);
    // Fetched once, reused for every field below — see
    // jobSearchAnswerMemoryStore.js's own comment on why this isn't a
    // per-field query.
    const memoryRows = await listAnswerMemoryForMatching().catch(() => []);

    async function flagForReview(label, locator, widget) {
      if (manualReviewFields.some((existing) => normalizeLabel(existing) === normalizeLabel(label))) return;
      manualReviewFields.push(label);
      const options = await captureFieldOptions(locator, widget, page).catch(() => []);
      if (options.length > 0) fieldOptions[label] = options;
    }

    // A similarly-worded question was answered by hand on a DIFFERENT
    // posting before (see the Review Queue's Memory tab / "Answer & Retry"
    // popup) — a human-verified past answer beats manual review, so this is
    // tried as a last resort by EVERY resolution branch below (EEO/work-auth,
    // a matched-but-unfillable standard field, and the generic catch-all),
    // not just the generic one — see greenhouse.js's identical helper for why
    // this needs to be its own function reused across branches rather than
    // one inline block the EEO/work-auth/standard-field paths skip straight
    // past on their way to flagForReview. An exact label match is tried
    // first and, unlike the fuzzy embedding match right after it, is never
    // gated behind the daily LLM-call budget — it costs no LLM call at all.
    async function tryMemoryAnswer(field, widget) {
      if (memoryRows.length === 0) return false;

      const fillMemoryMatch = async (memoryMatch) => {
        if (!memoryMatch) return false;

        for (const candidate of manualOverrideCandidates(memoryMatch.answer)) {
          if (await fillByWidget(page, field.locator, widget, candidate)) {
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

    for (const field of fields) {
      if (field.forId === "_systemfield_resume") continue; // handled above

      const widget = await classifyWidget(field.locator);
      if (widget === "file") continue; // e.g. optional cover-letter file upload — not supported, never guessed

      // A human already answered this exact question for this exact posting
      // (see the Review Queue's "Answer & Retry" popup) — try it before any
      // auto-resolution strategy below. Falls through to those on failure.
      const manualOverride = resolveManualOverride(field.normalizedLabel, posting.manualReviewFields);
      if (manualOverride != null) {
        let overrideFilled = null;
        for (const candidate of manualOverrideCandidates(manualOverride)) {
          if (await fillByWidget(page, field.locator, widget, candidate)) {
            overrideFilled = candidate;
            break;
          }
        }
        if (overrideFilled != null) {
          submittedAnswers[field.label] = overrideFilled;
          continue;
        }
      }

      // Flagged for manual review on any failure to fill — not gated behind
      // field.required. See greenhouse.js's identical comment: an EEO/work-
      // auth question routinely carries no visible asterisk (framed as
      // "voluntary") while the ATS's own client-side validation still
      // requires SOME selection before allowing submit — silently leaving
      // one blank produces a confusing "Failed: clicking submit did not
      // produce a recognized confirmation" instead of a needs_manual_review
      // outcome that actually names the field.
      if (isWorkAuthLabel(field.normalizedLabel)) {
        const value = resolveWorkAuthValue(field.normalizedLabel, profile.workAuthorization);
        if (value && await fillByWidget(page, field.locator, widget, value)) {
          submittedAnswers[field.label] = value;
          continue;
        }
        if (await tryMemoryAnswer(field, widget)) continue;
        await flagForReview(field.label, field.locator, widget);
        continue;
      }

      if (isEeoLabel(field.normalizedLabel)) {
        let filledValue = null;
        for (const candidate of resolveEeoCandidates(field.normalizedLabel, profile?.eeoAnswers)) {
          if (await fillByWidget(page, field.locator, widget, candidate)) {
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

      // Some fields have more than one acceptable value (country name
      // spelled out vs. abbreviated, phone with/without its country code) —
      // resolveStandardFieldCandidates() returns them in priority order;
      // fillByWidget() already dispatches correctly per widget type (a
      // select needs an option whose label actually matches, so retrying
      // candidates here is what actually lets it succeed instead of landing
      // in manual review over a spelling mismatch).
      const standardCandidates = resolveStandardFieldCandidates(
        field.normalizedLabel,
        profile,
        [field.label, field.selectorValue, field.forId].filter(Boolean).join(" ")
      );
      if (standardCandidates.length > 0) {
        let filledValue = null;
        for (const candidate of standardCandidates) {
          if (await fillByWidget(page, field.locator, widget, candidate)) {
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
      // this is checked ahead of every "never guessed" category below (yes/no,
      // fixed option sets) and the free-text fallback, for any widget type.
      if (await tryMemoryAnswer(field, widget)) continue;

      // Yes/no capability-style questions ("Do you have N years of experience
      // with X?") are a factual claim about the candidate, not a lookup — the
      // same reasoning that keeps EEO/work-auth hard-mapped and never
      // LLM-guessed applies here too, so these always go to manual review
      // rather than being answered by the LLM's best guess.
      if (widget === "yesno") {
        if (field.required) await flagForReview(field.label, field.locator, widget);
        continue;
      }

      // Fixed option sets (dropdowns, autocompletes) with no known mapping —
      // never guessed into, same rule as Greenhouse's combobox/select handling.
      if (widget === "native-select" || widget === "autocomplete" || widget === "radio") {
        if (field.required) await flagForReview(field.label, field.locator, widget);
        continue;
      }

      // Novel free-text question — LLM-assisted, capped, and metered against
      // the same daily budget as scoring/embedding.
      if ((widget === "text" || widget === "textarea") && llmAnsweredCount < MAX_LLM_ANSWERED_FIELDS) {
        const llmSettings = await getLlmFindSettings();
        const usage = await getTodayLlmUsage();
        if (usage.totalCalls >= llmSettings.maxLlmCallsPerDay) {
          if (field.required) manualReviewFields.push(field.label);
          continue;
        }

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

      if (field.required) await flagForReview(field.label, field.locator, widget);
    }

    for (const field of await collectUnansweredRequiredFields(page)) {
      await flagForReview(field.label, field.locator, field.widget);
    }

    if (manualReviewFields.length > 0) {
      status = "needs_manual_review";
    } else if (dryRun) {
      status = "dry_run_ok";
    } else {
      let submitButton = await findVisibleSubmitButton(page);
      let submitAttemptedAt = submitButton ? Date.now() : 0;
      let emailConfirmationText = "";
      const confirmSubmittedByEmail = async () => {
        if (emailConfirmationText) return true;
        emailConfirmationText = await findSubmissionConfirmationEmailText(posting, submitAttemptedAt);
        if (!emailConfirmationText) return false;
        confirmationText = emailConfirmationText;
        status = "submitted";
        errorMessage = "";
        return true;
      };
      let clickResult = submitButton
        ? await clickSubmitOrReadBlocker(page, submitButton)
        : { ok: false, blockerReason: await detectSubmissionBlocker(page).catch(() => null) };

      if (!clickResult.ok && clickResult.blockerReason && isHeldChallengeBlockerReason(clickResult.blockerReason)) {
        const challengeResult = await resolveHeldChallenge({ page, scope: page, posting, submittedAnswers, blockerReason: clickResult.blockerReason });
        if (challengeResult.ok) {
          submitButton = await findVisibleSubmitButton(page);
          submitAttemptedAt = submitButton ? Date.now() : submitAttemptedAt;
          clickResult = submitButton
            ? await clickSubmitOrReadBlocker(page, submitButton)
            : {
                ok: false,
                blockerReason: await detectSubmissionBlocker(page).catch(() => null),
                errorMessage: "Ashby submit button was not visible after resolving the held challenge. Review the posting manually before retrying."
              };
        } else {
          status = "blocked";
          errorMessage = challengeResult.errorMessage;
        }
      }

      if (status === "blocked") {
        // Keep the held-challenge error set above.
      } else if (!clickResult.ok) {
        status = clickResult.blockerReason ? "blocked" : "failed";
        errorMessage = clickResult.blockerReason || clickResult.errorMessage || "Ashby submit button was not visible after filling the form. Review the posting manually before retrying.";
      } else {
        let submitOutcome = await waitForAshbySubmitOutcome(page, submitButton);

        let postSubmitBlockerReason = await detectSubmissionBlocker(page).catch(() => null);
        if (isHeldChallengeBlockerReason(postSubmitBlockerReason)) {
          const challengeResult = await resolveHeldChallenge({ page, scope: page, posting, submittedAnswers, blockerReason: postSubmitBlockerReason });
          if (!challengeResult.ok) {
            status = "blocked";
            errorMessage = challengeResult.errorMessage;
          } else if (await submitButton.isVisible().catch(() => false)) {
            submitAttemptedAt = Date.now();
            const retryClickResult = await clickSubmitOrReadBlocker(page, submitButton);
            if (retryClickResult.ok) {
              submitOutcome = await waitForAshbySubmitOutcome(page, submitButton);
              postSubmitBlockerReason = await detectSubmissionBlocker(page).catch(() => null);
            } else {
              status = retryClickResult.blockerReason ? "blocked" : "failed";
              errorMessage = retryClickResult.blockerReason || retryClickResult.errorMessage || "Ashby submit button was not visible after resolving the held challenge. Review the posting manually before retrying.";
            }
          }
        }

        if (status !== "submitted" && postSubmitBlockerReason) {
          await confirmSubmittedByEmail();
        }

        if (status !== "submitted" && status !== "blocked" && postSubmitBlockerReason) {
          status = "blocked";
          errorMessage = postSubmitBlockerReason;
        }

        const pageText = submitOutcome?.text || await readSubmissionText(page);
        if (status !== "submitted") confirmationText = submissionTextExcerpt(pageText);

        if (status !== "blocked" && status !== "submitted") {
          const stillOnFormPage = submitButton ? await submitButton.isVisible().catch(() => false) : false;
          const hasErrorSignal = ERROR_TEXT_SIGNALS.test(pageText);
          const hasSuccessSignal = SUCCESS_TEXT_SIGNALS.test(pageText);
          const ambiguousPostSubmitState = submitOutcome?.state === "timeout" || (stillOnFormPage && !hasSuccessSignal);

          if (ambiguousPostSubmitState) {
            await confirmSubmittedByEmail();
          }

          if (status === "submitted") {
            // Confirmed by a fresh submission email.
          } else if (hasSuccessSignal || (!stillOnFormPage && !hasErrorSignal && submitOutcome?.state !== "timeout")) {
            status = "submitted";
          } else if (submitOutcome?.state === "timeout") {
            status = "failed";
            errorMessage = `Timed out after ${SUBMIT_OUTCOME_TIMEOUT_MS}ms waiting for Ashby to finish processing the submission. Review the posting manually before retrying.`;
          } else if (hasErrorSignal || (stillOnFormPage && !hasSuccessSignal)) {
            const unansweredRequiredFields = await collectUnansweredRequiredFields(page);
            for (const field of unansweredRequiredFields) {
              await flagForReview(field.label, field.locator, field.widget);
            }

            if (manualReviewFields.length > 0) {
              status = "needs_manual_review";
              errorMessage = "";
            } else {
              status = "failed";
              errorMessage = "Clicking submit did not produce a recognized confirmation — the form may still be showing "
                + "the submit button or a validation error. Review the posting manually before assuming this was submitted.";
            }
          } else {
            status = "submitted";
          }
        }
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
