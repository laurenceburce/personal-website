// Runs in the web app process only (started once from instrumentation.js).
// Polls job_search_submit_progress — written to by the SEPARATE always-on
// submit-worker process as it works through each posting (see
// jobSearchSubmitProgressStore.js) — plus a cheap live queue-count query,
// and fans the combined snapshot out to every open dashboard tab in real
// time via app/api/job-search/submit-progress-events' SSE route. One shared
// poll loop for every tab, same rationale as jobSearchHeldChallengeWatcher.js
// (and the same reason this has to be DB-polling at all, not an in-process
// event: the web app and the worker are two different Railway services with
// no direct channel between them other than the shared database).
import { EventEmitter } from "node:events";
import { isJobSearchDbConfigured } from "./jobSearchDb.js";
import { countPostingsByStatus } from "./jobSearchPostingsStore.js";
import { getSubmitProgress } from "./jobSearchSubmitProgressStore.js";

const POLL_INTERVAL_MS = 1500;

export const submitProgressEvents = new EventEmitter();
submitProgressEvents.setMaxListeners(50);

let started = false;
let lastPayloadJson = "";

// Shared by the SSE route's own initial "snapshot on connect" send, so a
// freshly-opened tab doesn't have to wait for the next poll tick to learn
// current state.
export async function buildSubmitProgressSnapshot() {
  const [progress, statusCounts] = await Promise.all([
    getSubmitProgress(),
    countPostingsByStatus().catch(() => ({}))
  ]);
  return {
    ...progress,
    approvedWaitingCount: statusCounts.approved || 0,
    pendingReviewCount: statusCounts.pending_review || 0
  };
}

async function pollOnce() {
  const snapshot = await buildSubmitProgressSnapshot().catch((error) => {
    console.error("[submit-progress-watcher] Poll failed:", error?.message || error);
    return null;
  });
  if (!snapshot) return;

  // Only broadcast when something actually changed — between submit-worker
  // passes this is otherwise an identical payload every 1.5s forever, which
  // is wasted traffic to every open tab for nothing.
  const json = JSON.stringify(snapshot);
  if (json === lastPayloadJson) return;
  lastPayloadJson = json;
  submitProgressEvents.emit("update", snapshot);
}

export function startSubmitProgressWatcher() {
  if (started) return;
  started = true;

  if (!isJobSearchDbConfigured()) {
    console.warn("[submit-progress-watcher] Job search DB is not configured — not starting.");
    return;
  }

  console.log("[submit-progress-watcher] Started.");
  setInterval(() => {
    pollOnce().catch((error) => console.error("[submit-progress-watcher] Poll failed:", error?.message || error));
  }, POLL_INTERVAL_MS);
}
