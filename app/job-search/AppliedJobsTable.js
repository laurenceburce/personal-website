"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { atsTypeLabel, Badge, Metric, useIsNewSince } from "./JobSearchUi";

// Distinct from DELETE_COUNTDOWN_MS below — this is the "have you seen this
// row before" cutoff (see useIsNewSince's own comment).
const NEW_SINCE_KEY = "job-search-applied-last-seen";

// How long a row sits in "Deleting in Ns…" before the delete actually fires
// — long enough to catch a misclick and hit Undo, short enough that it
// doesn't feel like the button did nothing.
const DELETE_COUNTDOWN_MS = 5000;

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

// Same relative-time convention as OverviewPanel's timeAgo — kept local
// since it's the only other place in job-search that wants it and pulling
// in a shared helper for one four-line function isn't worth the indirection.
function timeAgo(value) {
  if (!value) return "—";
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return "—";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// Applied Jobs is now a pure success log — anything that failed, needs
// manual review, or hit an unsupported ATS shows up in Review instead
// (where it's actually actionable: retry, reject, mark applied by hand),
// not buried here alongside real successes. See ReviewQueueTable.js.
function AppliedJobRow({ application, saving, isNew, onUpdateNote, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState(application.userNote || "");
  const [deleteAt, setDeleteAt] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const deleteTimerRef = useRef(null);
  const isBusy = Boolean(saving);
  const pendingDelete = deleteAt != null;
  const answers = application.submittedAnswers || {};
  const scoreSnapshot = application.scoreSnapshot || {};
  const applicationIsNew = isNew(application.submittedAt || application.attemptedAt);

  // Only ticks while a delete is actually pending, so idle rows don't run a
  // timer for nothing.
  useEffect(() => {
    if (!pendingDelete) return undefined;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [pendingDelete]);

  // Belt-and-suspenders: if the row unmounts mid-countdown (e.g. the user
  // switches tabs), don't let a stray timeout fire a delete no one can see
  // happening anymore.
  useEffect(() => () => {
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
  }, []);

  function requestDelete(e) {
    e.stopPropagation();
    setExpanded(false);
    setNow(Date.now());
    setDeleteAt(Date.now() + DELETE_COUNTDOWN_MS);
    deleteTimerRef.current = setTimeout(() => {
      deleteTimerRef.current = null;
      onDelete(application.id);
    }, DELETE_COUNTDOWN_MS);
  }

  function cancelDelete(e) {
    e.stopPropagation();
    if (deleteTimerRef.current) {
      clearTimeout(deleteTimerRef.current);
      deleteTimerRef.current = null;
    }
    setDeleteAt(null);
  }

  const secondsLeft = pendingDelete ? Math.max(1, Math.ceil((deleteAt - now) / 1000)) : 0;

  return (
    <>
      <tr
        className={`job-search-row${pendingDelete ? " job-search-row-pending-delete" : ""}${applicationIsNew && !pendingDelete ? " job-search-row-new" : ""}`}
        onClick={() => { if (!pendingDelete) setExpanded((v) => !v); }}
      >
        <td>
          <span className={`job-search-row-caret${expanded ? " job-search-row-caret-open" : ""}`} aria-hidden="true">▸</span>
          <strong>{application.jobTitle}</strong>
          {applicationIsNew ? <>{" "}<Badge text="New" tone="new" /></> : null}
          <div className="job-search-cell-note">{application.companyName} · {application.atsType}</div>
        </td>
        <td>
          <Badge text={application.autoApplied ? "Auto" : "Manual"} tone={application.autoApplied ? "success" : "neutral"} />
        </td>
        <td>{application.resumeLabel || "—"}</td>
        <td>
          <span title={formatDate(application.submittedAt || application.attemptedAt)}>
            {timeAgo(application.submittedAt || application.attemptedAt)}
          </span>
        </td>
        <td className="job-search-row-actions" onClick={(e) => e.stopPropagation()}>
          {pendingDelete ? (
            <span className="job-search-delete-pending">
              Deleting in {secondsLeft}s
              <button type="button" onClick={cancelDelete}>Undo</button>
            </span>
          ) : (
            <>
              <a href={application.applyUrl} target="_blank" rel="noreferrer">{atsTypeLabel(application.atsType)}</a>
              <button
                type="button"
                className="job-search-btn-ghost job-search-row-delete-btn"
                disabled={isBusy}
                title="Delete application"
                aria-label="Delete application"
                onClick={requestDelete}
              >
                ×
              </button>
            </>
          )}
        </td>
      </tr>
      <AnimatePresence initial={false}>
        {expanded && !pendingDelete && (
          <tr>
            <td colSpan={5} style={{ padding: 0 }}>
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.22, ease: "easeInOut" }}
                className="job-search-expanded"
              >
                <div className="job-search-expanded-inner" onClick={(e) => e.stopPropagation()}>
                  {application.atsConfirmationText ? <p className="job-search-summary">{application.atsConfirmationText}</p> : null}

                  {scoreSnapshot.overall != null ? (
                    <p className="job-search-cell-note">Score at submission time: {scoreSnapshot.overall}/100</p>
                  ) : null}

                  {Object.keys(answers).length > 0 ? (
                    <details className="job-search-description">
                      <summary>Submitted answers</summary>
                      <pre>{JSON.stringify(answers, null, 2)}</pre>
                    </details>
                  ) : (
                    <p className="job-search-empty">No submitted answers recorded.</p>
                  )}

                  <div className="job-search-form-actions">
                    <input
                      placeholder="Your note (e.g. recruiter replied, interview scheduled)"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                    />
                    <button type="button" disabled={isBusy} onClick={() => onUpdateNote(application.id, note)}>Save note</button>
                  </div>
                </div>
              </motion.div>
            </td>
          </tr>
        )}
      </AnimatePresence>
    </>
  );
}

const APPLIED_VIEWS = [
  { key: "all", label: "All", match: () => true },
  { key: "auto", label: "Auto-applied", match: (a) => a.autoApplied },
  { key: "manual", label: "Manually applied", match: (a) => !a.autoApplied }
];

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export default function AppliedJobsTable({ applications, saving, onUpdateNote, onDelete }) {
  const [view, setView] = useState("all");
  const isNew = useIsNewSince(NEW_SINCE_KEY);
  const successfulApplications = applications.filter((a) => a.submissionStatus === "submitted");
  const activeView = APPLIED_VIEWS.find((v) => v.key === view) || APPLIED_VIEWS[0];
  const list = successfulApplications.filter(activeView.match);

  const weekAgo = Date.now() - ONE_WEEK_MS;
  const thisWeekCount = successfulApplications.filter((a) => {
    const t = a.submittedAt || a.attemptedAt;
    return t && new Date(t).getTime() >= weekAgo;
  }).length;
  const uniqueCompanies = new Set(successfulApplications.map((a) => a.companyName)).size;

  return (
    <section className="job-search-panel job-search-applied-panel">
      <header className="job-search-panel-header">
        <h2>Applied Jobs</h2>
        <div className="job-search-toggle-group">
          {APPLIED_VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              className={view === v.key ? "job-search-toggle-active" : ""}
              onClick={() => setView(v.key)}
            >
              {v.label} ({successfulApplications.filter(v.match).length})
            </button>
          ))}
        </div>
      </header>

      {successfulApplications.length > 0 ? (
        <div className="job-search-field-grid job-search-applied-stats">
          <Metric label="Total submitted" value={successfulApplications.length} />
          <Metric label="This week" value={thisWeekCount} />
          <Metric label="Companies applied to" value={uniqueCompanies} />
        </div>
      ) : null}

      <p className="job-search-panel-hint">
        Only successfully submitted applications show here. Anything that failed, needs manual review, or hit an
        unsupported ATS is in Review instead, where it's actually actionable.
      </p>

      {applications.length === 0 ? (
        <p className="job-search-empty">No applications submitted yet — approve a posting in Review, or enable auto-apply, to get started.</p>
      ) : successfulApplications.length === 0 ? (
        <p className="job-search-empty">No successful submissions yet — check Review's Manual Review / Auto-apply Failed tabs for anything waiting on you.</p>
      ) : list.length === 0 ? (
        <p className="job-search-empty">Nothing here right now.</p>
      ) : (
        <div className="job-search-table-scroll">
          <table className="job-search-table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Applied</th>
                <th>Resume used</th>
                <th>Submitted</th>
                <th>Links</th>
              </tr>
            </thead>
            <tbody>
              {list.map((application) => (
                <AppliedJobRow key={application.id} application={application} saving={saving} isNew={isNew} onUpdateNote={onUpdateNote} onDelete={onDelete} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
