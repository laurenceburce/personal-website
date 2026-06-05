import { createHash } from "crypto";
import { NextResponse } from "next/server";
import { recordVisit } from "../../../lib/analyticsStore";

export const runtime = "nodejs";

const visitRateLimit = new Map();
const geoCache = new Map();
const VISIT_LIMIT_MS = 60 * 1000;
const VISIT_LIMIT_MAX = 20;
const GEO_CACHE_MS = 12 * 60 * 60 * 1000;
const GEO_TIMEOUT_MS = 2500;

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
  // Cloudflare (used when Railway serves a custom domain)
  const cf = request.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();

  // Standard reverse-proxy header — take the first (client) IP
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();

  const real = request.headers.get("x-real-ip");
  if (real) return real.trim();

  return "unknown";
};

const parseDeviceType = (ua) => {
  if (!ua) return null;
  if (/iPad|Tablet/i.test(ua)) return "tablet";
  if (/Mobi|Android|iPhone|iPod|Windows Phone/i.test(ua)) return "mobile";
  return "desktop";
};

const parseBrowser = (ua) => {
  if (!ua) return null;
  if (/Edg\//i.test(ua)) return "Edge";
  if (/OPR\/|Opera\//i.test(ua)) return "Opera";
  if (/SamsungBrowser/i.test(ua)) return "Samsung";
  if (/Chrome\/[0-9]/i.test(ua) && !/Chromium/i.test(ua)) return "Chrome";
  if (/Firefox\/[0-9]/i.test(ua)) return "Firefox";
  if (/Safari\/[0-9]/i.test(ua) && !/Chrome/i.test(ua)) return "Safari";
  return "Other";
};

const cleanReferrer = (raw) => {
  if (!raw) return null;
  try {
    const host = new URL(raw).hostname.replace(/^www\./, "");
    return host.slice(0, 100) || null;
  } catch {
    return null;
  }
};

const cleanHeaderValue = (value) => {
  if (!value) return null;

  try {
    return decodeURIComponent(value).trim() || null;
  } catch {
    return value.trim() || null;
  }
};

const getHeaderGeoLocation = (request) => {
  const country = cleanHeaderValue(request.headers.get("x-vercel-ip-country"))
    || cleanHeaderValue(request.headers.get("cf-ipcountry"))
    || cleanHeaderValue(request.headers.get("x-country-code"));
  const city = cleanHeaderValue(request.headers.get("x-vercel-ip-city"))
    || cleanHeaderValue(request.headers.get("cf-ipcity"))
    || cleanHeaderValue(request.headers.get("x-city"));

  return {
    country: country && country !== "XX" ? country : null,
    city
  };
};

const fetchJsonWithTimeout = async (url) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEO_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "accept": "application/json",
        "user-agent": "laurenceburce.com analytics"
      }
    });

    if (!res.ok) return null;
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
};

const lookupGeoLocation = async (ip) => {
  if (isPrivateIp(ip)) return { country: null, city: null };

  const cached = geoCache.get(ip);
  if (cached && Date.now() - cached.cachedAt < GEO_CACHE_MS) {
    return cached.geo;
  }

  const providers = [
    {
      url: `https://ipwho.is/${ip}`,
      parse: (data) => data?.success
        ? { country: data.country || null, city: data.city || null }
        : null
    },
    {
      url: `https://ipapi.co/${ip}/json/`,
      parse: (data) => data && !data.error
        ? { country: data.country_name || data.country || null, city: data.city || null }
        : null
    },
    {
      url: `http://ip-api.com/json/${ip}?fields=status,country,city`,
      parse: (data) => data?.status === "success"
        ? { country: data.country || null, city: data.city || null }
        : null
    }
  ];

  for (const provider of providers) {
    try {
      const data = await fetchJsonWithTimeout(provider.url);
      const geo = provider.parse(data);

      if (geo?.country || geo?.city) {
        geoCache.set(ip, { geo, cachedAt: Date.now() });
        return geo;
      }
    } catch (error) {
      console.error("Analytics geolocation lookup failed", {
        host: new URL(provider.url).hostname,
        code: error?.code,
        message: error?.message
      });
    }
  }

  const emptyGeo = { country: null, city: null };
  geoCache.set(ip, { geo: emptyGeo, cachedAt: Date.now() });
  return emptyGeo;
};

export async function POST(request) {
  try {
    const allowedOrigin = process.env.NEXT_PUBLIC_SITE_URL || "";
    const origin = request.headers.get("origin") || "";
    if (allowedOrigin && origin && origin !== allowedOrigin) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const ip = extractIp(request);
    const now = Date.now();
    const entry = visitRateLimit.get(ip) ?? { count: 0, windowStart: now };
    if (now - entry.windowStart > VISIT_LIMIT_MS) {
      entry.count = 0;
      entry.windowStart = now;
    }
    entry.count++;
    visitRateLimit.set(ip, entry);
    if (entry.count > VISIT_LIMIT_MAX) {
      return NextResponse.json({ error: "Too many requests." }, { status: 429 });
    }

    const body = await request.json();
    const ua = request.headers.get("user-agent") || "";
    const headerGeo = getHeaderGeoLocation(request);
    const lookupGeo = headerGeo.country || headerGeo.city
      ? { country: null, city: null }
      : await lookupGeoLocation(ip);
    const geo = {
      country: headerGeo.country || lookupGeo.country,
      city: headerGeo.city || lookupGeo.city
    };

    const meta = {
      ipAddress: isPrivateIp(ip) ? null : ip,
      ipHash: !isPrivateIp(ip) ? hashIp(ip) : null,
      country: geo.country,
      city: geo.city,
      referrer: cleanReferrer(body?.referrer),
      deviceType: parseDeviceType(ua),
      browser: parseBrowser(ua)
    };

    const stats = await recordVisit(body?.visitorId, meta);

    return NextResponse.json(stats);
  } catch {
    return NextResponse.json(
      { error: "Unable to record analytics visit." },
      { status: 500 }
    );
  }
}
