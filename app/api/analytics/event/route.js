import { NextResponse } from "next/server";
import { recordEvent } from "../../../lib/analyticsStore";
import { isAllowedOrigin, isLocalRequest } from "../../utils/origin";

export const runtime = "nodejs";

const eventRateLimit = new Map();
const EVENT_LIMIT_MS = 60 * 1000;
const EVENT_LIMIT_MAX = 90;

// Allow "time_on_page" (metric) and "Section: Label" format events (max 50 chars).
// Section can be a project title ("Personal Portfolio Website: GitHub") so we only
// require it starts with a letter and contains the ": " separator.
const isAllowedEventType = (type) => {
  if (typeof type !== "string" || type.length === 0 || type.length > 50) return false;
  if (type === "time_on_page") return true;
  // Legacy formats kept for backward compatibility during transition
  if (type === "download" || type === "link_click" || type === "sketch_share_created") return true;
  // "Section: Label" — starts with a letter, contains colon separator
  return /^[A-Za-z]/.test(type) && type.includes(": ");
};

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

    if (!isAllowedEventType(eventType)) {
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
