import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import mysql from "mysql2/promise";

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

export async function POST(request) {
  const adminToken = process.env.ANALYTICS_ADMIN_TOKEN;
  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!adminToken || !token || !safeCompare(token, adminToken)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const dbUrl = process.env.DATABASE_URL || process.env.MYSQL_URL || "";
  if (!dbUrl) {
    return NextResponse.json({ error: "Database not configured." }, { status: 503 });
  }

  const pool = mysql.createPool({ uri: dbUrl, connectionLimit: 1 });

  try {
    const tables = [
      "portfolio_analytics_visits",
      "portfolio_analytics_events",
      "portfolio_analytics_identified_visitors",
      "portfolio_analytics_visitors",
      "portfolio_analytics_counters"
    ];

    for (const table of tables) {
      await pool.query(`TRUNCATE TABLE \`${table}\``);
    }

    return NextResponse.json({ ok: true, cleared: tables });
  } finally {
    await pool.end();
  }
}
