"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";
import AuthProviderButtons from "../../components/auth/AuthProviderButtons";

const FINANCE_PROVIDERS = ["google", "github", "linkedin"];

export default function FinanceLoginClient({ callbackUrl, currentEmail, currentProvider, isSignedIn }) {
  const [status, setStatus] = useState("");

  return (
    <main className="finance-private-page">
      <section className="finance-auth-card">
        <p className="finance-kicker">Private Finance</p>
        <h1>Sign in</h1>
        <p>
          Use the owner Google, GitHub or LinkedIn account with a verified email to open the tracker.
        </p>

        {isSignedIn && currentEmail ? (
          <div className="finance-auth-note">
            <span>Signed in as</span>
            <strong>{currentEmail}</strong>
            <p>{currentProvider === "microsoft-entra-id"
              ? "For finance, choose Google, GitHub or LinkedIn below and sign in with your verified owner email."
              : "If this is your owner account, verify its email and sign in again using an option below."}</p>
            <button
              type="button"
              onClick={() => signOut({ callbackUrl: "/finance/login" })}
            >
              Sign out
            </button>
          </div>
        ) : null}

        <AuthProviderButtons
          callbackUrl={callbackUrl || "/finance"}
          allowedProviders={FINANCE_PROVIDERS}
          onStatusChange={setStatus}
          className="finance-provider-list"
        />
        {status ? <p className="finance-auth-status">{status}</p> : null}
      </section>
    </main>
  );
}
