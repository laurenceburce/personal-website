import { NextResponse } from "next/server";

const SESSION_COOKIE = "admin_session";

async function deriveSessionToken(adminToken) {
  const encoder = new TextEncoder();
  const data = encoder.encode(adminToken + ":admin-session");
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function middleware(request) {
  const { pathname } = request.nextUrl;

  // Let the login page through unconditionally
  if (pathname === "/admin/login") return NextResponse.next();

  const adminToken = process.env.ANALYTICS_ADMIN_TOKEN;

  // If no token is configured, block access entirely
  if (!adminToken) {
    return new NextResponse("Analytics admin token not configured.", { status: 503 });
  }

  const sessionCookie = request.cookies.get(SESSION_COOKIE)?.value ?? "";
  const expected = await deriveSessionToken(adminToken);

  if (sessionCookie !== expected) {
    const loginUrl = new URL("/admin/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*"]
};
