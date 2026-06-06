import { NextResponse } from "next/server";
import mysql from "mysql2/promise";

export const runtime = "nodejs";

export async function GET(request) {
  const token = request.headers.get("x-admin-token");
  if (!token || token !== process.env.ANALYTICS_ADMIN_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let pool;
  try {
    pool = mysql.createPool({ uri: process.env.DATABASE_URL, connectionLimit: 1 });
    const [[{ visitsRows }]] = await pool.query("SELECT COUNT(*) AS visitsRows FROM portfolio_analytics_visits");
    const [[{ visitorsRows }]] = await pool.query("SELECT COUNT(*) AS visitorsRows FROM portfolio_analytics_visitors");
    const [[counter]] = await pool.query("SELECT counter_value FROM portfolio_analytics_counters WHERE counter_key = 'total_visits'");
    return NextResponse.json({
      visitsTableRows: Number(visitsRows),
      visitorsTableRows: Number(visitorsRows),
      counterValue: Number(counter?.counter_value ?? 0)
    });
  } finally {
    await pool?.end().catch(() => {});
  }
}
