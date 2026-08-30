// Discovery (Adzuna) never knows a posting's real ATS — every posting it
// creates is tagged atsType: "external" (see jobSearchDiscovery.js). This is
// the missing link: given an approved posting's applyUrl, use a real browser
// (confirmed live: a plain fetch() never gets past Adzuna's own redirect —
// see jobSearchDiscovery.js's module comment) to find out whether it actually
// lands on a Greenhouse/Lever/Ashby-hosted application page, so the right
// adapter can be dispatched instead of automatically falling through to
// "unsupported ATS". Read-only — never fills or submits anything.
import { registerDiscoveredCompany } from "../jobSearchCompanyDirectory.js";
import { updatePostingAtsResolution } from "../jobSearchPostingsStore.js";
import { ATS_DOMAIN_PATTERNS, KNOWN_ATS_TYPES, SUBMITTABLE_ATS_TYPES } from "./atsTypes.js";
import { launchJobSearchBrowser } from "./jobSearchBrowser.js";

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

// Workday needs its own extraction: a board is 3 pieces (tenant/datacenter/
// site), not the single first-path-segment slug every other platform uses —
// confirmed live against real boards that the site segment isn't reliably
// "first" or "last" either (some tenants put a locale segment first, e.g.
// "/en-US/{site}/job/...", some don't, e.g. "/{site}/job/..."). The one fixed
// marker every real job URL has is "/job/" itself, so site is found relative
// to that. No locale handling needed beyond that — Workday's own "CXS" API
// (jobSearchAtsSources.js's fetchWorkdayJobs) never needs the locale, only
// {tenant, dc, site}.
function parseWorkdayBoardUrl(url) {
  try {
    const parsed = new URL(url);
    const hostMatch = parsed.hostname.match(/^([^.]+)\.(wd\d+)\.myworkdayjobs\.com$/i);
    if (!hostMatch) return null;
    const [, tenant, dc] = hostMatch;
    const segments = parsed.pathname.split("/").filter(Boolean);
    const jobIndex = segments.indexOf("job");
    const site = jobIndex > 0 ? segments[jobIndex - 1] : segments[0];
    return site ? { tenant, dc: dc.toLowerCase(), site } : null;
  } catch {
    return null;
  }
}

// oracle_fusion needs its own 3-piece extraction too, same shape of problem
// as Workday: a board is {hostname, siteName, siteNumber}, and siteNumber
// (e.g. "CX_45001") isn't anywhere in the URL itself — confirmed live it IS
// embedded in the page's own raw server-rendered HTML (a plain `curl`, no JS
// execution needed, already contains it), so `html` is the already-loaded
// page's content rather than a second network round trip. siteName is the
// URL path segment right after "/sites/" (confirmed live: every real job/
// jobs-listing URL follows ".../CandidateExperience/en/sites/{siteName}/...").
function parseOracleFusionBoardUrl(url, html) {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)oraclecloud\.com$/i.test(parsed.hostname)) return null;
    const segments = parsed.pathname.split("/").filter(Boolean);
    const sitesIndex = segments.indexOf("sites");
    const siteName = sitesIndex >= 0 ? segments[sitesIndex + 1] : null;
    const siteNumber = String(html || "").match(/\bCX_\d+\b/)?.[0] || null;
    return siteName && siteNumber ? { hostname: parsed.hostname, siteName, siteNumber } : null;
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
    const browserSession = await launchJobSearchBrowser({ headless });
    browser = browserSession.browser;
    const page = await browserSession.newPage({ userAgent: REAL_BROWSER_USER_AGENT });
    await page.goto(applyUrl, { waitUntil: "domcontentloaded", timeout: RESOLVE_TIMEOUT_MS });
    await page.waitForTimeout(1000);

    let finalUrl = page.url();
    let atsType = detectAtsType(finalUrl);

    if (!atsType) {
      const applyHref = await page
        .locator(
          'a[href*="greenhouse.io"], a[href*="lever.co"], a[href*="ashbyhq.com"], a[href*="workable.com"], ' +
          'a[href*="recruitee.com"], a[href*="jobs.personio.de"], a[href*="jobs.personio.com"], a[href*="breezy.hr"], ' +
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
    // Workday's boardToken is "tenant::dc::site" (see parseWorkdayBoardUrl);
    // oracle_fusion's is "hostname::siteName::siteNumber" (see
    // parseOracleFusionBoardUrl) — neither is the generic first-path-segment
    // slug everything else uses.
    const boardToken = atsType === "workday"
      ? (() => {
          const workday = parseWorkdayBoardUrl(finalUrl);
          return workday ? `${workday.tenant}::${workday.dc}::${workday.site}` : null;
        })()
      : atsType === "oracle_fusion"
        ? await (async () => {
            // finalUrl may be a same-host link found on the page (the applyHref
            // fallback above) rather than the page actually navigated to —
            // page.content() is only guaranteed to match the URL that was
            // actually loaded, so re-fetch when they differ. The plain oracle
            // detail/listing pages need no auth for this (confirmed live).
            const html = finalUrl === page.url()
              ? await page.content().catch(() => "")
              : await fetch(finalUrl).then((r) => r.text()).catch(() => "");
            const oracle = parseOracleFusionBoardUrl(finalUrl, html);
            return oracle ? `${oracle.hostname}::${oracle.siteName}::${oracle.siteNumber}` : null;
          })()
        : extractBoardToken(finalUrl);
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

  // Workday and oracle_fusion only ever enter the company directory this way
  // (see atsTypes.js's POLLABLE_ATS_TYPES comment) — the moment one posting
  // resolves to a real board on either, register the company so direct-poll
  // starts fetching the REST of its board too, not just this one posting.
  if (resolved.atsType === "workday" || resolved.atsType === "oracle_fusion") {
    await registerDiscoveredCompany({
      companyName: posting.companyName,
      atsType: resolved.atsType,
      boardToken: resolved.boardToken
    }).catch(() => {});
  }

  return { atsType: resolved.atsType, applyUrl: resolved.applyUrl, resolved: true };
}
