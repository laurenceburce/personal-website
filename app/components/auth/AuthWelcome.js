"use client";

import { useEffect, useRef, useState } from "react";
import AuthProviderButtons from "./AuthProviderButtons";
import { consumeAuthModalCallback } from "../../utils/authModal";

const DEFAULT_TITLE = "Welcome";
const DEFAULT_MESSAGE =
  "Sign in to unlock downloads, chat, and contact features. You can still browse the portfolio without signing in.";

export default function AuthWelcome() {
  const [visible, setVisible] = useState(false);
  const [config, setConfig] = useState({});
  const [status, setStatus] = useState("");
  const callbackIdRef = useRef(null);

  // Respond to programmatic openAuthModal() calls
  useEffect(() => {
    const handler = (e) => {
      const detail = e.detail || {};
      callbackIdRef.current = detail.callbackId ?? null;
      setConfig({ title: detail.title, message: detail.message });
      setStatus("");
      setVisible(true);
    };
    window.addEventListener("open-auth-modal", handler);
    return () => window.removeEventListener("open-auth-modal", handler);
  }, []);

  const dismiss = () => {
    setVisible(false);
    setStatus("");
  };

  const handleBeforeSignIn = () => {
    const cb = consumeAuthModalCallback(callbackIdRef.current);
    cb?.();
  };

  if (!visible) return null;

  const title = config.title || DEFAULT_TITLE;
  const message = config.message || DEFAULT_MESSAGE;
  const isWelcome = !config.title;

  return (
    <div className="auth-welcome" role="dialog" aria-modal="true" aria-labelledby="auth-welcome-title">
      <button
        className="auth-welcome-backdrop"
        type="button"
        aria-label="Close"
        onClick={dismiss}
      />
      <div className="auth-welcome-panel">
        <div className="auth-welcome-head">
          <p id="auth-welcome-title">{title}</p>
          <button type="button" onClick={dismiss} aria-label="Close">
            x
          </button>
        </div>
        <p className="auth-welcome-copy">{message}</p>
        <AuthProviderButtons
          callbackUrl={typeof window !== "undefined" ? window.location.href : "/"}
          onBeforeSignIn={handleBeforeSignIn}
          onStatusChange={setStatus}
        />
        {status ? <p className="auth-gate-status">{status}</p> : null}
        {isWelcome && (
          <button className="auth-welcome-skip" type="button" onClick={dismiss}>
            Continue without signing in
          </button>
        )}
      </div>
    </div>
  );
}
