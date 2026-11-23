import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { ensureFinanceSchema } from "../../../lib/financeStore";
import { refreshFinancePlanPostings } from "../../../lib/financePlanPostings.mjs";
import { reviewFinancePendingPlanner } from "../../../lib/financePendingPlannerReview.mjs";
import { isAllowedOrigin } from "../../utils/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const REVIEW_KEY_SHA256 = "ba95287a852a27867d340729cfddc1ebe126aa543b9603fb24f0ba45177a2603";
const REVIEW_OPERATION_SHA256 = "e052046f86427c684908cc428e2fa74007731bccd71cbc3a0e48c69b3a57547e";
const REVIEW_EXPIRES_AT = 1795421228232;
const digest = (value) => createHash("sha256").update(value).digest();
const matchesHash = (value, hash) => /^[a-f0-9]{64}$/.test(hash) && timingSafeEqual(digest(value), Buffer.from(hash, "hex"));
const json = (value, status = 200) => NextResponse.json(value, { status, headers: {
  "Cache-Control": "private, no-store, max-age=0", Vary: "X-Admin-Token, X-Finance-Review-Key",
} });

export async function POST(request) {
  const admin = process.env.ANALYTICS_ADMIN_TOKEN;
  const supplied = request.headers.get("x-admin-token") || "";
  if (!admin || !supplied || !timingSafeEqual(digest(supplied), digest(admin)) ||
      !matchesHash(request.headers.get("x-finance-review-key") || "", REVIEW_KEY_SHA256) || Date.now() >= REVIEW_EXPIRES_AT)
    return json({ error: "Unauthorized" }, 401);
  if (!isAllowedOrigin(request)) return json({ error: "Origin not allowed" }, 403);
  if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "Send JSON" }, 415);
  if (Number(request.headers.get("content-length") || 0) > 4096) return json({ error: "Request too large" }, 413);
  try {
    const text = await request.text();
    if (Buffer.byteLength(text) > 4096) return json({ error: "Request too large" }, 413);
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: "Invalid JSON" }, 400); }
    if (!body || !["review", "refresh"].includes(body.mode) || !body.operation ||
        !matchesHash(JSON.stringify(body.operation), REVIEW_OPERATION_SHA256))
      return json({ error: "This operation is not authorized" }, 403);
    const pool = await ensureFinanceSchema();
    if (!pool) return json({ error: "Database unavailable" }, 503);
    const report = await reviewFinancePendingPlanner(pool, body.operation,
      { ...(body.mode === "refresh" ? { refresh: refreshFinancePlanPostings } : {}) });
    return json({ ok: true, report });
  } catch (error) {
    return json({ error: error?.status ? error.message : "Pending charge review failed" }, Number(error?.status) || 500);
  }
}
