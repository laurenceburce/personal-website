"use client";

import usePortfolioAnalytics from "../../hooks/usePortfolioAnalytics";

const formatCount = (value) => {
  const numberValue = Number(value);

  if (!Number.isFinite(numberValue)) return "0";

  return new Intl.NumberFormat("en-US", {
    notation: numberValue >= 10000 ? "compact" : "standard",
    maximumFractionDigits: 1
  }).format(numberValue);
};

export default function SidebarAnalytics() {
  const { stats, status } = usePortfolioAnalytics();
  const unavailable = status === "unconfigured" || status === "error";
  const disabled = status === "disabled";

  return (
    <section className="sidebar-analytics" aria-label="Visitor analytics">
      <div className="sidebar-analytics-head">
        <span className="sidebar-analytics-dot" aria-hidden="true" />
        <span>Site Traffic</span>
      </div>

      {unavailable || disabled ? (
        <p className="sidebar-analytics-note">
          {disabled ? "Tracking disabled" : "Analytics pending"}
        </p>
      ) : (
        <div className="sidebar-analytics-grid">
          <div>
            <strong>{status === "loading" ? "--" : formatCount(stats.totalVisits)}</strong>
            <span>Total</span>
          </div>
          <div>
            <strong>{status === "loading" ? "--" : formatCount(stats.uniqueVisitors)}</strong>
            <span>Unique</span>
          </div>
        </div>
      )}
    </section>
  );
}
