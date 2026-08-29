import { NextResponse } from "next/server";
import { jsonError, requireAccessOrRespond } from "../../../lib/jobSearchApiHelpers";
import { getAllWorkerStatus } from "../../../lib/jobSearchWorkerStatusStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only, polled client-side every ~20s by the Overview tab's Workers
// panel (see OverviewPanel.js) so "Last run"/"Next expected" reflect an
// actual cron run landing in the background without the user refreshing the
// page. Cheap (2-row SELECT) — safe to poll far more often than the
// underlying data actually changes.
export async function GET() {
  const { unauthorizedResponse } = await requireAccessOrRespond();
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    const workerStatus = await getAllWorkerStatus();
    return NextResponse.json({ ok: true, workerStatus });
  } catch (error) {
    return jsonError(error);
  }
}
