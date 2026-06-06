import { NextResponse } from "next/server";
import mysql from "mysql2/promise";

export const runtime = "nodejs";

export async function POST(request) {
  const token = request.headers.get("x-admin-token");
  if (!token || token !== process.env.ANALYTICS_ADMIN_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 500 });
  }

  let pool;
  try {
    pool = mysql.createPool({ uri: dbUrl, connectionLimit: 1 });

    const [preview] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM portfolio_analytics_events
       WHERE event_type = 'link_click'
         AND event_value LIKE '% | %'`
    );
    const total = preview[0]?.total ?? 0;

    if (total === 0) {
      return NextResponse.json({ ok: true, updated: 0, message: "Nothing to migrate." });
    }

    const [result] = await pool.query(
      `UPDATE portfolio_analytics_events
       SET event_value = SUBSTRING_INDEX(event_value, ' | ', 1)
       WHERE event_type = 'link_click'
         AND event_value LIKE '% | %'`
    );

    return NextResponse.json({ ok: true, updated: result.affectedRows });
  } catch (error) {
    console.error("migrate-link-labels failed", error?.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  } finally {
    await pool?.end().catch(() => {});
  }
}
