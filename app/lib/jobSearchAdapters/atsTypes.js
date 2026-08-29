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

// Only greenhouse/lever/ashby/workable have a submission adapter (see
// jobSearchAdapters/index.js) — the other four are recognized purely so a
// posting gets labeled accurately (e.g. "workday") instead of a generic
// "external" one. Confirmed live that none of them are realistically
// automatable: SmartRecruiters and iCIMS both hard bot-wall their
// application flow before it renders at all; Workday requires per-tenant
// account creation and a non-standard component framework; Oracle
// Recruiting/Taleo shares that same enterprise-account shape (two domain
// families depending on whether a company is still on legacy Taleo or
// migrated to Oracle Fusion Recruiting Cloud).
export const ATS_DOMAIN_PATTERNS = [
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
// again, even if it's one of the four with no adapter. Re-running a full
// browser launch against a platform already confirmed unsubmittable would
// just burn time for the same answer every time.
export const KNOWN_ATS_TYPES = new Set(ATS_DOMAIN_PATTERNS.map((p) => p.atsType));

// Only these four have a real submission adapter (jobSearchAdapters/index.js).
export const SUBMITTABLE_ATS_TYPES = new Set(["greenhouse", "lever", "ashby", "workable"]);
