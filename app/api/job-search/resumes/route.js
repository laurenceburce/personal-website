import { NextResponse } from "next/server";
import { jsonError, requireAccessOrRespond } from "../../../lib/jobSearchApiHelpers";
import { extractPdfText } from "../../../lib/jobSearchResumeParser";
import { createResume, deleteResume, setDefaultResume } from "../../../lib/jobSearchSettingsStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_RESUME_BYTES = 8 * 1024 * 1024;

// This route branches on content-type: a multipart upload creates a new resume,
// a JSON body dispatches {action,data} for setDefault/delete — matching the
// repo's {action,data} convention wherever the payload is plain JSON.
export async function POST(request) {
  const { unauthorizedResponse } = await requireAccessOrRespond();
  if (unauthorizedResponse) return unauthorizedResponse;

  const contentType = request.headers.get("content-type") || "";

  try {
    if (contentType.startsWith("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("file");
      const label = formData.get("label");
      const makeDefault = formData.get("makeDefault") === "true";

      if (!file || typeof file === "string") {
        return NextResponse.json({ error: "A resume file is required." }, { status: 400 });
      }
      if (file.size > MAX_RESUME_BYTES) {
        return NextResponse.json({ error: "Resume file is too large (max 8MB)." }, { status: 400 });
      }

      const fileBuffer = Buffer.from(await file.arrayBuffer());
      const isPdf = (file.type || "").includes("pdf") || (file.name || "").toLowerCase().endsWith(".pdf");
      // Only PDF gets automatic text extraction for now — other formats are
      // still stored (and usable by the Playwright file-upload step later) but
      // won't feed the resume-match embedding or LLM scoring context.
      const parsedText = isPdf ? await extractPdfText(fileBuffer) : "";

      const result = await createResume({
        label: label || file.name,
        fileName: file.name,
        mimeType: file.type || "application/pdf",
        fileBuffer,
        parsedText,
        makeDefault
      });

      return NextResponse.json({ ok: true, result });
    }

    const body = await request.json().catch(() => ({}));
    const action = body?.action;
    const data = body?.data || {};

    switch (action) {
      case "setDefaultResume":
        return NextResponse.json({ ok: true, result: await setDefaultResume(data.id) });
      case "deleteResume":
        return NextResponse.json({ ok: true, result: await deleteResume(data.id) });
      default:
        return NextResponse.json({ error: "Unknown resume action." }, { status: 400 });
    }
  } catch (error) {
    return jsonError(error);
  }
}
