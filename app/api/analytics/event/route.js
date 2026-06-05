import { NextResponse } from "next/server";
import { recordEvent } from "../../../lib/analyticsStore";
import { isAllowedOrigin, isLocalRequest } from "../../utils/origin";

export const runtime = "nodejs";

const eventRateLimit = new Map();
const EVENT_LIMIT_MS = 60 * 1000;
const EVENT_LIMIT_MAX = 90;

const ALLOWED_TYPES = new Set(["download", "link_click", "time_on_page", "sketch_share_created"]);

export async function POST(request) {
  try {
    if (!isAllowedOrigin(request)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
    const now = Date.now();
    const entry = eventRateLimit.get(ip) ?? { count: 0, windowStart: now };
    if (now - entry.windowStart > EVENT_LIMIT_MS) {
      entry.count = 0;
      entry.windowStart = now;
    }
    entry.count++;
    eventRateLimit.set(ip, entry);
    if (entry.count > EVENT_LIMIT_MAX) {
      return NextResponse.json({ error: "Too many requests." }, { status: 429 });
    }

    const body = await request.json();
    const { visitorId, eventType, eventValue } = body ?? {};

    if (!ALLOWED_TYPES.has(eventType)) {
      return NextResponse.json({ error: "Invalid event type." }, { status: 400 });
    }

    await recordEvent(visitorId, eventType, String(eventValue ?? ""));

    return NextResponse.json({ ok: true });
  } catch {
    if (isLocalRequest(request)) {
      return NextResponse.json({ ok: false, skipped: true, reason: "local_analytics_unavailable" });
    }

    return NextResponse.json(
      { error: "Unable to record event." },
      { status: 500 }
    );
  }
}
