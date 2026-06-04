import { createHash, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const SESSION_COOKIE = "admin_session";
const LOGIN_RATE_LIMIT = new Map();
const LIMIT_MS = 15 * 60 * 1000; // 15 minutes
const LIMIT_MAX = 10;

function deriveSessionToken(adminToken) {
  return createHash("sha256")
    .update(adminToken + ":admin-session")
    .digest("hex");
}

function safeCompare(a, b) {
  try {
    const aBuf = Buffer.from(a);
    const bBuf = Buffer.from(b);
    if (aBuf.length !== bBuf.length) return false;
    return timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

export async function POST(request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  const now = Date.now();
  const entry = LOGIN_RATE_LIMIT.get(ip) ?? { count: 0, windowStart: now };

  if (now - entry.windowStart > LIMIT_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }

  entry.count++;
  LOGIN_RATE_LIMIT.set(ip, entry);

  if (entry.count > LIMIT_MAX) {
    return NextResponse.json(
      { error: "Too many login attempts. Try again later." },
      { status: 429 }
    );
  }

  const adminToken = process.env.ANALYTICS_ADMIN_TOKEN;
  if (!adminToken) {
    return NextResponse.json({ error: "Not configured." }, { status: 503 });
  }

  const body = await request.json().catch(() => ({}));
  const password = typeof body?.password === "string" ? body.password : "";

  if (!safeCompare(password, adminToken)) {
    return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
  }

  const sessionValue = deriveSessionToken(adminToken);
  const isProduction = process.env.NODE_ENV === "production";

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, sessionValue, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "strict",
    path: "/",
    maxAge: 60 * 60 * 8 // 8 hours
  });

  return response;
}
