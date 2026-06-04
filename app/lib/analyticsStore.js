const ANALYTICS_PREFIX = "portfolio:analytics";
const TOTAL_VISITS_KEY = `${ANALYTICS_PREFIX}:total_visits`;
const UNIQUE_VISITORS_KEY = `${ANALYTICS_PREFIX}:unique_visitors`;
const VISITOR_SESSIONS_KEY = `${ANALYTICS_PREFIX}:visitor_sessions`;
const IDENTIFIED_VISITORS_KEY = `${ANALYTICS_PREFIX}:identified_visitors`;
const IDENTIFIED_EMAILS_KEY = `${ANALYTICS_PREFIX}:identified_emails`;
const MAX_IDENTIFIED_RESULTS = 50;

const isConfigured = () => (
  Boolean(process.env.UPSTASH_REDIS_REST_URL) &&
  Boolean(process.env.UPSTASH_REDIS_REST_TOKEN)
);

const normalizeUrl = () => process.env.UPSTASH_REDIS_REST_URL.replace(/\/$/, "");

const upstashRequest = async (path, commands) => {
  if (!isConfigured()) {
    return null;
  }

  const response = await fetch(`${normalizeUrl()}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(commands),
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error("Analytics storage request failed.");
  }

  const payload = await response.json();
  const error = Array.isArray(payload)
    ? payload.find((item) => item?.error)
    : payload?.error;

  if (error) {
    throw new Error(typeof error === "string" ? error : "Analytics storage command failed.");
  }

  return payload;
};

const resultAt = (payload, index, fallback = 0) => {
  const value = payload?.[index]?.result;
  const numberValue = Number(value);

  return Number.isFinite(numberValue) ? numberValue : fallback;
};

const cleanVisitorId = (visitorId) => (
  typeof visitorId === "string" && /^[a-zA-Z0-9_-]{16,80}$/.test(visitorId)
    ? visitorId
    : null
);

const cleanText = (value, maxLength) => String(value || "").trim().slice(0, maxLength);

const cleanEmail = (email) => {
  const value = cleanText(email, 200).toLowerCase();
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  return emailPattern.test(value) ? value : null;
};

export async function recordVisit(visitorId) {
  const safeVisitorId = cleanVisitorId(visitorId);

  if (!safeVisitorId || !isConfigured()) {
    return getAnalyticsStats();
  }

  const now = new Date().toISOString();
  const payload = await upstashRequest("/pipeline", [
    ["INCR", TOTAL_VISITS_KEY],
    ["SADD", UNIQUE_VISITORS_KEY, safeVisitorId],
    ["HSET", VISITOR_SESSIONS_KEY, safeVisitorId, now],
    ["GET", TOTAL_VISITS_KEY],
    ["SCARD", UNIQUE_VISITORS_KEY],
    ["SCARD", IDENTIFIED_EMAILS_KEY]
  ]);

  return {
    configured: true,
    totalVisits: resultAt(payload, 3),
    uniqueVisitors: resultAt(payload, 4),
    identifiedVisitors: resultAt(payload, 5)
  };
}

export async function getAnalyticsStats() {
  if (!isConfigured()) {
    return {
      configured: false,
      totalVisits: 0,
      uniqueVisitors: 0,
      identifiedVisitors: 0
    };
  }

  const payload = await upstashRequest("/pipeline", [
    ["GET", TOTAL_VISITS_KEY],
    ["SCARD", UNIQUE_VISITORS_KEY],
    ["SCARD", IDENTIFIED_EMAILS_KEY]
  ]);

  return {
    configured: true,
    totalVisits: resultAt(payload, 0),
    uniqueVisitors: resultAt(payload, 1),
    identifiedVisitors: resultAt(payload, 2)
  };
}

export async function identifyVisitor({ visitorId, email, name }) {
  const safeVisitorId = cleanVisitorId(visitorId);
  const safeEmail = cleanEmail(email);

  if (!safeVisitorId || !safeEmail || !isConfigured()) {
    return getAnalyticsStats();
  }

  const now = new Date().toISOString();
  const safeName = cleanText(name, 120);
  const record = JSON.stringify({
    visitorId: safeVisitorId,
    email: safeEmail,
    name: safeName,
    lastSeenAt: now
  });

  const payload = await upstashRequest("/pipeline", [
    ["HSET", IDENTIFIED_VISITORS_KEY, safeVisitorId, record],
    ["SADD", IDENTIFIED_EMAILS_KEY, safeEmail],
    ["GET", TOTAL_VISITS_KEY],
    ["SCARD", UNIQUE_VISITORS_KEY],
    ["SCARD", IDENTIFIED_EMAILS_KEY]
  ]);

  return {
    configured: true,
    totalVisits: resultAt(payload, 2),
    uniqueVisitors: resultAt(payload, 3),
    identifiedVisitors: resultAt(payload, 4)
  };
}

export async function getIdentifiedVisitors() {
  if (!isConfigured()) {
    return {
      configured: false,
      visitors: []
    };
  }

  const payload = await upstashRequest("/pipeline", [
    ["HVALS", IDENTIFIED_VISITORS_KEY]
  ]);
  const visitors = (payload?.[0]?.result || [])
    .map((item) => {
      try {
        return JSON.parse(item);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
    .slice(0, MAX_IDENTIFIED_RESULTS);

  return {
    configured: true,
    visitors
  };
}
