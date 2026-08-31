import { NextResponse } from "next/server";
import { jsonError, requireAccessOrRespond } from "../../../lib/jobSearchApiHelpers";
import { answerSecurityChallenge, listPendingSecurityChallenges } from "../../../lib/jobSearchSecurityChallengeStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { unauthorizedResponse } = await requireAccessOrRespond();
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    const challenges = await listPendingSecurityChallenges({ limit: 20 });
    return NextResponse.json({ ok: true, challenges });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request) {
  const { unauthorizedResponse } = await requireAccessOrRespond();
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    const body = await request.json().catch(() => ({}));
    const action = body?.action;
    const data = body?.data || {};

    switch (action) {
      case "submitSecurityCode":
        return NextResponse.json({ ok: true, result: await answerSecurityChallenge(data.id, data.code) });
      default:
        return NextResponse.json({ error: "Unknown security-challenge action." }, { status: 400 });
    }
  } catch (error) {
    return jsonError(error);
  }
}
