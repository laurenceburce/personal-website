import { NextResponse } from "next/server";
import { getApplicationScreenshot } from "../../../../../lib/jobSearchApplicationStore";
import { requireJobSearchAccess } from "../../../../../lib/jobSearchAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const access = await requireJobSearchAccess();
  if (!access) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const screenshot = await getApplicationScreenshot(id).catch(() => null);
  if (!screenshot) return NextResponse.json({ error: "No screenshot available." }, { status: 404 });

  return new NextResponse(screenshot, {
    headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600" }
  });
}
