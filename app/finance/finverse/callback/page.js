import { redirect } from "next/navigation";
import { getFinanceAccess } from "../../../lib/financeAuth";
import { exchangeFinverseAuthorizationCode } from "../../../lib/financeStore";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Finverse Callback",
  robots: {
    index: false,
    follow: false
  }
};

export default async function FinverseCallbackPage({ searchParams }) {
  const params = await searchParams;
  const access = await getFinanceAccess();

  if (!access.session) {
    redirect(`/finance/login?callbackUrl=${encodeURIComponent("/finance/finverse/callback")}`);
  }

  if (!access.authorized) {
    return (
      <main className="finance-private-page">
        <section className="finance-auth-card">
          <p className="finance-kicker">Private Finance</p>
          <h1>Access restricted</h1>
          <p>This tracker is only available to the owner account.</p>
          <a href="/finance/login" className="finance-link-button">Use another account</a>
        </section>
      </main>
    );
  }

  const code = typeof params?.code === "string" ? params.code : "";
  const error = typeof params?.error === "string" ? params.error : "";
  let exchangeResult = null;
  let exchangeError = "";

  if (code && !error) {
    try {
      exchangeResult = await exchangeFinverseAuthorizationCode(code);
    } catch (err) {
      exchangeError = err.message || "Finverse token exchange failed.";
    }
  }

  return (
    <main className="finance-private-page">
      <section className="finance-auth-card">
        <p className="finance-kicker">Finverse</p>
        <h1>{exchangeResult ? "Connection saved" : error ? "Connection paused" : "Returned to Finance"}</h1>
        {error ? (
          <p>Finverse returned an error: {error}</p>
        ) : exchangeResult ? (
          <p>Finverse authorization was saved. Balance and transaction sync can be mapped once your Finverse data endpoints are available.</p>
        ) : exchangeError ? (
          <p>Finverse returned a code, but the app could not exchange it yet: {exchangeError}</p>
        ) : code ? (
          <p>
            Finverse returned an authorization code. The app is ready for the next step once your
            Finverse token and data endpoints are configured.
          </p>
        ) : (
          <p>No authorization code was returned.</p>
        )}
        <a href="/finance?tab=profile" className="finance-link-button">Back to profile</a>
      </section>
    </main>
  );
}
