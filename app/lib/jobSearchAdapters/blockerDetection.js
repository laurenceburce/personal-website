// Shared across every submission adapter. Confirmed live against a real Ashby
// form (Ramp's "Security Engineer, Cloud" posting): a genuine reCAPTCHA
// (`g-recaptcha-response`) AND a separate, textual "decode this and prove
// you're not a bot" anti-automation puzzle in the ordinary question flow.
// Nothing in this file ever solves or works around what it detects on its
// own — it only classifies and reports. The security-code / anti-bot-text /
// CAPTCHA reasons below are handled by jobSearchAdapters/heldChallengeRelay.js,
// which pauses the submission and relays the account owner's OWN typed
// answer or their own live clicks/keystrokes back to this exact page —
// never an automated guess or an automated solve.
const CAPTCHA_WIDGET_SELECTORS = [
  ".g-recaptcha",
  "[name=\"g-recaptcha-response\"]",
  "iframe[src*=\"recaptcha\"]",
  ".h-captcha",
  "iframe[src*=\"hcaptcha\"]",
  "iframe[src*=\"turnstile\"]",
  "[data-sitekey]"
].join(", ");

const SECURITY_CODE_INPUT_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[name*="security" i]',
  'input[id*="security" i]',
  'input[placeholder*="security" i]',
  'input[name*="verification" i]',
  'input[id*="verification" i]',
  'input[placeholder*="verification" i]',
  'input[name*="confirmation" i]',
  'input[id*="confirmation" i]',
  'input[placeholder*="confirmation" i]',
  'input[name*="passcode" i]',
  'input[id*="passcode" i]',
  'input[placeholder*="passcode" i]',
  'input[name*="pin" i]',
  'input[id*="pin" i]',
  'input[placeholder*="pin" i]',
  'input[name*="otp" i]',
  'input[id*="otp" i]',
  'input[name*="code" i][inputmode="numeric"]',
  'input[id*="code" i][inputmode="numeric"]',
  'input[inputmode="numeric"][autocomplete="one-time-code"]'
].join(", ");

export const SECURITY_CODE_BLOCKER_REASON = "Security/verification code challenge present on the application form.";
export const ANTI_BOT_TEXT_BLOCKER_REASON = "Anti-automation challenge question present in the application form.";
export const CAPTCHA_BLOCKER_REASON = "CAPTCHA widget present on the application form.";

const SECURITY_CODE_TEXT_SIGNALS = /\b(security|verification|confirmation|confirm|one[-\s]?time|authentication|two[-\s]?factor|2fa)\s+(code|passcode|pin)\b|\b(code|passcode|pin|otp)\b.{0,80}\b(security|verification|confirmation|authentication|email)\b|enter (the )?(security|verification|confirmation|one[-\s]?time|authentication)?\s*(code|passcode|pin)\b|(code|passcode|pin) (sent|emailed|mailed) to|sent .{0,100}(code|passcode|pin).{0,100}(email|inbox)|check .{0,100}(email|inbox).{0,100}(code|passcode|pin)|verify .{0,60}(email|identity|application)|confirm .{0,60}(email|identity|application)|verification email/i;
const ANTI_BOT_TEXT_SIGNALS = /(prove (that )?you('re| are) not a (bot|robot)|not a bot auto-?applying|solve the (following )?(captcha|puzzle|challenge)|human verification|figure out the (correct )?secret)/i;
const LOGIN_WALL_SIGNALS = /(sign in to apply|log in to apply|create an account to apply|please log in to continue)/i;

async function isInteractiveCaptchaWidget(locator) {
  return locator.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (
      rect.width <= 0
        || rect.height <= 0
        || style.display === "none"
        || style.visibility === "hidden"
        || Number(style.opacity || "1") === 0
    ) {
      return false;
    }

    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "textarea" || type === "hidden") return false;

    const src = el.getAttribute("src") || "";
    const size = [
      el.getAttribute("data-size"),
      el.getAttribute("data-theme"),
      src
    ].filter(Boolean).join(" ");

    // Greenhouse and Ashby commonly keep invisible reCAPTCHA Enterprise
    // anchors in the form. They are visible DOM iframes, but not a human
    // challenge; treating them as blockers causes a false "still asking"
    // loop after the form's own invisible token flow runs.
    if (/\bsize=invisible\b|data-size=["']?invisible|(?:^|\s)invisible(?:\s|$)/i.test(size)) {
      return false;
    }

    return true;
  }).catch(() => false);
}

// Returns a short human-readable reason string if this application should be
// treated as blocked, or null if nothing was detected. Deliberately checked
// BEFORE any field is filled — no point answering nine questions only to
// discover the tenth is an unsolvable anti-bot puzzle.
export async function detectSubmissionBlocker(scope) {
  const bodyText = await scope.locator("body").innerText().catch(() => "");

  // Checked BEFORE the CAPTCHA widget scan below: a real security-code or
  // anti-bot text prompt is a more specific, actionable signal than a
  // co-present CAPTCHA badge. Confirmed live (GitLab's Greenhouse posting,
  // Snowflake's Ashby posting both carry Google's invisible reCAPTCHA badge
  // as boilerplate anti-spam alongside a genuine text challenge) — checking
  // the CAPTCHA widget first was masking the text challenge entirely, so the
  // security-code relay never actually fired even though the page clearly
  // had a fillable code field.
  if (SECURITY_CODE_TEXT_SIGNALS.test(bodyText)) {
    return SECURITY_CODE_BLOCKER_REASON;
  }

  const codeInputs = scope.locator(SECURITY_CODE_INPUT_SELECTORS);
  const codeInputCount = await codeInputs.count().catch(() => 0);
  for (let i = 0; i < codeInputCount; i += 1) {
    const input = codeInputs.nth(i);
    if (!(await input.isVisible().catch(() => false))) continue;
    const descriptor = await input.evaluate((el) => [
      el.getAttribute("autocomplete"),
      el.getAttribute("aria-label"),
      el.getAttribute("placeholder"),
      el.getAttribute("name"),
      el.getAttribute("id")
    ].filter(Boolean).join(" ")).catch(() => "");
    if (/one[-\s]?time|security|verification|confirmation|authentication|passcode|\bpin\b|\botp\b/i.test(descriptor)) {
      return SECURITY_CODE_BLOCKER_REASON;
    }
  }

  if (ANTI_BOT_TEXT_SIGNALS.test(bodyText)) {
    return ANTI_BOT_TEXT_BLOCKER_REASON;
  }

  // Visibility-gated, not raw DOM presence. Greenhouse/Ashby (among others)
  // embed an invisible reCAPTCHA v3 badge on essentially every form as
  // boilerplate anti-spam — present in the DOM whether or not it ever
  // actually challenges the visitor. Matching on count() alone flagged those
  // as blocked constantly: the same Snowflake posting alternated between
  // "CAPTCHA widget present" and a clean submit across attempts with no code
  // change, which is exactly that badge sometimes rendering itself and
  // sometimes not. Requiring at least one matched element to actually be
  // visible keeps catching a real interactive challenge (checkbox iframe,
  // hCaptcha, Turnstile) while dropping that false positive.
  const captchaWidgets = scope.locator(CAPTCHA_WIDGET_SELECTORS);
  const captchaCount = await captchaWidgets.count().catch(() => 0);
  for (let i = 0; i < captchaCount; i += 1) {
    if (await isInteractiveCaptchaWidget(captchaWidgets.nth(i))) {
      return CAPTCHA_BLOCKER_REASON;
    }
  }

  if (LOGIN_WALL_SIGNALS.test(bodyText)) {
    return "Application requires signing in / creating an account first.";
  }

  return null;
}

export function isSecurityCodeBlockerReason(reason) {
  return reason === SECURITY_CODE_BLOCKER_REASON;
}

export function isAntiBotTextBlockerReason(reason) {
  return reason === ANTI_BOT_TEXT_BLOCKER_REASON;
}

export function isCaptchaBlockerReason(reason) {
  return reason === CAPTCHA_BLOCKER_REASON;
}

// True for any blocker kind heldChallengeRelay.js.resolveHeldChallenge()
// knows how to hold-and-relay. Anything else (login wall, an unrecognized
// future signal) stays a hard "blocked" — see each adapter's call site.
export function isHeldChallengeBlockerReason(reason) {
  return isSecurityCodeBlockerReason(reason) || isAntiBotTextBlockerReason(reason) || isCaptchaBlockerReason(reason);
}
