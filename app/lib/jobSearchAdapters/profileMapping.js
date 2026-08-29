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

function splitName(fullName) {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || "", last: parts.slice(1).join(" ") || "" };
}

// Each resolver returns a string to fill, or null/undefined if the profile
// doesn't have that data (in which case the field is left for the LLM
// free-text fallback, or flagged needs_manual_review — never guessed).
export const STANDARD_FIELD_RESOLVERS = [
  { test: (l) => l === "first name", resolve: (p) => splitName(p.fullName).first },
  { test: (l) => l === "last name", resolve: (p) => splitName(p.fullName).last },
  // "Legal Name" confirmed live on a real Ashby form — without this, it fell
  // through to the LLM free-text fallback, which answered truthfully but
  // verbosely ("The candidate's legal name is Test Candidate.") instead of a
  // clean field value, since it's not really a question needing explanation.
  { test: (l) => l === "full name" || l === "name" || l === "legal name", resolve: (p) => p.fullName },
  // Word-boundaried, not exact-equality — confirmed live as a real miss:
  // Ashby's own field is labeled "Phone Number", not bare "Phone", so the
  // old `l === "phone"` never matched it and a phone number that WAS on file
  // still landed in manual review every time. "Email Address" is the same
  // risk pre-emptively; both are common enough label variants that a narrow
  // exact match was never going to hold up.
  { test: (l) => /\bemail\b/.test(l), resolve: (p) => p.email },
  { test: (l) => /\bphone\b/.test(l), resolve: (p) => p.phone },
  { test: (l) => l === "country", resolve: (p) => p.country },
  { test: (l) => /location city|current location|^location$/.test(l), resolve: (p) => [p.city, p.stateRegion].filter(Boolean).join(", ") },
  { test: (l) => l.includes("linkedin"), resolve: (p) => p.linkedinUrl },
  { test: (l) => l.includes("github"), resolve: (p) => p.githubUrl },
  { test: (l) => l.includes("personal website") || l.includes("portfolio"), resolve: (p) => p.portfolioUrl },
  { test: (l) => l.includes("current company"), resolve: (p) => p.workHistory?.[0]?.company },
  { test: (l) => l.includes("current title") || l.includes("current role"), resolve: (p) => p.workHistory?.[0]?.title }
];

export function resolveStandardField(label, profile) {
  const match = STANDARD_FIELD_RESOLVERS.find((r) => r.test(label));
  const value = match?.resolve(profile);
  return value ? String(value) : null;
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
