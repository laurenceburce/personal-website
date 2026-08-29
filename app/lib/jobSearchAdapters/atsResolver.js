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

const RESOLVE_TIMEOUT_MS = 20000;
const REAL_BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Only greenhouse/lever/ashby/workable have a submission adapter (see
// SUBMITTABLE_ATS_TYPES below and jobSearchAdapters/index.js) —
// the other four are recognized purely so a posting gets labeled accurately
// (e.g. "workday") instead of a generic "external" one. Confirmed live that
// none of them are realistically automatable: SmartRecruiters and iCIMS both
// hard bot-wall their application flow before it renders at all; Workday
// requires per-tenant account creation and a non-standard component
// framework; Oracle Recruiting/Taleo shares that same enterprise-account
// shape (two domain families depending on whether a company is still on
// legacy Taleo or migrated to Oracle Fusion Recruiting Cloud).
const ATS_DOMAIN_PATTERNS = [
  { atsType: "greenhouse", pattern: /(^|\.)greenhouse\.io$/i },
  { atsType: "lever", pattern: /(^|\.)lever\.co$/i },
  { atsType: "ashby", pattern: /(^|\.)ashbyhq\.com$/i },
  { atsType: "workable", pattern: /(^|\.)workable\.com$/i },
  { atsType: "smartrecruiters", pattern: /(^|\.)smartrecruiters\.com$/i },
  { atsType: "workday", pattern: /(^|\.)myworkdayjobs\.com$/i },
  { atsType: "icims", pattern: /(^|\.)icims\.com$/i },
  { atsType: "oracle_taleo", pattern: /(^|\.)(taleo\.net|oraclecloud\.com)$/i }
];

// Every type resolveAtsDestination() can possibly return — once a posting is
// labeled as any of these, resolvePostingForSubmission() never re-resolves it
// again, even if it's one of the four with no adapter (see below). Re-running
// a full browser launch against a platform already confirmed unsubmittable
// would just burn time for the same answer every time.
const KNOWN_ATS_TYPES = new Set(ATS_DOMAIN_PATTERNS.map((p) => p.atsType));
// Only these three have a real submission adapter (jobSearchAdapters/index.js).
// The other four in ATS_DOMAIN_PATTERNS are detected purely for accurate
// labeling — confirmed live that none of them are realistically automatable
// (SmartRecruiters/iCIMS hard bot-wall the application page before it even
// renders; Workday/Oracle Recruiting/Taleo require per-tenant account
// creation and use non-standard, heavily customized form frameworks).
export const SUBMITTABLE_ATS_TYPES = new Set(["greenhouse", "lever", "ashby", "workable"]);

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
