function normalizeKeyword(value) {
  return String(value || "").trim().toLowerCase();
}

// Word-boundary match so "AI" doesn't match "Maintain" — keywords may be
// multi-word phrases ("machine learning"), matched as a literal phrase.
function matchesAnyKeyword(text, keywords) {
  const haystack = String(text || "").toLowerCase();
  return keywords.some((keyword) => {
    const needle = normalizeKeyword(keyword);
    if (!needle) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(haystack);
  });
}

// Plain predicate functions, evaluated all-at-once so a rejected posting still
// gets stored with every reason it failed for (status='filtered_out'), never
// silently dropped — useful for auditing/tuning findSettings later.
export function runHardFilters(posting, findSettings) {
  const reasons = [];
  const titleAndDepartment = `${posting.title || ""} ${posting.department || ""}`;

  const includeKeywords = (findSettings.titleKeywords || []).filter(Boolean);
  if (includeKeywords.length && !matchesAnyKeyword(titleAndDepartment, includeKeywords)) {
    reasons.push(`Title/department doesn't match any of: ${includeKeywords.join(", ")}`);
  }

  const excludeKeywords = (findSettings.excludeKeywords || []).filter(Boolean);
  if (excludeKeywords.length && matchesAnyKeyword(titleAndDepartment, excludeKeywords)) {
    reasons.push("Title/department matches an excluded keyword");
  }

  const locations = (findSettings.locations || []).filter(Boolean);
  const remotePreference = findSettings.remotePreference || "remote_friendly";
  if (remotePreference === "remote_only" && posting.remoteType !== "remote") {
    reasons.push("Not a remote position");
  } else if (remotePreference === "onsite_only" && posting.remoteType === "remote") {
    reasons.push("Fully remote position (onsite required)");
  } else if (locations.length && posting.remoteType !== "remote" && !matchesAnyKeyword(posting.locationText, locations)) {
    reasons.push(`Location "${posting.locationText}" doesn't match any of: ${locations.join(", ")}`);
  }

  const seniorityLevels = (findSettings.seniorityLevels || []).filter(Boolean);
  if (seniorityLevels.length && posting.seniorityGuess !== "unknown" && !seniorityLevels.includes(posting.seniorityGuess)) {
    reasons.push(`Seniority "${posting.seniorityGuess}" not in allowed levels: ${seniorityLevels.join(", ")}`);
  }

  // Only reject on salary when the posting actually discloses a floor — most
  // Greenhouse/Lever postings have no comp data at all, and absence isn't a signal.
  if (findSettings.salaryFloorUsd && posting.salaryMin != null && posting.salaryMin < findSettings.salaryFloorUsd) {
    reasons.push(`Salary min ${posting.salaryMin} is below floor ${findSettings.salaryFloorUsd}`);
  }

  const excludedCompanies = (findSettings.excludedCompanies || []).filter(Boolean);
  if (excludedCompanies.length) {
    const normalizedCompany = normalizeKeyword(posting.companyName);
    if (excludedCompanies.some((company) => normalizeKeyword(company) === normalizedCompany)) {
      reasons.push(`Company "${posting.companyName}" is excluded`);
    }
  }

  return { passed: reasons.length === 0, reasons };
}
