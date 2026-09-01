import { NextResponse } from "next/server";
import { requireAccessOrRespond } from "../../../../../lib/jobSearchApiHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Proxies a batch of relayed mouse/keyboard events through to the
// submit-worker's own /live/:id/input — see the frame route's sibling
// comment on why this never reaches the worker directly.
export async function POST(request, { params }) {
  const { unauthorizedResponse } = await requireAccessOrRespond();
  if (unauthorizedResponse) return unauthorizedResponse;

  const workerUrl = process.env.JOB_SEARCH_SUBMIT_WORKER_URL;
  if (!workerUrl) {
    return NextResponse.json({ error: "JOB_SEARCH_SUBMIT_WORKER_URL is not configured." }, { status: 503 });
  }

  const { id } = await params;
  const body = await request.text();

  try {
    const upstream = await fetch(`${workerUrl.replace(/\/+$/, "")}/live/${encodeURIComponent(id)}/input`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.JOB_SEARCH_SUBMIT_TRIGGER_SECRET ? { "X-Trigger-Secret": process.env.JOB_SEARCH_SUBMIT_TRIGGER_SECRET } : {})
      },
      body
    });

    const payload = await upstream.json().catch(() => ({}));
    return NextResponse.json(payload, { status: upstream.status });
  } catch (error) {
    return NextResponse.json({ error: `Failed to reach the submit worker: ${error?.message || error}` }, { status: 502 });
  }
}
