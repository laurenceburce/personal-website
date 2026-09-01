// Pure data, deliberately split out of atsResolver.js: that file imports
// `playwright` at the top level (needed for its actual browser-based
// resolution logic), and ANY import from a module — even just for an
// unrelated named export — evaluates that module's own top-level imports too.
// jobSearchCompanyDirectory.js only ever needed the SUBMITTABLE_ATS_TYPES set,
// but importing it from atsResolver.js pulled Playwright into the main web
// app's build: page.js -> jobSearchCompanyDirectory.js -> atsResolver.js ->
// jobSearchBrowser.js -> `import { chromium } from "playwright"`, which broke
// the standalone production build ("Cannot find module
// .../playwright-core/browsers.json") since the main app was never set up to
// bundle Playwright at all — only the separate worker services have it, via
// their own Docker image. Confirmed
// live in production logs. Anything that only needs these constants (not the
// actual browser-driven resolution) must import from here, never from
// atsResolver.js.

// Only greenhouse/lever/ashby/workable/recruitee/personio/breezy/
// oracle_fusion have a submission adapter (see jobSearchAdapters/index.js).
// Everything else here is recognized purely so a posting gets labeled accurately (e.g.
// "workday") instead of a generic "external" one. Confirmed live that none
// of the rest are realistically automatable: SmartRecruiters and iCIMS both
// hard bot-wall their application flow before it renders at all; Workday
// requires per-tenant account creation and a non-standard component
// framework; legacy Taleo (oracle_taleo, the taleo.net domain — a genuinely
// different, older product than Fusion) shares that same enterprise-account
// shape and has never been live-tested. Lever and Recruitee were promoted
// from polling-only once the submit-worker gained a live CAPTCHA relay: the
// worker still never solves hCaptcha itself, but it can now pause on the
// real employer page, let the account owner solve it, and then continue the
// same conservative adapter flow.
//
// oracle_fusion (Oracle Recruiting/Fusion Cloud, the oraclecloud.com domain
// — NOT the same product as legacy taleo.net, see oracle_taleo above) is a
// separate, later addition, live-tested against Oracle's own real careers
// site (careers.oracle.com, which itself runs on Fusion): its "Candidate
// Experience" REST API (recruitingCEJobRequisitions/
// recruitingCEJobRequisitionDetails) is genuinely public and unauthenticated
// — confirmed live with a plain unauthenticated curl, no cookies — despite
// the back-office HCM Recruiting Cloud API being OAuth-gated as previously
// assumed here; that assumption only ever held for the back-office surface,
// never for the public-facing site's own API. Its apply flow has no
// third-party SSO wall either — confirmed live, "Apply Now" leads straight
// to Oracle's own lightweight email-based flow (no password, no account),
// which does require a one-time emailed verification code, so submission
// still needs a saved per-tenant session (see oracleFusion.js's header
// comment) — just a much lighter connect step than an SSO login would be.
export const ATS_DOMAIN_PATTERNS = [
  { atsType: "greenhouse", pattern: /(^|\.)greenhouse\.io$/i },
  { atsType: "lever", pattern: /(^|\.)lever\.co$/i },
  { atsType: "ashby", pattern: /(^|\.)ashbyhq\.com$/i },
  { atsType: "workable", pattern: /(^|\.)workable\.com$/i },
  { atsType: "recruitee", pattern: /(^|\.)recruitee\.com$/i },
  { atsType: "personio", pattern: /(^|\.)jobs\.personio\.(de|com)$/i },
  { atsType: "breezy", pattern: /(^|\.)breezy\.hr$/i },
  { atsType: "smartrecruiters", pattern: /(^|\.)smartrecruiters\.com$/i },
  { atsType: "workday", pattern: /(^|\.)myworkdayjobs\.com$/i },
  { atsType: "icims", pattern: /(^|\.)icims\.com$/i },
  { atsType: "oracle_fusion", pattern: /(^|\.)oraclecloud\.com$/i },
  { atsType: "oracle_taleo", pattern: /(^|\.)taleo\.net$/i }
];

// Every type resolveAtsDestination() can possibly return — once a posting is
// labeled as any of these, resolvePostingForSubmission() never re-resolves it
// again, even if it's one with no adapter. Re-running a full browser launch
// against a platform already confirmed unsubmittable would just burn time
// for the same answer every time.
export const KNOWN_ATS_TYPES = new Set(ATS_DOMAIN_PATTERNS.map((p) => p.atsType));

// Only these have a real submission adapter (jobSearchAdapters/index.js).
// CAPTCHA-gated platforms are included only when the live relay can hand the
// challenge to the account owner and then resume a normal form-fill path.
export const SUBMITTABLE_ATS_TYPES = new Set([
  "greenhouse",
  "lever",
  "ashby",
  "workable",
  "recruitee",
  "personio",
  "breezy",
  "oracle_fusion"
]);

// Companies on any of these get their postings actually fetched by
// jobSearchDirectPoll.js — a strict superset of SUBMITTABLE_ATS_TYPES.
// Polling (finding postings from a platform's own public API) and
// submitting (auto-filling that platform's application form) are
// independent capabilities:
// - Recruitee/Personio/Breezy HR/SmartRecruiters all have a confirmed
//   public, unauthenticated polling API (see jobSearchAtsSources.js).
//   Recruitee, Personio, and Breezy now also have submission adapters.
//   SmartRecruiters remains polling/manual-review only because its apply
//   flow is bot-walled or fails to expose a direct form. SmartRecruiters'
//   polling API is unrelated to its bot-walled apply form — confirmed live
//   to be the same read-only endpoint its own public job board widget
//   already calls, no auth, no CAPTCHA.
// - Workday and oracle_fusion are here too, but reached differently from the
//   rest: neither has a GUESSABLE public API. Workday needs 3 pieces
//   (tenant/datacenter/site); oracle_fusion needs 3 of its own (hostname,
//   e.g. "eeho.fa.us2.oraclecloud.com" / site name, e.g. "jobsearch" / site
//   number, e.g. "CX_45001") — none derivable from a company name the way a
//   single slug is for everything else, so jobSearchCompanyProbe.js never
//   adds a row for either. Instead, atsResolver.js parses an already-
//   resolved real posting URL (from an Adzuna-discovered posting) into those
//   pieces the first time one is seen, registers the company, and every
//   poll after that fetches the REST of that company's board too — see
//   fetchWorkdayJobs's/fetchOracleFusionJobs's own comments in
//   jobSearchAtsSources.js.
// - iCIMS and legacy Taleo (oracle_taleo) are deliberately left OUT of this
//   set even after a real attempt to find an equivalent path for them:
//   iCIMS has no public feed at all (confirmed live — a real iCIMS-hosted
//   tenant's `/api/jobs` and `/jobs/search` both just returned an unrelated
//   CMS shell, not job data; some iCIMS/Jibe sites reportedly expose one,
//   but none could be confirmed working), and legacy Taleo (the taleo.net
//   domain — a different, older product than Fusion, see
//   ATS_DOMAIN_PATTERNS' comment) has never been live-tested for an
//   equivalent anonymous read path the way Fusion's oracle_fusion now has.
//   Both stay label-only.
export const POLLABLE_ATS_TYPES = new Set([...SUBMITTABLE_ATS_TYPES, "smartrecruiters", "workday"]);
