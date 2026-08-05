import { NextResponse } from "next/server";
import { requireFinanceAccess } from "../../lib/financeAuth";
import {
  archiveFinanceAccount,
  createFinverseLink,
  createFinanceAccount,
  createFinanceTransaction,
  createPlaidLinkToken,
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
  upsertFinanceGoal
} from "../../lib/financeStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(error) {
  const status = Number(error?.status) || 500;
  return NextResponse.json(
    { error: error?.message || "Something went wrong." },
    { status }
  );
}

export async function GET(request) {
  const access = await requireFinanceAccess();
  if (!access) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const month = new URL(request.url).searchParams.get("month");
  return NextResponse.json(await getFinanceDashboard({ month }));
}

export async function POST(request) {
  const access = await requireFinanceAccess();
  if (!access) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json().catch(() => ({}));
    const action = body?.action;
    const data = body?.data || {};

    switch (action) {
      case "seedStarter":
        return NextResponse.json({ ok: true, result: await seedFinanceStarter() });
      case "createPlaidLinkToken":
        return NextResponse.json({ ok: true, result: await createPlaidLinkToken(access.email) });
      case "exchangePlaidPublicToken":
        return NextResponse.json({ ok: true, result: await exchangePlaidPublicToken(data) });
      case "createFinverseLink":
        return NextResponse.json({ ok: true, result: await createFinverseLink(access.email) });
      case "syncConnection":
        return NextResponse.json({ ok: true, result: await syncFinanceConnection(data.id) });
      case "updatePlan":
        return NextResponse.json({ ok: true, result: await updateFinancePlan(data) });
      case "updateDisplayCurrency":
        return NextResponse.json({ ok: true, result: await updateFinanceDisplayCurrency(data.currency) });
      case "refreshExchangeRate":
        return NextResponse.json({ ok: true, result: await refreshFinanceExchangeRate() });
      case "createTransaction":
        return NextResponse.json({ ok: true, result: await createFinanceTransaction(data) });
      case "updateTransaction":
        return NextResponse.json({ ok: true, result: await updateFinanceTransaction(data.id, data) });
      case "deleteTransaction":
        return NextResponse.json({ ok: true, result: await deleteFinanceTransaction(data.id) });
      case "createAccount":
        return NextResponse.json({ ok: true, result: await createFinanceAccount(data) });
      case "updateAccount":
        return NextResponse.json({ ok: true, result: await updateFinanceAccount(data.id, data) });
      case "archiveAccount":
        return NextResponse.json({ ok: true, result: await archiveFinanceAccount(data.id) });
      case "upsertBudget":
        return NextResponse.json({ ok: true, result: await upsertFinanceBudget(data) });
      case "deleteBudget":
        return NextResponse.json({ ok: true, result: await deleteFinanceBudget(data.id) });
      case "upsertBill":
        return NextResponse.json({ ok: true, result: await upsertFinanceBill(data) });
      case "toggleBillPaid":
        return NextResponse.json({ ok: true, result: await toggleFinanceBillPaid(data.id, data.isPaid) });
      case "deleteBill":
        return NextResponse.json({ ok: true, result: await deleteFinanceBill(data.id) });
      case "upsertGoal":
        return NextResponse.json({ ok: true, result: await upsertFinanceGoal(data) });
      case "deleteGoal":
        return NextResponse.json({ ok: true, result: await deleteFinanceGoal(data.id) });
      default:
        return NextResponse.json({ error: "Unknown finance action." }, { status: 400 });
    }
  } catch (error) {
    return jsonError(error);
  }
}
