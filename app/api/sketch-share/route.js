import { createHash, randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { createSketchShare } from "../../lib/analyticsStore";

export const runtime = "nodejs";

const SHARE_LIMIT_MS = 60 * 1000;
const SHARE_LIMIT_MAX = 8;
const MAX_PAYLOAD_CHARS = 2_800_000;
const shareRateLimit = new Map();

const hashIp = (ip) =>
  createHash("sha256").update(ip).digest("hex").slice(0, 16);

const isPrivateIp = (ip) => {
  if (!ip || ip === "unknown") return true;
  if (ip === "127.0.0.1" || ip === "localhost" || ip === "::1") return true;
  if (ip.startsWith("::")) return true;
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)) return true;
  return false;
};

const extractIp = (request) => {
  const cf = request.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();

  const real = request.headers.get("x-real-ip");
  if (real) return real.trim();

  return "unknown";
};

const createShareId = () => randomBytes(9).toString("base64url");

const normalizeOrigin = (value) => {
  if (!value) return "";

  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return "";
  }
};

const addOriginVariants = (origins, origin) => {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return;

  origins.add(normalized);

  const url = new URL(normalized);
  if (url.hostname.startsWith("www.")) {
    url.hostname = url.hostname.slice(4);
    origins.add(`${url.protocol}//${url.host}`.toLowerCase());
  } else {
    url.hostname = `www.${url.hostname}`;
    origins.add(`${url.protocol}//${url.host}`.toLowerCase());
  }
};

const isAllowedOrigin = (request) => {
  const origin = normalizeOrigin(request.headers.get("origin") || "");
  if (!origin) return true;

  const allowedOrigins = new Set();
  addOriginVariants(allowedOrigins, process.env.NEXT_PUBLIC_SITE_URL || "");
  addOriginVariants(allowedOrigins, request.url);

  const forwardedHost = request.headers.get("x-forwarded-host") || "";
  const forwardedProto = request.headers.get("x-forwarded-proto") || "https";
  if (forwardedHost) {
    addOriginVariants(allowedOrigins, `${forwardedProto}://${forwardedHost}`);
  }

  const host = request.headers.get("host") || "";
  if (host) {
    addOriginVariants(allowedOrigins, `https://${host}`);
    addOriginVariants(allowedOrigins, `http://${host}`);
  }

  return allowedOrigins.has(origin);
};

const isValidMarkup = (markup) => (
  markup &&
  markup.version === 1 &&
  typeof markup.canvasDataUrl === "string" &&
  markup.canvasDataUrl.startsWith("data:image/png;base64,") &&
  Number.isFinite(markup.canvasWidth) &&
  Number.isFinite(markup.canvasHeight) &&
  Number.isFinite(markup.cssWidth) &&
  Number.isFinite(markup.cssHeight) &&
  Array.isArray(markup.stickers)
);

export async function POST(request) {
  try {
    if (!isAllowedOrigin(request)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const ip = extractIp(request);
    const now = Date.now();
    const entry = shareRateLimit.get(ip) ?? { count: 0, windowStart: now };
    if (now - entry.windowStart > SHARE_LIMIT_MS) {
      entry.count = 0;
      entry.windowStart = now;
    }
    entry.count++;
    shareRateLimit.set(ip, entry);
    if (entry.count > SHARE_LIMIT_MAX) {
      return NextResponse.json({ error: "Too many requests." }, { status: 429 });
    }

    const body = await request.json();
    const payloadText = JSON.stringify(body?.markup ?? {});
    if (payloadText.length > MAX_PAYLOAD_CHARS) {
      return NextResponse.json({ error: "Markup is too large to share." }, { status: 413 });
    }

    if (!isValidMarkup(body?.markup)) {
      return NextResponse.json({ error: "Invalid markup." }, { status: 400 });
    }

    const publicIp = isPrivateIp(ip) ? null : ip;
    const result = await createSketchShare({
      shareId: createShareId(),
      visitorId: body?.visitorId,
      ipAddress: publicIp,
      ipHash: publicIp ? hashIp(publicIp) : null,
      payload: body.markup
    });

    if (!result) {
      return NextResponse.json({ error: "Unable to create share link." }, { status: 503 });
    }

    return NextResponse.json(result);
  } catch {
    return NextResponse.json(
      { error: "Unable to create share link." },
      { status: 500 }
    );
  }
}
