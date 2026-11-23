import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { ensureFinanceSchema } from "../../../lib/financeStore";
import { localDate } from "../../../lib/financePlanner.mjs";
import { importFinanceCardStatement } from "../../../lib/financeStatementImport.mjs";
import { verifyFinanceStatementPlan } from "../../../lib/financeStatementImportVerification.mjs";
import { isAllowedOrigin } from "../../utils/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Temporary, operation-bound maintenance route; removed after the verified import.
const IMPORT_KEY_SHA256 = "dcbb76d15093fc93c2c1bc640bcb5b6124b61ef156f2df1bd1d97013f657d39c";
const IMPORT_OPERATION_SHA256 = "8c3dd98c61acdc3804c1079ab6d72074266cdfd6bfe6a42835848f475a385a41";
const IMPORT_EXPIRES_AT = 1795414615582;
const digest = (value) => createHash("sha256").update(value).digest();
const matchesHash = (value, hash) => /^[a-f0-9]{64}$/.test(hash) &&
  timingSafeEqual(digest(value), Buffer.from(hash, "hex"));
const json = (value, status = 200) => NextResponse.json(value, { status, headers: {
  "Cache-Control": "private, no-store, max-age=0", Vary: "X-Admin-Token, X-Finance-Import-Key",
} });

export async function POST(request) {
  const admin = process.env.ANALYTICS_ADMIN_TOKEN;
  const supplied = request.headers.get("x-admin-token") || "";
  const key = request.headers.get("x-finance-import-key") || "";
  if (!admin || !supplied || !timingSafeEqual(digest(supplied), digest(admin)) ||
      !matchesHash(key, IMPORT_KEY_SHA256) || Date.now() >= IMPORT_EXPIRES_AT)
    return json({ error: "Unauthorized" }, 401);
  if (!isAllowedOrigin(request)) return json({ error: "Origin not allowed" }, 403);
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return json({ error: "Send JSON" }, 415);
  if (Number(request.headers.get("content-length") || 0) > 4096)
    return json({ error: "Request too large" }, 413);
  try {
    const text = await request.text();
    if (Buffer.byteLength(text) > 4096) return json({ error: "Request too large" }, 413);
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: "Invalid JSON" }, 400); }
    if (!body || !["preview", "apply", "verify"].includes(body.mode) || !body.operation ||
        !matchesHash(JSON.stringify(body.operation), IMPORT_OPERATION_SHA256))
      return json({ error: "This operation is not authorized" }, 403);
    const pool = await ensureFinanceSchema();
    if (!pool) return json({ error: "Database unavailable" }, 503);
    const today = localDate();
    const receipt = await importFinanceCardStatement(pool, body.operation, { apply: body.mode === "apply", today });
    const planner = body.mode === "verify"
      ? await verifyFinanceStatementPlan(pool, body.operation, receipt.account, today) : undefined;
    return json({ ok: true, receipt, ...(planner ? { planner } : {}) });
  } catch (error) {
    return json({ error: error?.status ? error.message : "Statement import failed" }, Number(error?.status) || 500);
  }
}
