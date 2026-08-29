"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { Badge } from "./JobSearchUi";

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function statusTone(status) {
  if (status === "submitted") return "success";
  if (status === "failed") return "danger";
  if (status === "needs_manual_review") return "warn";
  return "neutral";
}

function AppliedJobRow({ application, saving, onUpdateNote, onRetry }) {
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
          <Badge text={application.submissionStatus} tone={statusTone(application.submissionStatus)} />
          {" "}
          <Badge text={application.autoApplied ? "Auto" : "Manual"} />
        </td>
        <td>{application.resumeLabel || "—"}</td>
        <td>{formatDate(application.submittedAt || application.attemptedAt)}</td>
        <td className="job-search-row-actions" onClick={(e) => e.stopPropagation()}>
          <a href={application.applyUrl} target="_blank" rel="noreferrer">Posting</a>
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
                  {application.errorMessage ? <p className="job-search-alert job-search-alert-error">{application.errorMessage}</p> : null}
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
                    {(application.submissionStatus === "failed" || application.submissionStatus === "needs_manual_review") ? (
                      <button type="button" disabled={isBusy} onClick={() => onRetry(application.id)}>Retry submission</button>
                    ) : null}
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

export default function AppliedJobsTable({ applications, saving, onUpdateNote, onRetry }) {
  return (
    <section className="job-search-panel job-search-applied-panel">
      <header className="job-search-panel-header">
        <h2>Applied Jobs</h2>
      </header>

      {applications.length === 0 ? (
        <p className="job-search-empty">No applications submitted yet — approved jobs in the review queue get submitted automatically once the Playwright adapters are wired up.</p>
      ) : (
        <div className="job-search-table-scroll">
          <table className="job-search-table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Status</th>
                <th>Resume used</th>
                <th>Submitted</th>
                <th>Links</th>
              </tr>
            </thead>
            <tbody>
              {applications.map((application) => (
                <AppliedJobRow key={application.id} application={application} saving={saving} onUpdateNote={onUpdateNote} onRetry={onRetry} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
