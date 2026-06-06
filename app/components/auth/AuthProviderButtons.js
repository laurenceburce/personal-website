"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";

const PROVIDER_LABELS = {
  google: "Google",
  github: "GitHub",
  linkedin: "LinkedIn",
  "microsoft-entra-id": "Microsoft"
};

const PROVIDER_ICONS = {
  google: (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="22" height="22" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.3 9 3.4l6.7-6.7C35.7 2.5 30.2 0 24 0 14.7 0 6.7 5.5 2.9 13.4l7.8 6C12.4 13 17.8 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4 6.9-10 6.9-17z"/>
      <path fill="#FBBC05" d="M10.7 28.7A14.8 14.8 0 0 1 9.5 24c0-1.7.3-3.3.8-4.8l-7.8-6A23.9 23.9 0 0 0 0 24c0 3.9.9 7.5 2.5 10.8l8.2-6.1z"/>
      <path fill="#34A853" d="M24 48c6.2 0 11.4-2 15.2-5.5l-7.5-5.8c-2 1.4-4.6 2.3-7.7 2.3-6.2 0-11.4-4.2-13.3-9.9l-8.2 6.1C6.8 42.6 14.7 48 24 48z"/>
    </svg>
  ),
  github: (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.2 11.37.6.1.82-.26.82-.58v-2.03c-3.34.72-4.04-1.6-4.04-1.6-.55-1.4-1.34-1.77-1.34-1.77-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.5 1 .1-.78.42-1.3.76-1.6-2.66-.3-5.47-1.33-5.47-5.93 0-1.3.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.28-1.55 3.28-1.23 3.28-1.23.66 1.66.25 2.88.12 3.18.77.84 1.23 1.9 1.23 3.22 0 4.61-2.8 5.63-5.48 5.92.43.37.81 1.1.81 2.22v3.3c0 .32.22.7.83.58C20.57 21.8 24 17.3 24 12 24 5.37 18.63 0 12 0z"/>
    </svg>
  ),
  linkedin: (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path fill="#0A66C2" d="M20.45 20.45h-3.56v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.13 1.45-2.13 2.94v5.67H9.35V9h3.41v1.56h.05a3.74 3.74 0 0 1 3.37-1.85c3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.07 2.07 0 1 1 0-4.13 2.07 2.07 0 0 1 0 4.13zM7.12 20.45H3.55V9h3.57v11.45zM22.23 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.46C23.2 24 24 23.23 24 22.27V1.73C24 .77 23.2 0 22.23 0z"/>
    </svg>
  ),
  "microsoft-entra-id": (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21" width="22" height="22" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
      <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
      <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
    </svg>
  )
};

export default function AuthProviderButtons({
  callbackUrl,
  onBeforeSignIn,
  onSignInError,
  onStatusChange,
  className = "auth-provider-list"
}) {
  const [providers, setProviders] = useState(null);
  const [signingInProvider, setSigningInProvider] = useState("");

  useEffect(() => {
    let cancelled = false;

    const loadProviders = async () => {
      onStatusChange?.("Loading sign-in options...");

      try {
        const response = await fetch("/api/auth/providers", { cache: "no-store" });
        const payload = response.ok ? await response.json() : {};
        if (cancelled) return;

        setProviders(payload);
        onStatusChange?.(
          Object.keys(payload).length === 0
            ? "OAuth sign-in is not configured yet."
            : ""
        );
      } catch {
        if (cancelled) return;
        setProviders({});
        onStatusChange?.("Unable to load sign-in options.");
      }
    };

    loadProviders();
    return () => { cancelled = true; };
  }, [onStatusChange]);

  const entries = Object.values(providers || {});

  return (
    <div className={className}>
      {entries.map((provider) => {
        const label = PROVIDER_LABELS[provider.id] || provider.name;
        return (
          <button
            key={provider.id}
            type="button"
            disabled={Boolean(signingInProvider)}
            aria-label={
              signingInProvider === provider.id
                ? `Opening ${label} sign-in…`
                : `Sign in with ${label}`
            }
            title={`Sign in with ${label}`}
            className={signingInProvider === provider.id ? "auth-provider-btn auth-provider-btn--loading" : "auth-provider-btn"}
            onClick={async () => {
              setSigningInProvider(provider.id);
              onBeforeSignIn?.(provider.id);

              try {
                await signIn(provider.id, {
                  callbackUrl: callbackUrl || window.location.href
                });
              } catch {
                setSigningInProvider("");
                onSignInError?.(provider.id);
                onStatusChange?.("Unable to start sign-in. Please try again.");
              }
            }}
          >
            {PROVIDER_ICONS[provider.id] ?? <span>{label[0]}</span>}
          </button>
        );
      })}
    </div>
  );
}
