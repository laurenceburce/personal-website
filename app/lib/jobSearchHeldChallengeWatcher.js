// Runs in the web app process only (started once from instrumentation.js).
// Polls for held challenges (security_code / anti_bot_text / captcha — see
// heldChallengeRelay.js) that have never been notified about yet, and fans
// each one out two ways: a push notification (fires even with the dashboard
// closed) and an in-process 'new' event that app/api/job-search/held-events'
// SSE route relays to any open dashboard tab in real time. One shared poll
// loop for both, rather than each dashboard connection polling the DB
// itself — see held-events/route.js's own comment.
import { EventEmitter } from "node:events";
import { isJobSearchDbConfigured } from "./jobSearchDb.js";
import { sendPushToAllSubscriptions } from "./jobSearchPushSender.js";
import { listUnnotifiedPendingChallenges, markChallengeNotified } from "./jobSearchSecurityChallengeStore.js";

const POLL_INTERVAL_MS = 3000;

export const heldChallengeEvents = new EventEmitter();
// SSE connections can pile up (one per open dashboard tab) — this is a
// broadcast bus, not a per-request thing, so raise the default cap rather
// than have Node warn about a "possible memory leak" for ordinary use.
heldChallengeEvents.setMaxListeners(50);

function challengeKindLabel(kind) {
  if (kind === "captcha") return "CAPTCHA";
  if (kind === "anti_bot_text") return "an anti-bot question";
  return "a security code";
}

let started = false;

async function pollOnce() {
  const fresh = await listUnnotifiedPendingChallenges().catch((error) => {
    console.error("[held-challenge-watcher] Failed to list unnotified challenges:", error?.message || error);
    return [];
  });

  for (const challenge of fresh) {
    // Marked notified BEFORE the push actually sends — a push failure (bad
    // VAPID config, every subscription gone) shouldn't turn into an
    // infinite retry loop hammering the same row every 3s forever. The
    // in-app SSE event carries no such risk (it's just an emit), but is
    // gated the same way for one consistent "have we told anyone about
    // this yet" flag.
    await markChallengeNotified(challenge.id).catch(() => {});
    heldChallengeEvents.emit("new", challenge);
    await sendPushToAllSubscriptions({
      title: "Job Search: action needed",
      body: `${challengeKindLabel(challenge.challengeKind)} is needed for ${challenge.jobTitle} at ${challenge.companyName}.`,
      url: "/job-search"
    }).catch((error) => console.error("[held-challenge-watcher] Push send failed:", error?.message || error));
  }
}

export function startHeldChallengeWatcher() {
  if (started) return;
  started = true;

  if (!isJobSearchDbConfigured()) {
    console.warn("[held-challenge-watcher] Job search DB is not configured — not starting.");
    return;
  }

  console.log("[held-challenge-watcher] Started.");
  setInterval(() => {
    pollOnce().catch((error) => console.error("[held-challenge-watcher] Poll failed:", error?.message || error));
  }, POLL_INTERVAL_MS);
}
