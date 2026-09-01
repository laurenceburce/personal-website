// Shared by every submission adapter (greenhouse/ashby/breezy/personio/
// workable/oracleFusion) — the one place that knows how to pause a
// submission on a security-code / anti-bot-text / CAPTCHA blocker
// (blockerDetection.js), hand it to the dashboard, and resume once the
// account owner has answered it themselves. Nothing here guesses an answer
// or drives a challenge on its own — see blockerDetection.js's own header
// comment for why that boundary matters.
//
// Two relay mechanisms, chosen by blocker kind:
//  - security_code / anti_bot_text: a typed-answer relay. Find the input,
//    create a DB row, wait for the dashboard to fill in an answer, type it
//    in, click the continue/verify button.
//  - captcha: a LIVE relay. There's no text to type — solving means seeing
//    and clicking/dragging the actual widget — so this opens a CDP session
//    on the page and holds it open (via jobSearchLiveSessionRegistry.js) for
//    the submit-worker's own HTTP server to relay frames/input through,
//    until the dashboard says it's been solved.
import { isAntiBotTextBlockerReason, isCaptchaBlockerReason, isSecurityCodeBlockerReason } from "./blockerDetection.js";
import { clickWithBrowserMouse } from "./browserEngineClick.js";
import { registerLiveSession, unregisterLiveSession } from "../jobSearchLiveSessionRegistry.js";
import { createSecurityChallenge, markSecurityChallengeUsed, waitForSecurityChallengeCode } from "../jobSearchSecurityChallengeStore.js";

const TEXT_RELAY_WAIT_TIMEOUT_MS = Math.max(30_000, Number(process.env.JOB_SEARCH_SECURITY_CODE_WAIT_MS || 5 * 60 * 1000));
const CAPTCHA_WAIT_TIMEOUT_MS = Math.max(30_000, Number(process.env.JOB_SEARCH_CAPTCHA_WAIT_MS || 5 * 60 * 1000));

// Broader than blockerDetection.js's own signals on purpose — this only
// gates the "accept the single remaining visible input" fallback below, not
// whether something counts as a blocker in the first place (that's already
// decided by the time resolveHeldChallenge() is called). Covers both the
// security-code phrasing and the anti-bot-text phrasing so the fallback
// helps either kind.
const CONTEXT_SIGNALS = /\b(security|verification|one[-\s]?time|authentication)\s+code\b|enter (the )?(security|verification|one[-\s]?time)?\s*code\b|code (sent|emailed|mailed) to|prove (that )?you('re| are) not a (bot|robot)|not a bot auto-?applying|solve the (following )?(captcha|puzzle|challenge)|human verification|figure out the (correct )?secret|decode (this|the following)|what('s| is) the answer/i;
const STRONG_FIELD_SIGNALS = /\b(security|verification|one[-\s]?time|authentication)\s+code\b|one-time-code/i;
const INPUT_SELECTOR = [
  'input[autocomplete="one-time-code"]',
  'input[name*="security" i]',
  'input[id*="security" i]',
  'input[placeholder*="security" i]',
  'input[name*="verification" i]',
  'input[id*="verification" i]',
  'input[placeholder*="verification" i]',
  'input[name*="code" i]',
  'input[id*="code" i]',
  'input[placeholder*="code" i]',
  'input[inputmode="numeric"]',
  'input[type="tel"]'
].join(", ");

function challengePromptExcerpt(text, fallback = "") {
  const source = String(text || "").replace(/\s+/g, " ").trim();
  const index = source.search(CONTEXT_SIGNALS);
  if (index < 0) return String(fallback || "").slice(0, 500);
  return source.slice(Math.max(0, index - 140), index + 360).slice(0, 500);
}

function isChallengeFieldDescriptor(descriptor, { allowGenericMatch = false } = {}) {
  const normalized = String(descriptor || "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (STRONG_FIELD_SIGNALS.test(normalized)) return true;
  if (!allowGenericMatch) return false;

  const tokens = normalized.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => ["enter", "the", "code"].includes(token));
}

async function isVisibleEnabled(locator) {
  return await locator.isVisible().catch(() => false) && await locator.isEnabled().catch(() => false);
}

async function describeInput(locator) {
  return locator.evaluate((el) => {
    const labels = Array.from(el.labels || []).map((label) => label.innerText || "");
    return [
      ...labels,
      el.getAttribute("aria-label"),
      el.getAttribute("placeholder"),
      el.getAttribute("name"),
      el.getAttribute("id"),
      el.getAttribute("autocomplete"),
      el.getAttribute("inputmode")
    ].filter(Boolean).join(" ");
  }).catch(() => "");
}

async function isFillableTextInput(locator) {
  const tag = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
  if (tag === "textarea") return true;
  if (tag !== "input") return false;
  const type = ((await locator.getAttribute("type").catch(() => "")) || "text").toLowerCase();
  return !["checkbox", "radio", "file", "submit", "button", "hidden", "image", "reset"].includes(type);
}

// Minimal, self-contained label[for] scan — deliberately NOT each adapter's
// own field-collection helper (they differ in normalization and this module
// has no business depending on any one of them). Only needs {label, locator}.
async function collectLabeledInputs(scope) {
  const labelHandles = await scope.locator("label[for]").all();
  const fields = [];

  for (const label of labelHandles) {
    const forId = await label.getAttribute("for").catch(() => null);
    if (!forId) continue;
    const text = (await label.innerText().catch(() => "")) || "";
    const locator = scope.locator(`[id="${forId.replace(/"/g, '\\"')}"]`);
    if (await locator.count().catch(() => 0) === 0) continue;
    fields.push({ label: text, locator });
  }

  return fields;
}

// Split one-time-code entry — Greenhouse's own shape (confirmed live on a
// real GitLab posting's screenshot: six separate boxes, each
// `maxlength="1"`), not a single fillable field. A single .fill() on one box
// silently only ever fills that one box, so this has to be detected and
// handled as its own case rather than folded into the single-input path.
// Checked unconditionally and first — a challenge blocker was already
// confirmed by the caller, so a real box group here is unambiguous, cheap to
// check, and takes priority over any single-input match.
async function findSplitBoxGroup(scope) {
  const boxes = await scope.locator('input[maxlength="1"]').all().catch(() => []);
  const visible = [];
  for (const box of boxes) {
    if (await isVisibleEnabled(box)) visible.push(box);
  }
  if (visible.length < 2) return null;

  const withPositions = [];
  for (const box of visible) {
    const rect = await box.boundingBox().catch(() => null);
    withPositions.push({ box, x: rect?.x ?? 0, y: rect?.y ?? 0 });
  }
  // Reading order (top row first, then left-to-right) so digits land in the
  // right boxes regardless of how the boxes are laid out in the DOM.
  withPositions.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  return withPositions.map((entry) => entry.box);
}

async function findChallengeInput(scope, { allowSingleTextFallback = false } = {}) {
  const splitBoxes = await findSplitBoxGroup(scope);
  if (splitBoxes) return { mode: "split", locators: splitBoxes, descriptor: "Security/verification code" };

  const labeledFields = await collectLabeledInputs(scope).catch(() => []);
  for (const field of labeledFields) {
    if (!isChallengeFieldDescriptor(field.label, { allowGenericMatch: allowSingleTextFallback })) continue;
    if (!(await isFillableTextInput(field.locator))) continue;
    if (await isVisibleEnabled(field.locator)) {
      return { mode: "single", locator: field.locator, descriptor: field.label };
    }
  }

  const targetedInputs = await scope.locator(INPUT_SELECTOR).all().catch(() => []);
  for (const input of targetedInputs) {
    if (!(await isVisibleEnabled(input))) continue;
    const descriptor = await describeInput(input);
    if (isChallengeFieldDescriptor(descriptor, { allowGenericMatch: allowSingleTextFallback })) {
      return { mode: "single", locator: input, descriptor };
    }
  }

  if (!allowSingleTextFallback) return null;

  const genericInputs = await scope.locator(
    'input:not([type]), input[type="text"], input[type="tel"], input[type="number"], input[type="password"]'
  ).all().catch(() => []);
  const visibleInputs = [];
  for (const input of genericInputs) {
    if (await isVisibleEnabled(input)) visibleInputs.push(input);
  }

  return visibleInputs.length === 1 ? { mode: "single", locator: visibleInputs[0], descriptor: "Challenge answer" } : null;
}

// Searches the page AND any same-origin-or-not iframe (not just a specific
// ATS's own domain — this module is shared, so no adapter-specific URL
// filter here) for a fillable challenge input, same shape as
// detectSubmissionBlocker()'s own scope-then-page fallback pattern.
async function findChallengeChallenge(page, preferredScope) {
  const scopes = [];
  const addScope = (candidate) => {
    if (candidate && !scopes.includes(candidate)) scopes.push(candidate);
  };

  addScope(preferredScope);
  addScope(page);
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    addScope(frame);
  }

  for (const candidateScope of scopes) {
    const bodyText = await candidateScope.locator("body").innerText().catch(() => "");
    const hasContext = CONTEXT_SIGNALS.test(bodyText);
    const found = await findChallengeInput(candidateScope, { allowSingleTextFallback: hasContext });
    if (!found) continue;
    if (hasContext || isChallengeFieldDescriptor(found.descriptor)) {
      return { scope: candidateScope, found, promptText: challengePromptExcerpt(bodyText, found.descriptor) };
    }
  }

  return null;
}

async function findContinueButton(scope) {
  const roleButton = scope.getByRole("button", { name: /verify|continue|submit|next|confirm/i }).first();
  if (await isVisibleEnabled(roleButton)) return roleButton;

  const submitButton = scope.locator('button[type="submit"], input[type="submit"], input[type="button"]').first();
  if (await isVisibleEnabled(submitButton)) return submitButton;

  return null;
}

// Brief, generic "did clicking continue do something" settle — deliberately
// NOT trying to interpret success/failure text, since that's specific to
// each ATS's own confirmation copy (each adapter already has its own
// SUCCESS/ERROR text signals). The calling adapter re-checks its own
// blocker/outcome flow right after resolveHeldChallenge() returns, same as
// it does after any other step.
async function settleAfterClick(page, button) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!(await button.isVisible().catch(() => false))) return;
    await page.waitForTimeout(250);
  }
}

function challengeKindLabel(kind) {
  return kind === "anti_bot_text" ? "Anti-bot question" : "Security/verification code";
}

// The Held For You panel's Cancel button (cancelSecurityChallenge) sets
// status='cancelled', which waitForSecurityChallengeCode's poll loop already
// returns as soon as it sees a non-'pending' status — so this only needs to
// pick the right WORDING for what's already a resolved failure, not detect
// the cancellation itself.
function describeUnresolvedChallenge(label, status, timeoutMs) {
  if (status === "cancelled") return `${label} was cancelled from the dashboard.`;
  return `${label} required; timed out waiting for dashboard input after ${Math.round(timeoutMs / 1000)}s.`;
}

async function resolveTextRelayChallenge({ page, scope, posting, submittedAnswers, kind }) {
  const challenge = await findChallengeChallenge(page, scope);
  if (!challenge) {
    return { ok: false, errorMessage: `${challengeKindLabel(kind)} challenge was detected, but no fillable input was found.` };
  }

  const pendingChallenge = await createSecurityChallenge({
    postingId: posting.id,
    companyName: posting.companyName,
    jobTitle: posting.title,
    atsType: posting.atsType,
    applyUrl: posting.applyUrl,
    challengeKind: kind,
    promptText: challenge.promptText,
    timeoutMs: TEXT_RELAY_WAIT_TIMEOUT_MS
  });
  console.log(`  [held-challenge] Waiting for dashboard answer for "${posting.title}" at ${posting.companyName} (${kind}, challenge ${pendingChallenge.id}).`);

  const answerResult = await waitForSecurityChallengeCode(pendingChallenge.id, { timeoutMs: TEXT_RELAY_WAIT_TIMEOUT_MS });
  if (answerResult.status !== "answered" || !answerResult.code) {
    return { ok: false, errorMessage: describeUnresolvedChallenge(challengeKindLabel(kind), answerResult.status, TEXT_RELAY_WAIT_TIMEOUT_MS) };
  }

  try {
    if (challenge.found.mode === "split") {
      const digits = String(answerResult.code).replace(/\s+/g, "").split("");
      for (let i = 0; i < challenge.found.locators.length && digits[i] != null; i += 1) {
        await challenge.found.locators[i].fill(digits[i]);
      }
    } else {
      await challenge.found.locator.fill(answerResult.code);
    }
  } finally {
    await markSecurityChallengeUsed(pendingChallenge.id).catch(() => {});
  }

  submittedAnswers[challengeKindLabel(kind)] = "[entered by user]";

  const continueButton = await findContinueButton(challenge.scope);
  if (continueButton) {
    await clickWithBrowserMouse(page, continueButton);
    await settleAfterClick(page, continueButton);
  }

  return { ok: true };
}

async function resolveCaptchaChallenge({ page, posting }) {
  const pendingChallenge = await createSecurityChallenge({
    postingId: posting.id,
    companyName: posting.companyName,
    jobTitle: posting.title,
    atsType: posting.atsType,
    applyUrl: posting.applyUrl,
    challengeKind: "captcha",
    promptText: "CAPTCHA challenge — solve it live from the dashboard.",
    timeoutMs: CAPTCHA_WAIT_TIMEOUT_MS
  });

  const cdpSession = await page.context().newCDPSession(page);
  const viewport = page.viewportSize() || { width: 1280, height: 800 };
  registerLiveSession(pendingChallenge.id, { page, cdpSession, viewport });
  console.log(`  [held-challenge] Live CAPTCHA session open for "${posting.title}" at ${posting.companyName} (challenge ${pendingChallenge.id}) — waiting for it to be solved from the dashboard.`);

  try {
    const result = await waitForSecurityChallengeCode(pendingChallenge.id, { timeoutMs: CAPTCHA_WAIT_TIMEOUT_MS });
    if (result.status !== "answered") {
      return { ok: false, errorMessage: describeUnresolvedChallenge("CAPTCHA challenge", result.status, CAPTCHA_WAIT_TIMEOUT_MS) };
    }
    return { ok: true };
  } finally {
    unregisterLiveSession(pendingChallenge.id);
    await cdpSession.detach().catch(() => {});
    await markSecurityChallengeUsed(pendingChallenge.id).catch(() => {});
  }
}

// The single entry point every adapter calls from its existing blocked-check
// site. Returns { ok: true } once the challenge has been answered/solved and
// it's safe for the caller to carry on (re-check its own blocker/outcome
// flow); { ok: false, errorMessage } if it couldn't be resolved (no input
// found, or the dashboard never answered in time) — the caller falls
// through to its normal `status: "blocked"` return in that case, unchanged.
export async function resolveHeldChallenge({ page, scope, posting, submittedAnswers, blockerReason }) {
  if (isCaptchaBlockerReason(blockerReason)) {
    return resolveCaptchaChallenge({ page, posting });
  }
  if (isSecurityCodeBlockerReason(blockerReason)) {
    return resolveTextRelayChallenge({ page, scope, posting, submittedAnswers, kind: "security_code" });
  }
  if (isAntiBotTextBlockerReason(blockerReason)) {
    return resolveTextRelayChallenge({ page, scope, posting, submittedAnswers, kind: "anti_bot_text" });
  }
  return { ok: false, errorMessage: blockerReason };
}
