const normalizeEmail = (value) => typeof value === "string" ? value.trim().toLowerCase() : "";

/** A signed older Google/GitHub session keeps its existing access until re-login. */
export function hasFinanceEmailProof(user) {
  if (user?.financeEmailVerified !== undefined) return user.financeEmailVerified === true;
  return ["google", "github"].includes(user?.provider);
}

/** Verify new sign-ins without treating a mutable identity-provider email as proof. */
export async function verifyFinanceEmail({ account, profile, email }, fetcher = globalThis.fetch) {
  const address = normalizeEmail(email);
  if (!address) return false;
  if (["google", "linkedin"].includes(account?.provider))
    return profile?.email_verified === true && normalizeEmail(profile.email) === address;
  if (account?.provider !== "github" || typeof account.access_token !== "string" || !account.access_token)
    return false;
  try {
    const response = await fetcher("https://api.github.com/user/emails", {
      headers: { Authorization: `Bearer ${account.access_token}`, Accept: "application/vnd.github+json",
        "User-Agent": "personal-website-finance" },
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return false;
    const emails = await response.json();
    return Array.isArray(emails) && emails.some((item) => item?.verified === true && normalizeEmail(item.email) === address);
  } catch {
    return false;
  }
}
