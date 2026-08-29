// Keyword-based discovery via Adzuna — the sole posting source for this
// system, finding postings without specifying any company up front. It
// searches across the whole web by title keywords + location, the same way a
// person would search on a job board, rather than polling a known list of
// company ATS boards.
//
// Adzuna's free tier is far more limited than the ATS APIs (roughly
// 1,000 calls/month, not officially published but widely corroborated), so
// this is throttled independently via find_settings.discovery_last_run_at —
// see shouldRunDiscovery() — regardless of how often the poll cron itself runs.
import { computeContentHash, guessRemoteType, guessSeniority, MAX_DESCRIPTION_TEXT_CHARS, stripHtml } from "./jobSearchAtsSources.js";
import { upsertPosting } from "./jobSearchPostingsStore.js";
import { markDiscoveryRun } from "./jobSearchSettingsStore.js";

const FETCH_TIMEOUT_MS = 20000;
const DEFAULT_DISCOVERY_INTERVAL_MINUTES = 60;

// Adzuna doesn't return currency directly per result — it's implied by which
// country's endpoint was queried. Covers the country codes Adzuna documents;
// falls back to null (no guess) for anything else.
const COUNTRY_CURRENCY = {
  us: "USD", gb: "GBP", ca: "CAD", au: "AUD", de: "EUR", fr: "EUR", nl: "EUR",
  at: "EUR", be: "EUR", it: "EUR", es: "EUR", pl: "PLN", in: "INR", sg: "SGD",
  za: "ZAR", nz: "NZD", mx: "MXN", br: "BRL"
};

export function isAdzunaConfigured() {
  return Boolean(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY);
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${url.split("?")[0]} responded with ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

// True once discoveryIntervalMinutes (default 60) has elapsed since the last
// discovery run — checked by the caller before spending an Adzuna call, so the
// throttle holds regardless of how often the underlying poll cron fires.
export function shouldRunDiscovery(findSettings) {
  if (!findSettings.discoveryEnabled) return false;
  if (!findSettings.discoveryLastRunAt) return true;
  const intervalMs = (findSettings.discoveryIntervalMinutes || DEFAULT_DISCOVERY_INTERVAL_MINUTES) * 60 * 1000;
  return Date.now() - new Date(findSettings.discoveryLastRunAt).getTime() >= intervalMs;
}

// `what_or` matches any of the space-separated terms (vs. `what`, which
// requires all of them) — the right mode for a list of acceptable title
// variants, same broad-net philosophy as the hard filter's own keyword match.
export async function fetchAdzunaJobs({ keywords, location, country = "us", resultsPerPage = 50 }) {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) throw new Error("ADZUNA_APP_ID/ADZUNA_APP_KEY is not configured.");

  const params = new URLSearchParams({
    app_id: appId,
    app_key: appKey,
    results_per_page: String(resultsPerPage),
    "content-type": "application/json"
  });

  const whatOr = (keywords || []).filter(Boolean).join(" ");
  if (whatOr) params.set("what_or", whatOr);
  if (location) params.set("where", location);

  const countryCode = (country || "us").toLowerCase();
  const url = `https://api.adzuna.com/v1/api/jobs/${encodeURIComponent(countryCode)}/search/1?${params.toString()}`;
  const data = await fetchJson(url);
  const results = Array.isArray(data?.results) ? data.results : [];

  return results.map((job) => {
    const descriptionText = stripHtml(job.description || "").slice(0, MAX_DESCRIPTION_TEXT_CHARS);
    const title = job.title || "";
    const locationText = job.location?.display_name || "";

    return {
      // 'external' — no ATS adapter is registered for this type, so submission
      // correctly falls through to needs-manual-apply (see jobSearchAdapters/index.js)
      // until/unless a future pass resolves redirect_url to a real ATS domain
      // and re-tags it as greenhouse/lever/ashby.
      atsType: "external",
      boardToken: "adzuna",
      externalJobId: String(job.id),
      companyName: job.company?.display_name || "Unknown",
      title,
      department: job.category?.label || "",
      locationText,
      remoteType: guessRemoteType(locationText, descriptionText),
      seniorityGuess: guessSeniority(title),
      salaryMin: job.salary_min != null ? Math.round(Number(job.salary_min)) : null,
      salaryMax: job.salary_max != null ? Math.round(Number(job.salary_max)) : null,
      salaryCurrency: COUNTRY_CURRENCY[countryCode] || null,
      descriptionText,
      applyUrl: job.redirect_url || "",
      postedAt: job.created ? new Date(job.created) : null,
      contentHash: computeContentHash(title, descriptionText)
    };
  });
}

// Shared by the poll-cron worker (throttle-gated via shouldRunDiscovery) and
// the manual "Run Discovery Now" button (bypasses the throttle on purpose —
// that's the point of a manual trigger — but still records the run so the
// cron's own timer doesn't immediately fire again right after).
export async function runDiscoveryPass(findSettings) {
  if (!isAdzunaConfigured()) {
    return { ok: false, reason: "ADZUNA_APP_ID/ADZUNA_APP_KEY is not configured.", found: 0, created: 0 };
  }

  const jobs = await fetchAdzunaJobs({
    keywords: findSettings.titleKeywords,
    location: findSettings.discoveryLocation,
    country: findSettings.discoveryCountry
  });

  let created = 0;
  for (const job of jobs) {
    const result = await upsertPosting(job);
    if (result.isNew) created += 1;
  }

  await markDiscoveryRun();
  return { ok: true, found: jobs.length, created };
}
