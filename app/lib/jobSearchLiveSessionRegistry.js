// In-memory only — deliberately not backed by the DB. A live CAPTCHA-solve
// session is a real, open CDP connection to a real, open browser Page; that
// object only ever exists inside THIS process's memory (the submit-worker's
// — see scripts/job-search-submit-worker-server.mjs's own header comment on
// why it's a separate Railway service from the web app). The DB row
// (job_search_security_challenges, challenge_kind='captcha') is the
// cross-process handle both sides agree on; this Map is what lets the
// worker's own HTTP handler (added in job-search-submit-worker-server.mjs
// for /live/:id/frame, /live/:id/stream, and /live/:id/input) find the right session without
// threading the CDP session through every layer between there and
// heldChallengeRelay.js's resolveHeldChallenge(), which is the only thing
// that ever calls register()/unregister().
//
// One entry at a time in practice: the submit-worker's own concurrency guard
// (see job-search-submit-worker-server.mjs's triggerRun()) never runs two
// passes at once, and each pass processes approved postings sequentially —
// so at most one posting is ever paused on a live session at a time. Keyed
// by challenge id anyway (not a single slot) since that's what the HTTP
// routes address by, and it costs nothing.
const sessions = new Map();

export function registerLiveSession(challengeId, { page, cdpSession, viewport }) {
  sessions.set(Number(challengeId), { page, cdpSession, viewport });
}

export function getLiveSession(challengeId) {
  return sessions.get(Number(challengeId)) || null;
}

export function unregisterLiveSession(challengeId) {
  sessions.delete(Number(challengeId));
}
