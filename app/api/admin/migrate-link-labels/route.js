import { NextResponse } from "next/server";
import mysql from "mysql2/promise";

export const runtime = "nodejs";

// Old label → readable label
const RENAME_MAP = {
  "About01":            "About",
  "Work Experience02":  "Work Experience",
  "Education03":        "Education",
  "Skills04":           "Skills",
  "Projects05":         "Projects",
  "Website ↗":     "Company Website",   // Website ↗ (work section, all companies)
  "Website":            "Mapua University Website",
  "Repository":         "Project Repository",
  "View Repository":    "Project Repository",
  "Laurence Alec Burce":"Home",
  "GitHub":             "GitHub Profile",
  "LinkedIn":           "LinkedIn Profile",
};

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

    // Step 1: strip raw URL suffix from any remaining old-format entries
    await pool.query(
      `UPDATE portfolio_analytics_events
       SET event_value = SUBSTRING_INDEX(event_value, ' | ', 1)
       WHERE event_type = 'link_click'
         AND event_value LIKE '% | %'`
    );

    // Step 2: rename known labels to readable names
    const entries = Object.entries(RENAME_MAP);
    const placeholders = entries.map(() => "WHEN event_value = ? THEN ?").join("\n        ");
    const values = entries.flatMap(([old, next]) => [old, next]);
    const inList = entries.map(() => "?").join(", ");
    const inValues = entries.map(([old]) => old);

    const [result] = await pool.query(
      `UPDATE portfolio_analytics_events
       SET event_value = CASE
         ${placeholders}
         ELSE event_value
       END
       WHERE event_type = 'link_click'
         AND event_value IN (${inList})`,
      [...values, ...inValues]
    );

    return NextResponse.json({ ok: true, renamed: result.affectedRows });
  } catch (error) {
    console.error("migrate-link-labels failed", error?.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  } finally {
    await pool?.end().catch(() => {});
  }
}
