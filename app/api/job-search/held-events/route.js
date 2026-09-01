import { requireAccessOrRespond } from "../../../lib/jobSearchApiHelpers";
import { heldChallengeEvents } from "../../../lib/jobSearchHeldChallengeWatcher";
import { listPendingSecurityChallenges } from "../../../lib/jobSearchSecurityChallengeStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Real-time counterpart to HeldSubmissionsPanel's own 4s poll — that poll
// still runs and is the actual source of truth for what's rendered, this
// just wakes the dashboard up immediately instead of waiting up to 4s (or,
// with the tab backgrounded, however long the browser throttles a timer to).
// One shared jobSearchHeldChallengeWatcher.js poll loop feeds every open
// connection here rather than each tab polling the DB on its own.
export async function GET() {
  const { unauthorizedResponse } = await requireAccessOrRespond();
  if (unauthorizedResponse) return unauthorizedResponse;

  const encoder = new TextEncoder();
  let onNew;
  let heartbeat;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      // A freshly-opened dashboard shouldn't have to wait for the NEXT
      // challenge to learn about ones already pending.
      const initial = await listPendingSecurityChallenges({ limit: 20 }).catch(() => []);
      send("snapshot", initial);

      onNew = (challenge) => send("new", challenge);
      heldChallengeEvents.on("new", onNew);

      // Comment-only keepalive (SSE convention: a line starting with ":" is
      // ignored by EventSource) so an idle connection doesn't get silently
      // dropped by an intermediary proxy/load balancer.
      heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(": ping\n\n"));
      }, 25000);
    },
    cancel() {
      if (onNew) heldChallengeEvents.off("new", onNew);
      if (heartbeat) clearInterval(heartbeat);
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    }
  });
}
