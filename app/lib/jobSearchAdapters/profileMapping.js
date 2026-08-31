// Label-text matching is the only reliable way to map a Greenhouse/Lever/Ashby
// form field to profile data — custom question field IDs are unique per job
// posting (confirmed against a real live Greenhouse form: "question_68292370"
// etc.), so nothing here can key off IDs for anything but the ATS's ~6 standard
// fields (name/email/phone/country/location).

export function normalizeLabel(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\*/g, "")
    .replace(/\[optional[^\]]*\]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Same country, wildly different expected spelling depending on the form —
// confirmed as a real recurring problem: some ask for "United States of
// America" (the profile's own stored form), others want "US"/"USA"/"United
// States". Returned as an ordered candidate list (most-specific/most-likely
// first) rather than a single guess, so a caller trying a select/autocomplete
// widget can fall through the list until one actually matches the form's own
// option text — deliberately NOT exhaustive (a small, single-user-relevant
// set), falling back to the stored value verbatim for anything unrecognized
// rather than inventing a spelling we have no evidence is right.
const COUNTRY_NAME_VARIANTS = {
  "united states of america": ["United States of America", "United States", "USA", "US"],
  "united states": ["United States", "United States of America", "USA", "US"],
  "usa": ["USA", "United States", "United States of America", "US"],
  "us": ["US", "United States", "United States of America", "USA"],
  "united kingdom": ["United Kingdom", "UK", "Great Britain"],
  "uk": ["UK", "United Kingdom", "Great Britain"],
  "great britain": ["Great Britain", "United Kingdom", "UK"],
  "canada": ["Canada"],
  "australia": ["Australia"],
  "india": ["India"],
  "germany": ["Germany"],
  "france": ["France"]
};

function getCountryVariants(country) {
  const key = String(country || "").trim().toLowerCase();
  if (COUNTRY_NAME_VARIANTS[key]) return COUNTRY_NAME_VARIANTS[key];
  return country ? [String(country)] : [];
}

// International calling codes for the same small set of countries above —
// used both for a field that explicitly wants the code folded into the
// phone number itself, and for a field asking for the code on its own
// (a "Country Code"/"Dial Code" dropdown separate from the number field).
// Deliberately small and falls back to no candidate (never a guess) for an
// unrecognized country, same posture as everything else here.
const COUNTRY_CALLING_CODES = {
  "united states of america": "1", "united states": "1", "usa": "1", "us": "1",
  "canada": "1",
  "united kingdom": "44", "uk": "44", "great britain": "44",
  "australia": "61",
  "india": "91",
  "germany": "49",
  "france": "33"
};

function getCallingCode(country) {
  return COUNTRY_CALLING_CODES[String(country || "").trim().toLowerCase()] || null;
}

// A field asking JUST for the calling/dial code, entirely separate from the
// phone number field itself (e.g. a "Phone Country Code" dropdown next to a
// plain "Phone Number" field) — distinct from wantsCountryCodeInPhone below,
// which is a single field wanting the code folded into the same value.
function isPhoneCountryCodeOnlyLabel(l) {
  return /\bcountry\s*code\b/.test(l) || /\bdial(l?ing)?\s*code\b/.test(l) || /\bcalling\s*code\b/.test(l);
}

// A single phone field whose own label says it wants the country code
// included in the same value — "Phone Number (with country code)", "Phone
// Number incl. country code", "International Phone Number". Checked against
// the RAW label, not the fully-normalized one — normalizeLabel() strips
// parenthetical content entirely (to keep "(optional)"-style tags from
// interfering with other matches), which would otherwise erase exactly the
// phrasing this needs to see ("Phone Number (with country code)" -> "Phone
// Number", with the one part that mattered gone). Only lowercased/
// whitespace-collapsed, so parens survive.
function wantsCountryCodeInPhone(rawLabel) {
  const l = String(rawLabel || "").toLowerCase().replace(/\s+/g, " ").trim();
  return /\bwith\s*country\s*code\b/.test(l) || /\binclud(e|ing)\s*country\s*code\b/.test(l) || /\binternational\s*phone\b/.test(l);
}

function getCallingCodeCandidates(country) {
  const code = getCallingCode(country);
  if (!code) return [];
  // Different dropdowns/fields expect a different representation of the
  // same code — tried in order: the conventional "+1" form, then the bare
  // digits, then the country name itself (some dropdowns list options by
  // country name rather than by code).
  return [`+${code}`, code, country ? String(country) : null].filter(Boolean);
}

// Builds phone candidates in the requested priority order — both the bare
// local number and the full "+<code> <local>" form are always included
// regardless of preference (only their ORDER changes), since a label alone
// can't tell us with certainty which a given field actually validates
// against, and offering both means the less-likely form still gets a real
// attempt before falling back to manual review.
function phoneCandidates(phone, country, { preferWithCode }) {
  const bare = String(phone || "").trim();
  if (!bare) return [];
  const code = getCallingCode(country);
  const digitsOnly = bare.replace(/\D/g, "");
  const withCode = code ? `+${code} ${digitsOnly}` : null;
  return preferWithCode ? [withCode, bare].filter(Boolean) : [bare, withCode].filter(Boolean);
}

// Each resolver returns a string, an array of candidate strings (tried in
// order by the caller until one actually fills), or null/undefined if the
// profile doesn't have that data (in which case the field is left for the
// LLM free-text fallback, or flagged needs_manual_review — never guessed).
// Order matters: entries are matched via .find(), so a more specific test
// (e.g. "phone country code") must come before a more general one that
// would otherwise also match the same label (e.g. bare "phone").
export const STANDARD_FIELD_RESOLVERS = [
  { test: (l) => /\b(first|given)\s*name\b/.test(l), resolve: (p) => p.firstName || null },
  // Derived from the stored middle name's own first letter, not guessed from
  // splitting anything — a real middle initial ("M") isn't necessarily the
  // first letter of a first attempt at splitting a combined string, it's
  // just whatever the profile's actual middle name starts with.
  { test: (l) => /\bmiddle\s*initial\b/.test(l), resolve: (p) => (p.middleName ? p.middleName.trim().charAt(0).toUpperCase() : null) },
  { test: (l) => /\bmiddle\s*name\b/.test(l), resolve: (p) => p.middleName || null },
  { test: (l) => /\b(last|family)\s*name\b|\bsurname\b/.test(l), resolve: (p) => p.lastName || null },
  // "Legal Name" confirmed live on a real Ashby form — without this, it fell
  // through to the LLM free-text fallback, which answered truthfully but
  // verbosely ("The candidate's legal name is Test Candidate.") instead of a
  // clean field value, since it's not really a question needing explanation.
  // Deliberately excludes "preferred name"/"nickname" — those are genuinely
  // different data we don't have, not just a spelling variant of full name.
  { test: (l) => /\b(full|legal|applicant)\s*name\b|^name$/.test(l), resolve: (p) => p.fullName },
  // Word-boundaried, not exact-equality — confirmed live as a real miss:
  // Ashby's own field is labeled "Phone Number", not bare "Phone", so the
  // old `l === "phone"` never matched it and a phone number that WAS on file
  // still landed in manual review every time. "Email Address" is the same
  // risk pre-emptively; both are common enough label variants that a narrow
  // exact match was never going to hold up.
  { test: (l) => /\bemail\b/.test(l), resolve: (p) => p.email },
  { test: (l) => isPhoneCountryCodeOnlyLabel(l), resolve: (p) => getCallingCodeCandidates(p.country) },
  { test: (l, raw) => /\bphone\b/.test(l) && wantsCountryCodeInPhone(raw), resolve: (p) => phoneCandidates(p.phone, p.country, { preferWithCode: true }) },
  { test: (l) => /\bphone\b/.test(l), resolve: (p) => phoneCandidates(p.phone, p.country, { preferWithCode: false }) },
  { test: (l) => /\bcountry\b/.test(l) && !/\bcountry\s*code\b/.test(l), resolve: (p) => getCountryVariants(p.country) },
  { test: (l) => /location city|current location|^location$/.test(l), resolve: (p) => [p.city, p.stateRegion].filter(Boolean).join(", ") },
  { test: (l) => l.includes("linkedin"), resolve: (p) => p.linkedinUrl },
  { test: (l) => l.includes("github"), resolve: (p) => p.githubUrl },
  { test: (l) => l.includes("personal website") || l.includes("portfolio"), resolve: (p) => p.portfolioUrl },
  { test: (l) => l.includes("current company"), resolve: (p) => p.workHistory?.[0]?.company },
  { test: (l) => l.includes("current title") || l.includes("current role"), resolve: (p) => p.workHistory?.[0]?.title }
];

// Full candidate list, in priority order — for a caller that can retry a
// widget fill against more than one acceptable value (country name variants,
// phone with/without a country code). `rawLabel` is the field's original,
// un-normalized label text — defaults to the normalized label itself so
// existing callers that only ever had that available still work, but a
// caller with the real raw text should pass it: a couple of tests (see
// wantsCountryCodeInPhone) need to see punctuation/parentheses that
// normalizeLabel() deliberately strips for everything else.
export function resolveStandardFieldCandidates(label, profile, rawLabel = label) {
  const match = STANDARD_FIELD_RESOLVERS.find((r) => r.test(label, rawLabel));
  if (!match) return [];
  const result = match.resolve(profile);
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  return list.filter(Boolean).map(String);
}

// Single best-guess value — unchanged contract for callers that only ever
// try one fill (a plain text `.fill()`, where trying alternate spellings
// wouldn't change whether the fill itself succeeds).
export function resolveStandardField(label, profile, rawLabel = label) {
  const candidates = resolveStandardFieldCandidates(label, profile, rawLabel);
  return candidates.length ? candidates[0] : null;
}

// EEO/work-authorization fields are hard-mapped by exact stored option text and
// NEVER touch the LLM — this classification gates that in the adapter.
// Word-boundaried on every single-word alternative — without \b, "race"
// matches inside "embrace", "visa" inside a hypothetical "visainfo", etc.,
// which would wrongly hard-map (and likely then skip, absent real EEO/
// work-auth profile data) an ordinary question that just happens to contain
// one of these as a substring, instead of ever reaching it with the LLM.
export function isEeoLabel(label) {
  return /\b(gender|race|ethnicity|hispanic|latino|veteran|disability)\b/.test(label);
}

export function isWorkAuthLabel(label) {
  return /\bsponsorship\b|require.*immigration|\bvisa\b|authorized to work|work authorization/.test(label);
}

export function resolveEeoValue(label, eeoAnswers) {
  const eeo = eeoAnswers || {};
  if (/\bgender\b/.test(label)) return eeo.gender || null;
  if (/\b(race|ethnicity|hispanic|latino)\b/.test(label)) return eeo.raceEthnicity || null;
  if (/\bveteran\b/.test(label)) return eeo.veteranStatus || null;
  if (/\bdisability\b/.test(label)) return eeo.disabilityStatus || null;
  return null;
}

export function resolveWorkAuthValue(label, workAuthorization) {
  const wa = workAuthorization || {};
  if (/\bsponsorship\b|require.*immigration|\bvisa\b/.test(label)) {
    if (wa.requiresSponsorship === "yes") return "Yes";
    if (wa.requiresSponsorship === "no") return "No";
    return null;
  }
  if (/authorized to work|work authorization/.test(label)) {
    if (wa.authorizedInCountry === "yes") return "Yes";
    if (wa.authorizedInCountry === "no") return "No";
    return null;
  }
  return null;
}

// A human's own saved answer for a specific field this posting previously
// landed in needs_manual_review over (see jobSearchPostingsStore.js's
// manual_review_fields column and the Review Queue's "Answer & Retry" popup)
// — checked by every adapter as the FIRST resolution strategy for a field,
// ahead of EEO/work-auth/profile-matching/LLM, since a real person already
// looked at this exact question for this exact posting and answered it
// on purpose. `manualReviewFields` is the posting's own array, `normalizedLabel`
// the field currently being resolved (same normalizeLabel() call every other
// resolver here already uses) — matched by normalized label rather than exact
// text so trivial whitespace/asterisk differences between the DOM at save-time
// and at retry-time can't cause a real saved answer to silently miss.
export function resolveManualOverride(normalizedLabel, manualReviewFields) {
  const match = (manualReviewFields || []).find(
    (f) => f?.answer != null && f.answer !== "" && normalizeLabel(f.label) === normalizedLabel
  );
  return match ? match.answer : null;
}
