import { NextResponse } from "next/server";
import { deleteAnswerMemory, updateAnswerMemory } from "../../../lib/jobSearchAnswerMemoryStore";
import { jsonError, requireAccessOrRespond } from "../../../lib/jobSearchApiHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Memory tab's own two actions — see jobSearchAnswerMemoryStore.js for
// where entries actually come from (the Review Queue's "Answer & Retry"
// popup, via review-queue/route.js's saveManualAnswersAndRetry) and get read
// back (each ATS adapter's findBestMemoryMatch() call). Nothing here creates
// an entry — this route only ever edits/removes what already exists.
export async function POST(request) {
  const { unauthorizedResponse } = await requireAccessOrRespond();
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    const body = await request.json().catch(() => ({}));
    const action = body?.action;
    const data = body?.data || {};

    switch (action) {
      case "updateAnswerMemory":
        return NextResponse.json({ ok: true, result: await updateAnswerMemory(data.id, data.answer) });
      case "deleteAnswerMemory":
        return NextResponse.json({ ok: true, result: await deleteAnswerMemory(data.id) });
      default:
        return NextResponse.json({ error: "Unknown answer-memory action." }, { status: 400 });
    }
  } catch (error) {
    return jsonError(error);
  }
}
