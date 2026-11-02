import { NextResponse } from "next/server";
import { requireFinanceAccess } from "../../../lib/financeAuth";
import { getFinanceActivity } from "../../../lib/financeStore";

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
    const month = new URL(request.url).searchParams.get("month");
    return NextResponse.json(await getFinanceActivity({ month }), { headers });
  } catch (error) {
    return NextResponse.json(
      {
        error: error?.status
          ? error.message
          : "Finance activity is temporarily unavailable.",
      },
      { status: error?.status || 500, headers },
    );
  }
}
