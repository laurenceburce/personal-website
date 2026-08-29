import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import LinkedIn from "next-auth/providers/linkedin";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";

const providers = [];
const DEFAULT_FINANCE_EMAIL = "laurenceburce@gmail.com";
const DEFAULT_JOB_SEARCH_EMAIL = "laurenceburce@gmail.com";

export function getFinanceAllowedEmails() {
  return (process.env.FINANCE_ALLOWED_EMAILS || DEFAULT_FINANCE_EMAIL)
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function isFinanceAuthorizedEmail(email) {
  return getFinanceAllowedEmails().includes(String(email || "").trim().toLowerCase());
}

export function getJobSearchAllowedEmails() {
  return (process.env.JOB_SEARCH_ALLOWED_EMAILS || DEFAULT_JOB_SEARCH_EMAIL)
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function isJobSearchAuthorizedEmail(email) {
  return getJobSearchAllowedEmails().includes(String(email || "").trim().toLowerCase());
}

if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
  providers.push(Google({
    clientId: process.env.AUTH_GOOGLE_ID,
    clientSecret: process.env.AUTH_GOOGLE_SECRET
  }));
}

if (process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET) {
  providers.push(GitHub({
    clientId: process.env.AUTH_GITHUB_ID,
    clientSecret: process.env.AUTH_GITHUB_SECRET
  }));
}

if (process.env.AUTH_LINKEDIN_ID && process.env.AUTH_LINKEDIN_SECRET) {
  providers.push(LinkedIn({
    clientId: process.env.AUTH_LINKEDIN_ID,
    clientSecret: process.env.AUTH_LINKEDIN_SECRET
  }));
}

if (process.env.AUTH_MICROSOFT_ENTRA_ID_ID && process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET) {
  providers.push(MicrosoftEntraID({
    clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID,
    clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
    issuer: process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER || undefined
  }));
}

export const { handlers: { GET, POST }, auth } = NextAuth({
  providers,
  secret: process.env.AUTH_SECRET || (
    process.env.NODE_ENV === "production" ? undefined : "local-development-download-gate-secret"
  ),
  session: {
    strategy: "jwt"
  },
  callbacks: {
    async jwt({ token, account }) {
      if (account?.provider) {
        token.provider = account.provider;
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.provider = token.provider || "";
        session.user.isFinanceAuthorized = isFinanceAuthorizedEmail(session.user.email);
        session.user.isJobSearchAuthorized = isJobSearchAuthorizedEmail(session.user.email);
      }

      return session;
    }
  },
  trustHost: true
});
