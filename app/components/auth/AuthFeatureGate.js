"use client";

import { useEffect, useState } from "react";
import { getSession } from "next-auth/react";
import { openAuthModal } from "../../utils/authModal";

export default function AuthFeatureGate({
  title = "Sign In Required",
  message = "Sign in to use this feature.",
  className = "auth-feature-gate",
  children
}) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const checkSession = async () => {
      try {
        const session = await getSession();
        if (!cancelled) setIsAuthenticated(Boolean(session?.user?.email));
      } finally {
        if (!cancelled) setIsChecking(false);
      }
    };

    checkSession();
    return () => { cancelled = true; };
  }, []);

  if (isChecking) {
    return (
      <div className={className}>
        <p className="auth-gate-status">Checking sign-in...</p>
      </div>
    );
  }

  if (isAuthenticated) return children;

  return (
    <div className={className}>
      <p className="auth-feature-title">{title}</p>
      <p className="auth-feature-copy">{message}</p>
      <button
        type="button"
        className="auth-feature-signin-btn"
        onClick={() => openAuthModal({ title, message })}
      >
        Sign In
      </button>
    </div>
  );
}
