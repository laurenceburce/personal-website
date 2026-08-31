// Auto-discovers a company's ATS board by guessing its slug against each
// platform's free, unauthenticated public API — the same manual process used
// to find every real test company this session (Palantir on Lever, Ramp on
// Ashby, Codurance on Workable, Equinox on SmartRecruiters, Vinted on
// Recruitee, Attentive on Breezy HR, Prenode on Personio), just automated.
// This is the mechanism behind direct polling: once a company is confirmed
// here, jobSearchDirectPoll.js can fetch its postings straight from the ATS
// instead of relying solely on Adzuna ever surfacing them, and any posting
// found this way is tagged with its real ats_type from the start — no lazy
// per-posting resolution needed later. A company can come back confirmed on
// MORE than one platform at once (see probeAllPlatforms below) — every
// genuine hit is kept and gets its own row in the directory, not just
// whichever platform happened to be checked first. Every platform in
// POLLABLE_ATS_TYPES
// that's actually guessable this way (greenhouse/lever/ashby/workable/
// recruitee/personio/breezy/smartrecruiters — see jobSearchAdapters/
// atsTypes.js) gets probed for that reason, submission adapter or not —
// SmartRecruiters' own apply-form bot-wall has nothing to do with its
// read-only postings API, which is confirmed live to work fine unauthenticated.
// Workday and oracle_fusion are also in POLLABLE_ATS_TYPES but deliberately
// NOT probed here — neither has a guessable public API (Workday needs 3
// pieces — tenant/datacenter/site; oracle_fusion needs its own 3 —
// hostname/siteName/siteNumber), none derivable from a company name, so
// both only ever get added via atsResolver.js registering an already-
// resolved real URL, never via slug-guessing. iCIMS/legacy-Taleo
// (oracle_taleo, the taleo.net domain — a different, older product than
// Fusion) are skipped here entirely and NOT in POLLABLE_ATS_TYPES at all —
// neither exposes a confirmed guessable public API (iCIMS: confirmed live,
// a real hosted tenant's would-be JSON endpoints just returned an unrelated
// CMS shell; legacy Taleo: never live-tested for an equivalent path the way
// oracle_fusion now has been).
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

// Every hit below carries jobCount alongside atsType/boardToken. Not used to
// arbitrate between platforms anymore (see probeAllPlatforms) — every
// genuine hit is kept — but still worth returning: it's what a hit actually
// means ("this board has N currently open postings"), useful for debugging
// a surprising multi-platform result after the fact.

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

// Checks every platform for a given slug CONCURRENTLY, and keeps EVERY
// genuine hit rather than picking a single winner — a company can genuinely
// (or coincidentally) match more than one platform for the same slug, and
// this is deliberately the point now: jobSearchCompanyDirectory.js registers
// one row per hit, so jobSearchDirectPoll.js ends up polling all of them.
// Confirmed genuinely possible two ways: an ATS migration can leave an old
// board still responding alongside the new one, and a company can
// deliberately run boards on two platforms at once (e.g. a subsidiary or
// regional brand on its own board). The trade-off: a generic slug
// coincidentally belonging to a different, unrelated company on another
// platform (also confirmed live, elsewhere in this file's own comments) now
// gets registered too, for the platforms with no company-name field to
// cross-check (Greenhouse/Lever/Ashby/Personio — see each probe function
// above). Accepted as low-stakes: a wrongly-registered board only ever
// contributes postings that still go through hard-filtering, scoring, and
// human review same as everything else — never straight to submission.
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

  return results.filter(Boolean);
}

// Tries each candidate slug shape in turn, stopping at the first shape that
// gets ANY hit (still not chasing the rarer case of a company using a
// different slug convention on each platform — e.g. "openai" on one board,
// "open-ai" on another — which would mean trying every shape against every
// platform, roughly doubling probe traffic for a case not yet confirmed to
// matter in practice). Returns every platform that matched at that winning
// slug, not just one. Never throws — a company nobody can find on any of
// these stays untagged (ats_type stays 'unknown'), which is exactly as
// informative as it sounds: still worth a retry someday, but nothing to
// poll directly right now.
export async function probeCompanyAts(companyName) {
  const candidates = generateSlugCandidates(companyName);

  for (const slug of candidates) {
    const hits = await probeAllPlatforms(slug, companyName);
    if (hits.length > 0) return hits;
  }

  return [];
}
