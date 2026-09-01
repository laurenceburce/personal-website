import { requireAccessOrRespond } from "../../../../../lib/jobSearchApiHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Proxies the submit-worker's MJPEG live stream. This replaces rapid
// browser-side frame polling with one long-lived response while keeping the
// worker private and authenticating the dashboard user here first.
export async function GET(request, { params }) {
  const { unauthorizedResponse } = await requireAccessOrRespond();
  if (unauthorizedResponse) return unauthorizedResponse;

  const workerUrl = process.env.JOB_SEARCH_SUBMIT_WORKER_URL;
  if (!workerUrl) {
    return Response.json({ error: "JOB_SEARCH_SUBMIT_WORKER_URL is not configured." }, { status: 503 });
  }

  const { id } = await params;
  try {
    const upstream = await fetch(`${workerUrl.replace(/\/+$/, "")}/live/${encodeURIComponent(id)}/stream`, {
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
        "X-Accel-Buffering": "no",
        "X-Live-Viewport-Width": upstream.headers.get("x-live-viewport-width") || "",
        "X-Live-Viewport-Height": upstream.headers.get("x-live-viewport-height") || ""
      }
    });
  } catch (error) {
    return Response.json({ error: `Failed to reach the submit worker: ${error?.message || error}` }, { status: 502 });
  }
}
