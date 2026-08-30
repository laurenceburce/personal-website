import { createHash } from "node:crypto";

const FETCH_TIMEOUT_MS = 20000;

// Confirmed live during the company-directory backfill: an unclaimed/trial
// Recruitee account ("google.recruitee.com") served a real, structurally
// valid offer titled "Senior Marketer (Sample)" — Recruitee's own onboarding
// convention seeds every new account with a placeholder posting before the
// account's real user has published anything, and it stays live indefinitely
// on unused trial subdomains. Left unfiltered, that one posting was enough to
// make probeCompanyAts() (jobCount>=1) confidently mislabel a random trial
// signup as the actual real company sharing that name. Filtered out at
// BOTH the probe and the actual polling fetch below, not just the probe —
// a real company could in principle leave a stray sample posting alongside
// genuine ones too.
const SAMPLE_POSTING_TITLE = /\(sample\)/i;
// Plenty for the LLM/embedding truncation windows (6-8K chars) plus full
// transparency in the review-queue UI, while bounding worst-case storage — a
// full-HTML approach here once grew one table to 200MB across ~4,500 postings.
export const MAX_DESCRIPTION_TEXT_CHARS = 20000;

// Every existing caller is a plain GET with no body — only Workday's own
// "CXS" API (fetchWorkdayJobs below) needs a POST with a JSON body, since a
// GET against that endpoint returns nothing useful (confirmed live).
async function fetchJson(url, { method = "GET", body } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        "User-Agent": "job-search-bot/1.0 (personal use, owner-only tool)",
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!response.ok) throw new Error(`${url} responded with ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

// Personio's board is an XML feed, not JSON — everything else here still
// only ever needs fetchJson.
async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "job-search-bot/1.0 (personal use, owner-only tool)" }
    });
    if (!response.ok) throw new Error(`${url} responded with ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function xmlUnescape(text) {
  return String(text || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Non-greedy so a tag that also appears nested deeper in the same block (e.g.
// a position's own <name> vs. the <name> inside each of its <jobDescription>
// sub-blocks) still resolves to the FIRST, outermost occurrence — confirmed
// against Personio's real feed shape, where the position's title always
// closes before any nested section starts.
function extractXmlTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? xmlUnescape(match[1].trim()) : "";
}

// Personio splits a posting's body into named sections (jobDescriptions>
// jobDescription>{name,value}) rather than one description field — value is
// itself HTML wrapped in CDATA. Concatenated here (section heading + its own
// stripped text) into the same single descriptionText shape every other
// poller produces.
function extractPersonioDescription(positionXml) {
  const blocks = positionXml.match(/<jobDescription>[\s\S]*?<\/jobDescription>/g) || [];
  return blocks
    .map((block) => {
      const name = extractXmlTag(block, "name");
      const cdataMatch = block.match(/<value>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/value>/);
      const text = stripHtml(cdataMatch ? cdataMatch[1] : extractXmlTag(block, "value"));
      return name ? `${name}\n${text}` : text;
    })
    .filter(Boolean)
    .join("\n\n");
}

export function stripHtml(html) {
  if (!html) return "";
  return String(html)
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"")
    // Confirmed live: SmartRecruiters' own description HTML leans heavily on
    // raw numeric character references (`&#xa0;` for a non-breaking space,
    // dozens per posting) rather than the small set of named entities above —
    // left undecoded, the visible text was littered with literal "&#xa0;"
    // wherever a space should be. Handles both hex (&#xNN;) and decimal
    // (&#NN;) forms generically, not just the one form actually seen.
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    // U+00A0 is the actual non-breaking-space character the entities above
    // decode to — folded into a plain space here, same as the named &nbsp;
    // case, so both forms end up looking identical in the final text.
    .replace(/[ \t\u00A0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function computeContentHash(title, descriptionText) {
  return createHash("sha256").update(`${title || ""}\n${descriptionText || ""}`).digest("hex");
}

// Description text is a supplementary signal only, checked when the location
// field itself doesn't already say remote/hybrid — kept to strong, explicit
// phrasings to avoid false-positiving on a JD that merely mentions "remote"
// in passing (e.g. "occasional remote days", "remote team tooling") for a
// role that's actually onsite.
const STRONG_REMOTE_SIGNALS = /\b(fully remote|100% remote|remote[- ]first|remote position|remote role|work from home|work from anywhere|remote anywhere)\b/i;

// A "remote" role is often still geography-restricted ("fully remote within
// European timezones", "remote, US-based only") — genuinely not the same as
// remote-from-anywhere for a candidate outside that region. Confirmed live: a
// Clera/Ashby posting located in Amsterdam said exactly "Fully remote within
// European timezones" with no visa sponsorship — STRONG_REMOTE_SIGNALS alone
// called that unrestricted "remote", which let it skip location filtering
// entirely (see jobSearchHardFilters.js's remote_only/locations checks) for a
// candidate who can't actually work it. This can't catch every phrasing (full
// geographic-restriction parsing is out of reach for a regex), but it covers
// the common ones: a region/country name appearing right next to the remote
// claim, in either word order.
const REGION_NAMES = "europe|european|emea|apac|apj|asia[- ]pacific|americas|latam|latin america|u\\.?s\\.?a?\\.?|united states|canada|u\\.?k\\.?|united kingdom|australia|india";
const REGION_RESTRICTED_REMOTE = new RegExp(
  `\\bremote\\b[^.]{0,60}\\b(within|in|based in|for candidates in)\\b[^.]{0,40}\\b(${REGION_NAMES})\\b` +
  `|\\bremote\\b[^.]{0,60}\\b(${REGION_NAMES})[- ]based\\b` +
  `|\\b(${REGION_NAMES})[- ]based\\b[^.]{0,30}\\bremote\\b`,
  "i"
);

// Priority order, confirmed live to matter (not arbitrary):
// 1. The location field itself saying remote/hybrid — a human typed this
//    directly into the location field, the strongest signal available.
// 2. An ATS platform's own structured remote flag (Ashby's isRemote,
//    Workable's telecommuting), when the location field is silent on it —
//    trusted in BOTH directions once it exists, not just the positive case.
//    Confirmed live this catches what the free-text heuristic below can't:
//    a Clera/Ashby "Staff Engineer" posting whose description said "This is
//    NOT a remote role" still matched STRONG_REMOTE_SIGNALS on the bare
//    phrase "remote role" (the regex has no concept of negation) — Ashby's
//    own isRemote:false is what actually gets that one right.
// 3. The free-text description heuristic, only once neither of the above
//    gave an answer — kept to strong, explicit phrasings to avoid false-
//    positiving on a JD that merely mentions "remote" in passing, and now
//    also rejecting geography-restricted claims (see REGION_RESTRICTED_REMOTE
//    above) so "fully remote within European timezones" doesn't count as
//    unrestricted remote for a candidate who can't actually work it.
// structuredRemote is deliberately NOT allowed to override step 1: a Cinder/
// Ashby posting whose location field literally said "Remote: SF/NYC/London"
// still had isRemote:false on that specific listing (a stale/inconsistent
// checkbox on their own board) — the explicit location text wins over that.
export function guessRemoteType(locationText, descriptionText, structuredRemote = null) {
  const text = String(locationText || "").toLowerCase();
  if (/remote/.test(text)) return "remote";
  if (/hybrid/.test(text)) return "hybrid";
  if (structuredRemote === true) return "remote";
  if (structuredRemote === false) return "onsite";
  if (descriptionText && STRONG_REMOTE_SIGNALS.test(descriptionText) && !REGION_RESTRICTED_REMOTE.test(descriptionText)) {
    return "remote";
  }
  if (text.trim()) return "onsite";
  return "unknown";
}

export function guessSeniority(title) {
  const text = String(title || "").toLowerCase();
  if (/\bintern(ship)?\b/.test(text)) return "intern";
  if (/\b(junior|jr\.?|entry.level|associate)\b/.test(text)) return "junior";
  if (/\bprincipal\b/.test(text)) return "principal";
  if (/\bstaff\b/.test(text)) return "staff";
  if (/\b(director|vp|vice president|head of)\b/.test(text)) return "director";
  if (/\blead\b/.test(text)) return "lead";
  if (/\b(senior|sr\.?)\b/.test(text)) return "senior";
  return "unknown";
}

export async function fetchGreenhouseJobs({ boardToken, companyName }) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs?content=true`;
  const data = await fetchJson(url);
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];

  return jobs.map((job) => {
    const descriptionText = stripHtml(job.content || "").slice(0, MAX_DESCRIPTION_TEXT_CHARS);
    const locationText = job.location?.name || "";
    const title = job.title || "";

    return {
      atsType: "greenhouse",
      boardToken,
      externalJobId: String(job.id),
      companyName,
      title,
      department: job.departments?.[0]?.name || "",
      locationText,
      remoteType: guessRemoteType(locationText, descriptionText),
      seniorityGuess: guessSeniority(title),
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      descriptionText,
      applyUrl: job.absolute_url || "",
      postedAt: job.updated_at ? new Date(job.updated_at) : null,
      contentHash: computeContentHash(title, descriptionText)
    };
  });
}

export async function fetchLeverJobs({ boardToken, companyName }) {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(boardToken)}?mode=json`;
  const data = await fetchJson(url);
  const postings = Array.isArray(data) ? data : [];

  return postings.map((posting) => {
    const descriptionText = (posting.descriptionPlain || stripHtml(posting.description || posting.descriptionBodyHtml || ""))
      .slice(0, MAX_DESCRIPTION_TEXT_CHARS);
    const locationText = posting.categories?.location || "";
    const title = posting.text || "";
    const workplaceType = String(posting.categories?.workplaceType || "").toLowerCase();
    const remoteType = workplaceType.includes("remote")
      ? "remote"
      : workplaceType.includes("hybrid")
        ? "hybrid"
        : workplaceType.includes("on-site") || workplaceType.includes("onsite")
          ? "onsite"
          : guessRemoteType(locationText, descriptionText);

    return {
      atsType: "lever",
      boardToken,
      externalJobId: String(posting.id),
      companyName,
      title,
      department: posting.categories?.team || "",
      locationText,
      remoteType,
      seniorityGuess: guessSeniority(title),
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      descriptionText,
      applyUrl: posting.applyUrl || posting.hostedUrl || "",
      postedAt: posting.createdAt ? new Date(Number(posting.createdAt)) : null,
      contentHash: computeContentHash(title, descriptionText)
    };
  });
}

export async function fetchAshbyJobs({ boardToken, companyName }) {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(boardToken)}?includeCompensation=true`;
  const data = await fetchJson(url);
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];

  return jobs.map((job) => {
    const descriptionText = stripHtml(job.descriptionHtml || "").slice(0, MAX_DESCRIPTION_TEXT_CHARS);
    const locationText = job.location || "";
    const title = job.title || "";
    const comp = job.compensation?.summaryComponents?.[0] || null;

    return {
      atsType: "ashby",
      boardToken,
      externalJobId: String(job.id),
      companyName,
      title,
      department: job.department || "",
      locationText,
      // job.isRemote is Ashby's own structured flag — see guessRemoteType's
      // priority-order comment for exactly how this, the location text, and
      // the description heuristic are weighed against each other.
      remoteType: guessRemoteType(locationText, descriptionText, job.isRemote),
      seniorityGuess: guessSeniority(title),
      salaryMin: comp?.minValue != null ? Math.round(Number(comp.minValue)) : null,
      salaryMax: comp?.maxValue != null ? Math.round(Number(comp.maxValue)) : null,
      salaryCurrency: comp?.currencyCode || null,
      descriptionText,
      // Ashby's API exposes two distinct URLs for the same posting: jobUrl (the
      // general "Overview" page — description only, no guarantee the form is
      // reachable without an extra click) and applyUrl (a direct link straight
      // to the application form, at a `/application` suffix). Confirmed live
      // against a failed submission: navigating to jobUrl showed 0 `label[for]`
      // elements (no form on that page), while applyUrl showed 45. Preferring
      // applyUrl avoids handing the submit adapter a page with no form to fill.
      applyUrl: job.applyUrl || job.jobUrl || "",
      postedAt: job.publishedAt ? new Date(job.publishedAt) : null,
      contentHash: computeContentHash(title, descriptionText)
    };
  });
}

export async function fetchWorkableJobs({ boardToken, companyName }) {
  const url = `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(boardToken)}?details=true`;
  const data = await fetchJson(url);
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];

  return jobs.map((job) => {
    const descriptionText = stripHtml(job.description || "").slice(0, MAX_DESCRIPTION_TEXT_CHARS);
    const locationText = [job.city, job.state, job.country].filter(Boolean).join(", ");
    const title = job.title || "";

    return {
      atsType: "workable",
      boardToken,
      externalJobId: job.shortcode,
      companyName,
      title,
      department: job.department || job.function || "",
      locationText,
      // Same priority order as Ashby's isRemote above.
      remoteType: guessRemoteType(locationText, descriptionText, job.telecommuting),
      seniorityGuess: guessSeniority(title),
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      descriptionText,
      applyUrl: job.application_url || job.url || "",
      postedAt: job.published_on ? new Date(job.published_on) : null,
      contentHash: computeContentHash(title, descriptionText)
    };
  });
}

// Recruitee's own structured booleans — same priority treatment as Ashby's
// isRemote/Workable's telecommuting above (see guessRemoteType's own comment):
// trusted in both directions once present, the location text itself still
// wins over them. `hybrid` has no equivalent on the other platforms, so it's
// checked first rather than folded into guessRemoteType's remote/onsite
// two-way signal.
export async function fetchRecruiteeJobs({ boardToken, companyName }) {
  const url = `https://${encodeURIComponent(boardToken)}.recruitee.com/api/offers`;
  const data = await fetchJson(url);
  const offers = (Array.isArray(data?.offers) ? data.offers : [])
    .filter((offer) => !SAMPLE_POSTING_TITLE.test(offer.title || ""));

  return offers.map((offer) => {
    const descriptionText = stripHtml(offer.description || "").slice(0, MAX_DESCRIPTION_TEXT_CHARS);
    const locationText = [offer.city, offer.state_name, offer.country].filter(Boolean).join(", ");
    const title = offer.title || "";
    const salary = offer.salary && typeof offer.salary === "object" ? offer.salary : null;
    const structuredRemote = offer.remote === true ? true : offer.on_site === true ? false : null;

    return {
      atsType: "recruitee",
      boardToken,
      externalJobId: String(offer.id),
      companyName,
      title,
      department: offer.department || "",
      locationText,
      remoteType: offer.hybrid ? "hybrid" : guessRemoteType(locationText, descriptionText, structuredRemote),
      seniorityGuess: guessSeniority(title),
      salaryMin: salary?.min != null ? Math.round(Number(salary.min)) : null,
      salaryMax: salary?.max != null ? Math.round(Number(salary.max)) : null,
      salaryCurrency: salary?.currency || null,
      descriptionText,
      // careers_apply_url lands straight on the application form; careers_url
      // is the read-only overview page — same apply-vs-overview distinction
      // already confirmed for Ashby's jobUrl/applyUrl above.
      applyUrl: offer.careers_apply_url || offer.careers_url || "",
      postedAt: offer.published_at ? new Date(offer.published_at) : null,
      contentHash: computeContentHash(title, descriptionText)
    };
  });
}

export async function fetchPersonioJobs({ boardToken, companyName }) {
  const xml = await fetchText(`https://${encodeURIComponent(boardToken)}.jobs.personio.de/xml?language=en`);
  const positions = xml.match(/<position>[\s\S]*?<\/position>/g) || [];

  return positions
    .map((position) => {
      const id = extractXmlTag(position, "id");
      const title = extractXmlTag(position, "name");
      const locationText = extractXmlTag(position, "office");
      const descriptionText = extractPersonioDescription(position).slice(0, MAX_DESCRIPTION_TEXT_CHARS);
      const createdAt = extractXmlTag(position, "createdAt");

      return {
        atsType: "personio",
        boardToken,
        externalJobId: id,
        companyName,
        title,
        department: extractXmlTag(position, "department"),
        locationText,
        remoteType: guessRemoteType(locationText, descriptionText),
        seniorityGuess: guessSeniority(title),
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        descriptionText,
        // Personio's XML feed carries no per-posting URL at all (confirmed
        // live) — every real example found this session followed the same
        // {subdomain}.jobs.personio.de/job/{id} shape, so it's built here
        // rather than left blank.
        applyUrl: `https://${boardToken}.jobs.personio.de/job/${id}?language=en`,
        postedAt: createdAt ? new Date(createdAt) : null,
        contentHash: computeContentHash(title, descriptionText)
      };
    })
    .filter((job) => job.externalJobId);
}

export async function fetchBreezyJobs({ boardToken, companyName }) {
  const url = `https://${encodeURIComponent(boardToken)}.breezy.hr/json?verbose=true`;
  const data = await fetchJson(url);
  const jobs = Array.isArray(data) ? data : [];

  return jobs.map((job) => {
    const descriptionText = stripHtml(job.description || "").slice(0, MAX_DESCRIPTION_TEXT_CHARS);
    const locationText = job.location?.name || [job.location?.city, job.location?.country?.name].filter(Boolean).join(", ");
    const title = job.name || "";

    return {
      atsType: "breezy",
      boardToken,
      externalJobId: String(job.id),
      companyName,
      title,
      department: job.department || "",
      locationText,
      // No structured remote flag anywhere on Breezy's own feed (confirmed
      // live) — falls straight to the shared location/description heuristic.
      remoteType: guessRemoteType(locationText, descriptionText),
      seniorityGuess: guessSeniority(title),
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      descriptionText,
      applyUrl: job.url || "",
      postedAt: job.published_date ? new Date(job.published_date) : null,
      contentHash: computeContentHash(title, descriptionText)
    };
  });
}

// Unlike Greenhouse's `?content=true`, no param on SmartRecruiters' LIST
// endpoint includes a description (confirmed live: neither `content=true` nor
// `fields=jobAd` changes the returned shape) — a real description requires a
// SEPARATE per-posting detail request. A large multi-location chain can have
// hundreds of open postings (confirmed live: Equinox alone had 727, almost
// all individual gym-staff roles), which would otherwise mean hundreds of
// detail requests EVERY poll run for one company. The list is already
// sorted most-recent-first by default (confirmed live) with no extra sort
// param needed, so capping here just means "only the freshest postings get a
// real description this run" — not a permanent miss, since a still-open
// posting stays near the front of this same list on the next poll too.
const SMARTRECRUITERS_MAX_POSTINGS = 60;
const SMARTRECRUITERS_DETAIL_CONCURRENCY = 8;

async function fetchSmartRecruitersDetail(boardToken, id) {
  const detail = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(boardToken)}/postings/${encodeURIComponent(id)}`);
  const sections = detail?.jobAd?.sections || {};
  const descriptionHtml = [sections.jobDescription?.text, sections.qualifications?.text, sections.additionalInformation?.text]
    .filter(Boolean)
    .join("\n\n");
  return {
    descriptionText: stripHtml(descriptionHtml).slice(0, MAX_DESCRIPTION_TEXT_CHARS),
    applyUrl: detail?.applyUrl || detail?.postingUrl || ""
  };
}

export async function fetchSmartRecruitersJobs({ boardToken, companyName }) {
  const data = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(boardToken)}/postings?limit=${SMARTRECRUITERS_MAX_POSTINGS}`);
  const postings = Array.isArray(data?.content) ? data.content : [];

  const jobs = [];
  for (let i = 0; i < postings.length; i += SMARTRECRUITERS_DETAIL_CONCURRENCY) {
    const batch = postings.slice(i, i + SMARTRECRUITERS_DETAIL_CONCURRENCY);
    const details = await Promise.all(
      batch.map((p) => fetchSmartRecruitersDetail(boardToken, p.id).catch(() => ({ descriptionText: "", applyUrl: "" })))
    );
    batch.forEach((posting, idx) => {
      const { descriptionText, applyUrl } = details[idx];
      const title = posting.name || "";
      const location = posting.location || {};
      const locationText = location.fullLocation || [location.city, location.region, location.country].filter(Boolean).join(", ");
      // SmartRecruiters' own structured flags — same priority treatment as
      // Ashby's isRemote/Workable's telecommuting above (see
      // guessRemoteType's own comment): trusted in both directions once
      // present, the location text itself still wins over them.
      const structuredRemote = location.remote === true ? true : location.remote === false && !location.hybrid ? false : null;

      jobs.push({
        atsType: "smartrecruiters",
        boardToken,
        externalJobId: String(posting.id),
        companyName,
        title,
        department: posting.department?.label || "",
        locationText,
        remoteType: location.hybrid ? "hybrid" : guessRemoteType(locationText, descriptionText, structuredRemote),
        seniorityGuess: guessSeniority(title),
        // No compensation field anywhere in SmartRecruiters' own response
        // (confirmed live, list AND detail) — some accounts surface a comp
        // range via a company-configured customField, but its fieldId/label
        // isn't standardized across companies the way Ashby's compensation
        // object is, so there's nothing reliable to parse here.
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        descriptionText,
        // NOT posting.ref — confirmed live that's the raw API self-link
        // (https://api.smartrecruiters.com/...), not a human-facing apply
        // page; applyUrl only ever comes from the detail fetch above.
        applyUrl,
        postedAt: posting.releasedDate ? new Date(posting.releasedDate) : null,
        contentHash: computeContentHash(title, descriptionText)
      });
    });
  }

  return jobs;
}

// Workday has no guessable public API the way Greenhouse/Lever/etc. do — a
// board is identified by THREE pieces (tenant, datacenter, site), none of
// which is derivable from a company's display name the way a single slug is
// for the others (confirmed live: "workday"/"wd5"/"Workday" for Workday's
// own board bears no obvious relationship to each other). So this is never
// reached via jobSearchCompanyProbe.js's slug-guessing — a company only ever
// gets a "workday" boardToken via atsResolver.js parsing an ALREADY-RESOLVED
// real Workday URL (from an Adzuna-discovered posting) into its 3 parts once,
// after which direct-poll can fetch the REST of that company's board the
// normal way. boardToken encodes all 3 pieces as "tenant::dc::site" — see
// atsResolver.js's parseWorkdayBoardUrl().
//
// The underlying endpoint is Workday's own "CXS" (Candidate Experience
// System) API — undocumented but confirmed live and stable against two real
// boards (Workday's own site, 365 postings; Walmart's, 2000) — the exact
// same calls the career site's own search box makes, not a private/internal
// API. Same N+1 detail-fetch shape and cap rationale as SmartRecruiters
// above: Walmart alone had 2000 open postings. Unlike SmartRecruiters', this
// list endpoint hard-rejects (400) any `limit` over 20 (confirmed live: 20
// succeeds, 21 doesn't) — WORKDAY_MAX_POSTINGS is paged out in
// WORKDAY_PAGE_SIZE-sized requests rather than requested in one shot.
const WORKDAY_PAGE_SIZE = 20;
const WORKDAY_MAX_POSTINGS = 60;
const WORKDAY_DETAIL_CONCURRENCY = 8;

// externalPath already starts with "/job/..." (confirmed live) — appended
// directly, not joined with another literal "/job" segment.
async function fetchWorkdayDetail(tenant, dc, site, externalPath) {
  const url = `https://${tenant}.${dc}.myworkdayjobs.com/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}${externalPath}`;
  const detail = await fetchJson(url);
  const info = detail?.jobPostingInfo || {};
  return {
    descriptionText: stripHtml(info.jobDescription || "").slice(0, MAX_DESCRIPTION_TEXT_CHARS),
    applyUrl: info.externalUrl || `https://${tenant}.${dc}.myworkdayjobs.com/${encodeURIComponent(site)}${externalPath}`
  };
}

export async function fetchWorkdayJobs({ boardToken, companyName }) {
  const [tenant, dc, site] = String(boardToken || "").split("::");
  if (!tenant || !dc || !site) return [];

  const jobsUrl = `https://${tenant}.${dc}.myworkdayjobs.com/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}/jobs`;
  const postings = [];
  for (let offset = 0; offset < WORKDAY_MAX_POSTINGS; offset += WORKDAY_PAGE_SIZE) {
    const data = await fetchJson(jobsUrl, {
      method: "POST",
      body: { appliedFacets: {}, limit: WORKDAY_PAGE_SIZE, offset, searchText: "" }
    });
    const page = Array.isArray(data?.jobPostings) ? data.jobPostings : [];
    postings.push(...page);
    if (page.length < WORKDAY_PAGE_SIZE) break; // fewer than a full page = no more postings
  }

  const jobs = [];
  for (let i = 0; i < postings.length; i += WORKDAY_DETAIL_CONCURRENCY) {
    const batch = postings.slice(i, i + WORKDAY_DETAIL_CONCURRENCY);
    const details = await Promise.all(
      batch.map((p) => fetchWorkdayDetail(tenant, dc, site, p.externalPath).catch(() => ({ descriptionText: "", applyUrl: "" })))
    );
    batch.forEach((posting, idx) => {
      const { descriptionText, applyUrl } = details[idx];
      const title = posting.title || "";
      const locationText = posting.locationsText || "";
      // Workday's own field ("Remote", "Flex"/"Hybrid", "On-Site" — exact
      // labels are company-configurable free text, not a fixed enum, so this
      // is matched loosely rather than against a strict value list).
      const remoteText = String(posting.remoteType || "").toLowerCase();
      const structuredRemote = remoteText.includes("remote") ? true : remoteText.includes("site") ? false : null;

      jobs.push({
        atsType: "workday",
        boardToken,
        externalJobId: posting.externalPath || `${site}:${idx}:${i}`,
        companyName,
        title,
        department: "",
        locationText,
        remoteType: remoteText.includes("hybrid") || remoteText.includes("flex") ? "hybrid" : guessRemoteType(locationText, descriptionText, structuredRemote),
        seniorityGuess: guessSeniority(title),
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        descriptionText,
        applyUrl,
        // Workday's list only ever gives a relative phrase ("Posted Yesterday",
        // "Posted 30+ Days Ago"), not a real timestamp — confirmed live, both
        // the list AND detail endpoints. Left null rather than guessed: a
        // wrong absolute date is worse than none for maxPostingAgeHours
        // filtering.
        postedAt: null,
        contentHash: computeContentHash(title, descriptionText)
      });
    });
  }

  return jobs;
}

// oracle_fusion has no guessable public API the way Greenhouse/Lever/etc.
// do — a board is identified by THREE pieces (hostname, siteName,
// siteNumber), none of which is derivable from a company's display name
// (confirmed live: "eeho.fa.us2.oraclecloud.com"/"jobsearch"/"CX_45001" for
// Oracle's own board bears no obvious relationship to "Oracle" or each
// other). So this is never reached via jobSearchCompanyProbe.js's slug-
// guessing — a company only ever gets an "oracle_fusion" boardToken via
// atsResolver.js parsing an ALREADY-RESOLVED real Fusion URL (from an
// Adzuna-discovered posting) into its 3 parts once, after which direct-poll
// can fetch the REST of that company's board the normal way. boardToken
// encodes all 3 pieces as "hostname::siteName::siteNumber" — see
// atsResolver.js's parseOracleFusionBoardUrl().
//
// The underlying endpoint is Oracle Fusion Recruiting Cloud's own
// "Candidate Experience" REST API — the exact same calls the public career
// site's own search page makes, confirmed live against Oracle's real site
// (careers.oracle.com, 2173 open postings) with a plain unauthenticated
// fetch — genuinely public, unlike the back-office HCM Recruiting Cloud API.
// `expand=requisitionList` is required for the list endpoint to actually
// return items (confirmed live: omitting it returns TotalJobsCount correctly
// but an empty requisitionList); `limit` is honored up to 200 (confirmed
// live: requesting 250 silently capped at 200), well above Workday's hard
// 20-cap, so pagination needs far fewer round trips. Same N+1 detail-fetch
// shape as Workday/SmartRecruiters for the full description text, since the
// list endpoint's own ShortDescriptionStr is a blurb, not the real JD
// (confirmed live: the detail endpoint's ExternalDescriptionStr is the full
// HTML body, the list endpoint doesn't carry it at all).
const ORACLE_FUSION_PAGE_SIZE = 200;
const ORACLE_FUSION_MAX_POSTINGS = 400;
const ORACLE_FUSION_DETAIL_CONCURRENCY = 8;

function oracleFusionJobUrl(hostname, siteName, id) {
  return `https://${hostname}/hcmUI/CandidateExperience/en/sites/${encodeURIComponent(siteName)}/job/${encodeURIComponent(id)}/`;
}

async function fetchOracleFusionDetail(hostname, siteNumber, id) {
  const url = `https://${hostname}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails`
    + `?expand=all&onlyData=true&finder=ById;Id=%22${encodeURIComponent(id)}%22,siteNumber=${encodeURIComponent(siteNumber)}`;
  const data = await fetchJson(url);
  const detail = data?.items?.[0] || {};
  return {
    // ExternalDescriptionStr is the actual job description; CorporateDescriptionStr
    // is Oracle's own boilerplate EEO/accessibility footer, repeated on every
    // posting — deliberately excluded, same reasoning as every other adapter
    // here keeping descriptionText to the posting's own real content.
    descriptionText: stripHtml(detail.ExternalDescriptionStr || "").slice(0, MAX_DESCRIPTION_TEXT_CHARS)
  };
}

export async function fetchOracleFusionJobs({ boardToken, companyName }) {
  const [hostname, siteName, siteNumber] = String(boardToken || "").split("::");
  if (!hostname || !siteName || !siteNumber) return [];

  const postings = [];
  for (let offset = 0; offset < ORACLE_FUSION_MAX_POSTINGS; offset += ORACLE_FUSION_PAGE_SIZE) {
    const url = `https://${hostname}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`
      + `?onlyData=true&expand=requisitionList&finder=findReqs;siteNumber=${encodeURIComponent(siteNumber)}`
      + `,facetsList=NONE,limit=${ORACLE_FUSION_PAGE_SIZE},offset=${offset},sortBy=POSTING_DATES_DESC`;
    const data = await fetchJson(url);
    const page = data?.items?.[0]?.requisitionList;
    const pageItems = Array.isArray(page) ? page : [];
    postings.push(...pageItems);
    if (pageItems.length < ORACLE_FUSION_PAGE_SIZE) break; // fewer than a full page = no more postings
  }

  const jobs = [];
  for (let i = 0; i < postings.length; i += ORACLE_FUSION_DETAIL_CONCURRENCY) {
    const batch = postings.slice(i, i + ORACLE_FUSION_DETAIL_CONCURRENCY);
    const details = await Promise.all(
      batch.map((p) => fetchOracleFusionDetail(hostname, siteNumber, p.Id).catch(() => ({ descriptionText: "" })))
    );
    batch.forEach((posting, idx) => {
      const { descriptionText } = details[idx];
      const title = posting.Title || "";
      const locationText = posting.PrimaryLocation || "";
      const structuredRemote = String(posting.WorkplaceType || "").toLowerCase() === "remote"
        ? true
        : String(posting.WorkplaceType || "").toLowerCase() === "on-site"
          ? false
          : null;

      jobs.push({
        atsType: "oracle_fusion",
        boardToken,
        externalJobId: String(posting.Id),
        companyName,
        title,
        department: posting.Organization || posting.JobFamily || "",
        locationText,
        remoteType: String(posting.WorkplaceType || "").toLowerCase() === "hybrid"
          ? "hybrid"
          : guessRemoteType(locationText, descriptionText, structuredRemote),
        seniorityGuess: guessSeniority(title),
        // No compensation field anywhere in this API's response (confirmed
        // live, list AND detail) — same gap as SmartRecruiters/Workday.
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        descriptionText,
        applyUrl: oracleFusionJobUrl(hostname, siteName, posting.Id),
        postedAt: posting.PostedDate ? new Date(posting.PostedDate) : null,
        contentHash: computeContentHash(title, descriptionText)
      });
    });
  }

  return jobs;
}

export async function fetchAtsJobs({ atsType, boardToken, companyName }) {
  switch (atsType) {
    case "greenhouse": return fetchGreenhouseJobs({ boardToken, companyName });
    case "lever": return fetchLeverJobs({ boardToken, companyName });
    case "ashby": return fetchAshbyJobs({ boardToken, companyName });
    case "workable": return fetchWorkableJobs({ boardToken, companyName });
    case "recruitee": return fetchRecruiteeJobs({ boardToken, companyName });
    case "personio": return fetchPersonioJobs({ boardToken, companyName });
    case "breezy": return fetchBreezyJobs({ boardToken, companyName });
    case "smartrecruiters": return fetchSmartRecruitersJobs({ boardToken, companyName });
    case "workday": return fetchWorkdayJobs({ boardToken, companyName });
    case "oracle_fusion": return fetchOracleFusionJobs({ boardToken, companyName });
    default: throw new Error(`Unsupported ATS type: ${atsType}`);
  }
}
