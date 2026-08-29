"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { Badge, scamBadgeTone } from "./JobSearchUi";

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

const SKIP_REASON_LABELS = {
  unsupported_ats: "Unsupported ATS",
  required_field_unknown: "Required field unknown",
  captcha_or_login_required: "CAPTCHA / login required",
  scam_risk_too_high: "Scam risk too high",
  score_too_low: "Below auto-apply threshold"
};

function ReviewQueueRow({ posting, selected, onToggleSelect, onApprove, onReject, onRescore, saving }) {
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState("");
  const isBusy = Boolean(saving);
  const scores = posting.llmDimensionScores?.scores || {};
  const reasoning = posting.llmDimensionScores?.reasoning || {};

  return (
    <>
      <tr className="job-search-row" onClick={() => setExpanded((v) => !v)}>
        <td onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={selected} onChange={() => onToggleSelect(posting.id)} />
        </td>
        <td>
          <strong>{posting.title}</strong>
          <div className="job-search-cell-note">{posting.companyName} · {posting.locationText || posting.remoteType}</div>
        </td>
        <td>{posting.llmOverallScore != null ? posting.llmOverallScore.toFixed(1) : "—"}</td>
        <td>
          {posting.status === "skipped_auto_apply" ? (
            <Badge text={SKIP_REASON_LABELS[posting.autoApplySkipReason] || "Skipped"} tone="warn" />
          ) : (
            <Badge text={`${posting.scamRiskLevel || "low"}${posting.scamRiskScore ? ` (${posting.scamRiskScore})` : ""}`} tone={scamBadgeTone(posting.scamRiskLevel)} />
          )}
        </td>
        <td>{formatDate(posting.postedAt)}</td>
        <td className="job-search-row-actions" onClick={(e) => e.stopPropagation()}>
          {posting.applyUrl ? <a href={posting.applyUrl} target="_blank" rel="noreferrer">Posting</a> : null}
          <button type="button" disabled={isBusy} onClick={() => onApprove(posting.id)}>Approve</button>
          <button type="button" disabled={isBusy} onClick={() => onReject(posting.id, note)}>Reject</button>
          <button type="button" disabled={isBusy} onClick={() => onRescore(posting.id)}>Re-score</button>
        </td>
      </tr>
      <AnimatePresence initial={false}>
        {expanded && (
          <tr>
            <td colSpan={6} style={{ padding: 0 }}>
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.22, ease: "easeInOut" }}
                className="job-search-expanded"
              >
                <div className="job-search-expanded-inner" onClick={(e) => e.stopPropagation()}>
                  {posting.status === "skipped_auto_apply" && posting.decisionNote ? (
                    <p className="job-search-alert">Auto-apply skipped this: {posting.decisionNote}</p>
                  ) : null}

                  {posting.llmSummary ? <p className="job-search-summary">{posting.llmSummary}</p> : null}

                  {posting.llmConcerns?.length > 0 && (
                    <ul className="job-search-concerns">
                      {posting.llmConcerns.map((concern, i) => <li key={i}>{concern}</li>)}
                    </ul>
                  )}

                  {posting.scamRiskFlags?.length > 0 && (
                    <p className="job-search-scam-flags">Scam-risk flags: {posting.scamRiskFlags.join(", ")}</p>
                  )}

                  {Object.keys(scores).length > 0 && (
                    <div className="job-search-dimension-grid">
                      {Object.entries(scores).map(([key, value]) => (
                        <div key={key} className="job-search-dimension">
                          <span>{key}</span>
                          <strong>{value}/10</strong>
                          {reasoning[key] ? <small>{reasoning[key]}</small> : null}
                        </div>
                      ))}
                    </div>
                  )}

                  <details className="job-search-description">
                    <summary>Full job description</summary>
                    <pre>{posting.descriptionText}</pre>
                  </details>

                  <div className="job-search-form-actions">
                    <a href={posting.applyUrl} target="_blank" rel="noreferrer">View original posting</a>
                    <input
                      placeholder="Rejection note (optional)"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                    />
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

export default function ReviewQueueTable({ postings, scoredLow, autoApplySkipped, saving, onApprove, onReject, onBatchApprove, onBatchReject, onRescore }) {
  const [selected, setSelected] = useState(new Set());
  const [view, setView] = useState("pending");
  const list = view === "scoredLow" ? scoredLow : view === "autoSkipped" ? (autoApplySkipped || []) : postings;
  const isBusy = Boolean(saving);

  function toggleSelect(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) => (prev.size === list.length ? new Set() : new Set(list.map((p) => p.id))));
  }

  function switchList(nextView) {
    setView(nextView);
    setSelected(new Set());
  }

  async function handleBatchApprove() {
    await onBatchApprove([...selected]);
    setSelected(new Set());
  }

  async function handleBatchReject() {
    await onBatchReject([...selected], "");
    setSelected(new Set());
  }

  return (
    <section className="job-search-panel job-search-review-panel">
      <header className="job-search-panel-header">
        <h2>Review Queue</h2>
        <div className="job-search-toggle-group">
          <button type="button" className={view === "pending" ? "job-search-toggle-active" : ""} onClick={() => switchList("pending")}>
            Pending review ({postings.length})
          </button>
          <button type="button" className={view === "scoredLow" ? "job-search-toggle-active" : ""} onClick={() => switchList("scoredLow")}>
            Scored low ({scoredLow.length})
          </button>
          <button type="button" className={view === "autoSkipped" ? "job-search-toggle-active" : ""} onClick={() => switchList("autoSkipped")}>
            Skipped auto-apply ({(autoApplySkipped || []).length})
          </button>
        </div>
      </header>

      {selected.size > 0 && (
        <div className="job-search-batch-toolbar">
          <span>{selected.size} selected</span>
          <button type="button" disabled={isBusy} onClick={handleBatchApprove}>Approve selected</button>
          <button type="button" disabled={isBusy} onClick={handleBatchReject}>Reject selected</button>
        </div>
      )}

      {list.length === 0 ? (
        <p className="job-search-empty">Nothing here right now.</p>
      ) : (
        <div className="job-search-table-scroll">
          <table className="job-search-table">
            <thead>
              <tr>
                <th><input type="checkbox" checked={selected.size === list.length && list.length > 0} onChange={toggleSelectAll} /></th>
                <th>Job</th>
                <th>Score</th>
                <th>Scam risk</th>
                <th>Posted</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {list.map((posting) => (
                <ReviewQueueRow
                  key={posting.id}
                  posting={posting}
                  selected={selected.has(posting.id)}
                  onToggleSelect={toggleSelect}
                  onApprove={onApprove}
                  onReject={onReject}
                  onRescore={onRescore}
                  saving={saving}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
