"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { atsTypeLabel, Badge, scamBadgeTone } from "./JobSearchUi";

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

// A posting past pending_review that still has a real reason attached —
// covers all three of skipped_auto_apply/needs_manual_review/failed
// (unsupported_ats included in "failed" — there's no submission adapter to
// have tried) with one prefix each, since decision_note is the same column
// regardless of which path wrote it (auto-apply's own gate vs the
// submit-worker's own submission outcome — see jobSearchPostingsStore.js).
const REASON_PREFIXES = {
  skipped_auto_apply: "Auto-apply skipped this",
  needs_manual_review: "Needs manual review",
  failed: "Submission failed",
  unsupported_ats: "Submission failed"
};

function ReviewQueueRow({ posting, selected, onToggleSelect, onApprove, onReject, onRescore, onMarkApplied, saving }) {
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState("");
  const isBusy = Boolean(saving);
  const scores = posting.llmDimensionScores?.scores || {};
  const reasoning = posting.llmDimensionScores?.reasoning || {};
  // "Approve" only makes sense the first time — for anything that already
  // went through a submission attempt and didn't make it (needs review,
  // failed, or an ATS with no adapter), the same action (reset to
  // 'approved' so the submit worker picks it up again) reads as "Retry".
  const isRetryable = posting.status === "needs_manual_review" || posting.status === "failed" || posting.status === "unsupported_ats";
  const reasonPrefix = REASON_PREFIXES[posting.status];

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
          {posting.status === "approved" ? (
            <Badge text="Waiting for worker" tone="neutral" />
          ) : posting.status === "skipped_auto_apply" ? (
            <Badge text={SKIP_REASON_LABELS[posting.autoApplySkipReason] || "Skipped"} tone="warn" />
          ) : posting.status === "needs_manual_review" ? (
            <Badge text="Needs manual review" tone="warn" />
          ) : posting.status === "unsupported_ats" ? (
            <Badge text="Unsupported ATS" tone="danger" />
          ) : posting.status === "failed" ? (
            <Badge text="Failed" tone="danger" />
          ) : (
            <Badge text={`${posting.scamRiskLevel || "low"}${posting.scamRiskScore ? ` (${posting.scamRiskScore})` : ""}`} tone={scamBadgeTone(posting.scamRiskLevel)} />
          )}
        </td>
        <td>{formatDate(posting.postedAt)}</td>
        <td className="job-search-row-actions" onClick={(e) => e.stopPropagation()}>
          {posting.applyUrl ? <a href={posting.applyUrl} target="_blank" rel="noreferrer">{atsTypeLabel(posting.atsType)}</a> : null}
          {posting.status !== "approved" ? (
            <>
              <button type="button" disabled={isBusy} onClick={() => onApprove(posting.id)}>{isRetryable ? "Retry" : "Approve"}</button>
              <button type="button" disabled={isBusy} onClick={() => onRescore(posting.id)}>Re-score</button>
            </>
          ) : null}
          <button type="button" disabled={isBusy} onClick={() => onReject(posting.id, note)}>Reject</button>
          <button type="button" disabled={isBusy} onClick={() => onMarkApplied(posting.id)}>Mark as Applied</button>
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
                  {reasonPrefix && posting.decisionNote ? (
                    <p className={(posting.status === "failed" || posting.status === "unsupported_ats") ? "job-search-alert job-search-alert-error" : "job-search-alert"}>
                      {reasonPrefix}: {posting.decisionNote}
                    </p>
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

export default function ReviewQueueTable({
  postings, scoredLow, autoApplySkipped, approvedWaiting, autoApplyQueue, autoApplyEnabled,
  needsManualReview, failedPostings,
  saving, onApprove, onReject, onBatchApprove, onBatchReject, onRescore, onMarkApplied
}) {
  const [selected, setSelected] = useState(new Set());
  const [view, setView] = useState("pending");
  const list = view === "scoredLow" ? scoredLow
    : view === "autoSkipped" ? (autoApplySkipped || [])
    : view === "approved" ? (approvedWaiting || [])
    : view === "autoApplyQueue" ? (autoApplyQueue || [])
    : view === "needsManualReview" ? (needsManualReview || [])
    : view === "failed" ? (failedPostings || [])
    : postings;
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
          <button type="button" className={view === "approved" ? "job-search-toggle-active" : ""} onClick={() => switchList("approved")}>
            Waiting for worker ({(approvedWaiting || []).length})
          </button>
          <button type="button" className={view === "autoApplyQueue" ? "job-search-toggle-active" : ""} onClick={() => switchList("autoApplyQueue")}>
            Auto-Apply Queue ({(autoApplyQueue || []).length})
          </button>
          <button type="button" className={view === "needsManualReview" ? "job-search-toggle-active" : ""} onClick={() => switchList("needsManualReview")}>
            Needs Manual Review ({(needsManualReview || []).length})
          </button>
          <button type="button" className={view === "failed" ? "job-search-toggle-active" : ""} onClick={() => switchList("failed")}>
            Failed ({(failedPostings || []).length})
          </button>
        </div>
      </header>

      {view === "autoApplyQueue" ? (
        <p className="job-search-panel-hint">
          {autoApplyEnabled
            ? "Pending-review postings that already clear every free auto-apply threshold (score, resume match, scam risk, freshness) — these are what the submit worker will actually attempt next, ranked highest score first. A posting can still land in \"Skipped auto-apply\" afterward for a reason only discoverable by actually trying it (unsupported ATS, CAPTCHA, an unanswerable required field) — this list is a preview, not a guarantee."
            : "Auto-apply is currently disabled in Job Find Settings, so nothing here gets submitted automatically — approve postings by hand instead, or enable auto-apply to have qualifying postings like these submitted on their own."}
        </p>
      ) : null}

      {view === "needsManualReview" ? (
        <p className="job-search-panel-hint">
          A submission attempt (approved by hand, or auto-applied) hit at least one required field it couldn't
          confidently fill on its own — expand a row to see exactly which ones. Fill in the missing info in your
          Profile Settings if it's something reusable, then click "Retry" to have the submit worker try again.
        </p>
      ) : null}

      {view === "failed" ? (
        <p className="job-search-panel-hint">
          A submission attempt genuinely failed (a real error, a timeout) or resolved to an ATS platform with no
          submission adapter — expand a row to see the specific error. "Retry" re-queues it for the submit worker;
          if it's the same error every time, it likely needs a code-level fix rather than another attempt.
        </p>
      ) : null}

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
                  onMarkApplied={onMarkApplied}
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
