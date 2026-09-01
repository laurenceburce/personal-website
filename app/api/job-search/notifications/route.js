import { NextResponse } from "next/server";
import { jsonError, requireAccessOrRespond } from "../../../lib/jobSearchApiHelpers";
import { listRecentNotifications } from "../../../lib/jobSearchNotifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Polled by the toolbar's notification bell (see NotificationsBell.js) so
// new discovery/submit-worker activity shows up without a full page
// refresh. Cheap — two small LIMIT-30 reads, no joins (see
// jobSearchNotifications.js).
export async function GET() {
  const { unauthorizedResponse } = await requireAccessOrRespond();
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    const notifications = await listRecentNotifications({ limit: 20 });
    return NextResponse.json({ ok: true, notifications });
  } catch (error) {
    return jsonError(error);
  }
}
