import { appError } from "./jobSearchDb.js";

export const GMAIL_OAUTH_STATE_COOKIE = "job_search_gmail_oauth_state";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export function appOrigin(request) {
  const configured = process.env.NEXTAUTH_URL || process.env.AUTH_URL || "";
  if (configured) return configured.startsWith("http") ? configured : `https://${configured}`;
  return new URL(request.url).origin;
}

export function gmailRedirectUri(request) {
  return `${appOrigin(request).replace(/\/+$/, "")}/api/job-search/gmail/callback`;
}

export function googleClientId() {
  return process.env.JOB_SEARCH_GMAIL_CLIENT_ID || process.env.AUTH_GOOGLE_ID || "";
}

export function googleClientConfig() {
  const clientId = googleClientId();
  const clientSecret = process.env.JOB_SEARCH_GMAIL_CLIENT_SECRET || process.env.AUTH_GOOGLE_SECRET || "";
  if (!clientId || !clientSecret) {
    throw appError("AUTH_GOOGLE_ID/AUTH_GOOGLE_SECRET or JOB_SEARCH_GMAIL_CLIENT_ID/JOB_SEARCH_GMAIL_CLIENT_SECRET is required to connect Gmail.", 503);
  }
  return { clientId, clientSecret };
}
