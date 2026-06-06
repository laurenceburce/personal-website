import { NextResponse } from "next/server";
import { identifyVisitor } from "../../../lib/analyticsStore";
import { isAllowedOrigin, isLocalRequest } from "../../utils/origin";

export const runtime = "nodejs";

const identifyRateLimit = new Map();
const IDENTIFY_LIMIT_MS = 60 * 1000;
const IDENTIFY_LIMIT_MAX = 20;

export async function POST(request) {
  try {
    if (!isAllowedOrigin(request)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
    const now = Date.now();
    const entry = identifyRateLimit.get(ip) ?? { count: 0, windowStart: now };
    if (now - entry.windowStart > IDENTIFY_LIMIT_MS) {
      entry.count = 0;
      entry.windowStart = now;
    }
    entry.count++;
    identifyRateLimit.set(ip, entry);
    if (entry.count > IDENTIFY_LIMIT_MAX) {
      return NextResponse.json({ error: "Too many requests." }, { status: 429 });
    }

    const body = await request.json();
    const stats = await identifyVisitor({
      visitorId: body?.visitorId,
      email: body?.email,
      name: body?.name,
      authProvider: body?.authProvider,
      profileImage: body?.profileImage
    });

    return NextResponse.json(stats);
  } catch {
    if (isLocalRequest(request)) {
      return NextResponse.json({ ok: false, skipped: true, reason: "local_analytics_unavailable" });
    }

    return NextResponse.json(
      { error: "Unable to identify analytics visitor." },
      { status: 500 }
    );
  }
}
