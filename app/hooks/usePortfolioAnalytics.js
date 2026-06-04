"use client";

import { useEffect, useState } from "react";
import {
  analyticsTrackingDisabled,
  getOrCreateVisitorId,
  hasTrackedSession,
  markSessionTracked,
  trackAnalyticsEvent
} from "../utils/analyticsClient";

const initialStats = {
  configured: true,
  totalVisits: 0,
  uniqueVisitors: 0,
  identifiedVisitors: 0,
  topCountries: [],
  topReferrers: [],
  deviceBreakdown: [],
  browserBreakdown: [],
  topDownloads: [],
  avgTimeOnPageSeconds: null
};

export default function usePortfolioAnalytics() {
  const [stats, setStats] = useState(initialStats);
  const [status, setStatus] = useState("loading");

  // Track visit and fetch stats
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
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              visitorId,
              referrer: document.referrer || ""
            })
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

  // Track time on page — fires on tab hide or page unload
  useEffect(() => {
    if (analyticsTrackingDisabled()) return;

    const startTime = Date.now();

    const sendTime = () => {
      const seconds = Math.round((Date.now() - startTime) / 1000);
      if (seconds >= 5) {
        trackAnalyticsEvent("time_on_page", String(seconds));
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") sendTime();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", sendTime);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", sendTime);
    };
  }, []);

  return { stats, status };
}
