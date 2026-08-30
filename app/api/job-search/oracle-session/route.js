import { NextResponse } from "next/server";
import { jsonError, requireAccessOrRespond } from "../../../lib/jobSearchApiHelpers";
import { deleteOracleSession, saveOracleSession } from "../../../lib/jobSearchOracleSessionStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A real storageState is typically a few KB to a couple hundred KB — this is
// generous headroom, not a meaningful size limit.
const MAX_SESSION_BYTES = 2 * 1024 * 1024;

// Same branching convention as resumes/route.js: multipart upload creates/
// replaces a session, a JSON {action,data} body handles delete.
export async function POST(request) {
  const { unauthorizedResponse } = await requireAccessOrRespond();
  if (unauthorizedResponse) return unauthorizedResponse;

  const contentType = request.headers.get("content-type") || "";

  try {
    if (contentType.startsWith("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("file");
      const label = formData.get("label");

      if (!file || typeof file === "string") {
        return NextResponse.json({ error: "A session file is required." }, { status: 400 });
      }
      if (file.size > MAX_SESSION_BYTES) {
        return NextResponse.json({ error: "That file is larger than a real session export should be." }, { status: 400 });
      }

      let parsed;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        return NextResponse.json(
          { error: "That file isn't valid JSON — upload the file scripts/job-search-oracle-login.mjs saved, unmodified." },
          { status: 400 }
        );
      }

      // scripts/job-search-oracle-login.mjs saves { tenantHost, capturedAt,
      // storageState } — tenantHost is derived there from the URL the human
      // actually signed into, never re-typed by hand here, so there's no
      // chance of a mismatched host getting attached to the wrong session.
      if (!parsed?.tenantHost || !parsed?.storageState) {
        return NextResponse.json(
          { error: "That file doesn't look like a session saved by job-search-oracle-login.mjs (missing tenantHost/storageState)." },
          { status: 400 }
        );
      }

      const result = await saveOracleSession({
        tenantHost: parsed.tenantHost,
        label: label || parsed.tenantHost,
        fileName: file.name,
        storageState: parsed.storageState,
        capturedAt: parsed.capturedAt
      });

      return NextResponse.json({ ok: true, result });
    }

    const body = await request.json().catch(() => ({}));
    const action = body?.action;
    const data = body?.data || {};

    switch (action) {
      case "deleteOracleSession":
        return NextResponse.json({ ok: true, result: await deleteOracleSession(data.id) });
      default:
        return NextResponse.json({ error: "Unknown Oracle session action." }, { status: 400 });
    }
  } catch (error) {
    return jsonError(error);
  }
}
