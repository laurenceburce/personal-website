import { createHash } from "node:crypto";

const FETCH_TIMEOUT_MS = 20000;
// Plenty for the LLM/embedding truncation windows (6-8K chars) plus full
// transparency in the review-queue UI, while bounding worst-case storage — a
// full-HTML approach here once grew one table to 200MB across ~4,500 postings.
export const MAX_DESCRIPTION_TEXT_CHARS = 20000;

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "job-search-bot/1.0 (personal use, owner-only tool)" }
    });
    if (!response.ok) throw new Error(`${url} responded with ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
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
    .replace(/[ \t]+/g, " ")
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

export function guessRemoteType(locationText, descriptionText) {
  const text = String(locationText || "").toLowerCase();
  if (/remote/.test(text)) return "remote";
  if (/hybrid/.test(text)) return "hybrid";
  if (descriptionText && STRONG_REMOTE_SIGNALS.test(descriptionText)) return "remote";
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
      remoteType: job.isRemote ? "remote" : guessRemoteType(locationText, descriptionText),
      seniorityGuess: guessSeniority(title),
      salaryMin: comp?.minValue != null ? Math.round(Number(comp.minValue)) : null,
      salaryMax: comp?.maxValue != null ? Math.round(Number(comp.maxValue)) : null,
      salaryCurrency: comp?.currencyCode || null,
      descriptionText,
      applyUrl: job.jobUrl || job.applyUrl || "",
      postedAt: job.publishedAt ? new Date(job.publishedAt) : null,
      contentHash: computeContentHash(title, descriptionText)
    };
  });
}

export async function fetchAtsJobs({ atsType, boardToken, companyName }) {
  switch (atsType) {
    case "greenhouse": return fetchGreenhouseJobs({ boardToken, companyName });
    case "lever": return fetchLeverJobs({ boardToken, companyName });
    case "ashby": return fetchAshbyJobs({ boardToken, companyName });
    default: throw new Error(`Unsupported ATS type: ${atsType}`);
  }
}
