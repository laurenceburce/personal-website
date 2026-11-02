import { NextResponse } from "next/server";
import { requireFinanceAccess } from "../../../lib/financeAuth";
import { getFinancePlanActivity } from "../../../lib/financeStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = {
  "Cache-Control": "private, no-store, max-age=0",
  Vary: "Cookie",
};

export async function GET(request) {
  try {
    if (!(await requireFinanceAccess()))
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401, headers },
      );
    const params = new URL(request.url).searchParams;
    return NextResponse.json(
      await getFinancePlanActivity({
        startDate: params.get("start"),
        endDate: params.get("end"),
      }),
      { headers },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: error?.status
          ? error.message
          : "Plan activity is temporarily unavailable.",
      },
      { status: error?.status || 500, headers },
    );
  }
}
