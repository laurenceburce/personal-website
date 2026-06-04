import { NextResponse } from "next/server";
import { getAnalyticsStats } from "../../../lib/analyticsStore";

export const runtime = "nodejs";

export async function GET() {
  try {
    const stats = await getAnalyticsStats();

    return NextResponse.json(stats);
  } catch {
    return NextResponse.json(
      { error: "Unable to load analytics stats." },
      { status: 500 }
    );
  }
}
