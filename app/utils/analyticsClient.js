const VISITOR_ID_KEY = "portfolio-visitor-id-v1";
const SESSION_TRACKED_KEY = "portfolio-session-tracked-v1";

const createVisitorId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `visitor-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export const analyticsTrackingDisabled = () => (
  typeof navigator !== "undefined" &&
  (
    navigator.doNotTrack === "1" ||
    (typeof window !== "undefined" && window.doNotTrack === "1")
  )
);

export const getOrCreateVisitorId = () => {
  if (typeof window === "undefined") return "";

  try {
    const existing = window.localStorage.getItem(VISITOR_ID_KEY);
    if (existing) return existing;

    const next = createVisitorId();
    window.localStorage.setItem(VISITOR_ID_KEY, next);
    return next;
  } catch {
    return createVisitorId();
  }
};

export const hasTrackedSession = () => {
  try {
    return window.sessionStorage.getItem(SESSION_TRACKED_KEY) === "true";
  } catch {
    return false;
  }
};

export const markSessionTracked = () => {
  try {
    window.sessionStorage.setItem(SESSION_TRACKED_KEY, "true");
  } catch {}
};

export const identifyAnalyticsVisitor = async ({ email, name }) => {
  if (analyticsTrackingDisabled()) return null;

  const visitorId = getOrCreateVisitorId();
  if (!visitorId || !email) return null;

  const response = await fetch("/api/analytics/identify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      visitorId,
      email,
      name
    })
  });

  return response.ok ? response.json() : null;
};
