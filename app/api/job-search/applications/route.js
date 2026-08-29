import { NextResponse } from "next/server";
import { jsonError, requireAccessOrRespond } from "../../../lib/jobSearchApiHelpers";
import { getApplicationById, updateApplicationNote } from "../../../lib/jobSearchApplicationStore";
import { updatePostingScore } from "../../../lib/jobSearchPostingsStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
      case "retrySubmission": {
        // Requeues by flipping the posting back to 'approved' so the next
        // submit-worker cron run picks it up — running Playwright synchronously
        // inside this HTTP request would be slow and outside its request budget.
        const application = await getApplicationById(data.id);
        if (!application) return NextResponse.json({ error: "Application not found." }, { status: 404 });
        await updatePostingScore(application.postingId, { status: "approved" });
        return NextResponse.json({ ok: true, result: { requeued: true } });
      }
      default:
        return NextResponse.json({ error: "Unknown applications action." }, { status: 400 });
    }
  } catch (error) {
    return jsonError(error);
  }
}
