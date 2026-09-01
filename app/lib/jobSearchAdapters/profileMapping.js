// Label text plus nearby field context is the most reliable way to map an ATS
// form field to profile data. Custom question ids are unique per job posting,
// but ATS-owned repeatable resume sections (employment/education) often expose
// stable-ish names like company-name-0 or school--0, so callers pass those ids
// and nearby section text as rawLabel context when available.

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

const US_STATE_NAME_BY_ABBR = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
  DC: "District of Columbia"
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

function locationCandidates(profile) {
  const city = String(profile?.city || "").trim();
  if (!city) return [];

  const state = String(profile?.stateRegion || "").trim();
  const stateVariants = state
    ? [state, US_STATE_NAME_BY_ABBR[state.toUpperCase()]].filter(Boolean)
    : [];
  const countryVariants = getCountryVariants(profile?.country);
  const candidates = [];

  for (const country of countryVariants) {
    for (const stateVariant of stateVariants) candidates.push(`${city}, ${stateVariant}, ${country}`);
  }
  for (const stateVariant of stateVariants) candidates.push(`${city}, ${stateVariant}`);
  for (const country of countryVariants) candidates.push(`${city}, ${country}`);
  candidates.push(city);

  return [...new Set(candidates.filter(Boolean))];
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

function preferredNameCandidates(profile) {
  const firstName = String(profile?.firstName || "").trim();
  const firstToken = firstName.split(/\s+/)[0] || "";
  return [firstToken, firstName, profile?.fullName].filter(Boolean);
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];

function uniqueTruthyStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const clean = String(value || "").trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
  }
  return result;
}

function parseDateParts(value) {
  const raw = String(value || "").trim();
  if (!raw) return {};

  const lower = raw.toLowerCase();
  const year = raw.match(/\b(19|20)\d{2}\b/)?.[0] || "";
  const yearMonth = raw.match(/\b(?:19|20)\d{2}[-/](\d{1,2})\b/);
  const monthYear = raw.match(/\b(\d{1,2})[-/](?:19|20)\d{2}\b/);
  const numericMonth = Number(yearMonth?.[1] || monthYear?.[1] || 0);
  if (numericMonth >= 1 && numericMonth <= 12) {
    return { year, monthName: MONTH_NAMES[numericMonth - 1] };
  }

  const monthIndex = MONTH_NAMES.findIndex((month) => lower.includes(month.toLowerCase()) || lower.includes(month.slice(0, 3).toLowerCase()));
  return { year, monthName: monthIndex >= 0 ? MONTH_NAMES[monthIndex] : "" };
}

function datePartCandidates(dateValue, part) {
  const { year, monthName } = parseDateParts(dateValue);
  if (part === "year") return year ? [year] : [];
  if (!monthName) return [];
  const monthNumber = MONTH_NAMES.indexOf(monthName) + 1;
  return uniqueTruthyStrings([monthName, monthName.slice(0, 3), String(monthNumber), String(monthNumber).padStart(2, "0")]);
}

function indexedEntry(entries, rawLabel, fallbackIndex = 0) {
  const raw = String(rawLabel || "");
  const indexText = raw.match(/(?:company-name|company|employer|organization|org|title|job-title|position-title|start-date-month|start-date-year|end-date-month|end-date-year|current-role|school|degree|discipline|field-of-study|major|education)[^\d]*(\d+)/i)?.[1]
    || raw.match(/\[(\d+)\]/)?.[1];
  const index = Number(indexText);
  const safeIndex = Number.isInteger(index) && index >= 0 ? index : fallbackIndex;
  return entries?.[safeIndex] || entries?.[fallbackIndex] || entries?.find((entry) => Object.values(entry || {}).some(Boolean)) || null;
}

function workEntry(profile, rawLabel) {
  return indexedEntry(profile?.workHistory || [], rawLabel);
}

function educationEntry(profile, rawLabel) {
  return indexedEntry(profile?.education || [], rawLabel);
}

function hasEmploymentContext(label, rawLabel) {
  const combined = normalizeLabel(`${label} ${rawLabel || ""}`);
  const hasEducationSignal = /\beducation\b|\bschool\b|\buniversity\b|\bcollege\b|\bdegree\b|\bdiscipline\b|\bfield of study\b|\bmajor\b/.test(combined);
  const hasWorkSignal = /\bemployment\b|\bwork history\b|\bwork experience\b|\bprofessional experience\b|\bexperience\b|company name \d|company \d|employer \d|organization \d|org \d|title \d|job title \d|position title \d|current role|current position/.test(combined);
  const hasDateIndexedSignal = /start date month \d|start date year \d|end date month \d|end date year \d/.test(combined);
  return hasWorkSignal || (hasDateIndexedSignal && !hasEducationSignal);
}

function hasEducationContext(label, rawLabel) {
  const combined = normalizeLabel(`${label} ${rawLabel || ""}`);
  return /\beducation\b|\bschool\b|\buniversity\b|\bcollege\b|\bdegree\b|\bdiscipline\b|\bfield of study\b|\bmajor\b|school \d|degree \d|discipline \d|field of study \d|major \d/.test(combined);
}

function degreeCandidates(education) {
  const degree = String(education?.degree || "").trim();
  const normalized = normalizeLabel(degree);
  const candidates = [degree];

  if (/\b(bachelor|bachelors|bachelor s|bs|b s|ba|b a)\b/.test(normalized)) {
    candidates.push("Bachelor's Degree", "Bachelor of Science", "Bachelor of Arts", "BS", "B.S.", "BA", "B.A.");
  }
  if (/\b(master|masters|master s|ms|m s|ma|m a|mba|m b a)\b/.test(normalized)) {
    candidates.push("Master's Degree", "Master of Science", "Master of Arts", "Master of Business Administration (M.B.A.)", "MS", "M.S.", "MA", "M.A.", "MBA");
  }
  if (/\b(associate|associates|associate s)\b/.test(normalized)) {
    candidates.push("Associate's Degree");
  }
  if (/\b(phd|ph d|doctor of philosophy|doctorate)\b/.test(normalized)) {
    candidates.push("Doctor of Philosophy (Ph.D.)");
  }

  return uniqueTruthyStrings(candidates);
}

function schoolCandidates(education) {
  const school = String(education?.school || "").trim();
  if (!school) return [];
  return uniqueTruthyStrings([
    school,
    school.replace(/,/g, ""),
    school.replace(/\b&\b/g, "and"),
    "0 - Other",
    "Other"
  ]);
}

function disciplineCandidates(education) {
  const field = String(education?.field || "").trim();
  const normalized = normalizeLabel(field);
  const candidates = [field];

  if (/\bcomputer\b|\bsoftware\b|\bprogramming\b/.test(normalized)) {
    candidates.push("Computer Science", "Engineering", "Information Systems");
  }
  if (/\bengineering\b/.test(normalized)) candidates.push("Engineering");
  if (/\belectrical\b|\belectronic\b/.test(normalized)) candidates.push("Electronics", "Engineering");
  if (/\binformation systems\b|\binformation technology\b|\bit\b/.test(normalized)) candidates.push("Information Systems", "Computer Science");
  if (/\bbusiness\b/.test(normalized)) candidates.push("Business", "Business Administration");
  if (/\bmath\b|\bmathematics\b/.test(normalized)) candidates.push("Mathematics");

  return uniqueTruthyStrings(candidates);
}

function hasProfessionalProfile(profile) {
  return Boolean(
    profile?.workHistory?.some((entry) => entry?.company || entry?.title)
      || profile?.education?.some((entry) => entry?.school || entry?.degree)
  );
}

function previouslyEmployedCandidates(label, profile) {
  const match = String(label || "").match(/\bpreviously\s+been\s+employed\s+by\s+(.+?)(?:\s+in\s+any\s+capacity|\?|$)/i);
  const employer = normalizeLabel(match?.[1] || "");
  if (!employer) return [];
  const hadEmployer = (profile?.workHistory || []).some((entry) => {
    const company = normalizeLabel(entry?.company || "");
    return company && (company === employer || company.includes(employer) || employer.includes(company));
  });
  return [hadEmployer ? "Yes" : "No"];
}

function aiToolUseCandidates(profile) {
  const text = normalizeLabel([
    profile?.workHistory?.map((entry) => `${entry?.title || ""} ${entry?.description || ""}`).join(" "),
    profile?.coverLetterTemplate
  ].filter(Boolean).join(" "));
  if (/\b(ai|artificial intelligence|automation|automate|agent|llm|copilot|prompt)\b/.test(text)) {
    return [
      "I design or automate workflows with AI tools (e.g., building agents, integrating AI into team processes).",
      "I regularly use AI tools to speed up existing tasks (e.g., drafting, summarizing, debugging, basic analysis)."
    ];
  }
  return [];
}

function currentRoleCandidates(entry) {
  return entry?.current ? ["true", "Yes", "Current role"] : [];
}

function workLocationCandidates(entry, profile) {
  return uniqueTruthyStrings([
    entry?.location,
    ...locationCandidates(profile)
  ]);
}

function heardAboutJobCandidates() {
  return [
    "Career Page",
    "Company Website",
    "Company Careers Page",
    "Company Careers Site",
    "Employer Website",
    "Job Board",
    "Other"
  ];
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
  // Preferred/chosen name is not stored separately today, so use the first
  // token of firstName before falling back to the full firstName/fullName.
  { test: (l) => /\b(preferred|chosen|nick)\s*name\b|\bnickname\b/.test(l), resolve: (p) => preferredNameCandidates(p) },
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
  { test: (l) => /\b(street\s*)?address( line 1)?\b/.test(l), resolve: (p) => p.addressLine1 || null },
  { test: (l) => /\bcity\b/.test(l) && !/location city|current location|^location$/.test(l), resolve: (p) => p.city || null },
  { test: (l) => /\b(state|province|region)\b/.test(l), resolve: (p) => p.stateRegion || null },
  { test: (l) => /\b(zip|postal)\s*code\b/.test(l), resolve: (p) => p.postalCode || null },
  { test: (l) => /\bcountry\b/.test(l) && !/\bcountry\s*code\b/.test(l), resolve: (p) => getCountryVariants(p.country) },
  { test: (l) => /location city|current location|^location$/.test(l), resolve: (p) => locationCandidates(p) },
  { test: (l) => l.includes("linkedin"), resolve: (p) => p.linkedinUrl },
  { test: (l) => l.includes("github"), resolve: (p) => p.githubUrl },
  { test: (l) => l.includes("personal website") || l.includes("portfolio"), resolve: (p) => p.portfolioUrl },
  { test: (l, raw) => hasEmploymentContext(l, raw) && (/\bcompany\s*name\b/.test(l) || /^company$/.test(l) || /^employer$/.test(l)), resolve: (p, l, raw) => workEntry(p, raw)?.company || null },
  { test: (l, raw) => hasEmploymentContext(l, raw) && (/^title$/.test(l) || /\bjob\s*title\b|\bposition\s*title\b/.test(l)), resolve: (p, l, raw) => workEntry(p, raw)?.title || null },
  { test: (l, raw) => hasEmploymentContext(l, raw) && /\b(location|city|state|country)\b/.test(l), resolve: (p, l, raw) => workLocationCandidates(workEntry(p, raw), p) },
  { test: (l, raw) => hasEmploymentContext(l, raw) && /\bcurrent\s*role\b|\bcurrent\s*position\b/.test(l), resolve: (p, l, raw) => currentRoleCandidates(workEntry(p, raw)) },
  { test: (l, raw) => hasEmploymentContext(l, raw) && /\bstart\s*date\s*month\b/.test(l), resolve: (p, l, raw) => datePartCandidates(workEntry(p, raw)?.startDate, "month") },
  { test: (l, raw) => hasEmploymentContext(l, raw) && /\bstart\s*date\s*year\b/.test(l), resolve: (p, l, raw) => datePartCandidates(workEntry(p, raw)?.startDate, "year") },
  { test: (l, raw) => hasEmploymentContext(l, raw) && /\bend\s*date\s*month\b/.test(l), resolve: (p, l, raw) => workEntry(p, raw)?.current ? [] : datePartCandidates(workEntry(p, raw)?.endDate, "month") },
  { test: (l, raw) => hasEmploymentContext(l, raw) && /\bend\s*date\s*year\b/.test(l), resolve: (p, l, raw) => workEntry(p, raw)?.current ? [] : datePartCandidates(workEntry(p, raw)?.endDate, "year") },
  { test: (l, raw) => hasEducationContext(l, raw) && /\bschool\b|\buniversity\b|\bcollege\b/.test(l), resolve: (p, l, raw) => schoolCandidates(educationEntry(p, raw)) },
  { test: (l, raw) => hasEducationContext(l, raw) && /\bdegree\b/.test(l), resolve: (p, l, raw) => degreeCandidates(educationEntry(p, raw)) },
  { test: (l, raw) => hasEducationContext(l, raw) && /\bdiscipline\b|\bfield\s*of\s*study\b|\bmajor\b/.test(l), resolve: (p, l, raw) => disciplineCandidates(educationEntry(p, raw)) },
  { test: (l, raw) => hasEducationContext(l, raw) && /\bstart\s*date\s*month\b/.test(l), resolve: (p, l, raw) => datePartCandidates(educationEntry(p, raw)?.startDate, "month") },
  { test: (l, raw) => hasEducationContext(l, raw) && /\bstart\s*date\s*year\b/.test(l), resolve: (p, l, raw) => datePartCandidates(educationEntry(p, raw)?.startDate, "year") },
  { test: (l, raw) => hasEducationContext(l, raw) && /\bend\s*date\s*month\b/.test(l), resolve: (p, l, raw) => datePartCandidates(educationEntry(p, raw)?.endDate, "month") },
  { test: (l, raw) => hasEducationContext(l, raw) && /\bend\s*date\s*year\b/.test(l), resolve: (p, l, raw) => datePartCandidates(educationEntry(p, raw)?.endDate, "year") },
  { test: (l) => /\bat least\s+18\b|\b18\s+years\s+of\s+age\b/.test(l), resolve: (p) => hasProfessionalProfile(p) ? "Yes" : null },
  { test: (l) => /\bpreviously\s+been\s+employed\s+by\b/.test(l), resolve: (p, l) => previouslyEmployedCandidates(l, p) },
  { test: (l) => /\bhow\b.*\bhear\b.*\b(job|role|position|opening)\b|\bwhere\b.*\b(find|found)\b.*\b(job|role|position|opening)\b/.test(l), resolve: () => heardAboutJobCandidates() },
  { test: (l) => /\b(confirm|receipt|acknowledge|acknowledgement)\b.*\b(privacy notice|privacy policy|arbitration agreement)\b/.test(l), resolve: () => ["Confirmed", "Yes", "I confirm", "I agree"] },
  { test: (l) => /\bi understand\b.*\bai tools\b.*\b(application|interview|hiring)\b/.test(l), resolve: () => ["Yes"] },
  { test: (l) => /\buse ai tools today\b|\busing ai tools\b/.test(l), resolve: (p) => aiToolUseCandidates(p) },
  { test: (l) => /\b(current|most recent|recent|latest)\b.*\b(company|employer|organization|organisation)\b/.test(l), resolve: (p) => p.workHistory?.[0]?.company },
  { test: (l) => /\b(current|most recent|recent|latest)\b.*\b(job\s*title|title|role|position)\b/.test(l), resolve: (p) => p.workHistory?.[0]?.title }
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
  const result = match.resolve(profile, label, rawLabel);
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
  return /\b(gender|sex|race|ethnicity|hispanic|latino|veteran|disability)\b/.test(label);
}

export function isWorkAuthLabel(label) {
  return /\bsponsorship\b|require.*immigration|\bvisa\b|authorized to work|work authorization/.test(label);
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const clean = String(value || "").trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
  }
  return result;
}

const EEO_DECLINE_CANDIDATES = [
  "Decline to self-identify",
  "Decline To Self Identify",
  "I don't wish to answer",
  "I do not wish to answer",
  "I don't want to answer",
  "I do not want to answer",
  "Prefer not to answer",
  "Prefer not to say",
  "Choose not to disclose",
  "I choose not to disclose"
];

function isDeclineEeoAnswer(value) {
  const normalized = normalizeLabel(value);
  return /\bdecline\b/.test(normalized)
    || /\bprefer not\b/.test(normalized)
    || /\bdo not want to answer\b/.test(normalized)
    || /\bdon t want to answer\b/.test(normalized)
    || /\bdo not wish to answer\b/.test(normalized)
    || /\bdon t wish to answer\b/.test(normalized)
    || /\bchoose not to disclose\b/.test(normalized);
}

function genderCandidates(value) {
  const normalized = normalizeLabel(value);
  if (!normalized) return [];
  if (isDeclineEeoAnswer(value)) return uniqueStrings([value, ...EEO_DECLINE_CANDIDATES]);
  if (normalized === "male" || normalized === "man") return uniqueStrings([value, "Male", "Man"]);
  if (normalized === "female" || normalized === "woman") return uniqueStrings([value, "Female", "Woman"]);
  return [String(value).trim()];
}

function raceEthnicityCandidates(label, value) {
  const normalized = normalizeLabel(value);
  if (!normalized) return [];
  if (isDeclineEeoAnswer(value)) return uniqueStrings([value, ...EEO_DECLINE_CANDIDATES]);

  const asksHispanicLatino = /\b(hispanic|latino)\b/.test(label);
  const asksEthnicity = /\bethnicity\b/.test(label);
  const isHispanicLatino = /\b(hispanic|latino)\b/.test(normalized);
  const candidates = [];

  if (asksHispanicLatino) {
    candidates.push(
      ...(isHispanicLatino
        ? ["Yes", "Yes, Hispanic or Latino", "Hispanic or Latino"]
        : ["No", "No, not Hispanic or Latino", "Not Hispanic or Latino", "No, I am not Hispanic or Latino"])
    );
  }

  const nonHispanicVariants = [
    `${value} (Not Hispanic or Latino)`,
    `${value} (Not Hispanic/Latino)`,
    `${value} (Not Hispanic or Latinx)`
  ];

  const raceVariants = {
    "hispanic or latino": ["Hispanic or Latino", "Hispanic/Latino", "Latino", "Latina/o/x"],
    white: ["White", "White (Not Hispanic or Latino)", "White (Not Hispanic/Latino)"],
    "black or african american": [
      "Black or African American",
      "Black or African American (Not Hispanic or Latino)",
      "Black or African-American",
      "Black / African American"
    ],
    "native hawaiian or other pacific islander": [
      "Native Hawaiian or Other Pacific Islander",
      "Native Hawaiian or Other Pacific Islander (Not Hispanic or Latino)"
    ],
    asian: ["Asian", "Asian (Not Hispanic or Latino)", "Asian (Not Hispanic/Latino)"],
    "american indian or alaska native": [
      "American Indian or Alaska Native",
      "American Indian or Alaska Native (Not Hispanic or Latino)"
    ],
    "two or more races": ["Two or More Races", "Two or More Races (Not Hispanic or Latino)"]
  };

  candidates.push(...(raceVariants[normalized] || [value]));
  if (!isHispanicLatino) {
    candidates.push(...nonHispanicVariants);
    if (asksEthnicity) candidates.push("Not Hispanic or Latino", "No, not Hispanic or Latino", "No");
  }
  return uniqueStrings(candidates);
}

function veteranCandidates(value) {
  const normalized = normalizeLabel(value);
  if (!normalized) return [];
  if (isDeclineEeoAnswer(value)) {
    return uniqueStrings([value, ...EEO_DECLINE_CANDIDATES, "I decline to self-identify for protected veteran status"]);
  }
  if (/\bnot\b.*\bprotected veteran\b/.test(normalized)) {
    return uniqueStrings([value, "I am not a protected veteran", "Not a protected veteran", "No"]);
  }
  if (/\bprotected veteran\b/.test(normalized) || /\bclassifications\b.*\bprotected veteran\b/.test(normalized)) {
    return uniqueStrings([
      value,
      "I identify as one or more of the classifications of a protected veteran",
      "I identify as one or more of the classifications of protected veteran listed above",
      "I am a protected veteran",
      "Protected veteran",
      "Yes"
    ]);
  }
  return [String(value).trim()];
}

function disabilityCandidates(value) {
  const normalized = normalizeLabel(value);
  if (!normalized) return [];
  if (isDeclineEeoAnswer(value)) return uniqueStrings([value, ...EEO_DECLINE_CANDIDATES]);
  if (/^yes\b/.test(normalized)) {
    return uniqueStrings([value, "Yes, I have a disability", "Yes"]);
  }
  if (/^no\b/.test(normalized)) {
    return uniqueStrings([value, "No, I do not have a disability", "No"]);
  }
  return [String(value).trim()];
}

export function resolveEeoCandidates(label, eeoAnswers) {
  const eeo = eeoAnswers || {};
  if (/\b(gender|sex)\b/.test(label)) return genderCandidates(eeo.gender);
  if (/\b(race|ethnicity|hispanic|latino)\b/.test(label)) return raceEthnicityCandidates(label, eeo.raceEthnicity);
  if (/\bveteran\b/.test(label)) return veteranCandidates(eeo.veteranStatus);
  if (/\bdisability\b/.test(label)) return disabilityCandidates(eeo.disabilityStatus);
  return [];
}

export function resolveEeoValue(label, eeoAnswers) {
  const candidates = resolveEeoCandidates(label, eeoAnswers);
  if (candidates.length > 0) return candidates[0];
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

// A saved answer (from either resolveManualOverride above or a memory-bank
// match) is free-form text a human typed — great for a plain text/textarea
// widget, but an EXACT match against it will often miss a fixed-option
// widget entirely: a location override like "San Diego, CA 92071" rarely
// matches an autocomplete's own canonical option text ("San Diego,
// California, United States"), and a qualification question rendered as a
// Yes/No dropdown rarely has an option matching a full sentence like "Yes, I
// have strong proficiency in...". Confirmed live: this is exactly why a
// saved answer can silently fail to apply and land the posting right back in
// manual review with the same fields, even though the answer was genuinely
// right. Returned in priority order — try the answer as typed first, same
// "try multiple candidates until one actually fills" pattern
// resolveStandardFieldCandidates() already uses for profile fields — so a
// plain text/textarea widget still gets the full, unmodified answer.
export function manualOverrideCandidates(answer) {
  const raw = String(answer || "").trim();
  if (!raw) return [];
  const candidates = [raw];

  const beforeComma = raw.split(",")[0].trim();
  if (beforeComma && beforeComma !== raw) candidates.push(beforeComma);

  if (/^yes\b/i.test(raw)) candidates.push("Yes");
  else if (/^no\b/i.test(raw)) candidates.push("No");

  return [...new Set(candidates)];
}

// The radio-group counterpart to fillByWidget/fillField/fillCandidates
// looping over manualOverrideCandidates() above — every adapter's own
// radio-group option-matching (EEO/work-auth today, a saved override/memory
// match now too) needs the exact same "try each candidate in turn against
// the option list" shape, so it lives here once rather than once per
// adapter. `options` is each adapter's own `{ text, value }` shape (or
// similar — only `.text` is read here); returns the first option whose text
// exactly matches (case-insensitively) any candidate, or null.
export function matchOptionByCandidates(options, candidates) {
  for (const candidate of candidates || []) {
    const target = String(candidate || "").trim().toLowerCase();
    if (!target) continue;
    const match = (options || []).find((option) => String(option.text || "").trim().toLowerCase() === target);
    if (match) return match;
  }
  return null;
}
