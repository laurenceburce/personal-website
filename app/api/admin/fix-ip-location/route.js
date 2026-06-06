import { NextResponse } from "next/server";
import mysql from "mysql2/promise";

export const runtime = "nodejs";

const TARGET_IPS = [
  "110.54.142.115",
  "136.158.101.235",
  "49.146.247.248",
  "180.191.171.216",
  "136.158.100.180",
  "103.200.33.2",
  "136.158.100.197",
  "136.158.100.237"
];

const NEW_IP       = "68.107.96.6";
const NEW_CITY     = "San Diego";
const NEW_COUNTRY  = "United States";

export async function POST(request) {
  const token = request.headers.get("x-admin-token");
  if (!token || token !== process.env.ANALYTICS_ADMIN_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let pool;
  try {
    pool = mysql.createPool({ uri: process.env.DATABASE_URL, connectionLimit: 1 });

    const placeholders = TARGET_IPS.map(() => "?").join(", ");

    // Update visits table — replace ip_address, city, country
    const [visitsResult] = await pool.query(
      `UPDATE portfolio_analytics_visits
       SET ip_address = ?, city = ?, country = ?
       WHERE ip_address IN (${placeholders})`,
      [NEW_IP, NEW_CITY, NEW_COUNTRY, ...TARGET_IPS]
    );

    // Update visitors table — city and country for visitors whose
    // recorded IP hash matches any of the target IPs
    const [visitorsResult] = await pool.query(
      `UPDATE portfolio_analytics_visitors v
       JOIN (
         SELECT DISTINCT visitor_id
         FROM portfolio_analytics_visits
         WHERE ip_address = ?
       ) matched ON matched.visitor_id = v.visitor_id
       SET v.city = ?, v.country = ?`,
      [NEW_IP, NEW_CITY, NEW_COUNTRY]
    );

    return NextResponse.json({
      ok: true,
      visitsUpdated: visitsResult.affectedRows,
      visitorsUpdated: visitorsResult.affectedRows
    });
  } catch (error) {
    console.error("fix-ip-location failed", error?.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  } finally {
    await pool?.end().catch(() => {});
  }
}
