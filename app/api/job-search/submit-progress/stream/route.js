import { requireAccessOrRespond } from "../../../../lib/jobSearchApiHelpers";
import { getSubmitProgressSnapshot } from "../../../../lib/jobSearchSubmitProgressStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Live push for a submit-worker pass in progress, layered on top of (not
// replacing) submit-progress/route.js's plain 2s poll. Two SSE attempts at
// this exact feed (see jobSearchSubmitProgressStore.js's own history —
// commits 550d8fb and ac500d8) never delivered a single update during a run
// in production, even with the X-Accel-Buffering fix that held-events/
// route.js still relies on today: that route only ever pushes rarely (one
// challenge at a time), while this one needed many updates per run, and
// that turned out to be exactly the case Railway's proxy kept buffering.
// multipart/x-mixed-replace is the one mechanism in this codebase confirmed
// to survive that at real per-item frequency — the live-frame viewer (see
// app/api/job-search/live-sessions/[id]/stream/route.js) pushes a JPEG this
// same way every ~125ms for the CAPTCHA-assist feature, which would be
// unusable if it were silently buffered. This reuses that exact framing
// with a JSON part instead of a JPEG one.
//
// Deliberately opened by the client only while a pass is actually running
// (see JobSearchAppClient.js) and closed the moment this loop observes it
// finish — an idle dashboard costs nothing here, the ordinary poll already
// covers idle state fine, and this is purely a latency upgrade on top of it.
// If this turns out to hit the same wall as the SSE attempts once deployed,
// the client's poll loop is untouched and keeps working exactly as before.
const BOUNDARY = "submit-progress";
const TICK_MS = 350;
// Safety valve, not a normal-operation limit — a pass this long would
// already be surfaced elsewhere as stuck; this just guarantees the
// connection (and its DB polling) eventually recycles instead of hanging
// open forever if a client never notices and closes its own end.
const MAX_STREAM_MS = 30 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request) {
  const { unauthorizedResponse } = await requireAccessOrRespond();
  if (unauthorizedResponse) return unauthorizedResponse;

  const encoder = new TextEncoder();
  let closed = false;
  request.signal.addEventListener("abort", () => { closed = true; });

  const stream = new ReadableStream({
    async start(controller) {
      const startedAt = Date.now();
      let lastPayload = null;
      let sentIdleSinceRunning = false;

      const writeSnapshot = (snapshot) => {
        const json = JSON.stringify(snapshot);
        if (json === lastPayload) return;
        lastPayload = json;
        controller.enqueue(encoder.encode(`--${BOUNDARY}\r\nContent-Type: application/json\r\n\r\n${json}\r\n`));
      };

      while (!closed && Date.now() - startedAt < MAX_STREAM_MS) {
        try {
          const snapshot = await getSubmitProgressSnapshot();
          writeSnapshot(snapshot);

          if (snapshot.status === "running") {
            sentIdleSinceRunning = false;
          } else if (!sentIdleSinceRunning) {
            // One more tick's worth of grace after a run finishes so the
            // client is guaranteed to see the resting state (not just
            // whatever the last "running" snapshot happened to be) before
            // this connection closes itself.
            sentIdleSinceRunning = true;
          } else {
            break;
          }
        } catch (error) {
          // Best-effort, matches every other poller of this row — a missed
          // tick just means the next one catches up, never worth tearing
          // down the connection over.
        }

        await sleep(TICK_MS);
      }

      try {
        controller.close();
      } catch {
        // Already closed by cancel() below racing this — fine either way.
      }
    },
    cancel() {
      closed = true;
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}
