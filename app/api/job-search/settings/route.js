import { NextResponse } from "next/server";
import { jsonError, requireAccessOrRespond } from "../../../lib/jobSearchApiHelpers";
import { updateFindSettings, updateProfile } from "../../../lib/jobSearchSettingsStore";
import { setWorkerEnabled } from "../../../lib/jobSearchWorkerStatusStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  const { unauthorizedResponse } = await requireAccessOrRespond();
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    const body = await request.json().catch(() => ({}));
    const action = body?.action;
    const data = body?.data || {};

    switch (action) {
      case "updateProfile":
        return NextResponse.json({ ok: true, result: await updateProfile(data) });
      case "updateFindSettings":
        return NextResponse.json({ ok: true, result: await updateFindSettings(data) });
      case "setWorkerEnabled":
        return NextResponse.json({ ok: true, result: await setWorkerEnabled(data?.workerName, Boolean(data?.enabled)) });
      default:
        return NextResponse.json({ error: "Unknown settings action." }, { status: 400 });
    }
  } catch (error) {
    return jsonError(error);
  }
}
