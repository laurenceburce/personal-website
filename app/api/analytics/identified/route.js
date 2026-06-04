import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { getIdentifiedVisitors } from "../../../lib/analyticsStore";

export const runtime = "nodejs";

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

export async function GET(request) {
  const adminToken = process.env.ANALYTICS_ADMIN_TOKEN;
  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!adminToken || !token || !safeCompare(token, adminToken)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const payload = await getIdentifiedVisitors();

    return NextResponse.json(payload);
  } catch {
    return NextResponse.json(
      { error: "Unable to load identified analytics visitors." },
      { status: 500 }
    );
  }
}
