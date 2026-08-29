import { createHash } from "node:crypto";

const FETCH_TIMEOUT_MS = 20000;

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

export function guessRemoteType(locationText) {
  const text = String(locationText || "").toLowerCase();
  if (/remote/.test(text)) return "remote";
  if (/hybrid/.test(text)) return "hybrid";
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
    const descriptionHtml = job.content || "";
    const descriptionText = stripHtml(descriptionHtml);
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
      remoteType: guessRemoteType(locationText),
      seniorityGuess: guessSeniority(title),
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      descriptionHtml,
      descriptionText,
      applyUrl: job.absolute_url || "",
      postedAt: job.updated_at ? new Date(job.updated_at) : null,
      contentHash: computeContentHash(title, descriptionText),
      rawJson: job
    };
  });
}

export async function fetchLeverJobs({ boardToken, companyName }) {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(boardToken)}?mode=json`;
  const data = await fetchJson(url);
  const postings = Array.isArray(data) ? data : [];

  return postings.map((posting) => {
    const descriptionHtml = posting.description || posting.descriptionBodyHtml || "";
    const descriptionText = posting.descriptionPlain || stripHtml(descriptionHtml);
    const locationText = posting.categories?.location || "";
    const title = posting.text || "";
    const workplaceType = String(posting.categories?.workplaceType || "").toLowerCase();
    const remoteType = workplaceType.includes("remote")
      ? "remote"
      : workplaceType.includes("hybrid")
        ? "hybrid"
        : workplaceType.includes("on-site") || workplaceType.includes("onsite")
          ? "onsite"
          : guessRemoteType(locationText);

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
      descriptionHtml,
      descriptionText,
      applyUrl: posting.applyUrl || posting.hostedUrl || "",
      postedAt: posting.createdAt ? new Date(Number(posting.createdAt)) : null,
      contentHash: computeContentHash(title, descriptionText),
      rawJson: posting
    };
  });
}

export async function fetchAshbyJobs({ boardToken, companyName }) {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(boardToken)}?includeCompensation=true`;
  const data = await fetchJson(url);
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];

  return jobs.map((job) => {
    const descriptionHtml = job.descriptionHtml || "";
    const descriptionText = stripHtml(descriptionHtml);
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
      remoteType: job.isRemote ? "remote" : guessRemoteType(locationText),
      seniorityGuess: guessSeniority(title),
      salaryMin: comp?.minValue != null ? Math.round(Number(comp.minValue)) : null,
      salaryMax: comp?.maxValue != null ? Math.round(Number(comp.maxValue)) : null,
      salaryCurrency: comp?.currencyCode || null,
      descriptionHtml,
      descriptionText,
      applyUrl: job.jobUrl || job.applyUrl || "",
      postedAt: job.publishedAt ? new Date(job.publishedAt) : null,
      contentHash: computeContentHash(title, descriptionText),
      rawJson: job
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
