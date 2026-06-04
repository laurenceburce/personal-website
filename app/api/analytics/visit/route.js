import { NextResponse } from "next/server";
import { recordVisit } from "../../../lib/analyticsStore";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const body = await request.json();
    const stats = await recordVisit(body?.visitorId);

    return NextResponse.json(stats);
  } catch {
    return NextResponse.json(
      { error: "Unable to record analytics visit." },
      { status: 500 }
    );
  }
}
