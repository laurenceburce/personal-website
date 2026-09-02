import { appError } from "./jobSearchDb.js";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";
const GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_LOOKBACK_MINUTES = 30;
const DEFAULT_MAX_RESULTS = 30;
const DEFAULT_CONFIRMATION_LOOKBACK_MINUTES = 30;
const MAX_LOOKBACK_MINUTES = 60;
const MAX_CONFIRMATION_LOOKBACK_MINUTES = 120;
const MAX_RESULTS_CAP = 100;
const SECURITY_CODE_CREATED_GRACE_MS = 2 * 60 * 1000;

const SECURITY_TERMS = /\b(security|verification|verify|one[-\s]?time|authentication|login|sign[-\s]?in|passcode|otp|confirm|validate|code)\b/i;
const CODE_CONTEXT_TERMS = /\b(code|passcode|otp|pin|verification|security|authentication|one[-\s]?time)\b/i;
const CODE_MARKER_TERMS = "(?:code|passcode|otp|pin|verification|security|authentication|confirmation)";
const CODE_VALUE_MARKER_TERMS = "(?:(?:security|verification|authentication|confirmation|one[-\\s]?time)\\s+)?(?:code|passcode|otp|pin)";
const SUBMISSION_CONFIRMATION_TERMS = /(thank you for applying|thanks for applying|thank you for your application|thanks for your application|application (?:has been |was |is )?(?:successfully )?(?:submitted|received|sent)|we(?:'ve| have) received your application|we received your application|we got your application|your application (?:has been|was|is) received|application received)/i;
const NON_CONFIRMATION_EMAIL_TERMS = /(?:security|verification|authentication|one[-\s]?time)\s+(?:code|passcode|pin)|enter .{0,80}\b(?:code|passcode|pin|otp)\b|confirm you(?:'re| are) human|verify .{0,40}(?:identity|email)|complete your application|finish your application|action required/i;
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
    .replace(/&quot;/gi, "\"")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
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

function normalizeCodeToken(value) {
  return String(value || "").replace(/[\s-]/g, "").trim();
}

function expectedCodeLengthsFromChallenge(challenge) {
  const text = normalizeText([
    challenge?.promptText,
    challenge?.jobTitle,
    challenge?.companyName
  ].filter(Boolean).join(" "));
  const lengths = new Set();
  const patterns = [
    /\b(\d{1,2})\s*[-–—‑]?\s*(?:character|characters|char|chars|digit|digits)\s+(?:code|passcode|otp|pin)\b/gi,
    /\b(?:code|passcode|otp|pin)\b\D{0,40}\b(\d{1,2})\s*[-–—‑]?\s*(?:character|characters|char|chars|digit|digits)\b/gi
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
  const hasExpectedLength = expectedLengths.has(normalized.length);
  if (!normalized) return true;
  if (/^20[2-3]\d$/.test(normalized)) return true;
  if (/^[01]+$/.test(normalized) && normalized.length >= 6 && !directContext && !hasExpectedLength) return true;
  if (CODE_TOKEN_STOPWORDS.has(normalized.toLowerCase())) return true;
  if (expectedLengths.size > 0 && !hasExpectedLength) return true;

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
  const addCandidate = ({ rawCode, start, directContextHint = false }) => {
    const code = normalizeCodeToken(rawCode);
    if (code.length < 4 || code.length > 12) return;

    const context = source.slice(Math.max(0, start - 120), Math.min(source.length, start + String(rawCode).length + 160));
    if (!CODE_CONTEXT_TERMS.test(context)) return;

    const flexibleCode = codeCharactersPattern(code);
    const before = new RegExp(`\\b${CODE_MARKER_TERMS}\\b\\D{0,90}${flexibleCode}`, "i");
    const after = new RegExp(`${flexibleCode}\\D{0,90}\\b${CODE_MARKER_TERMS}\\b`, "i");
    const directContext = directContextHint || before.test(context) || after.test(context);
    if (candidateLooksLikeNoise(code, { rawCode, directContext, expectedLengths })) return;

    const key = code.toUpperCase();
    if (seen.has(key)) return;
    seen.add(key);

    let score = directContext ? 40 : 18;
    if (expectedLengths.has(code.length)) score += 35;
    else if (expectedLengths.size === 0 && code.length === 6) score += 10;
    else if (expectedLengths.size === 0 && (code.length === 5 || code.length === 7 || code.length === 8)) score += 4;
    if (code.length === 4) score -= 5;
    if (/[a-z]/i.test(code) && /\d/.test(code)) score += 8;
    if (/^\d+$/.test(code) && code.length < 6) score -= 8;

    candidates.push({ code, score, context });
  };

  // Greenhouse and similar systems sometimes render an 8-character code as
  // `ABCD-EFGH` or as separate styled characters. The generic token scan
  // below would see that as two 4-character tokens and reject both when the
  // prompt asks for an 8-character code, so scan marker-adjacent windows for
  // grouped alphanumeric tokens first.
  const groupedPatterns = [
    new RegExp(`\\b${CODE_VALUE_MARKER_TERMS}\\b(?:\\s+(?:is|are|was|will be|below))?[^a-z0-9]{0,80}([a-z0-9](?:[\\s-]*[a-z0-9]){3,11})(?![a-z0-9])`, "gi"),
    new RegExp(`(^|[^a-z0-9])([a-z0-9](?:[\\s-]*[a-z0-9]){3,11})[^a-z0-9]{0,80}\\b${CODE_VALUE_MARKER_TERMS}\\b`, "gi")
  ];
  for (const pattern of groupedPatterns) {
    let match;
    while ((match = pattern.exec(source))) {
      const rawCode = match[2] || match[1];
      const leading = match[2] ? String(match[1] || "").length : 0;
      addCandidate({ rawCode, start: match.index + leading, directContextHint: true });
    }
  }

  const codePatterns = [
    /(^|[^a-z0-9])([a-z0-9]{4,12})(?![a-z0-9])/gi,
    /(^|[^\d])(\d(?:[\s-]?\d){3,7})(?!\d)/g
  ];

  for (const codePattern of codePatterns) {
    let match;
    while ((match = codePattern.exec(source))) {
      const rawCode = match[2];
      const start = match.index + match[1].length;
      addCandidate({ rawCode, start });
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

function securityCodeSearchSinceMs(challenge) {
  const createdAtMs = new Date(challenge?.createdAt || 0).getTime();
  if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) return 0;
  return Math.max(0, createdAtMs - SECURITY_CODE_CREATED_GRACE_MS);
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

function challengeSearchTerms(challenge) {
  return [
    ...companyTokens(challenge?.companyName),
    ...tokensFromText(challenge?.jobTitle, COMPANY_STOPWORDS).slice(0, 4),
    ...hostTokens(challenge?.applyUrl)
  ].slice(0, 10);
}

function postingSearchTerms(posting) {
  return [
    ...companyTokens(posting?.companyName),
    ...tokensFromText(posting?.title || posting?.jobTitle, COMPANY_STOPWORDS).slice(0, 6),
    ...hostTokens(posting?.applyUrl)
  ].slice(0, 12);
}

function buildGmailSearchQueries(challenge, lookbackMinutes) {
  const customQuery = env("JOB_SEARCH_EMAIL_SEARCH_QUERY");
  const lookbackClause = `newer_than:${lookbackMinutes}m`;
  const queries = [];
  const add = (query) => {
    const clean = String(query || "").replace(/\s+/g, " ").trim();
    if (clean && !queries.includes(clean)) queries.push(clean);
  };

  if (customQuery) add(`${customQuery} ${lookbackClause}`);
  add(`from:greenhouse-mail.io ${lookbackClause}`);
  add(`from:greenhouse.io ${lookbackClause}`);
  add(`"verification code" ${lookbackClause}`);
  add(`"security code" ${lookbackClause}`);
  add(`"confirm you're human" ${lookbackClause}`);
  add(`"confirm you are human" ${lookbackClause}`);
  for (const token of challengeSearchTerms(challenge).slice(0, 4)) {
    add(`${token} ${lookbackClause}`);
  }
  add(lookbackClause);

  return queries;
}

function confirmationSenderQueries(applyUrl, lookbackClause) {
  let hostname = "";
  try {
    hostname = new URL(applyUrl || "").hostname.toLowerCase();
  } catch {
    hostname = "";
  }

  if (/greenhouse/.test(hostname)) return [`from:greenhouse-mail.io ${lookbackClause}`, `from:greenhouse.io ${lookbackClause}`];
  if (/ashby/.test(hostname)) return [`from:ashbyhq.com ${lookbackClause}`, `from:ashbyhq.io ${lookbackClause}`];
  if (/lever/.test(hostname)) return [`from:lever.co ${lookbackClause}`];
  if (/workable/.test(hostname)) return [`from:workablemail.com ${lookbackClause}`, `from:workable.com ${lookbackClause}`];
  if (/recruitee/.test(hostname)) return [`from:recruitee.com ${lookbackClause}`];
  if (/personio/.test(hostname)) return [`from:personio.de ${lookbackClause}`, `from:personio.com ${lookbackClause}`];
  if (/breezy/.test(hostname)) return [`from:breezy.hr ${lookbackClause}`];
  if (/oraclecloud|myworkdayjobs|workday/.test(hostname)) return [`from:oraclecloud.com ${lookbackClause}`];
  return [];
}

function buildGmailSubmissionConfirmationQueries(posting, lookbackMinutes) {
  const customQuery = env("JOB_SEARCH_CONFIRMATION_EMAIL_SEARCH_QUERY");
  const lookbackClause = `newer_than:${lookbackMinutes}m`;
  const queries = [];
  const add = (query) => {
    const clean = String(query || "").replace(/\s+/g, " ").trim();
    if (clean && !queries.includes(clean)) queries.push(clean);
  };

  if (customQuery) add(`${customQuery} ${lookbackClause}`);
  for (const query of confirmationSenderQueries(posting?.applyUrl, lookbackClause)) add(query);
  add(`"thank you for applying" ${lookbackClause}`);
  add(`"thanks for applying" ${lookbackClause}`);
  add(`"thank you for your application" ${lookbackClause}`);
  add(`"application received" ${lookbackClause}`);
  add(`"received your application" ${lookbackClause}`);
  add(`"application submitted" ${lookbackClause}`);
  add(`"your application" ${lookbackClause}`);
  for (const token of postingSearchTerms(posting).slice(0, 5)) {
    add(`${token} ${lookbackClause}`);
  }
  add(lookbackClause);

  return queries;
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

async function listGmailMessageRefs({ accessToken, userId, searchQueries, maxResults, includeSpamTrash }) {
  const configuredLabels = gmailLabelIds();
  const labelPlans = configuredLabels.length > 0 ? [configuredLabels, []] : [[]];
  const messageRefs = [];
  const seenMessageIds = new Set();

  for (const query of searchQueries) {
    for (const labelIds of labelPlans) {
      const list = await gmailRequest(`/users/${encodeURIComponent(userId)}/messages`, accessToken, {
        q: query,
        maxResults,
        includeSpamTrash,
        labelIds
      });
      for (const ref of Array.isArray(list.messages) ? list.messages : []) {
        if (!ref?.id || seenMessageIds.has(ref.id)) continue;
        seenMessageIds.add(ref.id);
        messageRefs.push(ref);
      }
      if (messageRefs.length >= MAX_RESULTS_CAP) break;
    }
    if (messageRefs.length >= MAX_RESULTS_CAP) break;
  }

  return messageRefs;
}

async function findGmailSecurityCode(challenge) {
  const accessToken = await refreshGmailAccessToken();
  const userId = env("JOB_SEARCH_GMAIL_USER") || "me";
  const lookbackMinutes = intEnv("JOB_SEARCH_EMAIL_LOOKBACK_MINUTES", DEFAULT_LOOKBACK_MINUTES, { min: 1, max: MAX_LOOKBACK_MINUTES });
  const maxResults = intEnv("JOB_SEARCH_EMAIL_MAX_RESULTS", DEFAULT_MAX_RESULTS, { min: 1, max: MAX_RESULTS_CAP });
  const now = Date.now();
  const lookbackMs = lookbackMinutes * 60_000;
  const sinceMs = securityCodeSearchSinceMs(challenge);
  const expectedLengths = expectedCodeLengthsFromChallenge(challenge);

  const messageRefs = await listGmailMessageRefs({
    accessToken,
    userId,
    searchQueries: buildGmailSearchQueries(challenge, lookbackMinutes),
    maxResults,
    includeSpamTrash: env("JOB_SEARCH_EMAIL_INCLUDE_SPAM_TRASH") === "true"
  });

  if (messageRefs.length === 0) {
    throw appError("No recent email messages were found for security-code lookup.", 404);
  }

  const candidates = [];
  for (const ref of messageRefs.slice(0, MAX_RESULTS_CAP)) {
    if (!ref?.id) continue;
    const rawMessage = await gmailRequest(`/users/${encodeURIComponent(userId)}/messages/${encodeURIComponent(ref.id)}`, accessToken, {
      format: "full"
    });
    const message = parseMessage(rawMessage);
    if (message.receivedAt && now - message.receivedAt > lookbackMs) continue;
    if (message.receivedAt && sinceMs > 0 && message.receivedAt < sinceMs) continue;
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

function submissionConfirmationScore({ posting, message, now, lookbackMs, sinceMs }) {
  const subject = message.subject || "";
  const text = message.text || "";
  const source = [message.from, subject, text].filter(Boolean).join(" ");
  const hasConfirmationSignal = SUBMISSION_CONFIRMATION_TERMS.test(source);
  if (!hasConfirmationSignal) return null;

  // Security-code and "finish your application" emails are not proof that
  // the final application was accepted. A true confirmation usually contains
  // one of the positive phrases above without any action-required wording.
  if (NON_CONFIRMATION_EMAIL_TERMS.test(source) && !/(thank you for applying|thanks for applying|application received|received your application|your application (?:has been|was|is) received)/i.test(source)) {
    return null;
  }

  const minReceivedAt = Number(sinceMs || 0) - 120_000;
  if (message.receivedAt && minReceivedAt > 0 && message.receivedAt < minReceivedAt) return null;

  const companyMatches = scoreContextMatches(source, companyTokens(posting?.companyName), 1, 99);
  const jobMatches = scoreContextMatches(source, tokensFromText(posting?.title || posting?.jobTitle, COMPANY_STOPWORDS).slice(0, 7), 1, 99);
  const hostMatches = scoreContextMatches([message.from, source].join(" "), hostTokens(posting?.applyUrl), 1, 99);
  const hasCompanyTokens = companyTokens(posting?.companyName).length > 0;

  // Avoid crediting a different employer's confirmation email from the same
  // submit-worker run. Company match is the strongest evidence; absent that,
  // require multiple title tokens or an ATS sender/domain match.
  if (hasCompanyTokens && companyMatches === 0 && jobMatches < 2 && hostMatches === 0) return null;
  if (!hasCompanyTokens && jobMatches < 2 && hostMatches === 0) return null;

  let score = SUBMISSION_CONFIRMATION_TERMS.test(subject) ? 45 : 30;
  score += Math.min(60, companyMatches * 20);
  score += Math.min(36, jobMatches * 6);
  score += Math.min(24, hostMatches * 8);
  if (message.receivedAt) {
    const ageMs = Math.max(0, now - message.receivedAt);
    if (ageMs <= lookbackMs) score += Math.max(0, 20 - Math.floor(ageMs / 60_000) * 2);
  }
  return score;
}

async function findGmailSubmissionConfirmation(posting, { sinceMs } = {}) {
  const accessToken = await refreshGmailAccessToken();
  const userId = env("JOB_SEARCH_GMAIL_USER") || "me";
  const lookbackMinutes = intEnv(
    "JOB_SEARCH_EMAIL_CONFIRMATION_LOOKBACK_MINUTES",
    DEFAULT_CONFIRMATION_LOOKBACK_MINUTES,
    { min: 1, max: MAX_CONFIRMATION_LOOKBACK_MINUTES }
  );
  const maxResults = intEnv("JOB_SEARCH_EMAIL_CONFIRMATION_MAX_RESULTS", DEFAULT_MAX_RESULTS, { min: 1, max: MAX_RESULTS_CAP });
  const now = Date.now();
  const lookbackMs = lookbackMinutes * 60_000;
  const messageRefs = await listGmailMessageRefs({
    accessToken,
    userId,
    searchQueries: buildGmailSubmissionConfirmationQueries(posting, lookbackMinutes),
    maxResults,
    includeSpamTrash: env("JOB_SEARCH_EMAIL_INCLUDE_SPAM_TRASH") === "true"
  });

  if (messageRefs.length === 0) {
    throw appError("No recent email messages were found for submission-confirmation lookup.", 404);
  }

  const confirmations = [];
  for (const ref of messageRefs.slice(0, MAX_RESULTS_CAP)) {
    if (!ref?.id) continue;
    const rawMessage = await gmailRequest(`/users/${encodeURIComponent(userId)}/messages/${encodeURIComponent(ref.id)}`, accessToken, {
      format: "full"
    });
    const message = parseMessage(rawMessage);
    if (message.receivedAt && now - message.receivedAt > lookbackMs) continue;

    const score = submissionConfirmationScore({ posting, message, now, lookbackMs, sinceMs });
    if (score == null) continue;
    confirmations.push({ message, score });
  }

  confirmations.sort((a, b) => (b.score - a.score) || ((b.message.receivedAt || 0) - (a.message.receivedAt || 0)));
  const best = confirmations[0];
  if (!best) {
    throw appError("No recent submission confirmation email was found.", 404);
  }

  return {
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

export async function findEmailSubmissionConfirmation(posting, options = {}) {
  const provider = getEmailProvider();
  if (!provider) {
    throw appError("Email confirmation lookup is not configured. Set JOB_SEARCH_EMAIL_PROVIDER=gmail and Gmail credentials.", 503);
  }
  if (provider !== "gmail") {
    throw appError(`Email provider "${provider}" is not supported yet. Use JOB_SEARCH_EMAIL_PROVIDER=gmail.`, 503);
  }

  return findGmailSubmissionConfirmation(posting, options);
}
