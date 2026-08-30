// Auto-discovers a company's ATS board by guessing its slug against each
// platform's free, unauthenticated public API — the same manual process used
// to find every real test company this session (Palantir on Lever, Ramp on
// Ashby, Codurance on Workable, Equinox on SmartRecruiters, Vinted on
// Recruitee, Attentive on Breezy HR, Prenode on Personio), just automated.
// This is the mechanism behind direct polling: once a company is confirmed
// here, jobSearchDirectPoll.js can fetch its postings straight from the ATS
// instead of relying solely on Adzuna ever surfacing them, and any posting
// found this way is tagged with its real ats_type from the start — no lazy
// per-posting resolution needed later. Every platform in POLLABLE_ATS_TYPES
// that's actually guessable this way (greenhouse/lever/ashby/workable/
// recruitee/personio/breezy/smartrecruiters — see jobSearchAdapters/
// atsTypes.js) gets probed for that reason, submission adapter or not —
// SmartRecruiters' own apply-form bot-wall has nothing to do with its
// read-only postings API, which is confirmed live to work fine unauthenticated.
// Workday is also in POLLABLE_ATS_TYPES but deliberately NOT probed here —
// it has no guessable public API (needs 3 pieces — tenant/datacenter/site —
// none derivable from a company name), so it only ever gets added via
// atsResolver.js registering an already-resolved real Workday URL, never via
// slug-guessing. iCIMS/Oracle-Taleo are skipped here entirely and NOT in
// POLLABLE_ATS_TYPES at all — neither exposes a guessable public API the way
// the rest do (confirmed live: iCIMS has no working public feed at all, a
// real hosted tenant's would-be JSON endpoints just returned an unrelated CMS
// shell; Oracle Taleo/Fusion's REST surface is customer/OAuth-gated).
const FETCH_TIMEOUT_MS = 10000;

const COMPANY_SUFFIXES = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|group|holdings|technologies|technology|plc)\b\.?/gi;

export function normalizeCompanyName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(COMPANY_SUFFIXES, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// A handful of plausible slug shapes, most-likely-first — every board token
// confirmed live this session (palantir, ramp, codurance, equinox, canva)
// was exactly one of these shapes.
function generateSlugCandidates(companyName) {
  const normalized = normalizeCompanyName(companyName);
  if (!normalized) return [];
  const words = normalized.split(" ").filter(Boolean);
  // Deliberately NOT including words[0] alone for a multi-word name — confirmed
  // live as a real false-positive source ("some" from "Some Totally Fake Co"
  // happened to be somebody else's real, unrelated Workable account). A
  // single-word company name is unaffected: words.join("") already equals
  // words[0] in that case, so nothing is lost, only the risky partial-name
  // guess for multi-word names is dropped.
  const candidates = new Set([
    words.join(""),
    words.join("-")
  ]);
  return [...candidates].filter((c) => c.length >= 2 && c.length <= 64);
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "job-search-bot/1.0 (personal use, owner-only tool)" } });
    if (!response.ok) return null;
    return await response.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Personio's board is an XML feed, not JSON — a nonexistent subdomain
// redirects (307) to a generic not-found/checkpoint page rather than
// responding 404 directly (confirmed live), which `fetch`'s default
// redirect:"follow" would otherwise quietly turn into a 200 of unrelated
// HTML; `redirect: "manual"` surfaces that as its real, non-200 status
// instead so a nonexistent slug reads as "no hit", not a false positive.
async function fetchTextManualRedirect(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "manual", headers: { "User-Agent": "job-search-bot/1.0 (personal use, owner-only tool)" } });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Guards against a coincidental slug hit on a same-named-but-different small
// company (confirmed live: "notion" on Workable resolved to an unrelated
// Shoreditch agency, not the design-tool Notion) — the platform's own
// returned company name has to share real overlap with what we searched for.
// Exact match only, deliberately: a substring check ("some" inside "some
// totally fake xyz123") also confirmed live as a real false positive for any
// short, generic single-word candidate — far too easy to satisfy by accident.
function namesPlausiblyMatch(searched, returned) {
  const a = normalizeCompanyName(searched);
  const b = normalizeCompanyName(returned);
  return Boolean(a) && a === b;
}

// Every probe below requires at least one CURRENTLY ACTIVE posting, not just
// a structurally valid response for the slug — confirmed live as necessary
// two different ways: a dormant/abandoned account with zero postings can
// exist for a company that doesn't actually use that platform anymore (found
// real Workable accounts for "micron" and "l3harris" with zero jobs and a
// placeholder name identical to the slug — real registrations, just not
// their live ATS), and Lever's own `Array.isArray()` check alone would
// accept an empty array the same way. A company with no open roles at
// probe-time just stays 'unknown' rather than getting mislabeled — no retry
// mechanism exists yet, but that's a safer failure mode than the reverse.

// Every hit below carries jobCount alongside atsType/boardToken — the
// signal probeCompanyAts() uses to pick between more than one genuine match
// for the same slug (an ATS migration leaving a stale-but-still-responding
// old board, or two unrelated companies coincidentally sharing a slug on
// different platforms). A real, currently-used board almost always has
// meaningfully more open postings than a leftover or coincidental one.

async function probeGreenhouse(slug) {
  const data = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=false`);
  if (!data || !Array.isArray(data.jobs) || data.jobs.length === 0) return null;
  return { atsType: "greenhouse", boardToken: slug, jobCount: data.jobs.length };
}

async function probeLever(slug) {
  const data = await fetchJson(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
  if (!Array.isArray(data) || data.length === 0) return null; // {ok:false,...} for a nonexistent site
  return { atsType: "lever", boardToken: slug, jobCount: data.length };
}

async function probeAshby(slug) {
  const data = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`);
  if (!data || !Array.isArray(data.jobs) || data.jobs.length === 0) return null;
  return { atsType: "ashby", boardToken: slug, jobCount: data.jobs.length };
}

async function probeWorkable(slug, companyName) {
  const data = await fetchJson(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}`);
  if (!data || !data.name || !Array.isArray(data.jobs) || data.jobs.length === 0) return null;
  if (!namesPlausiblyMatch(companyName, data.name)) return null;
  return { atsType: "workable", boardToken: slug, jobCount: data.jobs.length };
}

// Confirmed live: an unclaimed/trial Recruitee account for the exact slug
// "google" served a real, structurally valid, exact-name-matching (its own
// company_name field literally said "Google") offer titled "Senior Marketer
// (Sample)" — Recruitee seeds every new signup with this placeholder before
// the account's real user publishes anything, and it survives indefinitely
// on an unused trial subdomain. That one posting alone was otherwise enough
// to pass every check below (real board, name match, jobCount>=1) and
// mislabel a random trial signup as the genuine company sharing that name —
// confirmed as a real false positive via the company-directory backfill, not
// theoretical. Filtered out before any of the other checks even run.
const SAMPLE_POSTING_TITLE = /\(sample\)/i;

async function probeRecruitee(slug, companyName) {
  const data = await fetchJson(`https://${encodeURIComponent(slug)}.recruitee.com/api/offers`);
  const offers = (Array.isArray(data?.offers) ? data.offers : [])
    .filter((offer) => !SAMPLE_POSTING_TITLE.test(offer.title || ""));
  if (offers.length === 0) return null;
  const returnedName = offers[0]?.company_name;
  if (!returnedName || !namesPlausiblyMatch(companyName, returnedName)) return null;
  return { atsType: "recruitee", boardToken: slug, jobCount: offers.length };
}

async function probeBreezy(slug, companyName) {
  const data = await fetchJson(`https://${encodeURIComponent(slug)}.breezy.hr/json`);
  if (!Array.isArray(data) || data.length === 0) return null;
  const returnedName = data[0]?.company?.name;
  if (!returnedName || !namesPlausiblyMatch(companyName, returnedName)) return null;
  return { atsType: "breezy", boardToken: slug, jobCount: data.length };
}

// No company-name field exists anywhere in Personio's XML feed to cross-check
// against — a hit here is trusted on the jobCount signal alone, the same
// posture Greenhouse/Lever/Ashby already have above. That gap is CONFIRMED
// live to produce real false positives, unlike Greenhouse/Lever/Ashby's own
// (still theoretical) version of the same gap: the company-directory
// backfill run found "amazon", "salesforce", and "safetykleen" all
// resolving here to byte-identical placeholder content (a "General
// Application" + a "SEO Marketing Manager" listing, the latter appearing
// verbatim across all three unrelated slugs) — some non-famous account
// (real HQ traced to Madrid, nothing like the real Safety-Kleen's Georgia
// HQ) squatting on famous single-word brand names, not the real companies.
// Those three rows were manually reverted; no code-level fix landed for
// this specific one, since there's no equivalently clean, low-risk signal
// to filter on the way Recruitee's own "(Sample)" convention gave above —
// a hit on an exact, famous, single-word brand-name slug from this probe
// specifically deserves a manual sanity check before being trusted, until a
// better signal is found.
async function probePersonio(slug) {
  const xml = await fetchTextManualRedirect(`https://${encodeURIComponent(slug)}.jobs.personio.de/xml?language=en`);
  if (!xml) return null;
  const jobCount = (xml.match(/<position>/g) || []).length;
  if (jobCount === 0) return null;
  return { atsType: "personio", boardToken: slug, jobCount };
}

async function probeSmartRecruiters(slug, companyName) {
  const data = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=1`);
  // Confirmed live: unlike Greenhouse/Lever/Ashby/Workable, this endpoint
  // returns a structurally valid 200 (`{totalFound:0,content:[]}`) for
  // basically ANY slug, registered or not — totalFound===0 is not a
  // "board exists but is empty" signal here the way it is elsewhere, it's
  // the default response for a nonexistent company too. A real hit requires
  // at least one actual posting to confirm the slug is genuine, plus that
  // posting's own company name has to match what was searched for.
  if (!data || !data.totalFound) return null;
  const returnedName = data.content?.[0]?.company?.name;
  if (!returnedName || !namesPlausiblyMatch(companyName, returnedName)) return null;
  return { atsType: "smartrecruiters", boardToken: slug, jobCount: data.totalFound };
}

// Checks every platform for a given slug CONCURRENTLY rather than stopping
// at the first hit — a company can genuinely (or coincidentally) match more
// than one platform for the same slug, and picking whichever was checked
// first would silently lock in the wrong one forever, since a company is
// never re-probed once known. Confirmed genuinely possible two ways this
// session: an ATS migration can leave an old board still responding, and a
// generic slug can coincidentally belong to a different, unrelated company
// on another platform. Whichever match has the most currently-open postings
// wins — a real, actively-used board almost always dwarfs a stale or
// coincidental one.
async function probeAllPlatforms(slug, companyName) {
  const results = await Promise.all([
    probeGreenhouse(slug),
    probeLever(slug),
    probeAshby(slug),
    probeWorkable(slug, companyName),
    probeSmartRecruiters(slug, companyName),
    probeRecruitee(slug, companyName),
    probeBreezy(slug, companyName),
    probePersonio(slug)
  ]);

  const hits = results.filter(Boolean);
  if (hits.length === 0) return null;
  return hits.reduce((best, hit) => (hit.jobCount > best.jobCount ? hit : best));
}

// Tries each candidate slug shape in turn, checking every platform for each
// one before moving to the next. Never throws — a company nobody can find on
// any of these stays untagged (ats_type stays 'unknown'), which is exactly
// as informative as it sounds: still worth a retry someday, but nothing to
// poll directly right now.
export async function probeCompanyAts(companyName) {
  const candidates = generateSlugCandidates(companyName);

  for (const slug of candidates) {
    const hit = await probeAllPlatforms(slug, companyName);
    if (hit) return hit;
  }

  return null;
}
