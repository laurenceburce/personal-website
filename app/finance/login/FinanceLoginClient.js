"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";
import AuthProviderButtons from "../../components/auth/AuthProviderButtons";

export default function FinanceLoginClient({ callbackUrl, currentEmail, isSignedIn }) {
  const [status, setStatus] = useState("");

  return (
    <main className="finance-private-page">
      <section className="finance-auth-card">
        <p className="finance-kicker">Private Finance</p>
        <h1>Sign in</h1>
        <p>
          Use the owner account to open the tracker.
        </p>

        {isSignedIn && currentEmail ? (
          <div className="finance-auth-note">
            <span>Signed in as</span>
            <strong>{currentEmail}</strong>
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
          onStatusChange={setStatus}
          className="finance-provider-list"
        />
        {status ? <p className="finance-auth-status">{status}</p> : null}
      </section>
    </main>
  );
}
