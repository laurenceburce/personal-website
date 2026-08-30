// Best-effort "wake up" call to the submit-worker's event-driven server
// (scripts/job-search-submit-worker-server.mjs) — used wherever the main app
// creates new submittable work (approving a posting, a scoring pass that
// might make one auto-apply-eligible) so it gets picked up in seconds rather
// than waiting for that service's own internal fallback timer.
//
// Deliberately Playwright-free: this file must be safely importable from the
// main web app (page.js's own request path, API routes) without pulling
// Chromium into that bundle — this only ever does a plain fetch() to another
// Railway service, the same class of thing jobSearchCompanyProbe.js already
// does to third-party APIs.
//
// Deliberately best-effort, never load-bearing for correctness: if
// JOB_SEARCH_SUBMIT_WORKER_URL isn't configured (local dev, or a deployment
// that only ever runs the plain one-shot script on a Railway Cron Schedule
// instead of the server), or the call fails for any reason, this silently
// no-ops. The submit-worker server's own fallback timer is what actually
// guarantees an approved posting gets processed eventually — this is purely
// a latency optimization on top of that guarantee, never a substitute for it.
const TRIGGER_TIMEOUT_MS = 3000;

export async function triggerSubmitWorker(reason) {
  const url = process.env.JOB_SEARCH_SUBMIT_WORKER_URL;
  if (!url) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRIGGER_TIMEOUT_MS);
  try {
    await fetch(`${url.replace(/\/+$/, "")}/run`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(process.env.JOB_SEARCH_SUBMIT_TRIGGER_SECRET
          ? { "X-Trigger-Secret": process.env.JOB_SEARCH_SUBMIT_TRIGGER_SECRET }
          : {})
      },
      body: JSON.stringify({ reason: String(reason || "unknown").slice(0, 100) })
    });
  } catch (error) {
    // Never throw — a human clicking "Approve" should never see an error
    // because the OPTIONAL speed-up couldn't reach the other service. The
    // fallback timer covers this posting regardless.
    console.error(`[submit-trigger] Failed to notify submit-worker (reason: ${reason}):`, error?.message || error);
  } finally {
    clearTimeout(timeout);
  }
}
