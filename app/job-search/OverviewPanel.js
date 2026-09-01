"use client";

import { useEffect, useState } from "react";
import { atsTypeLabel, Badge, Metric, Modal } from "./JobSearchUi";
import PushNotificationsControl from "./PushNotificationsControl";

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
  // Only meaningful for a worker with a real fixed cadence to be stale
  // relative to (the poll worker's Railway Cron Schedule). The submit
  // worker is purely event-driven now (no fallback timer, no cron) — a long
  // gap since its last heartbeat just as likely means nothing's been
  // approved in a while, not that anything stopped working, so this
  // heuristic would misfire "stale" on it constantly.
  if (worker.workerName !== "poll") return false;
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

// Poll-worker only (see WorkerCard below) — the submit worker has no
// periodic cadence to estimate a "next run" for. Estimated, not
// authoritative — derived purely from the gap between this worker's own last
// two check-ins (see jobSearchWorkerStatusStore.js), so it self-calibrates to
// whatever cadence Railway's cron is actually running on instead of requiring
// that schedule to be duplicated into app config by hand. Takes `now` as a
// param (rather than reading Date.now() internally) so it ticks in lockstep
// with the once-a-second re-render driven by that state.
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

// One entry per posting the submit worker has touched THIS pass — 'status'
// is 'in_progress' while it's mid-flight, then whatever toApplicationStatus/
// evaluateAutoApply's own result.status settled on (see
// jobSearchSubmitWorkerRun.js). Not the same vocabulary as posting status
// (NotificationsBell.js's POSTING_STATUS_META) — this is specifically an
// attempt outcome.
const PROGRESS_ITEM_META = {
  in_progress: { label: "Working…", tone: "warn" },
  submitted: { label: "Submitted", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  needs_manual_review: { label: "Needs manual review", tone: "danger" },
  unsupported_ats: { label: "Unsupported ATS", tone: "danger" },
  skipped_auto_apply: { label: "Skipped", tone: "neutral" }
};

// Real-time "what is the submit worker doing right now" block — fed by an
// SSE subscription in the OverviewPanel component below (see
// app/api/job-search/submit-progress-events), not by the page's own
// server-rendered snapshot, since the worker runs as a separate always-on
// process that can start a pass at any moment, not just when this dashboard
// happens to reload. `progress` is null until the first SSE message lands.
function SubmitLiveProgress({ progress }) {
  if (!progress) return null;
  const isRunning = progress.status === "running";
  const total = (progress.submittingTotal || 0) + (progress.autoApplyTotal || 0);
  const pct = total > 0 ? Math.min(100, Math.round((progress.processedCount / total) * 100)) : 0;
  const items = progress.items || [];

  return (
    <div className="job-search-live-progress">
      <div className="job-search-live-progress-header">
        <Badge text={isRunning ? "Working" : "Idle"} tone={isRunning ? "warn" : "neutral"} />
        {isRunning ? <span className="job-search-cell-note">{progress.processedCount} of {total || "?"} processed</span> : null}
      </div>

      {isRunning ? (
        <>
          <div className="job-search-progress-bar">
            <div className="job-search-progress-bar-fill" style={{ width: `${pct}%` }} />
          </div>
          {progress.currentItem ? (
            <p className="job-search-cell-note">
              Now processing: <strong>{progress.currentItem.title}</strong> at {progress.currentItem.companyName}
              {" — "}{progress.currentItem.phase === "auto_apply" ? "auto-apply" : "approved queue"}
            </p>
          ) : null}
        </>
      ) : null}

      {items.length > 0 ? (
        <details className="job-search-live-log-wrap" open={isRunning}>
          <summary>This run — {items.length} job{items.length === 1 ? "" : "s"}</summary>
          <ul className="job-search-live-log">
            {[...items].reverse().map((item, i) => {
              const meta = PROGRESS_ITEM_META[item.status] || { label: "Working…", tone: "warn" };
              return (
                <li key={`${item.postingId}-${i}`}>
                  <span>{item.title}<span className="job-search-cell-note"> · {item.companyName}</span></span>
                  <Badge text={meta.label} tone={meta.tone} />
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function WorkerCard({ worker, rules, saving, now, onToggle, onViewHistory, onViewQueue, liveProgress }) {
  const isBusy = Boolean(saving);
  const isSubmit = worker.workerName === "submit";
  const label = isSubmit ? "Submit worker" : "Poll worker";
  // The submit worker is purely event-driven (approving a posting, or a
  // scoring pass with auto-apply on, wakes it immediately — see
  // jobSearchSubmitTrigger.js) — no periodic cadence at all, unlike the poll
  // worker's Railway Cron Schedule, so it gets its own description and skips
  // the "Next expected" metric below entirely (there's nothing to estimate).
  const description = isSubmit
    ? "Playwright submissions and auto-apply — runs immediately when something's approved."
    : "Discovery, direct ATS polling, and scoring.";

  return (
    <div className="job-search-worker-card">
      <div className="job-search-worker-card-header">
        <div>
          <strong>{label}</strong>
          <div className="job-search-cell-note">{description}</div>
        </div>
        <div className="job-search-form-actions">
          {onViewQueue ? <button type="button" onClick={onViewQueue}>View Queue</button> : null}
          <button type="button" onClick={onViewHistory}>View Activity History</button>
          <button type="button" disabled={isBusy} onClick={() => onToggle(worker.workerName, !worker.enabled)}>
            {worker.enabled ? "Turn off" : "Turn on"}
          </button>
        </div>
      </div>

      <div className="job-search-field-grid">
        <Metric label="Status" value={workerStatusLabel(worker, now)} tone={workerStatusTone(worker, now)} />
        <Metric label="Last run" value={worker.lastRunAt ? timeAgo(worker.lastRunAt) : "Never"} detail={worker.lastRunSummary || null} />
        {!isSubmit ? <Metric label="Next expected" value={nextRunEstimate(worker, now)} /> : null}
      </div>

      {isSubmit ? <SubmitLiveProgress progress={liveProgress} /> : null}

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

// Extracted out of the old standalone "Recent Discovery Runs" section so it
// can live inside the Poll Worker card's history popup instead. Kept to a
// glance-able 4 columns on purpose — everything else that used to be spread
// across "Discovery (Adzuna)"/"Companies"/"Direct-poll"/"By ATS" columns
// moved into the per-row "Details" popup (see DiscoveryRunDetail below),
// which can show the actual lists those columns only ever summarized as
// counts.
function DiscoveryRunsTable({ runs, onViewDetails }) {
  if (!runs || runs.length === 0) {
    return <p className="job-search-empty">No discovery/poll runs recorded yet.</p>;
  }

  return (
    <div className="job-search-table-scroll">
      <table className="job-search-table">
        <thead>
          <tr>
            <th>Ran</th>
            <th>New postings</th>
            <th>Companies checked</th>
            <th>Status</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td>{timeAgo(run.ranAt)}</td>
              <td>{run.jobsCreated + run.directPollCreated}</td>
              <td>{run.directPollCompaniesPolled}/{run.directPollCompaniesTotal}</td>
              <td><Badge text={run.ok ? "OK" : "Error"} tone={run.ok ? "success" : "danger"} /></td>
              <td><button type="button" onClick={() => onViewDetails(run.id)}>Details</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The full breakdown a single run's row used to cram into its own columns,
// plus the two lists a count alone can't show: which postings were actually
// new, and which companies direct-poll actually checked. Fetched on demand
// (see viewRunDetails in OverviewPanel) rather than carried on every run in
// the list above — reconstructed server-side from timestamped tables, not
// stored per-run (see getDiscoveryRunDetails' own comment).
function DiscoveryRunDetail({ state, onBack }) {
  if (state.loading) return <p className="job-search-empty">Loading...</p>;
  if (state.error) return <p className="job-search-alert job-search-alert-error">{state.error}</p>;

  const { run, newPostings, companiesPolled } = state.data;
  const byAtsEntries = Object.entries(run.jobsFoundByAts || {}).filter(([, count]) => count > 0);

  return (
    <div>
      <button type="button" onClick={onBack}>&larr; Back to all runs</button>

      <div className="job-search-field-grid" style={{ marginTop: 12 }}>
        <Metric label="Ran" value={timeAgo(run.ranAt)} />
        <Metric
          label="Discovery (Adzuna)"
          value={run.discoveryRan ? `${run.jobsFound} found, ${run.jobsCreated} new` : "Skipped"}
          detail={!run.discoveryRan ? (run.discoverySkipReason || "not due yet") : null}
        />
        <Metric
          label="Direct-poll"
          value={`${run.directPollCompaniesPolled}/${run.directPollCompaniesTotal} companies`}
          detail={`${run.directPollCreated} new, ${run.directPollSkipped} filtered out${run.directPollErrors > 0 ? `, ${run.directPollErrors} error(s)` : ""}`}
        />
        <Metric label="Status" value={run.ok ? "OK" : "Error"} tone={run.ok ? "success" : "danger"} />
      </div>

      {run.error ? <p className="job-search-alert job-search-alert-error">{run.error}</p> : null}

      <h3>Posts per ATS platform</h3>
      {byAtsEntries.length > 0 ? (
        <div className="job-search-form-actions">
          {byAtsEntries.map(([atsType, count]) => (
            <span key={atsType} className="job-search-ats-count">{atsTypeLabel(atsType)}: {count}</span>
          ))}
        </div>
      ) : <p className="job-search-empty">No postings found on any ATS this run.</p>}

      <h3>New postings this run ({newPostings.length})</h3>
      {newPostings.length === 0 ? (
        <p className="job-search-empty">None — every posting seen this run already existed.</p>
      ) : (
        <div className="job-search-table-scroll">
          <table className="job-search-table">
            <thead><tr><th>Job</th><th>ATS</th><th>Link</th></tr></thead>
            <tbody>
              {newPostings.map((p) => (
                <tr key={p.id}>
                  <td><strong>{p.title}</strong><div className="job-search-cell-note">{p.companyName}</div></td>
                  <td>{atsTypeLabel(p.atsType)}</td>
                  <td>{p.applyUrl ? <a href={p.applyUrl} target="_blank" rel="noreferrer">View</a> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>Companies checked this run ({companiesPolled.length})</h3>
      {companiesPolled.length === 0 ? (
        <p className="job-search-empty">None — direct-poll had nothing to check, or this run predates it.</p>
      ) : (
        <div className="job-search-table-scroll">
          <table className="job-search-table">
            <thead><tr><th>Company</th><th>ATS</th><th>Jobs found</th><th>Status</th></tr></thead>
            <tbody>
              {companiesPolled.map((c) => (
                <tr key={`${c.companyName}-${c.atsType}`}>
                  <td>{c.companyName}</td>
                  <td>{atsTypeLabel(c.atsType)}</td>
                  <td>{c.jobsFoundLastPoll}</td>
                  <td>
                    {c.lastPollStatus === "ok"
                      ? <Badge text="OK" tone="success" />
                      : <Badge text="Error" tone="danger" />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// The submit-worker's own equivalent history — one row per cycle: postings
// actually processed (approved -> submitted/failed/needs review) and, if
// enabled, auto-apply's own evaluation of pending-review postings.
function SubmitRunsTable({ runs }) {
  if (!runs || runs.length === 0) {
    return <p className="job-search-empty">No submit-worker runs recorded yet.</p>;
  }

  return (
    <div className="job-search-table-scroll">
      <table className="job-search-table">
        <thead>
          <tr>
            <th>Ran</th>
            <th>Approved processed</th>
            <th>Outcome</th>
            <th>Auto-apply</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td>{timeAgo(run.ranAt)}</td>
              <td>{run.approvedTotal}</td>
              <td>
                {run.submittedCount} submitted, {run.manualReviewCount} manual review
                {run.failedCount > 0 ? <div className="job-search-cell-note">{run.failedCount} failed</div> : null}
              </td>
              <td>
                {run.autoApplyEnabled
                  ? <>{run.autoApplyEvaluated} evaluated, {run.autoAppliedCount} applied, {run.autoSkippedCount} skipped</>
                  : <span className="job-search-cell-note">Disabled</span>}
              </td>
              <td><Badge text={run.ok ? "OK" : "Error"} tone={run.ok ? "success" : "danger"} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function QueuePostingsTable({ postings }) {
  if (!postings || postings.length === 0) {
    return <p className="job-search-empty">None right now.</p>;
  }
  return (
    <div className="job-search-table-scroll">
      <table className="job-search-table">
        <thead>
          <tr>
            <th>Job</th>
            <th>Score</th>
            <th>Link</th>
          </tr>
        </thead>
        <tbody>
          {postings.map((p) => (
            <tr key={p.id}>
              <td>
                <strong>{p.title}</strong>
                <div className="job-search-cell-note">{p.companyName}</div>
              </td>
              <td>{p.llmOverallScore != null ? p.llmOverallScore.toFixed(1) : "—"}</td>
              <td>{p.applyUrl ? <a href={p.applyUrl} target="_blank" rel="noreferrer">{atsTypeLabel(p.atsType)}</a> : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Everything the submit worker will actually look at on its next run —
// approved postings waiting their turn, plus (if auto-apply is on)
// pending-review postings that already clear its free thresholds. Same
// underlying data as Review's own "In Queue" tab, surfaced here as a
// quick-access popup right on the card that's going to process them.
function SubmitQueueTable({ approvedWaiting, autoApplyQueue }) {
  const approved = approvedWaiting || [];
  const autoQueue = autoApplyQueue || [];

  return (
    <>
      <h3>Approved, waiting for worker ({approved.length})</h3>
      <QueuePostingsTable postings={approved} />

      <h3>Auto-apply queue ({autoQueue.length})</h3>
      <QueuePostingsTable postings={autoQueue} />
    </>
  );
}

export default function OverviewPanel({
  findSettings,
  statusCounts,
  discoveryRuns,
  submitRuns,
  llmUsage,
  maxLlmCallsPerDay,
  dbSizeMb,
  companyDirectoryStats,
  workerStatus,
  adzunaConfigured,
  defaultResume,
  approvedWaiting,
  autoApplyQueue,
  saving,
  submitProgress,
  onRunDiscovery,
  onScoreNow,
  onToggleWorker
}) {
  const [historyModal, setHistoryModal] = useState(null); // null | "poll" | "submit" | "submitQueue"
  // null | { runId, loading, data, error } — which discovery run's Details
  // popup is open, if any. Separate from historyModal itself so it's just a
  // nested view within the same "poll" modal, not a second overlay.
  const [runDetails, setRunDetails] = useState(null);
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

  // submitProgress itself is a prop, not local state — the SSE subscription
  // lives once in JobSearchAppClient.js (always mounted, unlike this panel
  // which only exists while the Overview tab is active) so the topbar's
  // SubmitWorkerBanner and this panel's SubmitLiveProgress share one
  // EventSource instead of each opening their own.

  // On demand only (no polling) — a run's details are static once recorded,
  // unlike worker status above. Reconstructed server-side, not carried on
  // the run list itself (see getDiscoveryRunDetails' own comment).
  async function viewRunDetails(runId) {
    setRunDetails({ runId, loading: true, data: null, error: "" });
    try {
      const response = await fetch(`/api/job-search/discovery-runs/${runId}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "Failed to load run details.");
      setRunDetails({ runId, loading: false, data: payload, error: "" });
    } catch (err) {
      setRunDetails({ runId, loading: false, data: null, error: err?.message || "Failed to load run details." });
    }
  }

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

  // Prefers the SSE feed's live count (see submitProgress above) once it's
  // arrived — otherwise falls back to the page's own server-rendered
  // snapshot, so this line doesn't sit blank while the connection opens.
  const approvedCount = submitProgress?.approvedWaitingCount ?? (statusCounts?.approved || 0);
  const pendingReviewCount = submitProgress?.pendingReviewCount ?? (statusCounts?.pending_review || 0);
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
          <div className="job-search-form-actions">
            <PushNotificationsControl />
            <button type="button" disabled={isBusy} onClick={onRunDiscovery}>
              {saving === "discoveryNow" ? "Running discovery..." : "Run Discovery Now"}
            </button>
            <button type="button" disabled={isBusy} onClick={onScoreNow}>
              {saving === "scoreNow" ? "Scoring..." : "Score New Postings Now"}
            </button>
          </div>
        </header>
        <p className="job-search-panel-hint">
          The poll worker runs two distinct things on every cron tick, at two different cadences:
          Discovery searches Adzuna by keyword for new postings and new companies (throttled — Adzuna's
          free tier has a real rate limit), while Direct-poll re-checks every company already known from
          past discovery straight against its own ATS board (no throttle — runs on every tick). The submit
          worker is separate again: it only submits postings you've approved and evaluates auto-apply. The
          two buttons above manually trigger a poll-worker-style pass right now, without waiting for its
          own cron.
        </p>
        <div className="job-search-worker-grid">
          <WorkerCard
            worker={pollWorker} rules={pollRules} saving={saving} now={now}
            onToggle={onToggleWorker} onViewHistory={() => setHistoryModal("poll")}
          />
          <WorkerCard
            worker={submitWorker} rules={submitRules} saving={saving} now={now}
            onToggle={onToggleWorker} onViewHistory={() => setHistoryModal("submit")}
            onViewQueue={() => setHistoryModal("submitQueue")}
            liveProgress={submitProgress}
          />
        </div>
      </section>

      <section className="job-search-panel">
        <header className="job-search-panel-header">
          <h2>System Status</h2>
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

      {historyModal === "poll" ? (
        <Modal
          title={runDetails ? "Poll Worker — Run Details" : "Poll Worker — Recent Runs"}
          hint={runDetails
            ? null
            : "One row per poll-worker run. Click \"Details\" on any row for the full breakdown — postings found "
              + "per ATS platform, every newly-created posting, and every company direct-poll actually checked."}
          onClose={() => { setHistoryModal(null); setRunDetails(null); }}
        >
          {runDetails
            ? <DiscoveryRunDetail state={runDetails} onBack={() => setRunDetails(null)} />
            : <DiscoveryRunsTable runs={discoveryRuns} onViewDetails={viewRunDetails} />}
        </Modal>
      ) : null}

      {historyModal === "submit" ? (
        <Modal
          title="Submit Worker — Recent Runs"
          hint={"One row per submit-worker run: postings approved by hand and actually processed (submitted/failed/"
            + "needs manual review), plus — when auto-apply is enabled — how many pending-review postings it "
            + "evaluated on its own and what it decided for each."}
          onClose={() => setHistoryModal(null)}
        >
          <SubmitRunsTable runs={submitRuns} />
        </Modal>
      ) : null}

      {historyModal === "submitQueue" ? (
        <Modal
          title="Submit Worker — Current Queue"
          hint={"Same data as Review's own \"In Queue\" tab, shown here for quick access. The auto-apply portion is a "
            + "preview, not a guarantee — a posting can still get skipped for a reason only discoverable by "
            + "actually attempting it."}
          onClose={() => setHistoryModal(null)}
        >
          <SubmitQueueTable approvedWaiting={approvedWaiting} autoApplyQueue={autoApplyQueue} />
        </Modal>
      ) : null}
    </>
  );
}
