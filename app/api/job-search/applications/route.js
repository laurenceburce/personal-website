import { NextResponse } from "next/server";
import { jsonError, requireAccessOrRespond } from "../../../lib/jobSearchApiHelpers";
import { deleteApplication, updateApplicationNote } from "../../../lib/jobSearchApplicationStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Retrying a failed/needs-manual-review submission used to live here
// (flipping the posting back to 'approved'), keyed off an application id —
// removed once Applied Jobs became a pure success log (see
// AppliedJobsTable.js) and that same action moved to the Review Queue's own
// "Retry" button instead, keyed off the posting id directly via the
// review-queue route's existing "approve" action (identical effect).
export async function POST(request) {
  const { unauthorizedResponse } = await requireAccessOrRespond();
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    const body = await request.json().catch(() => ({}));
    const action = body?.action;
    const data = body?.data || {};

    switch (action) {
      case "updateApplicationNote":
        return NextResponse.json({ ok: true, result: await updateApplicationNote(data.id, data.note) });
      case "deleteApplication":
        return NextResponse.json({ ok: true, result: await deleteApplication(data.id) });
      default:
        return NextResponse.json({ error: "Unknown applications action." }, { status: 400 });
    }
  } catch (error) {
    return jsonError(error);
  }
}
