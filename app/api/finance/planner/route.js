import { NextResponse } from "next/server";
import { requireFinanceAccess } from "../../../lib/financeAuth";
import { getFinancePlanner, refreshPlannerExchangeRate, saveFinancePlanner } from "../../../lib/financePlannerStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const HEADERS = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie" };

function json(data, status = 200) {
  return NextResponse.json(data, { status, headers: HEADERS });
}

function errorResponse(error) {
  return json({ error: error?.status ? error.message : "The finance planner is temporarily unavailable." }, error?.status || 500);
}

async function body(request) {
  if (Number(request.headers.get("content-length") || 0) > 1_000_000) throw Object.assign(new Error("The planner is too large."), { status: 413 });
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > 1_000_000) throw Object.assign(new Error("The planner is too large."), { status: 413 });
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error("Send valid planner JSON."), { status: 400 }); }
}

export async function GET() {
  try {
    if (!await requireFinanceAccess()) return json({ error: "Unauthorized" }, 401);
    return json(await getFinancePlanner());
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request) {
  try {
    if (!await requireFinanceAccess()) return json({ error: "Unauthorized" }, 401);
    const payload = await body(request);
    return json(await saveFinancePlanner(payload?.document, payload?.revision));
  } catch (error) { return errorResponse(error); }
}

export async function POST(request) {
  try {
    if (!await requireFinanceAccess()) return json({ error: "Unauthorized" }, 401);
    const payload = await body(request);
    if (payload?.action !== "refreshRate") return json({ error: "Unknown planner action." }, 400);
    return json({ exchangeRate: await refreshPlannerExchangeRate() });
  } catch (error) { return errorResponse(error); }
}
