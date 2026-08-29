// Auto-discovers a company's ATS board by guessing its slug against each
// platform's free, unauthenticated public API — the same manual process used
// to find every real test company this session (Palantir on Lever, Ramp on
// Ashby, Codurance on Workable, Equinox on SmartRecruiters), just automated.
// This is the mechanism behind direct polling: once a company is confirmed
// here, jobSearchDirectPoll.js can fetch its postings straight from the ATS
// instead of relying solely on Adzuna ever surfacing them, and any posting
// found this way is tagged with its real ats_type from the start — no lazy
// per-posting resolution needed later. Only greenhouse/lever/ashby/workable
// probes matter for that (the only platforms with a submission adapter — see
// jobSearchAdapters/atsResolver.js's SUBMITTABLE_ATS_TYPES); smartrecruiters
// is still probed for accurate labeling even though nothing can ever submit
// to it. Workday/iCIMS/Oracle-Taleo are skipped here entirely — none of them
// expose a guessable public API the way the other four do (confirmed live:
// each requires already knowing a company's exact tenant/site or slug).
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
    probeSmartRecruiters(slug, companyName)
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
