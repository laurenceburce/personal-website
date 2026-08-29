// Shared across every submission adapter. Confirmed live against a real Ashby
// form (Ramp's "Security Engineer, Cloud" posting): a genuine reCAPTCHA
// (`g-recaptcha-response`) AND a separate, textual "decode this and prove
// you're not a bot" anti-automation puzzle in the ordinary question flow.
// Anything this detects must never be solved or worked around — only
// reported so the caller can skip the application, never guessed at.
const CAPTCHA_WIDGET_SELECTORS = [
  ".g-recaptcha",
  "[name=\"g-recaptcha-response\"]",
  "iframe[src*=\"recaptcha\"]",
  ".h-captcha",
  "iframe[src*=\"hcaptcha\"]",
  "iframe[src*=\"turnstile\"]",
  "[data-sitekey]"
].join(", ");

const ANTI_BOT_TEXT_SIGNALS = /(prove (that )?you('re| are) not a (bot|robot)|not a bot auto-?applying|solve the (following )?(captcha|puzzle|challenge)|human verification|figure out the (correct )?secret)/i;
const LOGIN_WALL_SIGNALS = /(sign in to apply|log in to apply|create an account to apply|please log in to continue)/i;

// Returns a short human-readable reason string if this application should be
// treated as blocked, or null if nothing was detected. Deliberately checked
// BEFORE any field is filled — no point answering nine questions only to
// discover the tenth is an unsolvable anti-bot puzzle.
export async function detectSubmissionBlocker(scope) {
  const hasCaptchaWidget = await scope.locator(CAPTCHA_WIDGET_SELECTORS).count().catch(() => 0) > 0;
  if (hasCaptchaWidget) return "CAPTCHA widget present on the application form.";

  const bodyText = await scope.locator("body").innerText().catch(() => "");
  if (ANTI_BOT_TEXT_SIGNALS.test(bodyText)) {
    return "Anti-automation challenge question present in the application form.";
  }
  if (LOGIN_WALL_SIGNALS.test(bodyText)) {
    return "Application requires signing in / creating an account first.";
  }

  return null;
}
