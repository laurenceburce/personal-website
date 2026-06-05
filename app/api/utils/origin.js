export function isAllowedOrigin(request) {
  const origin = request.headers.get("origin") || "";
  if (!origin) return true;

  const allowedOrigins = new Set();
  addOriginVariants(allowedOrigins, process.env.NEXT_PUBLIC_SITE_URL || "");
  addOriginVariants(allowedOrigins, request.url);

  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto") || "https";
  if (forwardedHost) {
    addOriginVariants(allowedOrigins, `${forwardedProto}://${forwardedHost}`);
  }

  const host = request.headers.get("host");
  if (host) {
    addOriginVariants(allowedOrigins, `https://${host}`);
    addOriginVariants(allowedOrigins, `http://${host}`);
  }

  return allowedOrigins.has(origin);
}

export function isLocalRequest(request) {
  const origin = request.headers.get("origin") || "";
  const host = request.headers.get("host") || "";

  return [origin, host].some((value) => (
    value.includes("localhost") ||
    value.includes("127.0.0.1") ||
    value.includes("[::1]")
  ));
}

function addOriginVariants(origins, value) {
  if (!value) return;

  try {
    const url = new URL(value);
    origins.add(url.origin);

    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      origins.add(`http://${url.host}`);
      origins.add(`https://${url.host}`);
    }
  } catch {}
}
