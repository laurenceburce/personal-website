"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";

const PROVIDER_LABELS = {
  google: "Google",
  github: "GitHub",
  linkedin: "LinkedIn",
  "microsoft-entra-id": "Microsoft"
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

    return () => {
      cancelled = true;
    };
  }, [onStatusChange]);

  const entries = Object.values(providers || {});

  return (
    <div className={className}>
      {entries.map((provider) => (
        <button
          key={provider.id}
          type="button"
          disabled={Boolean(signingInProvider)}
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
          {signingInProvider === provider.id
            ? "Opening sign-in..."
            : `Continue with ${PROVIDER_LABELS[provider.id] || provider.name}`}
        </button>
      ))}
    </div>
  );
}
