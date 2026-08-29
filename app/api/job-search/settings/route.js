import { NextResponse } from "next/server";
import { jsonError, requireAccessOrRespond } from "../../../lib/jobSearchApiHelpers";
import { updateFindSettings, updateProfile } from "../../../lib/jobSearchSettingsStore";
import {
  createWatchlistEntry,
  deleteWatchlistEntry,
  updateWatchlistEntry
} from "../../../lib/jobSearchWatchlistStore";

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
      case "createWatchlistEntry":
        return NextResponse.json({ ok: true, result: await createWatchlistEntry(data) });
      case "updateWatchlistEntry":
        return NextResponse.json({ ok: true, result: await updateWatchlistEntry(data.id, data) });
      case "deleteWatchlistEntry":
        return NextResponse.json({ ok: true, result: await deleteWatchlistEntry(data.id) });
      default:
        return NextResponse.json({ error: "Unknown settings action." }, { status: 400 });
    }
  } catch (error) {
    return jsonError(error);
  }
}
