import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { requireAccessOrRespond } from "../../../../lib/jobSearchApiHelpers";
import { GMAIL_OAUTH_STATE_COOKIE, GMAIL_READONLY_SCOPE, GOOGLE_AUTH_URL, gmailRedirectUri, googleClientId } from "../../../../lib/jobSearchGmailOAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const { unauthorizedResponse } = await requireAccessOrRespond();
  if (unauthorizedResponse) return unauthorizedResponse;

  const clientId = googleClientId();
  if (!clientId) {
    return NextResponse.json({ error: "AUTH_GOOGLE_ID or JOB_SEARCH_GMAIL_CLIENT_ID is required to connect Gmail." }, { status: 503 });
  }

  const state = crypto.randomBytes(24).toString("base64url");
  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", gmailRedirectUri(request));
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", `openid email profile ${GMAIL_READONLY_SCOPE}`);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("state", state);

  const response = NextResponse.redirect(authUrl);
  response.cookies.set(GMAIL_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/job-search/gmail",
    maxAge: 10 * 60
  });
  return response;
}
