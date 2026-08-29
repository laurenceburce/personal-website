"use client";

import { atsTypeLabel, Badge, Metric } from "./JobSearchUi";

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
  { key: "skipped_auto_apply", label: "Skipped auto-apply" },
  { key: "submitted", label: "Submitted" },
  { key: "failed", label: "Failed" },
  { key: "needs_manual_review", label: "Needs manual review" },
  { key: "unsupported_ats", label: "Unsupported ATS" },
  { key: "closed", label: "Closed / delisted" },
  { key: "duplicate", label: "Duplicate (merged)" }
];

function statusTone(status) {
  if (["submitted", "approved", "pending_review"].includes(status)) return "success";
  if (["failed", "rejected"].includes(status)) return "danger";
  if (["needs_manual_review", "scored_low", "below_threshold", "skipped_auto_apply"].includes(status)) return "warn";
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

// A worker is only judged stale once there are at least two heartbeats to
// derive a real cadence from — a brand-new install (or a worker just
// re-enabled) hasn't had the chance to establish one yet, and that's not the
// same failure as "Railway's cron used to fire and stopped". The 3x
// multiplier is deliberately generous — real cron cadences jitter by a
// minute or two around their nominal schedule and that should never read as
// "broken".
function isWorkerStale(worker) {
  if (!worker.enabled || !worker.lastCheckedAt || !worker.observedIntervalMinutes) return false;
  const minutesSinceCheckIn = (Date.now() - new Date(worker.lastCheckedAt).getTime()) / 60000;
  return minutesSinceCheckIn > worker.observedIntervalMinutes * 3;
}

function workerStatusLabel(worker) {
  if (!worker.enabled) return "Disabled";
  if (isWorkerStale(worker)) return "Stale — hasn't checked in recently";
  if (!worker.lastRunAt) return "Waiting for first run";
  if (worker.lastRunOk === false) return "Last run failed";
  return "Healthy";
}

function workerStatusTone(worker) {
  if (!worker.enabled) return "warn";
  if (isWorkerStale(worker) || worker.lastRunOk === false) return "danger";
  if (!worker.lastRunAt) return "warn";
  return "success";
}

// Estimated, not authoritative — derived purely from the gap between this
// worker's own last two check-ins (see jobSearchWorkerStatusStore.js), so it
// self-calibrates to whatever cadence Railway's cron is actually running on
// instead of requiring that schedule to be duplicated into app config by hand.
function nextRunEstimate(worker) {
  if (!worker.enabled) return "—";
  if (!worker.lastCheckedAt || !worker.observedIntervalMinutes) return "Estimating (needs a second run)...";
  const nextMs = new Date(worker.lastCheckedAt).getTime() + worker.observedIntervalMinutes * 60000;
  const diffMinutes = Math.round((nextMs - Date.now()) / 60000);
  const cadence = `every ~${Math.max(1, Math.round(worker.observedIntervalMinutes))}m observed`;
  if (diffMinutes <= 0) return `Any moment now (${cadence})`;
  return `~${diffMinutes}m (${cadence})`;
}

function WorkerCard({ worker, rules, saving, onToggle }) {
  const isBusy = Boolean(saving);
  const label = worker.workerName === "poll" ? "Poll worker" : "Submit worker";
  const description = worker.workerName === "poll"
    ? "Discovery, direct ATS polling, and scoring."
    : "Playwright submissions and auto-apply.";

  return (
    <div className="job-search-worker-card">
      <div className="job-search-worker-card-header">
        <div>
          <strong>{label}</strong>
          <div className="job-search-cell-note">{description}</div>
        </div>
        <button type="button" disabled={isBusy} onClick={() => onToggle(worker.workerName, !worker.enabled)}>
          {worker.enabled ? "Turn off" : "Turn on"}
        </button>
      </div>

      <div className="job-search-field-grid">
        <Metric label="Status" value={workerStatusLabel(worker)} tone={workerStatusTone(worker)} />
        <Metric label="Last run" value={worker.lastRunAt ? timeAgo(worker.lastRunAt) : "Never"} detail={worker.lastRunSummary || null} />
        <Metric label="Next expected" value={nextRunEstimate(worker)} />
      </div>

      {worker.lastError ? <p className="job-search-alert job-search-alert-error">{worker.lastError}</p> : null}

      {rules?.length > 0 ? (
        <ul className="job-search-worker-rules">
          {rules.map((rule, i) => (
            <li key={i}>
              {rule.ok == null ? null : <Badge text={rule.ok ? "OK" : "Blocked"} tone={rule.ok ? "success" : "warn"} />} {rule.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default function OverviewPanel({
  findSettings,
  statusCounts,
  recentActivity,
  llmUsage,
  maxLlmCallsPerDay,
  dbSizeMb,
  companyDirectoryStats,
  workerStatus,
  adzunaConfigured,
  defaultResume,
  saving,
  onRunDiscovery,
  onScoreNow,
  onToggleWorker
}) {
  const totalPostings = Object.values(statusCounts || {}).reduce((sum, n) => sum + n, 0);
  const usagePct = llmUsage?.totalCalls != null ? llmUsage.totalCalls : 0;
  const nothingHasRunYet = totalPostings === 0;
  const discoveryEnabled = Boolean(findSettings?.discoveryEnabled);
  const autoApplyEnabled = Boolean(findSettings?.autoApplyEnabled);
  const isBusy = Boolean(saving);

  const pollWorker = workerStatus?.find((w) => w.workerName === "poll") || { workerName: "poll", enabled: true };
  const submitWorker = workerStatus?.find((w) => w.workerName === "submit") || { workerName: "submit", enabled: true };

  // Read-only — these are the conditions that already silently gate what
  // each worker actually does today (see jobSearchDiscovery.js/
  // jobSearchAutoApply.js); surfaced here so "why didn't it do anything"
  // never requires reading the source.
  const pollRules = [
    { label: "Adzuna API keys configured", ok: adzunaConfigured },
    { label: `Discovery ${discoveryEnabled ? "enabled" : "disabled"} in Job Find Settings`, ok: discoveryEnabled },
    { label: `Last discovery run: ${findSettings?.discoveryLastRunAt ? timeAgo(findSettings.discoveryLastRunAt) : "never"}`, ok: null },
    { label: `Gemini calls today: ${usagePct}/${maxLlmCallsPerDay ?? "—"}`, ok: maxLlmCallsPerDay ? usagePct < maxLlmCallsPerDay : null },
    { label: `Job-search DB size: ${dbSizeMb} MB`, ok: null }
  ];

  const approvedCount = statusCounts?.approved || 0;
  const pendingReviewCount = statusCounts?.pending_review || 0;
  const submitRules = [
    {
      label: defaultResume ? `Default resume set (${defaultResume.label || defaultResume.fileName})` : "No default resume uploaded — submissions can't attach one",
      ok: Boolean(defaultResume)
    },
    { label: `${approvedCount} posting(s) approved and waiting to submit`, ok: null },
    { label: `Auto-apply ${autoApplyEnabled ? "enabled" : "disabled"} in Job Find Settings`, ok: autoApplyEnabled ? true : null },
    autoApplyEnabled ? { label: `${pendingReviewCount} pending-review posting(s) eligible for auto-apply evaluation`, ok: null } : null
  ].filter(Boolean);

  return (
    <>
      <section className="job-search-panel">
        <header className="job-search-panel-header">
          <h2>Workers</h2>
        </header>
        <div className="job-search-worker-grid">
          <WorkerCard worker={pollWorker} rules={pollRules} saving={saving} onToggle={onToggleWorker} />
          <WorkerCard worker={submitWorker} rules={submitRules} saving={saving} onToggle={onToggleWorker} />
        </div>
      </section>

      <section className="job-search-panel">
        <header className="job-search-panel-header">
          <h2>System Status</h2>
          <div className="job-search-form-actions">
            <button type="button" disabled={isBusy} onClick={onRunDiscovery}>
              {saving === "discoveryNow" ? "Running discovery..." : "Run Discovery Now"}
            </button>
            <button type="button" disabled={isBusy} onClick={onScoreNow}>
              {saving === "scoreNow" ? "Scoring..." : "Score New Postings Now"}
            </button>
          </div>
        </header>

        {nothingHasRunYet ? (
          <p className="job-search-empty">
            Nothing has run yet — no poll or discovery search has completed. Either wait for the
            scheduled Railway cron service, or click &quot;Run Discovery Now&quot; above to search
            immediately using your Job Find Settings keywords/location.
          </p>
        ) : null}

        <div className="job-search-field-grid">
          <Metric label="Total postings tracked" value={totalPostings} />
          <Metric
            label="Gemini calls today"
            value={`${usagePct} / ${maxLlmCallsPerDay ?? "—"}`}
            detail={`${llmUsage?.embedCalls ?? 0} embed, ${llmUsage?.scoreCalls ?? 0} score`}
          />
          <Metric label="Job-search DB size" value={`${dbSizeMb} MB`} />
          <Metric
            label="Companies on a direct-poll ATS"
            value={companyDirectoryStats?.pollableCompanies ?? 0}
            detail={`${companyDirectoryStats?.totalProbed ?? 0} companies probed total`}
          />
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
                  <th>Link</th>
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
                    <td className="job-search-row-actions">
                      {posting.applyUrl ? <a href={posting.applyUrl} target="_blank" rel="noreferrer">{atsTypeLabel(posting.atsType)}</a> : "—"}
                    </td>
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
