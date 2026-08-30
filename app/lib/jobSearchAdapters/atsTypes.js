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

// Only greenhouse/ashby/workable/personio/breezy/oracle_fusion have a
// submission adapter (see jobSearchAdapters/index.js) — everything else
// here is recognized purely so a posting gets labeled accurately (e.g.
// "workday") instead of a generic "external" one. Confirmed live that none
// of the rest are realistically automatable: SmartRecruiters and iCIMS both
// hard bot-wall their application flow before it renders at all; Workday
// requires per-tenant account creation and a non-standard component
// framework; legacy Taleo (oracle_taleo, the taleo.net domain — a genuinely
// different, older product than Fusion) shares that same enterprise-account
// shape and has never been live-tested; Recruitee's own apply form ships an
// invisible hCaptcha by default (confirmed live: a real `captchaToken`
// field plus a `"captcha":"invisible"` app-config flag on a real company's
// live board) — the same bot-wall category as SmartRecruiters/iCIMS, just
// discovered later. Lever joined that same bucket during a later audit
// pass: it now ships a real hCaptcha (`id="h-captcha"`, a genuine
// `data-sitekey`, an actual hcaptcha.com iframe — confirmed live) on its
// apply form platform-wide, not per-company — tested against 5 unrelated
// companies (Aeva, Shield AI, Palantir, Filevine, Provectus), all 5 blocked.
// A later check against the existing Lever adapter still returned
// `blocked` for a live Palantir posting, so the adapter file was removed and
// Lever stays pollable-only. Personio and Breezy HR were later live-audited
// with CDP mouse dispatch against multiple application forms: both rendered
// direct forms with no CAPTCHA/account wall, so they now have conservative
// adapters registered.
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
// Lever is deliberately NOT here — see the ATS_DOMAIN_PATTERNS comment above
// (confirmed-live platform-wide hCaptcha).
export const SUBMITTABLE_ATS_TYPES = new Set(["greenhouse", "ashby", "workable", "personio", "breezy", "oracle_fusion"]);

// Companies on any of these get their postings actually fetched by
// jobSearchDirectPoll.js — a strict superset of SUBMITTABLE_ATS_TYPES.
// Polling (finding postings from a platform's own public API) and
// submitting (auto-filling that platform's application form) are
// independent capabilities:
// - Lever still has a perfectly good public polling API (unrelated to its
//   apply form's CAPTCHA — confirmed live, the CAPTCHA only exists on the
//   apply page, not the JSON board endpoint), so it's listed here explicitly
//   even though it's no longer in SUBMITTABLE_ATS_TYPES — its postings still
//   flow into scoring/review for the human to apply to by hand, exactly like
//   SmartRecruiters below.
// - Recruitee/Personio/Breezy HR/SmartRecruiters all have a confirmed
//   public, unauthenticated polling API (see jobSearchAtsSources.js).
//   Personio and Breezy now also have submission adapters; Recruitee and
//   SmartRecruiters remain polling/manual-review only because their apply
//   flows are blocked or fail to expose a direct form. SmartRecruiters'
//   polling API in particular is unrelated to its bot-walled apply form —
//   confirmed live to be the same read-only endpoint its own public job
//   board widget already calls, no auth, no CAPTCHA.
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
export const POLLABLE_ATS_TYPES = new Set([...SUBMITTABLE_ATS_TYPES, "lever", "recruitee", "smartrecruiters", "workday"]);
