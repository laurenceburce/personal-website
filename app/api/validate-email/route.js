import { NextResponse } from "next/server";
import { isAllowedOrigin } from "../utils/origin";

export const runtime = "nodejs";

const requestLimits = new Map();
const LIMIT_MS = 60 * 1000;
const LIMIT_MAX = 12;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const rejectionMessages = {
  syntax: "Enter a valid email address.",
  mx: "That email domain does not appear able to receive mail.",
  disposable: "Please use a non-disposable email address.",
  confidence: "That email address looks too risky to use for downloads."
};

export async function POST(request) {
  try {
    if (!isAllowedOrigin(request)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
    const now = Date.now();
    const entry = requestLimits.get(ip) ?? { count: 0, windowStart: now };
    if (now - entry.windowStart > LIMIT_MS) {
      entry.count = 0;
      entry.windowStart = now;
    }
    entry.count += 1;
    requestLimits.set(ip, entry);

    if (entry.count > LIMIT_MAX) {
      return NextResponse.json({ error: "Too many attempts. Please try again shortly." }, { status: 429 });
    }

    const body = await request.json();
    const email = String(body?.email || "").trim().toLowerCase();

    if (!EMAIL_PATTERN.test(email)) {
      return NextResponse.json({ valid: false, reason: "syntax", message: rejectionMessages.syntax }, { status: 400 });
    }

    const response = await fetch(`https://disify.com/api/email/${encodeURIComponent(email)}`, {
      cache: "no-store"
    });

    if (!response.ok) {
      return NextResponse.json(
        { valid: false, reason: "service", message: "Email validation is temporarily unavailable." },
        { status: 502 }
      );
    }

    const result = await response.json();
    const reason = getRejectionReason(result);

    return NextResponse.json({
      valid: !reason,
      email,
      reason,
      message: reason ? rejectionMessages[reason] : "Email address verified.",
      checks: {
        formatValid: Boolean(result.format),
        mxFound: Boolean(result.dns),
        disposable: result.disposable === true,
        role: result.role === true,
        free: result.free === true,
        confidence: typeof result.confidence === "number" ? result.confidence : null
      }
    });
  } catch {
    return NextResponse.json(
      { valid: false, reason: "service", message: "Unable to validate email right now." },
      { status: 500 }
    );
  }
}

function getRejectionReason(result) {
  if (!result?.format) return "syntax";
  if (!result.dns) return "mx";
  if (result.disposable === true) return "disposable";
  if (typeof result.confidence === "number" && result.confidence >= 90) return "confidence";
  return "";
}
