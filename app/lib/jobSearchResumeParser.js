import { PDFParse } from "pdf-parse";

// pdf-parse v2's API is class-based (new PDFParse({data}).getText()), a rewrite
// from the older v1 function-call API — isolated here so the rest of the app
// doesn't need to know pdf-parse's shape.
export async function extractPdfText(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return "";

  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return String(result?.text || "").trim();
  } catch (error) {
    console.error("[jobSearchResumeParser] PDF text extraction failed:", error?.message || error);
    return "";
  } finally {
    await parser.destroy();
  }
}
