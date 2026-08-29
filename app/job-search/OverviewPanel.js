"use client";

import { useEffect, useState } from "react";
import { atsTypeLabel, Badge, Metric } from "./JobSearchUi";

// How often the Workers panel re-fetches worker status from the server so
// "Last run"/"Next expected" reflect an actual cron run landing in the
// background, without the user having to refresh the tab. Cheap (2-row
// SELECT) relative to how rarely the underlying data actually changes
// (cron cadences here are 10-15+ minutes) — this is about latency to
// noticing a change, not about the data itself being expensive to read.
const WORKER_STATUS_POLL_MS = 20000;

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
function isWorkerStale(worker, now) {
  if (!worker.enabled || !worker.lastCheckedAt || !worker.observedIntervalMinutes) return false;
  const minutesSinceCheckIn = (now - new Date(worker.lastCheckedAt).getTime()) / 60000;
  return minutesSinceCheckIn > worker.observedIntervalMinutes * 3;
}

function workerStatusLabel(worker, now) {
  if (!worker.enabled) return "Disabled";
  if (isWorkerStale(worker, now)) return "Stale — hasn't checked in recently";
  if (!worker.lastRunAt) return "Waiting for first run";
  if (worker.lastRunOk === false) return "Last run failed";
  return "Healthy";
}

function workerStatusTone(worker, now) {
  if (!worker.enabled) return "warn";
  if (isWorkerStale(worker, now) || worker.lastRunOk === false) return "danger";
  if (!worker.lastRunAt) return "warn";
  return "success";
}

function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// Estimated, not authoritative — derived purely from the gap between this
// worker's own last two check-ins (see jobSearchWorkerStatusStore.js), so it
// self-calibrates to whatever cadence Railway's cron is actually running on
// instead of requiring that schedule to be duplicated into app config by hand.
// Takes `now` as a param (rather than reading Date.now() internally) so it
// ticks in lockstep with the once-a-second re-render driven by that state.
function nextRunEstimate(worker, now) {
  if (!worker.enabled) return "—";
  if (!worker.lastCheckedAt || !worker.observedIntervalMinutes) return "Estimating (needs a second run)...";
  const nextMs = new Date(worker.lastCheckedAt).getTime() + worker.observedIntervalMinutes * 60000;
  const remainingMs = nextMs - now;
  const cadence = `every ~${Math.max(1, Math.round(worker.observedIntervalMinutes))}m observed`;
  if (remainingMs <= 0) {
    const overdueMs = -remainingMs;
    // A little overdue is normal cron jitter — "Any moment now" covers that.
    // Once it's missed a full cycle, say so explicitly instead of still
    // claiming it's imminent — confirmed live this mattered: a worker whose
    // cron had genuinely stopped for 4 hours (a deploy-triggered gap) showed
    // "Any moment now" the whole time, which reads as healthy when it isn't.
    if (overdueMs > worker.observedIntervalMinutes * 60000) {
      return `Overdue by ${formatCountdown(overdueMs)} (${cadence})`;
    }
    return `Any moment now (${cadence})`;
  }
  return `${formatCountdown(remainingMs)} (${cadence})`;
}

function WorkerCard({ worker, rules, saving, now, onToggle }) {
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
        <Metric label="Status" value={workerStatusLabel(worker, now)} tone={workerStatusTone(worker, now)} />
        <Metric label="Last run" value={worker.lastRunAt ? timeAgo(worker.lastRunAt) : "Never"} detail={worker.lastRunSummary || null} />
        <Metric label="Next expected" value={nextRunEstimate(worker, now)} />
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
  discoveryRuns,
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

  // The server only hands over a fresh workerStatus when the page itself
  // re-renders (a button-triggered router.refresh()) — the two effects below
  // keep "Last run"/"Next expected" live in between those without requiring
  // one.
  const [liveWorkerStatus, setLiveWorkerStatus] = useState(workerStatus);
  const [now, setNow] = useState(() => Date.now());

  // Resync whenever the parent hands over a new snapshot (e.g. right after
  // toggling a worker) so that action's result is reflected immediately
  // rather than waiting for the next poll tick.
  useEffect(() => {
    setLiveWorkerStatus(workerStatus);
  }, [workerStatus]);

  // Ticks "Last run"/"Next expected" every second — pure client-side
  // recompute against whatever timestamps are already known, independent of
  // whether new data has actually arrived.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  // Actually refreshes the underlying data — a real cron run updates these
  // timestamps on its own schedule, with nothing else on the page prompting
  // a refresh, so this is what lets a landed run show up without the user
  // reloading the tab.
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const response = await fetch("/api/job-search/worker-status");
        if (!response.ok) return;
        const data = await response.json().catch(() => null);
        if (!cancelled && Array.isArray(data?.workerStatus)) setLiveWorkerStatus(data.workerStatus);
      } catch {
        // Best-effort — a missed poll just means the next one catches up;
        // never surface a transient network hiccup as a UI error here.
      }
    }
    const interval = setInterval(poll, WORKER_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const pollWorker = liveWorkerStatus?.find((w) => w.workerName === "poll") || { workerName: "poll", enabled: true };
  const submitWorker = liveWorkerStatus?.find((w) => w.workerName === "submit") || { workerName: "submit", enabled: true };

  // Read-only — these are the conditions that already silently gate what
  // each worker actually does today (see jobSearchDiscovery.js/
  // jobSearchAutoApply.js); surfaced here so "why didn't it do anything"
  // never requires reading the source. The poll worker actually runs two
  // distinct things on every tick (see the module doc-comment at the top of
  // jobSearchDiscovery.js/jobSearchDirectPoll.js) — labeled here so it's
  // clear which rule governs which: Discovery (Adzuna keyword search, finds
  // NEW companies/postings, throttled — Adzuna's free tier has a real
  // rate limit) vs Direct-poll (re-checks companies already known, no
  // throttle — the ATS platforms themselves showed no rate limiting).
  const pollRules = [
    { label: "Discovery: Adzuna API keys configured", ok: adzunaConfigured },
    {
      label: `Discovery: ${discoveryEnabled ? "enabled" : "disabled"} in Job Find Settings (every ~${findSettings?.discoveryIntervalMinutes || 60}m when it runs)`,
      ok: discoveryEnabled
    },
    { label: `Discovery: last ran ${findSettings?.discoveryLastRunAt ? timeAgo(findSettings.discoveryLastRunAt) : "never"}`, ok: null },
    {
      label: `Direct-poll: ${companyDirectoryStats?.pollableCompanies ?? 0} companies on the roster, checked on every run (no throttle)`,
      ok: null
    },
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
        <p className="job-search-panel-hint">
          The poll worker runs two distinct things on every cron tick, at two different cadences:
          Discovery searches Adzuna by keyword for new postings and new companies (throttled — Adzuna's
          free tier has a real rate limit), while Direct-poll re-checks every company already known from
          past discovery straight against its own ATS board (no throttle — runs on every tick). The submit
          worker is separate again: it only submits postings you've approved and evaluates auto-apply.
        </p>
        <div className="job-search-worker-grid">
          <WorkerCard worker={pollWorker} rules={pollRules} saving={saving} now={now} onToggle={onToggleWorker} />
          <WorkerCard worker={submitWorker} rules={submitRules} saving={saving} now={now} onToggle={onToggleWorker} />
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
          <h2>Recent Discovery Runs</h2>
        </header>
        <p className="job-search-panel-hint">
          One row per poll-worker run. "Discovery (Adzuna)" is the keyword search for new postings/companies
          — often shows "Skipped" since it only actually runs once per hour by default. "Direct-poll" and
          "By ATS" are the companies already on the roster, checked fresh every run regardless.
        </p>
        {(!discoveryRuns || discoveryRuns.length === 0) ? (
          <p className="job-search-empty">No discovery/poll runs recorded yet.</p>
        ) : (
          <div className="job-search-table-scroll">
            <table className="job-search-table">
              <thead>
                <tr>
                  <th>Ran</th>
                  <th>Jobs processed</th>
                  <th>Discovery (Adzuna)</th>
                  <th>Companies</th>
                  <th>Direct-poll</th>
                  <th>By ATS</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {discoveryRuns.map((run) => {
                  const byAtsEntries = Object.entries(run.jobsFoundByAts || {}).filter(([, count]) => count > 0);
                  const totalJobsSeen = run.jobsFound + byAtsEntries.reduce((sum, [, count]) => sum + count, 0);

                  return (
                    <tr key={run.id}>
                      <td>{timeAgo(run.ranAt)}</td>
                      <td>{totalJobsSeen}</td>
                      <td>
                        {run.discoveryRan
                          ? <>{run.jobsFound} found, {run.jobsCreated} new</>
                          : <span className="job-search-cell-note">Skipped ({run.discoverySkipReason || "not due yet"})</span>}
                      </td>
                      <td>{run.companiesProbed} probed, {run.companiesFound} matched</td>
                      <td>
                        {run.directPollCompaniesPolled}/{run.directPollCompaniesTotal} companies, {run.directPollCreated} new
                        <div className="job-search-cell-note">{run.directPollSkipped} filtered out{run.directPollErrors > 0 ? `, ${run.directPollErrors} error(s)` : ""}</div>
                      </td>
                      <td>
                        {byAtsEntries.length > 0
                          ? byAtsEntries.map(([atsType, count]) => (
                              <span key={atsType} className="job-search-ats-count">{atsTypeLabel(atsType)}: {count}</span>
                            ))
                          : "—"}
                      </td>
                      <td><Badge text={run.ok ? "OK" : "Error"} tone={run.ok ? "success" : "danger"} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
