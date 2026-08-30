import { Buffer } from "node:buffer";

function mimeTypeForFile(fileName) {
  const lower = String(fileName || "").toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".doc")) return "application/msword";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return "application/octet-stream";
}

export function resumeFilePayload(resumeBuffer, resumeFileName) {
  const name = resumeFileName || "resume.pdf";
  return {
    name,
    mimeType: mimeTypeForFile(name),
    buffer: Buffer.isBuffer(resumeBuffer) ? resumeBuffer : Buffer.from(resumeBuffer)
  };
}
