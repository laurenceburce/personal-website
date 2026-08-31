"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { atsTypeLabel, Badge, Field, scamBadgeTone } from "./JobSearchUi";

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

function ReviewQueueRow({ posting, selected, onToggleSelect, onApprove, onReject, onRescore, onMarkApplied, onOpenManualAnswer, saving }) {
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
  // The targeted alternative to plain "Retry" — only makes sense once there's
  // an actual structured field list to answer (older postings from before
  // this existed only ever got the flattened decisionNote string).
  const hasAnswerableFields = posting.status === "needs_manual_review" && posting.manualReviewFields?.length > 0;

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
          ) : posting.isAutoApplyQueuePreview ? (
            <Badge text="Auto-apply eligible" tone="success" />
          ) : posting.status === "skipped_auto_apply" ? (
            <Badge text={SKIP_REASON_LABELS[posting.autoApplySkipReason] || "Skipped"} tone="warn" />
          ) : posting.status === "needs_manual_review" ? (
            <Badge text="Needs manual review" tone="warn" />
          ) : posting.status === "unsupported_ats" ? (
            <Badge text="Unsupported ATS" tone="danger" />
          ) : posting.status === "failed" ? (
            <Badge text="Failed" tone="danger" />
          ) : (
            <>
              {posting.status === "scored_low" ? <><Badge text="Scored low" tone="warn" /> </> : null}
              <Badge text={`${posting.scamRiskLevel || "low"}${posting.scamRiskScore ? ` (${posting.scamRiskScore})` : ""}`} tone={scamBadgeTone(posting.scamRiskLevel)} />
            </>
          )}
        </td>
        <td>{formatDate(posting.postedAt)}</td>
        <td className="job-search-row-actions" onClick={(e) => e.stopPropagation()}>
          {posting.applyUrl ? <a href={posting.applyUrl} target="_blank" rel="noreferrer">{atsTypeLabel(posting.atsType)}</a> : null}
          {posting.status !== "approved" ? (
            <>
              <button type="button" disabled={isBusy} onClick={() => onApprove(posting.id)}>{isRetryable ? "Retry" : "Approve"}</button>
              {hasAnswerableFields ? (
                <button type="button" disabled={isBusy} onClick={() => onOpenManualAnswer(posting)}>Answer &amp; Retry</button>
              ) : null}
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

// The "Answer & Retry" popup — one textarea per field the submit worker
// couldn't confidently fill on its own (see jobSearchSubmitWorkerRun.js /
// profileMapping.js's resolveManualOverride), pre-filled with whatever answer
// was already saved for it (if any). "Polish with AI" refines just that one
// field's current draft in place; "Save & Retry" persists every field's
// current text and re-queues the posting exactly like the plain "Retry"
// button does. Same `.job-search-modal` backdrop/header structure as
// OverviewPanel.js's own HistoryModal, kept local here rather than shared —
// this one's body is a form, not a list/table, so there's little to share
// beyond the outer shell.
function ManualAnswerModal({ posting, saving, onClose, onPolish, onSaveAndRetry }) {
  const [answers, setAnswers] = useState(() => Object.fromEntries(
    (posting.manualReviewFields || []).map((f) => [f.label, f.answer || ""])
  ));
  const [polishingAll, setPolishingAll] = useState(false);
  const [polishNotes, setPolishNotes] = useState({});
  const isBusy = Boolean(saving) || polishingAll;

  // One button polishes every field with a draft in it, one request at a
  // time (not concurrently — this shares the same daily LLM-call budget as
  // everything else, and firing them all at once would just race each other
  // against it). Each field's own draft is read from this closure once, up
  // front — later iterations' setAnswers calls only ever touch OTHER
  // fields, so there's no stale-state dependency between them.
  async function handlePolishAll() {
    const labelsWithDrafts = Object.keys(answers).filter((label) => (answers[label] || "").trim());
    if (labelsWithDrafts.length === 0) {
      setPolishNotes({ _all: "Type an answer in at least one field first, then polish." });
      return;
    }
    setPolishingAll(true);
    setPolishNotes({});
    for (const label of labelsWithDrafts) {
      const draft = answers[label].trim();
      try {
        const result = await onPolish(posting.id, label, draft);
        if (result?.polished) {
          setAnswers((prev) => ({ ...prev, [label]: result.polished }));
        } else {
          setPolishNotes((prev) => ({ ...prev, [label]: "AI couldn't improve this — unchanged." }));
        }
      } catch (err) {
        setPolishNotes((prev) => ({ ...prev, [label]: err?.message || "Polish failed." }));
      }
    }
    setPolishingAll(false);
  }

  async function handleSaveAndRetry() {
    const payload = Object.entries(answers).map(([label, answer]) => ({ label, answer: answer.trim() }));
    await onSaveAndRetry(posting.id, payload);
    onClose();
  }

  return (
    <div className="job-search-modal-backdrop" onClick={onClose}>
      <div className="job-search-modal" onClick={(e) => e.stopPropagation()}>
        <div className="job-search-modal-header">
          <h2>Answer &amp; Retry</h2>
          <button type="button" onClick={onClose}>Close</button>
        </div>
        <p className="job-search-panel-hint">
          {posting.title} at {posting.companyName} — answer whatever the submit worker couldn't confidently fill on
          its own. "Polish all with AI" refines every draft's wording without inventing anything you didn't say;
          it's optional. Saving retries the submission using these answers.
        </p>

        {(posting.manualReviewFields || []).map((field) => (
          <Field key={field.label} label={field.label}>
            <textarea
              rows={3}
              value={answers[field.label] || ""}
              disabled={isBusy}
              onChange={(e) => setAnswers((prev) => ({ ...prev, [field.label]: e.target.value }))}
            />
            {polishNotes[field.label] ? <small>{polishNotes[field.label]}</small> : null}
          </Field>
        ))}

        {polishNotes._all ? <p className="job-search-alert">{polishNotes._all}</p> : null}

        <div className="job-search-form-actions">
          <button type="button" disabled={isBusy} onClick={handlePolishAll}>
            {polishingAll ? "Polishing..." : "Polish all with AI"}
          </button>
          <button type="button" disabled={isBusy} onClick={handleSaveAndRetry}>Save &amp; Retry</button>
          <button type="button" disabled={isBusy} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export default function ReviewQueueTable({
  postings, scoredLow, autoApplySkipped, approvedWaiting, autoApplyQueue, autoApplyEnabled,
  needsManualReview, failedPostings,
  saving, onApprove, onReject, onBatchApprove, onBatchReject, onRescore, onMarkApplied,
  onPolishManualAnswer, onSaveManualAnswersAndRetry
}) {
  const [selected, setSelected] = useState(new Set());
  const [view, setView] = useState("all");
  // The full posting object (not just an id) — its manualReviewFields are
  // only ever present on the needs_manual_review-status objects reaching this
  // component, and storing the object directly avoids a second lookup keyed
  // off whichever view/list the row that opened it happened to be in.
  const [manualAnswerPosting, setManualAnswerPosting] = useState(null);

  // Four tabs instead of seven — each one a union of statuses that share the
  // same next action, not a 1:1 mirror of every distinct posting.status
  // value. Every row still carries its own specific reason/tag regardless of
  // which tab merged it in (see ReviewQueueRow's badge switch above) — this
  // only changes how the lists are grouped, not what's shown per posting.
  const allView = [...postings, ...(scoredLow || [])];
  const autoApplyFailedView = [...(autoApplySkipped || []), ...(failedPostings || [])];
  // Tagged so the row can show "Auto-apply eligible" instead of falling
  // through to a generic scam-risk badge — these are still pending_review,
  // not actually approved yet, just a preview of what auto-apply would pick
  // up next (see jobSearchAutoApplyGates.js).
  const inQueueView = [
    ...(approvedWaiting || []),
    ...(autoApplyQueue || []).map((p) => ({ ...p, isAutoApplyQueuePreview: true }))
  ];

  const list = view === "manualReview" ? (needsManualReview || [])
    : view === "autoApplyFailed" ? autoApplyFailedView
    : view === "inQueue" ? inQueueView
    : allView;
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
        <h2>Review</h2>
        <div className="job-search-toggle-group">
          <button type="button" className={view === "all" ? "job-search-toggle-active" : ""} onClick={() => switchList("all")}>
            All ({allView.length})
          </button>
          <button type="button" className={view === "manualReview" ? "job-search-toggle-active" : ""} onClick={() => switchList("manualReview")}>
            Manual Review ({(needsManualReview || []).length})
          </button>
          <button type="button" className={view === "autoApplyFailed" ? "job-search-toggle-active" : ""} onClick={() => switchList("autoApplyFailed")}>
            Auto-apply Failed ({autoApplyFailedView.length})
          </button>
          <button type="button" className={view === "inQueue" ? "job-search-toggle-active" : ""} onClick={() => switchList("inQueue")}>
            In Queue ({inQueueView.length})
          </button>
        </div>
      </header>

      {view === "all" ? (
        <p className="job-search-panel-hint">
          Every posting that's been scored and is waiting on a decision — including ones scored below your
          review/auto-apply threshold, tagged "Scored low". Approve, reject, or re-score any of them.
        </p>
      ) : null}

      {view === "manualReview" ? (
        <p className="job-search-panel-hint">
          A submission attempt hit at least one required field it couldn't confidently fill on its own — expand a
          row to see exactly which ones. If it's something reusable, fill it into your Profile Settings and click
          "Retry"; if it's specific to this posting (a question only this company asks), click "Answer &amp; Retry"
          to type an answer for just those fields and have the submit worker try again with them.
        </p>
      ) : null}

      {view === "autoApplyFailed" ? (
        <p className="job-search-panel-hint">
          Either auto-apply declined to even attempt a submission (a skip reason — below the score/match/scam-risk/
          freshness threshold, an unanswerable field, CAPTCHA, or an unsupported ATS) or a real submission attempt
          genuinely errored out — expand a row to see which. "Retry" re-queues it for the submit worker; if it's
          the same error every time, it likely needs a code-level fix rather than another attempt.
        </p>
      ) : null}

      {view === "inQueue" ? (
        <p className="job-search-panel-hint">
          Everything either confirmed queued for the submit worker ("Waiting for worker") or, if auto-apply is
          enabled, eligible to be auto-applied to on its next run ("Auto-apply eligible" — a preview, not a
          guarantee, since a posting can still get skipped afterward for a reason only discoverable by actually
          attempting it).
          {!autoApplyEnabled ? " Auto-apply is currently disabled in Job Find Settings, so only approved postings show here." : ""}
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
                <th>Status</th>
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
                  onOpenManualAnswer={setManualAnswerPosting}
                  saving={saving}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {manualAnswerPosting ? (
        <ManualAnswerModal
          posting={manualAnswerPosting}
          saving={saving}
          onClose={() => setManualAnswerPosting(null)}
          onPolish={onPolishManualAnswer}
          onSaveAndRetry={onSaveManualAnswersAndRetry}
        />
      ) : null}
    </section>
  );
}
