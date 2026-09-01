import { NextResponse } from "next/server";
import { jsonError, requireAccessOrRespond } from "../../../lib/jobSearchApiHelpers";
import { getSubmitProgressSnapshot } from "../../../lib/jobSearchSubmitProgressStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Polled by the toolbar's SubmitWorkerBanner and OverviewPanel's Submit
// Worker card (see JobSearchAppClient.js) every couple seconds. Plain
// request/response, deliberately NOT a push (SSE) — a prior push-based
// version of this was silently buffered by Railway's proxy in production
// (updates never arrived until the connection closed), while the dashboard's
// other poll-based feeds (worker-status, notifications) worked fine, so this
// favors the mechanism actually proven to work here. Cheap: one single-row
// SELECT plus one small GROUP BY (see getSubmitProgressSnapshot).
export async function GET() {
  const { unauthorizedResponse } = await requireAccessOrRespond();
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    const progress = await getSubmitProgressSnapshot();
    return NextResponse.json({ ok: true, progress });
  } catch (error) {
    return jsonError(error);
  }
}
