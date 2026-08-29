"use client";

import { Badge, Metric } from "./JobSearchUi";

// Displayed in pipeline order, not alphabetical, so the flow reads left-to-right
// the same way a posting actually moves through it.
const STATUS_ORDER = [
  { key: "new", label: "New (unprocessed)" },
  { key: "filtered_out", label: "Filtered out" },
  { key: "below_threshold", label: "Below match threshold" },
  { key: "scored_low", label: "Scored low" },
  { key: "pending_review", label: "Pending review" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "submitted", label: "Submitted" },
  { key: "failed", label: "Failed" },
  { key: "needs_manual_review", label: "Needs manual review" },
  { key: "unsupported_ats", label: "Unsupported ATS" },
  { key: "closed", label: "Closed / delisted" }
];

function statusTone(status) {
  if (["submitted", "approved", "pending_review"].includes(status)) return "success";
  if (["failed", "rejected"].includes(status)) return "danger";
  if (["needs_manual_review", "scored_low", "below_threshold"].includes(status)) return "warn";
  return "neutral";
}

function timeAgo(value) {
  if (!value) return "—";
  const ms = Date.now() - new Date(value).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function mostRecentPollTime(watchlist) {
  const times = watchlist.map((w) => w.lastPolledAt).filter(Boolean).map((t) => new Date(t).getTime());
  return times.length ? new Date(Math.max(...times)) : null;
}

export default function OverviewPanel({ watchlist, statusCounts, recentActivity, llmUsage, maxLlmCallsPerDay, dbSizeMb }) {
  const activeCompanies = watchlist.filter((w) => w.isActive).length;
  const erroredCompanies = watchlist.filter((w) => w.lastPollStatus === "error").length;
  const lastPoll = mostRecentPollTime(watchlist);
  const totalPostings = Object.values(statusCounts || {}).reduce((sum, n) => sum + n, 0);
  const usagePct = llmUsage?.totalCalls != null ? llmUsage.totalCalls : 0;

  const nothingHasRunYet = watchlist.length === 0 && totalPostings === 0;

  return (
    <>
      <section className="job-search-panel">
        <header className="job-search-panel-header">
          <h2>System Status</h2>
        </header>

        {nothingHasRunYet ? (
          <p className="job-search-empty">
            Nothing has run yet — the watchlist is empty and no poll has ever completed. Add at least
            one company in the Watchlist tab, then either wait for the scheduled Railway cron service
            or trigger <code>scripts/job-search-worker.mjs</code> manually to see real activity here.
          </p>
        ) : null}

        <div className="job-search-field-grid">
          <Metric label="Last poll" value={lastPoll ? timeAgo(lastPoll) : "Never"} />
          <Metric label="Active companies" value={activeCompanies} detail={erroredCompanies ? `${erroredCompanies} with errors` : null} tone={erroredCompanies ? "warn" : null} />
          <Metric label="Total postings tracked" value={totalPostings} />
          <Metric
            label="Gemini calls today"
            value={`${usagePct} / ${maxLlmCallsPerDay ?? "—"}`}
            detail={`${llmUsage?.embedCalls ?? 0} embed, ${llmUsage?.scoreCalls ?? 0} score`}
          />
          <Metric label="Job-search DB size" value={`${dbSizeMb} MB`} />
        </div>
      </section>

      <section className="job-search-panel">
        <header className="job-search-panel-header">
          <h2>Pipeline Status</h2>
        </header>
        <div className="job-search-field-grid">
          {STATUS_ORDER.map(({ key, label }) => (
            <Metric key={key} label={label} value={statusCounts?.[key] || 0} />
          ))}
        </div>
      </section>

      <section className="job-search-panel">
        <header className="job-search-panel-header">
          <h2>Recent Activity</h2>
        </header>
        {(!recentActivity || recentActivity.length === 0) ? (
          <p className="job-search-empty">No postings collected yet.</p>
        ) : (
          <div className="job-search-table-scroll">
            <table className="job-search-table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Status</th>
                  <th>Score</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {recentActivity.map((posting) => (
                  <tr key={posting.id}>
                    <td>
                      <strong>{posting.title}</strong>
                      <div className="job-search-cell-note">{posting.companyName}</div>
                    </td>
                    <td><Badge text={posting.status.replace(/_/g, " ")} tone={statusTone(posting.status)} /></td>
                    <td>{posting.llmOverallScore != null ? posting.llmOverallScore.toFixed(1) : "—"}</td>
                    <td>{timeAgo(posting.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
