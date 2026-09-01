import { NextResponse } from "next/server";
import { jsonError, requireAccessOrRespond } from "../../../lib/jobSearchApiHelpers";
import { deletePushSubscriptionByEndpoint, savePushSubscription } from "../../../lib/jobSearchPushSubscriptionStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { unauthorizedResponse } = await requireAccessOrRespond();
  if (unauthorizedResponse) return unauthorizedResponse;

  return NextResponse.json({ ok: true, vapidPublicKey: process.env.JOB_SEARCH_VAPID_PUBLIC_KEY || "" });
}

export async function POST(request) {
  const { unauthorizedResponse } = await requireAccessOrRespond();
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    const body = await request.json().catch(() => ({}));
    const action = body?.action;
    const data = body?.data || {};

    switch (action) {
      case "subscribe":
        await savePushSubscription({
          endpoint: data.endpoint,
          p256dh: data.keys?.p256dh,
          auth: data.keys?.auth
        });
        return NextResponse.json({ ok: true });
      case "unsubscribe":
        await deletePushSubscriptionByEndpoint(data.endpoint);
        return NextResponse.json({ ok: true });
      default:
        return NextResponse.json({ error: "Unknown push-subscription action." }, { status: 400 });
    }
  } catch (error) {
    return jsonError(error);
  }
}
