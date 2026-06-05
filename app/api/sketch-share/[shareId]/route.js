import { NextResponse } from "next/server";
import { getSketchShare } from "../../../lib/analyticsStore";

export const runtime = "nodejs";

export async function GET(_request, { params }) {
  try {
    const { shareId } = await params;
    const share = await getSketchShare(shareId);

    if (!share) {
      return NextResponse.json({ error: "Share link not found." }, { status: 404 });
    }

    return NextResponse.json(share);
  } catch {
    return NextResponse.json(
      { error: "Unable to load share link." },
      { status: 500 }
    );
  }
}
