import { NextResponse } from "next/server";
import { jsonError, requireAccessOrRespond } from "../../../../lib/jobSearchApiHelpers";
import { getDiscoveryRunDetails } from "../../../../lib/jobSearchDiscoveryRunStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Powers the Overview tab's per-run "Details" popup — reconstructed on
// demand from job_search_postings/job_search_known_companies (see
// getDiscoveryRunDetails' own comment), not stored on the run row itself.
export async function GET(request, { params }) {
  const { unauthorizedResponse } = await requireAccessOrRespond();
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    const { id } = await params;
    const details = await getDiscoveryRunDetails(id);
    if (!details) return NextResponse.json({ error: "Discovery run not found." }, { status: 404 });
    return NextResponse.json({ ok: true, ...details });
  } catch (error) {
    return jsonError(error);
  }
}
