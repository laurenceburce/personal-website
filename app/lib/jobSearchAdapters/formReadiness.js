import { detectSubmissionBlocker } from "./blockerDetection.js";

const APPLICATION_CONTROL_SELECTOR = "input, textarea, select, label[for], [role=textbox], [role=combobox], [contenteditable=true]";
const STANDARD_APPLICANT_FIELD_SIGNALS = /\b(first|last|full)?\s*name\b|\bemail\b|\bphone\b|\bresume\b|\bcv\b|\bcover\s*letter\b|\blinkedin\b|\bportfolio\b|\blocation\b/i;

const UNAVAILABLE_SIGNALS = [
  /job not found/i,
  /job you requested was not found/i,
  /position (has been|is) (filled|closed)/i,
  /role (has been|is) (filled|closed)/i,
  /job (has been|is) (filled|closed|expired)/i,
  /job is no longer available/i,
  /no longer accepting applications/i,
  /this opening is no longer available/i,
  /this job posting has expired/i,
  /page not found/i
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactText(text, max = 240) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
}

export class ApplicationFormUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.code = "application_form_unavailable";
  }
}

export async function hasApplicationFormControls(scope) {
  const summary = await scope.evaluate(({ selector, standardSignalsSource }) => {
    const standardSignals = new RegExp(standardSignalsSource, "i");
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || "1") !== 0
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const textFor = (el) => clean([
      el.innerText || el.textContent || "",
      el.getAttribute("aria-label"),
      el.getAttribute("placeholder"),
      el.getAttribute("name"),
      el.id
    ].filter(Boolean).join(" "));

    let visibleLabels = 0;
    let visibleFileInputs = 0;
    let fillableControls = 0;
    let standardApplicantControls = 0;

    for (const el of document.querySelectorAll(selector)) {
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") || "").toLowerCase();
      const name = el.getAttribute("name") || "";
      const descriptor = textFor(el);

      if (/honey.?pot/i.test(name) || /honeypot/i.test(descriptor)) continue;
      if (tag === "label") {
        if (visible(el) && descriptor) visibleLabels += 1;
        continue;
      }

      if (["hidden", "submit", "button", "reset", "image"].includes(type)) continue;
      if (type === "search" || /\bsearch\b/i.test(descriptor)) continue;
      if (!visible(el) && type !== "file") continue;

      if (type === "file") visibleFileInputs += 1;
      else fillableControls += 1;
      if (standardSignals.test(descriptor)) standardApplicantControls += 1;
    }

    return { visibleLabels, visibleFileInputs, fillableControls, standardApplicantControls };
  }, {
    selector: APPLICATION_CONTROL_SELECTOR,
    standardSignalsSource: STANDARD_APPLICANT_FIELD_SIGNALS.source
  }).catch(() => ({
    visibleLabels: 0,
    visibleFileInputs: 0,
    fillableControls: 0,
    standardApplicantControls: 0
  }));

  return summary.visibleLabels > 0
    || summary.visibleFileInputs > 0
    || summary.standardApplicantControls > 0
    || summary.fillableControls >= 2;
}

export async function detectUnavailablePosting(scope) {
  const bodyText = await scope.locator("body").innerText().catch(() => "");
  if (!bodyText) return "";

  for (const signal of UNAVAILABLE_SIGNALS) {
    const match = bodyText.match(signal);
    if (!match) continue;
    const index = Math.max(0, match.index || 0);
    return compactText(bodyText.slice(Math.max(0, index - 120), index + 360));
  }

  return "";
}

export async function waitForApplicationFormReady(scope, {
  platformName = "Application",
  timeoutMs = 15000,
  pollMs = 250,
  detectBlocker = true
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let unavailableMessage = "";

  while (Date.now() < deadline) {
    unavailableMessage = await detectUnavailablePosting(scope).catch(() => "") || unavailableMessage;
    if (unavailableMessage) {
      return {
        state: "unavailable",
        message: `${platformName} application is not available: ${unavailableMessage}`
      };
    }

    if (detectBlocker) {
      const blockerReason = await detectSubmissionBlocker(scope).catch(() => null);
      if (blockerReason) return { state: "blocked", blockerReason };
    }

    if (await hasApplicationFormControls(scope)) return { state: "ready" };
    await sleep(pollMs);
  }

  return {
    state: "timeout",
    message: `${platformName} application form did not render within ${timeoutMs}ms: no visible application fields were found.`
  };
}

export async function requireApplicationFormReady(scope, options = {}) {
  const result = await waitForApplicationFormReady(scope, options);
  if (result.state === "ready" || result.state === "blocked") return result;
  if (result.state === "unavailable") throw new ApplicationFormUnavailableError(result.message);
  throw new Error(result.message);
}
