import { redirect } from "next/navigation";
import FinanceLoginClient from "./FinanceLoginClient";
import { getFinanceAccess } from "../../lib/financeAuth";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Finance Sign In",
  robots: {
    index: false,
    follow: false
  }
};

function cleanCallback(value) {
  if (typeof value !== "string") return "/finance";
  if (!value.startsWith("/finance")) return "/finance";
  if (value.startsWith("/finance/login")) return "/finance";
  return value;
}

export default async function FinanceLoginPage({ searchParams }) {
  const params = await searchParams;
  const callbackUrl = cleanCallback(params?.callbackUrl);
  const access = await getFinanceAccess();

  if (access.authorized) redirect(callbackUrl);

  return (
    <FinanceLoginClient
      callbackUrl={callbackUrl}
      currentEmail={access.email}
      isSignedIn={Boolean(access.session)}
    />
  );
}
