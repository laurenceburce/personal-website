import { NextResponse } from "next/server";
import { jsonError, requireAccessOrRespond } from "../../../lib/jobSearchApiHelpers";
import { deleteGmailConnection, getGmailConnectionStatus } from "../../../lib/jobSearchEmailConnectionStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { unauthorizedResponse } = await requireAccessOrRespond();
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    return NextResponse.json({ ok: true, connection: await getGmailConnectionStatus() });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request) {
  const { unauthorizedResponse } = await requireAccessOrRespond();
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    const body = await request.json().catch(() => ({}));
    const action = body?.action;

    switch (action) {
      case "disconnect":
        return NextResponse.json({ ok: true, result: await deleteGmailConnection() });
      default:
        return NextResponse.json({ error: "Unknown Gmail action." }, { status: 400 });
    }
  } catch (error) {
    return jsonError(error);
  }
}
