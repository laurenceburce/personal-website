"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { atsTypeLabel, Badge } from "./JobSearchUi";

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

// Applied Jobs is now a pure success log — anything that failed, needs
// manual review, or hit an unsupported ATS shows up in the Review Queue's
// own tabs instead (where it's actually actionable: retry, reject, mark
// applied by hand), not buried here alongside real successes. See
// ReviewQueueTable.js.
function AppliedJobRow({ application, saving, onUpdateNote, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState(application.userNote || "");
  const isBusy = Boolean(saving);
  const answers = application.submittedAnswers || {};
  const scoreSnapshot = application.scoreSnapshot || {};

  return (
    <>
      <tr className="job-search-row" onClick={() => setExpanded((v) => !v)}>
        <td>
          <strong>{application.jobTitle}</strong>
          <div className="job-search-cell-note">{application.companyName} · {application.atsType}</div>
        </td>
        <td>
          <Badge text={application.autoApplied ? "Auto" : "Manual"} tone={application.autoApplied ? "success" : "neutral"} />
        </td>
        <td>{application.resumeLabel || "—"}</td>
        <td>{formatDate(application.submittedAt || application.attemptedAt)}</td>
        <td className="job-search-row-actions" onClick={(e) => e.stopPropagation()}>
          <a href={application.applyUrl} target="_blank" rel="noreferrer">{atsTypeLabel(application.atsType)}</a>
          {application.hasScreenshot ? (
            <a href={`/api/job-search/applications/${application.id}/screenshot`} target="_blank" rel="noreferrer">Screenshot</a>
          ) : null}
        </td>
      </tr>
      <AnimatePresence initial={false}>
        {expanded && (
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
                    <button type="button" disabled={isBusy} onClick={() => onDelete(application.id)}>Delete</button>
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

export default function AppliedJobsTable({ applications, saving, onUpdateNote, onDelete }) {
  const [view, setView] = useState("all");
  const successfulApplications = applications.filter((a) => a.submissionStatus === "submitted");
  const activeView = APPLIED_VIEWS.find((v) => v.key === view) || APPLIED_VIEWS[0];
  const list = successfulApplications.filter(activeView.match);

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

      <p className="job-search-panel-hint">
        Only successfully submitted applications show here. Anything that failed, needs manual review, or hit an
        unsupported ATS is in the Review Queue's own tabs instead, where it's actually actionable.
      </p>

      {applications.length === 0 ? (
        <p className="job-search-empty">No applications submitted yet — approve a posting in the Review Queue, or enable auto-apply, to get started.</p>
      ) : successfulApplications.length === 0 ? (
        <p className="job-search-empty">No successful submissions yet — check the Review Queue's Needs Manual Review / Failed tabs for anything waiting on you.</p>
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
                <AppliedJobRow key={application.id} application={application} saving={saving} onUpdateNote={onUpdateNote} onDelete={onDelete} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
