import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  // pdf-parse (job-search resume text extraction) wraps pdfjs-dist, which resolves
  // its worker script via a dynamic path at runtime — bundling it through
  // Turbopack/webpack breaks that resolution ("Cannot find module .../pdf.worker.mjs").
  // Excluding it from bundling loads it via native require() instead, which works.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist"],
  // serverExternalPackages only keeps webpack/turbopack from bundling these —
  // it does NOT guarantee the separate standalone-output file trace copies
  // everything they need at runtime. Confirmed live: the traced
  // .next/standalone/node_modules/pdf-parse was missing its entire `worker`
  // directory (pdf-parse v2's class-based API spawns a worker thread to do
  // the actual parsing) and pdfjs-dist was missing cmaps/standard_fonts/wasm
  // — none of that is visible to static import analysis, only to pdf-parse's
  // own runtime logic. The result wasn't a crash: extractPdfText()'s own
  // try/catch swallowed whatever pdf-parse threw and returned "", so every
  // resume uploaded in production silently got zero parsed text — no
  // resume-match ranking, no resume context for the LLM rubric, and no
  // visible error anywhere in the UI. Forcing the full package directories
  // into the trace fixes it at the source.
  outputFileTracingIncludes: {
    "/**": ["./node_modules/pdf-parse/**/*", "./node_modules/pdfjs-dist/**/*"]
  },
  turbopack: {
    root: __dirname
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.plaid.com",
              "style-src 'self' 'unsafe-inline'",
              // blob: added for the Job Search live-CAPTCHA relay
              // (LiveCaptchaModal.js polls a live frame every ~500ms via
              // URL.createObjectURL — a data: URI would work under the
              // existing policy too, but re-base64-encoding a JPEG on every
              // poll is wasteful when the browser can just stream the bytes).
              "img-src 'self' data: blob: https://*.plaid.com",
              "font-src 'self'",
              "connect-src 'self' https://*.plaid.com",
              "frame-src 'self' https://*.plaid.com"
            ].join("; ")
          },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }
        ]
      }
    ];
  }
};

export default nextConfig;
