import { NextResponse } from "next/server";
import { jsonError, requireAccessOrRespond } from "../../../../lib/jobSearchApiHelpers";
import { getSubmitRunDetails } from "../../../../lib/jobSearchSubmitRunStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Powers the notification bell's "Successfully applied"/"application(s)
// failed" popups — same on-demand reconstruction as
// discovery-runs/[id]/route.js, from the applications actually attempted
// during this run's window (see getSubmitRunDetails' own comment).
export async function GET(request, { params }) {
  const { unauthorizedResponse } = await requireAccessOrRespond();
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    const { id } = await params;
    const details = await getSubmitRunDetails(id);
    if (!details) return NextResponse.json({ error: "Submit run not found." }, { status: 404 });
    return NextResponse.json({ ok: true, ...details });
  } catch (error) {
    return jsonError(error);
  }
}
