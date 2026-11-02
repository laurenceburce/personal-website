import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getFinanceAccess } from "../../../lib/financeAuth";
import {
  FINANCE_BRANKAS_STATE_COOKIE,
  saveBrankasCallback,
} from "../../../lib/financeStore";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Brankas Callback",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function BrankasCallbackPage({ searchParams }) {
  const params = await searchParams;
  const access = await getFinanceAccess();

  if (!access.session) {
    const query = new URLSearchParams();
    for (const key of [
      "code",
      "consent_id",
      "customer_id",
      "request_id",
      "reference_id",
      "state",
      "institution_name",
      "bank_name",
      "error",
    ]) {
      if (typeof params?.[key] === "string")
        query.set(key, params[key].slice(0, 1000));
    }
    redirect(
      `/finance/login?callbackUrl=${encodeURIComponent(`/finance/brankas/callback?${query}`)}`,
    );
  }

  if (!access.authorized) {
    return (
      <main className="finance-private-page">
        <section className="finance-auth-card">
          <p className="finance-kicker">Private Finance</p>
          <h1>Access restricted</h1>
          <p>This tracker is only available to the owner account.</p>
          <a href="/finance/login" className="finance-link-button">
            Use another account
          </a>
        </section>
      </main>
    );
  }

  const error = typeof params?.error === "string" ? params.error : "";
  let saveResult = null;
  let saveError = "";

  if (!error) {
    try {
      const cookieStore = await cookies();
      saveResult = await saveBrankasCallback(
        params,
        cookieStore.get(FINANCE_BRANKAS_STATE_COOKIE)?.value || "",
      );
    } catch (err) {
      saveError = err?.status
        ? err.message
        : "The authorization could not be saved. Please return to Accounts and try again.";
    }
  }

  return (
    <main className="finance-private-page">
      <section className="finance-auth-card">
        <p className="finance-kicker">Brankas</p>
        <h1>
          {saveResult
            ? "Connection saved"
            : error
              ? "Connection paused"
              : "Returned to Finance"}
        </h1>
        {error ? (
          <p>Brankas returned an error: {error}</p>
        ) : saveResult ? (
          <p>
            Brankas authorization was saved. Balance and transaction sync can be
            mapped once your Brankas Data/Statement endpoints are available.
          </p>
        ) : saveError ? (
          <p>
            Brankas returned a callback, but the app could not save it yet:{" "}
            {saveError}
          </p>
        ) : (
          <p>No Brankas callback payload was returned.</p>
        )}
        <a href="/finance?tab=accounts" className="finance-link-button">
          Back to accounts
        </a>
      </section>
    </main>
  );
}
