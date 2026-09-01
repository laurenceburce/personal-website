import { requireAccessOrRespond } from "../../../../../lib/jobSearchApiHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Proxies through to the submit-worker's own /live/:id/frame — see that
// service's job-search-submit-worker-server.mjs for why it's never reached
// directly from the browser (private networking + shared secret; this route
// is what actually authenticates the real dashboard user first).
export async function GET(request, { params }) {
  const { unauthorizedResponse } = await requireAccessOrRespond();
  if (unauthorizedResponse) return unauthorizedResponse;

  const workerUrl = process.env.JOB_SEARCH_SUBMIT_WORKER_URL;
  if (!workerUrl) {
    return Response.json({ error: "JOB_SEARCH_SUBMIT_WORKER_URL is not configured." }, { status: 503 });
  }

  const { id } = await params;
  try {
    const upstream = await fetch(`${workerUrl.replace(/\/+$/, "")}/live/${encodeURIComponent(id)}/frame`, {
      headers: process.env.JOB_SEARCH_SUBMIT_TRIGGER_SECRET
        ? { "X-Trigger-Secret": process.env.JOB_SEARCH_SUBMIT_TRIGGER_SECRET }
        : {},
      cache: "no-store"
    });

    if (!upstream.ok) {
      const payload = await upstream.json().catch(() => ({}));
      return Response.json({ error: payload?.error || `Worker responded ${upstream.status}.` }, { status: upstream.status });
    }

    const buffer = await upstream.arrayBuffer();
    return new Response(buffer, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store",
        "X-Live-Viewport-Width": upstream.headers.get("x-live-viewport-width") || "",
        "X-Live-Viewport-Height": upstream.headers.get("x-live-viewport-height") || ""
      }
    });
  } catch (error) {
    return Response.json({ error: `Failed to reach the submit worker: ${error?.message || error}` }, { status: 502 });
  }
}
