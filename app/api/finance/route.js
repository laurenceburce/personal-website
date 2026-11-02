import { NextResponse } from "next/server";
import { requireFinanceAccess } from "../../lib/financeAuth";
import { isAllowedOrigin } from "../utils/origin";
import {
  archiveFinanceAccount,
  createBrankasLink,
  createFinanceAccount,
  createFinanceTransaction,
  createPlaidLinkToken,
  FINANCE_BRANKAS_STATE_COOKIE,
  deleteFinanceBill,
  deleteFinanceBudget,
  deleteFinanceGoal,
  deleteFinanceTransaction,
  exchangePlaidPublicToken,
  getFinanceDashboard,
  seedFinanceStarter,
  syncFinanceConnection,
  toggleFinanceBillPaid,
  updateFinanceAccount,
  updateFinanceDisplayCurrency,
  updateFinancePlan,
  updateFinanceTransaction,
  refreshFinanceExchangeRate,
  upsertFinanceBill,
  upsertFinanceBudget,
  upsertFinanceGoal,
} from "../../lib/financeStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Vary: "Cookie",
};

function json(value, options = {}) {
  return NextResponse.json(value, {
    ...options,
    headers: { ...PRIVATE_HEADERS, ...(options.headers || {}) },
  });
}

async function readBody(request) {
  if (Number(request.headers.get("content-length") || 0) > 65_536)
    throw Object.assign(new Error("The finance request is too large."), {
      status: 413,
    });
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > 65_536)
    throw Object.assign(new Error("The finance request is too large."), {
      status: 413,
    });
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("Send valid finance JSON."), { status: 400 });
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Object.assign(new Error("Send a finance action."), { status: 400 });
  return value;
}

function jsonError(error) {
  const status = Number(error?.status) || 500;
  return json(
    {
      error: error?.status
        ? error.message
        : "Finance is temporarily unavailable. Please try again.",
    },
    { status },
  );
}

export async function GET(request) {
  try {
    const access = await requireFinanceAccess();
    if (!access) return json({ error: "Unauthorized" }, { status: 401 });
    const month = new URL(request.url).searchParams.get("month");
    return json(await getFinanceDashboard({ month }));
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request) {
  try {
    const access = await requireFinanceAccess();
    if (!access) return json({ error: "Unauthorized" }, { status: 401 });
    if (!isAllowedOrigin(request))
      return json(
        { error: "This request origin is not allowed." },
        { status: 403 },
      );
    const body = await readBody(request);
    const action = body?.action;
    const data = body?.data || {};

    switch (action) {
      case "seedStarter":
        return json({ ok: true, result: await seedFinanceStarter() });
      case "createPlaidLinkToken":
        return json({
          ok: true,
          result: await createPlaidLinkToken(access.email),
        });
      case "exchangePlaidPublicToken":
        return json({ ok: true, result: await exchangePlaidPublicToken(data) });
      case "createBrankasLink": {
        const { state, ...result } = await createBrankasLink(access.email);
        const response = json({ ok: true, result });
        response.cookies.set(FINANCE_BRANKAS_STATE_COOKIE, state, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          path: "/finance/brankas/callback",
          maxAge: 600,
        });
        return response;
      }
      case "syncConnection":
        return json({ ok: true, result: await syncFinanceConnection(data.id) });
      case "updatePlan":
        return json({ ok: true, result: await updateFinancePlan(data) });
      case "updateDisplayCurrency":
        return json({
          ok: true,
          result: await updateFinanceDisplayCurrency(data.currency),
        });
      case "refreshExchangeRate":
        return json({ ok: true, result: await refreshFinanceExchangeRate() });
      case "createTransaction":
        return json({ ok: true, result: await createFinanceTransaction(data) });
      case "updateTransaction":
        return json({
          ok: true,
          result: await updateFinanceTransaction(data.id, data),
        });
      case "deleteTransaction":
        return json({
          ok: true,
          result: await deleteFinanceTransaction(data.id),
        });
      case "createAccount":
        return json({ ok: true, result: await createFinanceAccount(data) });
      case "updateAccount":
        return json({
          ok: true,
          result: await updateFinanceAccount(data.id, data),
        });
      case "archiveAccount":
        return json({ ok: true, result: await archiveFinanceAccount(data.id) });
      case "upsertBudget":
        return json({ ok: true, result: await upsertFinanceBudget(data) });
      case "deleteBudget":
        return json({ ok: true, result: await deleteFinanceBudget(data.id) });
      case "upsertBill":
        return json({ ok: true, result: await upsertFinanceBill(data) });
      case "toggleBillPaid":
        return json({
          ok: true,
          result: await toggleFinanceBillPaid(data.id, data.isPaid),
        });
      case "deleteBill":
        return json({ ok: true, result: await deleteFinanceBill(data.id) });
      case "upsertGoal":
        return json({ ok: true, result: await upsertFinanceGoal(data) });
      case "deleteGoal":
        return json({ ok: true, result: await deleteFinanceGoal(data.id) });
      default:
        return json({ error: "Unknown finance action." }, { status: 400 });
    }
  } catch (error) {
    return jsonError(error);
  }
}
