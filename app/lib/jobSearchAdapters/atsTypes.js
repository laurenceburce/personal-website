// Pure data, deliberately split out of atsResolver.js: that file imports
// `playwright` at the top level (needed for its actual browser-based
// resolution logic), and ANY import from a module — even just for an
// unrelated named export — evaluates that module's own top-level imports too.
// jobSearchCompanyDirectory.js only ever needed the SUBMITTABLE_ATS_TYPES set,
// but importing it from atsResolver.js pulled Playwright into the main web
// app's build: page.js -> jobSearchCompanyDirectory.js -> atsResolver.js ->
// `import { chromium } from "playwright"`, which broke the standalone
// production build ("Cannot find module .../playwright-core/browsers.json")
// since the main app was never set up to bundle Playwright at all — only the
// separate worker services have it, via their own Docker image. Confirmed
// live in production logs. Anything that only needs these constants (not the
// actual browser-driven resolution) must import from here, never from
// atsResolver.js.

// Only greenhouse/ashby/workable have a submission adapter (see
// jobSearchAdapters/index.js) — everything else here is recognized purely so
// a posting gets labeled accurately (e.g. "workday") instead of a generic
// "external" one. Confirmed live that none of the rest are realistically
// automatable: SmartRecruiters and iCIMS both hard bot-wall their
// application flow before it renders at all; Workday requires per-tenant
// account creation and a non-standard component framework; Oracle
// Recruiting/Taleo shares that same enterprise-account shape (two domain
// families depending on whether a company is still on legacy Taleo or
// migrated to Oracle Fusion Recruiting Cloud); Recruitee's own apply form
// ships an invisible hCaptcha by default (confirmed live: a real
// `captchaToken` field plus a `"captcha":"invisible"` app-config flag on a
// real company's live board) — the same bot-wall category as SmartRecruiters/
// iCIMS, just discovered later. Lever joined that same bucket during a later
// audit pass: it now ships a real hCaptcha (`id="h-captcha"`, a genuine
// `data-sitekey`, an actual hcaptcha.com iframe — confirmed live) on its
// apply form platform-wide, not per-company — tested against 5 unrelated
// companies (Aeva, Shield AI, Palantir, Filevine, Provectus), all 5 blocked.
// lever.js's adapter code is left in place (unregistered in
// jobSearchAdapters/index.js, see its own comment) rather than deleted, in
// case Lever ever drops this. Personio and Breezy HR ARE polled (see
// POLLABLE_ATS_TYPES below) despite having no submission adapter either —
// unlike the others on this list, neither has a *confirmed* bot-wall; their
// apply forms simply haven't been live-verified with headed Playwright yet,
// so postings from them still surface for manual review/apply rather than
// being lumped in with the confirmed-unautomatable platforms.
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
  { atsType: "oracle_taleo", pattern: /(^|\.)(taleo\.net|oraclecloud\.com)$/i }
];

// Every type resolveAtsDestination() can possibly return — once a posting is
// labeled as any of these, resolvePostingForSubmission() never re-resolves it
// again, even if it's one with no adapter. Re-running a full browser launch
// against a platform already confirmed unsubmittable would just burn time
// for the same answer every time.
export const KNOWN_ATS_TYPES = new Set(ATS_DOMAIN_PATTERNS.map((p) => p.atsType));

// Only these three have a real submission adapter (jobSearchAdapters/index.js).
// Lever is deliberately NOT here despite having working adapter code — see
// the ATS_DOMAIN_PATTERNS comment above (confirmed-live platform-wide hCaptcha).
export const SUBMITTABLE_ATS_TYPES = new Set(["greenhouse", "ashby", "workable"]);

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
//   public, unauthenticated polling API (see jobSearchAtsSources.js) even
//   though none has a submission adapter, so their postings still flow into
//   scoring/review for the human to apply to by hand. SmartRecruiters'
//   polling API in particular is unrelated to its bot-walled apply form —
//   confirmed live to be the same read-only endpoint its own public job
//   board widget already calls, no auth, no CAPTCHA.
// - Workday is here too, but reached differently from the rest: it has no
//   GUESSABLE public API (a board needs 3 pieces — tenant/datacenter/site —
//   none derivable from a company name the way a single slug is for
//   everything else), so jobSearchCompanyProbe.js never adds a Workday row.
//   Instead, atsResolver.js parses an already-resolved real Workday URL
//   (from an Adzuna-discovered posting) into those 3 pieces the first time
//   one is seen, registers the company, and every poll after that fetches
//   the REST of that company's board too — see fetchWorkdayJobs's own
//   comment in jobSearchAtsSources.js.
// - iCIMS and Oracle Taleo are deliberately left OUT of this set even after
//   a real attempt to find an equivalent path for them: iCIMS has no public
//   feed at all (confirmed live — a real iCIMS-hosted tenant's `/api/jobs`
//   and `/jobs/search` both just returned an unrelated CMS shell, not job
//   data; some iCIMS/Jibe sites reportedly expose one, but none could be
//   confirmed working), and Oracle Taleo/Fusion's REST surface is
//   customer/OAuth-gated with no equivalent anonymous read path documented
//   anywhere. Both stay label-only, same as before.
export const POLLABLE_ATS_TYPES = new Set([...SUBMITTABLE_ATS_TYPES, "lever", "recruitee", "personio", "breezy", "smartrecruiters", "workday"]);
