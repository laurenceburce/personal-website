import { requireAccessOrRespond } from "../../../lib/jobSearchApiHelpers";
import { buildSubmitProgressSnapshot, submitProgressEvents } from "../../../lib/jobSearchSubmitProgressWatcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Real-time feed for the Overview tab's Submit Worker card (see
// OverviewPanel.js) — progress through the CURRENT pass (which job is being
// worked on, how many done/total, the run's item log) plus live queue
// counts. One shared jobSearchSubmitProgressWatcher.js poll loop feeds every
// open connection, same pattern as held-events/route.js.
export async function GET() {
  const { unauthorizedResponse } = await requireAccessOrRespond();
  if (unauthorizedResponse) return unauthorizedResponse;

  const encoder = new TextEncoder();
  let onUpdate;
  let heartbeat;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      // A freshly-opened dashboard shouldn't have to wait for the next poll
      // tick (or the next change) to learn current state.
      const initial = await buildSubmitProgressSnapshot().catch(() => null);
      if (initial) send("update", initial);

      onUpdate = (snapshot) => send("update", snapshot);
      submitProgressEvents.on("update", onUpdate);

      // Comment-only keepalive (SSE convention: a line starting with ":" is
      // ignored by EventSource) so an idle connection doesn't get silently
      // dropped by an intermediary proxy/load balancer.
      heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(": ping\n\n"));
      }, 25000);
    },
    cancel() {
      if (onUpdate) submitProgressEvents.off("update", onUpdate);
      if (heartbeat) clearInterval(heartbeat);
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Without this, Railway's proxy buffers the response instead of
      // flushing each chunk as it's written — confirmed live: updates during
      // a run never arrived, then the whole backlog showed up at once once
      // enough had accumulated (near/at the run finishing). Same fix already
      // used for the live-frame MJPEG stream in
      // app/api/job-search/live-sessions/[id]/stream/route.js.
      "X-Accel-Buffering": "no"
    }
  });
}
