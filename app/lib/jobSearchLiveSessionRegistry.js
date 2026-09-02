// In-memory only — deliberately not backed by the DB. A live relay session is
// a real, open CDP connection to a real, open browser Page; that object only
// ever exists inside THIS process's memory (the submit-worker's — see
// scripts/job-search-submit-worker-server.mjs's own header comment on why
// it's a separate Railway service from the web app). CAPTCHA pauses use the
// job_search_security_challenges row id as their handle; ordinary submit-page
// streams use the progress item's submit-* id. This Map is what lets the
// worker's own HTTP handler (/live/:id/frame, /live/:id/stream, and
// /live/:id/input) find the right session without threading the CDP session
// through every layer between there and the adapter code that opened the
// Playwright page.
//
// One entry at a time in practice: the submit-worker's own concurrency guard
// (see job-search-submit-worker-server.mjs's triggerRun()) never runs two
// passes at once, and each pass processes approved postings sequentially —
// so at most one posting is ever active in a live session at a time. Keyed by
// session id anyway (not a single slot) since that's what the HTTP routes
// address by, and it costs nothing.
const sessions = new Map();

function sessionKey(sessionId) {
  return String(sessionId || "");
}

export function registerLiveSession(challengeId, { page, cdpSession, viewport }) {
  const key = sessionKey(challengeId);
  if (!key) return;
  sessions.set(key, { page, cdpSession, viewport });
}

export function getLiveSession(challengeId) {
  return sessions.get(sessionKey(challengeId)) || null;
}

export function unregisterLiveSession(challengeId) {
  sessions.delete(sessionKey(challengeId));
}
