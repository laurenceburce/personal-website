import { NextResponse } from "next/server";
import { getJobSearchAccess } from "../../../../lib/jobSearchAuth";
import { appError } from "../../../../lib/jobSearchDb";
import { upsertGmailConnection } from "../../../../lib/jobSearchEmailConnectionStore";
import {
  GMAIL_OAUTH_STATE_COOKIE,
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  appOrigin,
  gmailRedirectUri,
  googleClientConfig
} from "../../../../lib/jobSearchGmailOAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function dashboardRedirect(request, params = {}) {
  const url = new URL("/job-search", appOrigin(request));
  url.searchParams.set("tab", "settings");
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, String(value).slice(0, 300));
  }
  return url;
}

async function fetchJson(url, options, errorLabel) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error_description || payload?.error?.message || payload?.error || `HTTP ${response.status}`;
    throw appError(`${errorLabel}: ${message}`, response.status >= 500 ? 502 : response.status);
  }
  return payload;
}

async function exchangeCodeForToken(request, code) {
  const { clientId, clientSecret } = googleClientConfig();
  return fetchJson(
    GOOGLE_TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: gmailRedirectUri(request)
      })
    },
    "Gmail OAuth token exchange failed"
  );
}

async function fetchGoogleUserInfo(accessToken) {
  return fetchJson(
    GOOGLE_USERINFO_URL,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    "Gmail OAuth user lookup failed"
  );
}

export async function GET(request) {
  const url = new URL(request.url);
  const response = NextResponse.redirect(dashboardRedirect(request));
  response.cookies.set(GMAIL_OAUTH_STATE_COOKIE, "", {
    path: "/api/job-search/gmail",
    maxAge: 0
  });

  try {
    const access = await getJobSearchAccess();
    if (!access.authorized) {
      response.headers.set("Location", dashboardRedirect(request, { gmail: "error", gmailError: "Job Search access is required." }).toString());
      return response;
    }

    const state = url.searchParams.get("state") || "";
    const expectedState = request.cookies.get(GMAIL_OAUTH_STATE_COOKIE)?.value || "";
    if (!state || !expectedState || state !== expectedState) {
      throw appError("Gmail connection state expired. Start the connection again.", 400);
    }

    const code = url.searchParams.get("code") || "";
    if (!code) {
      throw appError(url.searchParams.get("error_description") || url.searchParams.get("error") || "Google did not return an authorization code.", 400);
    }

    const tokenPayload = await exchangeCodeForToken(request, code);
    const refreshToken = tokenPayload.refresh_token || "";
    if (!refreshToken) {
      throw appError("Google did not return a refresh token. Try connecting Gmail again, or revoke this app's existing Google access and reconnect.", 400);
    }

    const userInfo = await fetchGoogleUserInfo(tokenPayload.access_token);
    const googleEmail = String(userInfo.email || "").trim().toLowerCase();
    const signedInEmail = String(access.email || "").trim().toLowerCase();
    if (!googleEmail) throw appError("Google did not return an email address for this Gmail connection.", 400);
    if (signedInEmail && googleEmail !== signedInEmail) {
      throw appError("Connect Gmail using the same Google account that owns the Job Search dashboard.", 403);
    }

    await upsertGmailConnection({
      email: googleEmail,
      refreshToken,
      scopes: tokenPayload.scope || ""
    });

    response.headers.set("Location", dashboardRedirect(request, { gmail: "connected" }).toString());
    return response;
  } catch (error) {
    response.headers.set("Location", dashboardRedirect(request, {
      gmail: "error",
      gmailError: error?.message || "Gmail connection failed."
    }).toString());
    return response;
  }
}
