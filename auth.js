import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import LinkedIn from "next-auth/providers/linkedin";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";

const providers = [];

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
  trustHost: true
});
