import { readFile } from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";
import { auth } from "../../../../auth";

export const runtime = "nodejs";

const FILES = {
  resume: "Laurence-Alec-Burce-Software-Developer-Resume.pdf",
  "cover-letter": "Laurence-Alec-Burce-Cover-Letter.pdf"
};

export async function GET(_request, { params }) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const { file } = await params;
  const fileName = FILES[file];
  if (!fileName) {
    return NextResponse.json({ error: "File not found." }, { status: 404 });
  }

  const filePath = path.join(process.cwd(), "app", "documents", fileName);
  const data = await readFile(filePath);

  return new Response(data, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "private, no-store"
    }
  });
}
