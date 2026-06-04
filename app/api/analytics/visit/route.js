import { NextResponse } from "next/server";
import { recordVisit } from "../../../lib/analyticsStore";

export const runtime = "nodejs";

const visitRateLimit = new Map();
const VISIT_LIMIT_MS = 60 * 1000;
const VISIT_LIMIT_MAX = 20;

export async function POST(request) {
  try {
    const allowedOrigin = process.env.NEXT_PUBLIC_SITE_URL || "";
    const origin = request.headers.get("origin") || "";
    if (allowedOrigin && origin && origin !== allowedOrigin) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
    const now = Date.now();
    const entry = visitRateLimit.get(ip) ?? { count: 0, windowStart: now };
    if (now - entry.windowStart > VISIT_LIMIT_MS) {
      entry.count = 0;
      entry.windowStart = now;
    }
    entry.count++;
    visitRateLimit.set(ip, entry);
    if (entry.count > VISIT_LIMIT_MAX) {
      return NextResponse.json({ error: "Too many requests." }, { status: 429 });
    }

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
