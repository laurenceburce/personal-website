import { appError } from "./jobSearchDb.js";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";
const GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_LOOKBACK_MINUTES = 10;
const DEFAULT_MAX_RESULTS = 20;
const MAX_LOOKBACK_MINUTES = 60;
const MAX_RESULTS_CAP = 50;

const SECURITY_TERMS = /\b(security|verification|verify|one[-\s]?time|authentication|login|sign[-\s]?in|passcode|otp|confirm|validate|code)\b/i;
const CODE_CONTEXT_TERMS = /\b(code|passcode|otp|pin|verification|security|authentication|one[-\s]?time)\b/i;
const CODE_MARKER_TERMS = "(?:code|passcode|otp|pin|verification|security|authentication|confirmation)";
const CODE_TOKEN_STOPWORDS = new Set([
  "application",
  "authentication",
  "checking",
  "confirm",
  "confirmation",
  "greenhouse",
  "identity",
  "passcode",
  "security",
  "verification",
  "verify"
]);
const COMPANY_STOPWORDS = new Set([
  "the",
  "and",
  "inc",
  "llc",
  "ltd",
  "corp",
  "corporation",
  "company",
  "co",
  "group",
  "holdings",
  "careers",
  "jobs",
  "recruiting"
]);
const HOST_STOPWORDS = new Set([
  "www",
  "jobs",
  "job",
  "careers",
  "apply",
  "app",
  "boards",
  "greenhouse",
  "lever",
  "workday",
  "myworkdayjobs",
  "oraclecloud",
  "oracle",
  "taleo",
  "ashbyhq",
  "workable",
  "recruitee",
  "breezy"
]);

function env(name) {
  return String(process.env[name] || "").trim();
}

function intEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number(env(name));
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function getEmailProvider() {
  return env("JOB_SEARCH_EMAIL_PROVIDER").toLowerCase() || (env("JOB_SEARCH_GMAIL_REFRESH_TOKEN") ? "gmail" : "");
}

function getGmailCredential(name, fallbackName) {
  return env(name) || (fallbackName ? env(fallbackName) : "");
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeBase64Url(data) {
  if (!data) return "";
  return Buffer.from(String(data).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function collectPayloadText(payload, chunks = []) {
  if (!payload) return chunks;

  const mimeType = String(payload.mimeType || "").toLowerCase();
  const data = payload.body?.data;
  if (data && (mimeType.startsWith("text/plain") || mimeType.startsWith("text/html"))) {
    const text = decodeBase64Url(data);
    chunks.push(mimeType.startsWith("text/html") ? stripHtml(text) : text);
  }

  for (const part of payload.parts || []) {
    collectPayloadText(part, chunks);
  }

  return chunks;
}

function headerValue(message, name) {
  const headers = message?.payload?.headers || [];
  const found = headers.find((header) => String(header.name || "").toLowerCase() === name.toLowerCase());
  return String(found?.value || "").trim();
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function codeCharactersPattern(code) {
  return String(code).split("").map(escapeRegExp).join("[\\s-]*");
}

function expectedCodeLengthsFromChallenge(challenge) {
  const text = normalizeText([
    challenge?.promptText,
    challenge?.jobTitle,
    challenge?.companyName
  ].filter(Boolean).join(" "));
  const lengths = new Set();
  const patterns = [
    /\b(\d{1,2})\s*[- ]?\s*(?:character|characters|char|chars|digit|digits)\s+(?:code|passcode|otp|pin)\b/gi,
    /\b(?:code|passcode|otp|pin)\b\D{0,40}\b(\d{1,2})\s*[- ]?\s*(?:character|characters|char|chars|digit|digits)\b/gi
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) {
      const length = Number(match[1]);
      if (Number.isInteger(length) && length >= 4 && length <= 12) lengths.add(length);
    }
  }

  return lengths;
}

function candidateLooksLikeNoise(code, { rawCode, directContext, expectedLengths }) {
  const normalized = String(code || "").trim();
  const raw = String(rawCode || "").trim();
  if (!normalized) return true;
  if (/^20[2-3]\d$/.test(normalized)) return true;
  if (/^[01]+$/.test(normalized) && normalized.length >= 6) return true;
  if (CODE_TOKEN_STOPWORDS.has(normalized.toLowerCase())) return true;
  if (expectedLengths.size > 0 && !expectedLengths.has(normalized.length)) return true;

  const hasDigit = /\d/.test(normalized);
  const hasLetter = /[a-z]/i.test(normalized);
  if (hasDigit && hasLetter) return false;
  if (hasDigit) return false;

  // All-letter tokens are common in sender names, company names, subjects,
  // and legal footer text. Only accept them when the surrounding sentence is
  // explicitly presenting the token as the code.
  return !directContext || raw !== raw.toUpperCase();
}

function extractCodes(text, { expectedLengths = new Set() } = {}) {
  const source = normalizeText(text);
  const candidates = [];
  const seen = new Set();
  const codePatterns = [
    /(^|[^a-z0-9])([a-z0-9]{4,12})(?![a-z0-9])/gi,
    /(^|[^\d])(\d(?:[\s-]?\d){3,7})(?!\d)/g
  ];

  for (const codePattern of codePatterns) {
    let match;
    while ((match = codePattern.exec(source))) {
      const rawCode = match[2];
      const code = rawCode.replace(/[\s-]/g, "");
      if (code.length < 4 || code.length > 12) continue;

      const start = match.index + match[1].length;
      const context = source.slice(Math.max(0, start - 120), Math.min(source.length, start + rawCode.length + 160));
      if (!CODE_CONTEXT_TERMS.test(context)) continue;

      const flexibleCode = codeCharactersPattern(code);
      const before = new RegExp(`\\b${CODE_MARKER_TERMS}\\b\\D{0,90}${flexibleCode}`, "i");
      const after = new RegExp(`${flexibleCode}\\D{0,90}\\b${CODE_MARKER_TERMS}\\b`, "i");
      const directContext = before.test(context) || after.test(context);
      if (candidateLooksLikeNoise(code, { rawCode, directContext, expectedLengths })) continue;

      const key = code.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);

      let score = directContext ? 40 : 18;
      if (expectedLengths.has(code.length)) score += 35;
      else if (expectedLengths.size === 0 && code.length === 6) score += 10;
      else if (expectedLengths.size === 0 && (code.length === 5 || code.length === 7 || code.length === 8)) score += 4;
      if (code.length === 4) score -= 5;
      if (/[a-z]/i.test(code) && /\d/.test(code)) score += 8;
      if (/^\d+$/.test(code) && code.length < 6) score -= 8;

      candidates.push({ code, score, context });
    }
  }

  return candidates;
}

function tokensFromText(text, stopwords) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !stopwords.has(token));
}

function companyTokens(companyName) {
  return tokensFromText(companyName, COMPANY_STOPWORDS).slice(0, 8);
}

function hostTokens(applyUrl) {
  try {
    return tokensFromText(new URL(applyUrl).hostname, HOST_STOPWORDS).slice(0, 8);
  } catch {
    return [];
  }
}

function scoreContextMatches(text, tokens, pointsPerMatch, maxPoints) {
  if (!tokens.length) return 0;
  const lower = text.toLowerCase();
  const matches = tokens.filter((token) => lower.includes(token)).length;
  return Math.min(maxPoints, matches * pointsPerMatch);
}

function parseMessage(message) {
  const subject = headerValue(message, "Subject");
  const from = headerValue(message, "From");
  const date = headerValue(message, "Date");
  const receivedAt = Number(message.internalDate || 0);
  const body = collectPayloadText(message.payload).join("\n");
  const text = [subject, from, message.snippet, body].filter(Boolean).join("\n");

  return {
    id: message.id,
    subject,
    from,
    date,
    receivedAt,
    text: normalizeText(text)
  };
}

function scoreCandidate({ challenge, message, candidate, now, lookbackMs }) {
  const text = message.text || "";
  let score = candidate.score;

  if (SECURITY_TERMS.test(message.subject)) score += 12;
  if (SECURITY_TERMS.test(text)) score += 8;

  score += scoreContextMatches(text, companyTokens(challenge.companyName), 9, 27);
  score += scoreContextMatches([message.from, text].join(" "), hostTokens(challenge.applyUrl), 7, 21);

  if (message.receivedAt) {
    const ageMs = Math.max(0, now - message.receivedAt);
    if (ageMs <= lookbackMs) score += Math.max(0, 18 - Math.floor(ageMs / 60_000) * 2);
  }

  return score;
}

function buildGmailSearchQuery(lookbackMinutes) {
  const customQuery = env("JOB_SEARCH_EMAIL_SEARCH_QUERY");
  const lookbackClause = `newer_than:${lookbackMinutes}m`;
  return customQuery ? `${customQuery} ${lookbackClause}` : lookbackClause;
}

function gmailLabelIds() {
  const setting = env("JOB_SEARCH_GMAIL_LABEL_IDS") || "INBOX";
  if (setting === "*") return [];
  return setting.split(",").map((label) => label.trim()).filter(Boolean);
}

async function fetchJson(url, options, errorMessage) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const upstreamMessage = payload?.error_description || payload?.error?.message || payload?.error;
    throw appError(upstreamMessage ? `${errorMessage}: ${upstreamMessage}` : errorMessage, response.status >= 500 ? 502 : response.status);
  }
  return payload;
}

async function refreshGmailAccessToken() {
  const clientId = getGmailCredential("JOB_SEARCH_GMAIL_CLIENT_ID", "AUTH_GOOGLE_ID");
  const clientSecret = getGmailCredential("JOB_SEARCH_GMAIL_CLIENT_SECRET", "AUTH_GOOGLE_SECRET");
  const refreshToken = env("JOB_SEARCH_GMAIL_REFRESH_TOKEN");

  if (!clientId || !clientSecret || !refreshToken) {
    throw appError(
      "Gmail code lookup is not configured. Set JOB_SEARCH_GMAIL_REFRESH_TOKEN and either JOB_SEARCH_GMAIL_CLIENT_ID/JOB_SEARCH_GMAIL_CLIENT_SECRET or AUTH_GOOGLE_ID/AUTH_GOOGLE_SECRET.",
      503
    );
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });

  const payload = await fetchJson(
    GMAIL_TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    },
    "Gmail token refresh failed"
  );

  if (!payload.access_token) throw appError("Gmail token refresh did not return an access token.", 502);
  return payload.access_token;
}

async function gmailRequest(path, accessToken, params = {}) {
  const url = new URL(`${GMAIL_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item);
    } else if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  return fetchJson(
    url,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    "Gmail request failed"
  );
}

async function findGmailSecurityCode(challenge) {
  const accessToken = await refreshGmailAccessToken();
  const userId = env("JOB_SEARCH_GMAIL_USER") || "me";
  const lookbackMinutes = intEnv("JOB_SEARCH_EMAIL_LOOKBACK_MINUTES", DEFAULT_LOOKBACK_MINUTES, { min: 1, max: MAX_LOOKBACK_MINUTES });
  const maxResults = intEnv("JOB_SEARCH_EMAIL_MAX_RESULTS", DEFAULT_MAX_RESULTS, { min: 1, max: MAX_RESULTS_CAP });
  const now = Date.now();
  const lookbackMs = lookbackMinutes * 60_000;
  const expectedLengths = expectedCodeLengthsFromChallenge(challenge);

  const listParams = {
    q: buildGmailSearchQuery(lookbackMinutes),
    maxResults,
    includeSpamTrash: env("JOB_SEARCH_EMAIL_INCLUDE_SPAM_TRASH") === "true",
    labelIds: gmailLabelIds()
  };
  const list = await gmailRequest(`/users/${encodeURIComponent(userId)}/messages`, accessToken, listParams);
  const messageRefs = Array.isArray(list.messages) ? list.messages : [];
  if (messageRefs.length === 0) {
    throw appError("No recent email messages were found for security-code lookup.", 404);
  }

  const candidates = [];
  for (const ref of messageRefs) {
    if (!ref?.id) continue;
    const rawMessage = await gmailRequest(`/users/${encodeURIComponent(userId)}/messages/${encodeURIComponent(ref.id)}`, accessToken, {
      format: "full"
    });
    const message = parseMessage(rawMessage);
    if (message.receivedAt && now - message.receivedAt > lookbackMs) continue;
    if (!SECURITY_TERMS.test(message.text)) continue;

    for (const candidate of extractCodes(message.text, { expectedLengths })) {
      candidates.push({
        ...candidate,
        message,
        score: scoreCandidate({ challenge, message, candidate, now, lookbackMs })
      });
    }
  }

  candidates.sort((a, b) => (b.score - a.score) || ((b.message.receivedAt || 0) - (a.message.receivedAt || 0)));
  const best = candidates[0];
  if (!best) {
    throw appError("No recent email security code was found. Wait a few seconds and try again.", 404);
  }

  return {
    code: best.code,
    provider: "gmail",
    subject: best.message.subject,
    from: best.message.from,
    receivedAt: best.message.receivedAt ? new Date(best.message.receivedAt).toISOString() : "",
    messageId: best.message.id
  };
}

export async function findEmailSecurityCode(challenge) {
  if ((challenge?.challengeKind || "security_code") !== "security_code") {
    throw appError("Email lookup is only available for security-code prompts.");
  }

  const provider = getEmailProvider();
  if (!provider) {
    throw appError("Email code lookup is not configured. Set JOB_SEARCH_EMAIL_PROVIDER=gmail and Gmail credentials.", 503);
  }
  if (provider !== "gmail") {
    throw appError(`Email provider "${provider}" is not supported yet. Use JOB_SEARCH_EMAIL_PROVIDER=gmail.`, 503);
  }

  return findGmailSecurityCode(challenge);
}
