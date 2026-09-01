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

export const SECURITY_CODE_BLOCKER_REASON = "Security/verification code challenge present on the application form.";
export const ANTI_BOT_TEXT_BLOCKER_REASON = "Anti-automation challenge question present in the application form.";
export const CAPTCHA_BLOCKER_REASON = "CAPTCHA widget present on the application form.";

const SECURITY_CODE_TEXT_SIGNALS = /\b(security|verification|one[-\s]?time)\s+code\b|enter (the )?(security|verification) code/i;
const ANTI_BOT_TEXT_SIGNALS = /(prove (that )?you('re| are) not a (bot|robot)|not a bot auto-?applying|solve the (following )?(captcha|puzzle|challenge)|human verification|figure out the (correct )?secret)/i;
const LOGIN_WALL_SIGNALS = /(sign in to apply|log in to apply|create an account to apply|please log in to continue)/i;

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
    if (await captchaWidgets.nth(i).isVisible().catch(() => false)) {
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
