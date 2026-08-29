import { NextResponse } from "next/server";
import { jsonError, requireAccessOrRespond } from "../../../lib/jobSearchApiHelpers";
import { decidePosting, getPostingById } from "../../../lib/jobSearchPostingsStore";
import { scorePosting } from "../../../lib/jobSearchScoringPipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function approveOne(id, email) {
  return decidePosting(id, { status: "approved", decidedBy: email });
}

async function rejectOne(id, email, note) {
  return decidePosting(id, { status: "rejected", decidedBy: email, decisionNote: note });
}

export async function POST(request) {
  const { access, unauthorizedResponse } = await requireAccessOrRespond();
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    const body = await request.json().catch(() => ({}));
    const action = body?.action;
    const data = body?.data || {};

    switch (action) {
      case "approve":
        return NextResponse.json({ ok: true, result: await approveOne(data.id, access.email) });
      case "reject":
        return NextResponse.json({ ok: true, result: await rejectOne(data.id, access.email, data.note) });
      case "batchApprove": {
        const ids = Array.isArray(data.ids) ? data.ids : [];
        for (const id of ids) await approveOne(id, access.email);
        return NextResponse.json({ ok: true, result: { count: ids.length } });
      }
      case "batchReject": {
        const ids = Array.isArray(data.ids) ? data.ids : [];
        for (const id of ids) await rejectOne(id, access.email, data.note);
        return NextResponse.json({ ok: true, result: { count: ids.length } });
      }
      case "rescoreNow": {
        const posting = await getPostingById(data.id);
        if (!posting) return NextResponse.json({ error: "Posting not found." }, { status: 404 });
        const outcome = await scorePosting(posting);
        return NextResponse.json({ ok: true, result: outcome });
      }
      default:
        return NextResponse.json({ error: "Unknown review-queue action." }, { status: 400 });
    }
  } catch (error) {
    return jsonError(error);
  }
}
