import { NextResponse } from "next/server";
import { jsonError, requireAccessOrRespond } from "../../../lib/jobSearchApiHelpers";
import { runDiscoveryPass } from "../../../lib/jobSearchDiscovery";
import { requeuePostingsForRescoring } from "../../../lib/jobSearchPostingsStore";
import { scoreNewPostings } from "../../../lib/jobSearchScoringPipeline";
import { getFindSettings } from "../../../lib/jobSearchSettingsStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Manual triggers for the Overview tab's "Run Discovery Now" / "Score New
// Postings Now" buttons, plus Find Settings' "Re-score filtered/low-scored"
// bulk action — all three otherwise only run on the poll-worker's own cron
// schedule, which can mean waiting up to 15 minutes to see anything happen
// after a settings change.
export async function POST(request) {
  const { unauthorizedResponse } = await requireAccessOrRespond();
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    const body = await request.json().catch(() => ({}));
    const action = body?.action;

    switch (action) {
      case "discoveryNow": {
        const findSettings = await getFindSettings();
        const result = await runDiscoveryPass(findSettings);
        return NextResponse.json({ ok: result.ok, result });
      }
      case "scoreNow": {
        const result = await scoreNewPostings({ limit: 200 });
        return NextResponse.json({ ok: true, result });
      }
      case "requeueForRescoring": {
        const result = await requeuePostingsForRescoring();
        return NextResponse.json({ ok: true, result });
      }
      default:
        return NextResponse.json({ error: "Unknown run action." }, { status: 400 });
    }
  } catch (error) {
    return jsonError(error);
  }
}
