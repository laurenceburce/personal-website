import { requireAccessOrRespond } from "../../../../lib/jobSearchApiHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Proxies the submit-worker's own progress stream — deliberately NOT
// generated here. Three earlier attempts at pushing this exact feed (two
// SSE, one multipart/x-mixed-replace) were all generated inside a Next.js
// route handler via a self-built ReadableStream, and all three silently
// never delivered a single update during a run in production, even with
// the X-Accel-Buffering fix that held-events/route.js's own SSE still
// relies on today. The one stream in this codebase confirmed to survive
// production at real per-item frequency is the live-frame viewer (see
// app/api/job-search/live-sessions/[id]/stream/route.js) — and the one
// thing structurally different about it is that Next.js never generates
// that stream itself; it only relays an already-open body from the
// worker's own plain Node http server. This route now does the exact same
// thing for submit progress: fetch the worker's /progress/stream and pass
// upstream.body straight through, unmodified.
export async function GET(request) {
  const { unauthorizedResponse } = await requireAccessOrRespond();
  if (unauthorizedResponse) return unauthorizedResponse;

  const workerUrl = process.env.JOB_SEARCH_SUBMIT_WORKER_URL;
  if (!workerUrl) {
    return Response.json({ error: "JOB_SEARCH_SUBMIT_WORKER_URL is not configured." }, { status: 503 });
  }

  try {
    const upstream = await fetch(`${workerUrl.replace(/\/+$/, "")}/progress/stream`, {
      headers: process.env.JOB_SEARCH_SUBMIT_TRIGGER_SECRET
        ? { "X-Trigger-Secret": process.env.JOB_SEARCH_SUBMIT_TRIGGER_SECRET }
        : {},
      cache: "no-store",
      signal: request.signal
    });

    if (!upstream.ok || !upstream.body) {
      const payload = await upstream.json().catch(() => ({}));
      return Response.json({ error: payload?.error || `Worker responded ${upstream.status}.` }, { status: upstream.status });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "multipart/x-mixed-replace",
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        "X-Accel-Buffering": "no"
      }
    });
  } catch (error) {
    return Response.json({ error: `Failed to reach the submit worker: ${error?.message || error}` }, { status: 502 });
  }
}
