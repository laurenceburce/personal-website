"use client";

import { useEffect } from "react";
import { getSession } from "next-auth/react";
import { identifyAnalyticsVisitor } from "../../utils/analyticsClient";

export default function AuthSessionTracker() {
  useEffect(() => {
    let cancelled = false;

    const identifySession = async () => {
      const session = await getSession();
      if (cancelled || !session?.user?.email) return;

      await identifyAnalyticsVisitor({
        email: session.user.email,
        name: session.user.name || "",
        authProvider: session.user.provider || "",
        profileImage: session.user.image || ""
      }).catch(() => {});
    };

    identifySession();

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
