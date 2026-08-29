import { ensureJobSearchSchema, requirePool } from "./jobSearchDb.js";
import { SALARY_BANDS } from "./jobSearchScoringConfig.js";

const FREE_EMAIL_DOMAINS = ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com", "aol.com"];
const OFFICIAL_APPLY_DOMAINS = ["boards.greenhouse.io", "job-boards.greenhouse.io", "jobs.lever.co", "jobs.ashbyhq.com"];
const DOMAIN_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DOMAIN_LOOKUP_TIMEOUT_MS = 8000;
const YOUNG_DOMAIN_DAYS = 90;

function extractEmails(text) {
  return String(text || "").match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isOfficialAtsHost(host) {
  return OFFICIAL_APPLY_DOMAINS.some((official) => host === official || host.endsWith(`.${official}`));
}

// Finds links in the JD text that are (a) near the word "apply"/"application",
// (b) not on a known ATS domain, and (c) not just the posting's own apply_url —
// this is the one signal legitimate Greenhouse/Lever/Ashby-hosted postings almost
// never trigger, which is also why it's the only rule worth an RDAP lookup over.
function findSuspiciousApplyHosts(posting) {
  const text = posting.descriptionText || "";
  const applyUrlHost = hostnameOf(posting.applyUrl);
  const urlRegex = /(.{0,60})(https?:\/\/[^\s"'<>)]+)/gi;
  const hosts = new Set();
  let match;
  while ((match = urlRegex.exec(text))) {
    const context = match[1];
    const host = hostnameOf(match[2]);
    if (!host || isOfficialAtsHost(host) || host === applyUrlHost) continue;
    if (/apply|application/i.test(context)) hosts.add(host);
  }
  return [...hosts];
}

// Each rule reads from `ctx` (the posting plus suspiciousApplyHosts computed
// once up front) and never throws on missing fields — a bad shape just means
// the rule doesn't fire, never crashes the whole assessment.
export const SCAM_RULES = [
  {
    id: "upfront_payment_request",
    weight: 30,
    label: "Asks the applicant to pay for something upfront",
    test: (ctx) => /\b(processing fee|starter kit|starting kit|pay(?:ment)? (?:for|to receive) (?:your |a )?(?:equipment|kit|training)|background check.{0,20}paid by you|purchase.{0,20}(?:equipment|software).{0,10}(?:yourself|upfront))\b/i
      .test(ctx.descriptionText || "")
  },
  {
    id: "free_email_contact",
    weight: 25,
    label: "Recruiter contact is a free/personal email address",
    test: (ctx) => extractEmails(ctx.descriptionText).some((email) =>
      FREE_EMAIL_DOMAINS.some((domain) => email.toLowerCase().endsWith(`@${domain}`))
    )
  },
  {
    id: "messaging_app_contact",
    weight: 20,
    label: "Pushes contact via WhatsApp/Telegram/Signal or a personal number",
    test: (ctx) => /\b(whatsapp|telegram|signal)\b.{0,40}\b(text|message|contact|reach)\b|\b(text|message)\s+(?:me|us)\s+(?:at|on)\b.{0,20}\d{3}/i
      .test(ctx.descriptionText || "")
  },
  {
    id: "comp_outlier_high",
    weight: 20,
    label: "Disclosed comp is implausibly high for the guessed seniority",
    test: (ctx) => {
      if (ctx.salaryMin == null && ctx.salaryMax == null) return false;
      const band = SALARY_BANDS[ctx.seniorityGuess] || SALARY_BANDS.unknown;
      const topOfRange = ctx.salaryMax ?? ctx.salaryMin;
      return topOfRange > band.max * 1.75;
    }
  },
  {
    id: "apply_url_mismatch",
    weight: 15,
    label: "JD links to an \"apply here\" URL outside the known ATS domains",
    test: (ctx) => ctx.suspiciousApplyHosts.length > 0
  },
  {
    id: "vague_company_info",
    weight: 10,
    label: "Listing is extremely short with no real company/role detail",
    test: (ctx) => (ctx.descriptionText || "").trim().length < 200
  }
];

// Free, keyless RDAP bootstrap lookup — soft-fails to null on any error/timeout/
// unsupported TLD so a lookup failure never itself counts as a red flag. Cached
// for 30 days per domain since registration age never needs fresher data than that.
export async function checkDomainAge(domain) {
  if (!domain) return null;
  const pool = requirePool(await ensureJobSearchSchema());

  const [cached] = await pool.query(
    "SELECT age_days, lookup_ok, checked_at FROM job_search_domain_cache WHERE domain = ? LIMIT 1",
    [domain]
  );
  if (cached[0] && Date.now() - new Date(cached[0].checked_at).getTime() < DOMAIN_CACHE_MAX_AGE_MS) {
    return cached[0].lookup_ok ? Number(cached[0].age_days) : null;
  }

  let ageDays = null;
  let lookupOk = false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOMAIN_LOOKUP_TIMEOUT_MS);
    try {
      // rdap.org sits behind Cloudflare bot management and returns a 403
      // challenge page to bare server-side fetches with no User-Agent —
      // a browser-like one is required even though this is a plain JSON API.
      const response = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          "Accept": "application/rdap+json"
        }
      });
      if (response.ok) {
        const data = await response.json();
        const registrationEvent = (data.events || []).find((event) => event.eventAction === "registration");
        if (registrationEvent?.eventDate) {
          ageDays = Math.floor((Date.now() - new Date(registrationEvent.eventDate).getTime()) / (24 * 60 * 60 * 1000));
          lookupOk = true;
        }
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    // Network error, timeout, or unsupported TLD — no signal, not a red flag.
  }

  await pool.query(
    `INSERT INTO job_search_domain_cache (domain, age_days, lookup_ok, checked_at)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE age_days = VALUES(age_days), lookup_ok = VALUES(lookup_ok), checked_at = VALUES(checked_at)`,
    [domain, ageDays, lookupOk ? 1 : 0, new Date()]
  );

  return lookupOk ? ageDays : null;
}

// Pure rules + one conditional RDAP call, never an LLM. Informational only —
// callers surface this as a badge, it never gates the review queue.
export async function assessScamRisk(posting) {
  const suspiciousApplyHosts = findSuspiciousApplyHosts(posting);
  const ctx = { ...posting, suspiciousApplyHosts };

  const flags = [];
  let score = 0;
  for (const rule of SCAM_RULES) {
    try {
      if (rule.test(ctx)) {
        flags.push(rule.id);
        score += rule.weight;
      }
    } catch {
      // A single bad rule should never break the whole assessment.
    }
  }

  // Only spend an RDAP lookup on a domain we already have another reason to be
  // suspicious of — the vast majority of ATS-hosted postings have none, so this
  // keeps the common case free of network calls entirely.
  if (suspiciousApplyHosts.length) {
    for (const host of suspiciousApplyHosts) {
      try {
        const ageDays = await checkDomainAge(host);
        if (ageDays != null && ageDays < YOUNG_DOMAIN_DAYS) {
          flags.push("domain_age_young");
          score += 15;
          break;
        }
      } catch {
        // checkDomainAge already soft-fails internally; this is just a final guard.
      }
    }
  }

  score = Math.min(100, score);
  const level = score >= 50 ? "high" : score >= 20 ? "medium" : "low";
  return { score, level, flags };
}
