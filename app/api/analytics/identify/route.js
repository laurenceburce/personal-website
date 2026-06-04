import { NextResponse } from "next/server";
import { identifyVisitor } from "../../../lib/analyticsStore";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const body = await request.json();
    const stats = await identifyVisitor({
      visitorId: body?.visitorId,
      email: body?.email,
      name: body?.name
    });

    return NextResponse.json(stats);
  } catch {
    return NextResponse.json(
      { error: "Unable to identify analytics visitor." },
      { status: 500 }
    );
  }
}
