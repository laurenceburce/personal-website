// "Wake up" call to the submit-worker's event-driven server
// (scripts/job-search-submit-worker-server.mjs) — used wherever the main app
// creates new submittable work (approving a posting, a scoring pass that
// might make one auto-apply-eligible) so it gets picked up in seconds.
//
// Deliberately Playwright-free: this file must be safely importable from the
// main web app (page.js's own request path, API routes) without pulling
// Chromium into that bundle — this only ever does a plain fetch() to another
// Railway service, the same class of thing jobSearchCompanyProbe.js already
// does to third-party APIs.
//
// The call itself never throws — if JOB_SEARCH_SUBMIT_WORKER_URL isn't
// configured (local dev, or the submit-worker service isn't up yet) or the
// fetch fails for any reason, this silently no-ops rather than surfacing an
// error to whatever action (approve, scoreNow) triggered it. But this IS
// load-bearing, not just a latency optimization: the submit-worker server
// has no periodic fallback timer (see its own header comment), so if every
// trigger call for a given posting is dropped, nothing else will pick it up
// until the submit-worker's next restart. Worth keeping in mind if postings
// ever seem to sit at 'approved' without being picked up.
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
    // because this side-call couldn't reach the other service. Logged loudly
    // rather than swallowed, though: per the header comment above, there's no
    // fallback timer to fall back on, so this failing silently is the actual
    // failure mode worth being able to spot in the logs.
    console.error(`[submit-trigger] Failed to notify submit-worker (reason: ${reason}):`, error?.message || error);
  } finally {
    clearTimeout(timeout);
  }
}
