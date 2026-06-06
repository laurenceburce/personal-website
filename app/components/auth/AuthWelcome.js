"use client";

import { useEffect, useState } from "react";
import { getSession } from "next-auth/react";
import AuthProviderButtons from "./AuthProviderButtons";

const WELCOME_DISMISSED_KEY = "portfolio-auth-welcome-dismissed-v1";

export default function AuthWelcome() {
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    let cancelled = false;

    const checkWelcome = async () => {
      try {
        if (window.localStorage.getItem(WELCOME_DISMISSED_KEY) === "true") return;

        const session = await getSession();
        if (!cancelled && !session?.user?.email) {
          setVisible(true);
        }
      } catch {
        if (!cancelled) setVisible(true);
      }
    };

    checkWelcome();

    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = () => {
    try {
      window.localStorage.setItem(WELCOME_DISMISSED_KEY, "true");
    } catch {}
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div className="auth-welcome" role="dialog" aria-modal="true" aria-labelledby="auth-welcome-title">
      <button
        className="auth-welcome-backdrop"
        type="button"
        aria-label="Continue without signing in"
        onClick={dismiss}
      />
      <div className="auth-welcome-panel">
        <div className="auth-welcome-head">
          <p id="auth-welcome-title">Welcome</p>
          <button type="button" onClick={dismiss} aria-label="Close welcome dialog">
            x
          </button>
        </div>
        <p className="auth-welcome-copy">
          Sign in to unlock downloads, chat, and contact features. You can still browse the portfolio without signing in.
        </p>
        <AuthProviderButtons
          callbackUrl={typeof window !== "undefined" ? window.location.href : "/"}
          onBeforeSignIn={() => {
            try {
              window.localStorage.setItem(WELCOME_DISMISSED_KEY, "true");
            } catch {}
          }}
          onStatusChange={setStatus}
        />
        {status ? <p className="auth-gate-status">{status}</p> : null}
        <button className="auth-welcome-skip" type="button" onClick={dismiss}>
          Continue without signing in
        </button>
      </div>
    </div>
  );
}
