"use client";

import { useEffect, useState } from "react";
import {
  analyticsTrackingDisabled,
  getOrCreateVisitorId,
  hasTrackedSession,
  markSessionTracked
} from "../utils/analyticsClient";

const initialStats = {
  configured: true,
  totalVisits: 0,
  uniqueVisitors: 0,
  identifiedVisitors: 0
};

export default function usePortfolioAnalytics() {
  const [stats, setStats] = useState(initialStats);
  const [status, setStatus] = useState("loading");

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (window.self !== window.top) return;

      if (analyticsTrackingDisabled()) {
        setStatus("disabled");
        return;
      }

      const visitorId = getOrCreateVisitorId();
      const sessionTracked = hasTrackedSession();
      const endpoint = sessionTracked ? "/api/analytics/stats" : "/api/analytics/visit";
      const options = sessionTracked
        ? { method: "GET" }
        : {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ visitorId })
          };

      try {
        const response = await fetch(endpoint, options);
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(payload.error || "Unable to load analytics.");
        }

        if (!cancelled) {
          setStats(payload);
          setStatus(payload.configured !== false ? "ready" : "unconfigured");
        }

        if (!sessionTracked && payload.configured) {
          markSessionTracked();
        }
      } catch {
        if (!cancelled) {
          setStatus("error");
        }
      }
    };

    run();

    return () => {
      cancelled = true;
    };
  }, []);

  return {
    stats,
    status
  };
}
