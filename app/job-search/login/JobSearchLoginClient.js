"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";
import AuthProviderButtons from "../../components/auth/AuthProviderButtons";

export default function JobSearchLoginClient({ callbackUrl, currentEmail, isSignedIn }) {
  const [status, setStatus] = useState("");

  return (
    <main className="job-search-private-page">
      <section className="job-search-auth-card">
        <p className="job-search-kicker">Job Search</p>
        <h1>Sign in</h1>
        <p>
          Use the owner account to open the job search dashboard.
        </p>

        {isSignedIn && currentEmail ? (
          <div className="job-search-auth-note">
            <span>Signed in as</span>
            <strong>{currentEmail}</strong>
            <button
              type="button"
              onClick={() => signOut({ callbackUrl: "/job-search/login" })}
            >
              Sign out
            </button>
          </div>
        ) : null}

        <AuthProviderButtons
          callbackUrl={callbackUrl || "/job-search"}
          onStatusChange={setStatus}
          className="job-search-provider-list"
        />
        {status ? <p className="job-search-auth-status">{status}</p> : null}
      </section>
    </main>
  );
}
