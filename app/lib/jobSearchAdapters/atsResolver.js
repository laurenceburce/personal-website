// Discovery (Adzuna) never knows a posting's real ATS — every posting it
// creates is tagged atsType: "external" (see jobSearchDiscovery.js). This is
// the missing link: given an approved posting's applyUrl, use a real browser
// (confirmed live: a plain fetch() never gets past Adzuna's own redirect —
// see jobSearchDiscovery.js's module comment) to find out whether it actually
// lands on a Greenhouse/Lever/Ashby-hosted application page, so the right
// adapter can be dispatched instead of automatically falling through to
// "unsupported ATS". Read-only — never fills or submits anything.
import { chromium } from "playwright";
import { updatePostingAtsResolution } from "../jobSearchPostingsStore.js";
import { ATS_DOMAIN_PATTERNS, KNOWN_ATS_TYPES, SUBMITTABLE_ATS_TYPES } from "./atsTypes.js";

// Re-exported so existing importers (jobSearchAutoApply.js) don't need to
// change — but anything that only needs the constant, not the actual
// browser-based resolution below, should import it from atsTypes.js
// directly instead. This file pulls in `playwright` at module scope, which
// must never be reachable from the main web app's page.js — see atsTypes.js.
export { SUBMITTABLE_ATS_TYPES };

const RESOLVE_TIMEOUT_MS = 20000;
const REAL_BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function detectAtsType(url) {
  try {
    const host = new URL(url).hostname;
    for (const { atsType, pattern } of ATS_DOMAIN_PATTERNS) {
      if (pattern.test(host)) return atsType;
    }
  } catch {
    // Malformed URL — treat as unresolved, not an error.
  }
  return null;
}

// Every adapter/poller in this codebase keys postings by (ats_type,
// board_token, external_job_id) — extracting a token here keeps a
// resolved posting consistent with that same shape, in case it's ever
// cross-referenced against a fetchGreenhouseJobs/fetchLeverJobs/
// fetchAshbyJobs-sourced row for the same company.
function extractBoardToken(url) {
  try {
    return new URL(url).pathname.match(/^\/([^/]+)/)?.[1] || null;
  } catch {
    return null;
  }
}

// Navigates to a discovery-sourced apply link and inspects wherever it
// actually lands. Some aggregator pages (confirmed live for Adzuna's own
// /details/ page) don't hard-redirect — the real employer link is a further
// on-page "Apply"/"Apply now" element a visitor has to follow — so this also
// checks for that before giving up. Returns null (never throws) whenever it
// can't confidently resolve to a supported ATS; callers should treat that
// exactly like "unsupported ATS" today.
export async function resolveAtsDestination(applyUrl, { headless = true } = {}) {
  if (!applyUrl) return null;

  let browser;
  try {
    browser = await chromium.launch({ headless });
    const page = await browser.newPage({ userAgent: REAL_BROWSER_USER_AGENT });
    await page.goto(applyUrl, { waitUntil: "domcontentloaded", timeout: RESOLVE_TIMEOUT_MS });
    await page.waitForTimeout(1000);

    let finalUrl = page.url();
    let atsType = detectAtsType(finalUrl);

    if (!atsType) {
      const applyHref = await page
        .locator(
          'a[href*="greenhouse.io"], a[href*="lever.co"], a[href*="ashbyhq.com"], a[href*="workable.com"], ' +
          'a[href*="smartrecruiters.com"], a[href*="myworkdayjobs.com"], a[href*="icims.com"], ' +
          'a[href*="taleo.net"], a[href*="oraclecloud.com"], a:has-text("Apply")'
        )
        .first()
        .getAttribute("href")
        .catch(() => null);
      if (applyHref) {
        const detected = detectAtsType(applyHref);
        if (detected) {
          atsType = detected;
          finalUrl = applyHref;
        }
      }
    }

    if (!atsType) return null;
    const boardToken = extractBoardToken(finalUrl);
    if (!boardToken) return null;

    return { atsType, applyUrl: finalUrl, boardToken };
  } catch {
    // Timeout, geo-block, DNS failure, whatever — resolution is best-effort;
    // a failure here means "stays unsupported", never a thrown error that
    // could take down a caller.
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

// Shared by both submission paths — auto-apply (jobSearchAutoApply.js) and
// the manual submit-worker (scripts/job-search-submit-worker.mjs) — so a
// human-approved posting gets exactly the same ATS resolution auto-apply
// already got, instead of only ever resolving for the (off by default)
// auto-apply path and always reporting "unsupported ATS" for everything a
// human approves by hand.
//
// Resolves and PERSISTS the result onto the posting row: once labeled as
// anything in KNOWN_ATS_TYPES (including the four with no adapter), this
// never re-resolves that posting again — a real browser launch isn't worth
// repeating for an answer that can't change.
export async function resolvePostingForSubmission(posting) {
  if (KNOWN_ATS_TYPES.has(posting.atsType)) {
    return { atsType: posting.atsType, applyUrl: posting.applyUrl, resolved: false };
  }

  const resolved = await resolveAtsDestination(posting.applyUrl).catch(() => null);
  if (!resolved) {
    return { atsType: posting.atsType, applyUrl: posting.applyUrl, resolved: false };
  }

  await updatePostingAtsResolution(posting.id, resolved).catch(() => {});
  return { atsType: resolved.atsType, applyUrl: resolved.applyUrl, resolved: true };
}
