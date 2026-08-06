import { redirect } from "next/navigation";
import { getFinanceAccess } from "../../../lib/financeAuth";
import { saveBrankasCallback } from "../../../lib/financeStore";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Brankas Callback",
  robots: {
    index: false,
    follow: false
  }
};

export default async function BrankasCallbackPage({ searchParams }) {
  const params = await searchParams;
  const access = await getFinanceAccess();

  if (!access.session) {
    redirect(`/finance/login?callbackUrl=${encodeURIComponent("/finance/brankas/callback")}`);
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

  const error = typeof params?.error === "string" ? params.error : "";
  let saveResult = null;
  let saveError = "";

  if (!error) {
    try {
      saveResult = await saveBrankasCallback(params);
    } catch (err) {
      saveError = err.message || "Brankas callback save failed.";
    }
  }

  return (
    <main className="finance-private-page">
      <section className="finance-auth-card">
        <p className="finance-kicker">Brankas</p>
        <h1>{saveResult ? "Connection saved" : error ? "Connection paused" : "Returned to Finance"}</h1>
        {error ? (
          <p>Brankas returned an error: {error}</p>
        ) : saveResult ? (
          <p>Brankas authorization was saved. Balance and transaction sync can be mapped once your Brankas Data/Statement endpoints are available.</p>
        ) : saveError ? (
          <p>Brankas returned a callback, but the app could not save it yet: {saveError}</p>
        ) : (
          <p>No Brankas callback payload was returned.</p>
        )}
        <a href="/finance?tab=profile" className="finance-link-button">Back to profile</a>
      </section>
    </main>
  );
}
