"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { manualOverrideCandidates, normalizeLabel, resolveStandardFieldCandidates, resolveWorkAuthValue } from "../lib/jobSearchAdapters/profileMapping";
import { atsTypeLabel, Badge, Field, scamBadgeTone } from "./JobSearchUi";

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// Distinguishes "this is a fresh result from the retry I just kicked off"
// from "this is stale — my retry hasn't actually landed yet (or never
// triggered)" — a real gap when Save & Retry's own outcome only shows up
// once the submit-worker gets around to it, sometime after the click.
function timeAgo(value) {
  if (!value) return null;
  const ms = Date.now() - new Date(value).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
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

function ReviewQueueRow({ posting, selected, onToggleSelect, onApprove, onReject, onRescore, onMarkApplied, onOpenManualAnswer, latestApplication, saving }) {
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
                      {posting.decidedAt ? (
                        <span className="job-search-cell-note"> — {timeAgo(posting.decidedAt)}{posting.decidedBy ? ` (${posting.decidedBy})` : ""}</span>
                      ) : null}
                    </p>
                  ) : null}

                  {latestApplication?.hasScreenshot ? (
                    // What the adapter's browser actually saw at the moment it
                    // gave up on this attempt — e.g. what widget type a
                    // stubbornly-failing field really is, or what a saved
                    // answer's fill attempt actually looked like — already
                    // captured on every failed/needs_manual_review attempt
                    // (jobSearchAdapters/*.js), just never linked to from here
                    // before now.
                    <p className="job-search-cell-note">
                      <a href={`/api/job-search/applications/${latestApplication.id}/screenshot`} target="_blank" rel="noreferrer">
                        View screenshot from this attempt ({timeAgo(latestApplication.attemptedAt)})
                      </a>
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

// A field the adapter flagged while looking at a select/dropdown/radio-group
// widget carries its REAL option text, captured at the moment it was flagged
// (see each adapter's captureFieldOptions/flagForReview) — rendered below as
// an actual <select> instead of a textarea, so a saved answer is guaranteed
// to be one of the widget's real options rather than free text that might
// not match anything (the "None" typed against a Yes/No-only dropdown that
// silently never filled — confirmed live via jobSearchSubmitWorkerRun logs).
function hasCapturedOptions(field) {
  return Array.isArray(field.options) && field.options.length > 0;
}

// Not every manualReviewFields entry is a QUESTION — a resume/CV upload the
// adapter couldn't confirm (see resumeUploadCheck.js) is a synthetic,
// system-flagged label like "Resume upload (could not confirm success)",
// never a real form field, so there's nothing a typed or selected answer
// could ever match on retry (resolveManualOverride() matches against the
// ATS's own field labels, and this was never one). Confirmed live this was
// a real dead end: the popup still demanded SOME non-blank text here before
// Save & Retry would enable at all, with no indication anything typed would
// do nothing. Matches every adapter's own wording (greenhouse/workable:
// "Resume upload (...)"; ashby/breezy: "Resume upload (<reason>)" or bare
// "Resume upload"; personio: "CV upload (...)"/"CV upload"; oracleFusion:
// "Resume/CV upload (...)"/"Resume/CV upload").
function isResumeUploadFlag(label) {
  return /^(resume(\/cv)?|cv)\s+upload\b/i.test(label || "");
}

function asAnswerCandidates(value) {
  if (value === true) return ["Yes", "true"];
  if (value === false) return ["No", "false"];
  return manualOverrideCandidates(value);
}

function pickOptionAnswer(field, candidates) {
  if (!hasCapturedOptions(field)) return candidates.find((candidate) => String(candidate || "").trim()) || "";

  for (const candidate of candidates) {
    const target = String(candidate || "").trim().toLowerCase();
    if (!target) continue;
    const option = field.options.find((optionText) => String(optionText || "").trim().toLowerCase() === target);
    if (option) return option;
  }

  return "";
}

function pastSubmittedAnswer(field, posting, applications) {
  const target = normalizeLabel(field.label);
  for (const application of applications || []) {
    if (application.postingId !== posting.id) continue;
    for (const [label, answer] of Object.entries(application.submittedAnswers || {})) {
      if (normalizeLabel(label) === target && answer != null && answer !== "") return answer;
    }
  }
  return null;
}

function profileAnswerCandidates(field, profile) {
  const normalized = normalizeLabel(field.label);
  const workAuthValue = resolveWorkAuthValue(normalized, profile?.workAuthorization);
  return [
    ...resolveStandardFieldCandidates(normalized, profile || {}, field.label),
    ...(workAuthValue ? [workAuthValue] : [])
  ];
}

function memoryAnswer(field, answerMemory) {
  const target = normalizeLabel(field.label);
  const match = (answerMemory || []).find((entry) => entry.normalizedLabel === target);
  return match?.answer || null;
}

function initialManualAnswer(field, { posting, profile, answerMemory, applications }) {
  const answerSources = [
    field.answer,
    pastSubmittedAnswer(field, posting, applications),
    profileAnswerCandidates(field, profile),
    memoryAnswer(field, answerMemory)
  ];

  for (const source of answerSources) {
    const candidates = Array.isArray(source) ? source.flatMap(asAnswerCandidates) : asAnswerCandidates(source);
    const answer = pickOptionAnswer(field, candidates);
    if (answer) return answer;
  }

  return "";
}

// The "Answer & Retry" popup — one field per entry the submit worker
// couldn't confidently fill on its own (see jobSearchSubmitWorkerRun.js /
// profileMapping.js's resolveManualOverride), pre-filled with whatever answer
// was already saved for it (if any). A textarea for free-text fields, a real
// <select> for anything with captured options (see hasCapturedOptions above).
// "Polish with AI" refines just that one field's current draft in place —
// skipped for select-backed fields, there's no wording to polish about a
// discrete choice; "Save & Retry" persists every field's current text/choice
// and re-queues the posting exactly like the plain "Retry" button does. Same
// `.job-search-modal` backdrop/header structure as OverviewPanel.js's own
// HistoryModal, kept local here rather than shared — this one's body is a
// form, not a list/table, so there's little to share beyond the outer shell.
function ManualAnswerModal({ posting, profile, answerMemory, applications, saving, onClose, onPolish, onSaveAndRetry }) {
  const fields = posting.manualReviewFields || [];
  // A select-backed field only pre-fills when the chosen source exactly
  // matches one of the widget's real options. Sources are tried from most
  // posting-specific to most general: the posting's saved answer, prior
  // same-posting submitted answers (useful after a CAPTCHA/blocker wiped the
  // structured field list), profile-derived values, then exact answer memory.
  const [answers, setAnswers] = useState(() => Object.fromEntries(
    fields.map((f) => [f.label, initialManualAnswer(f, { posting, profile, answerMemory, applications })])
  ));
  const [polishingAll, setPolishingAll] = useState(false);
  const [polishNotes, setPolishNotes] = useState({});
  const [saveError, setSaveError] = useState("");
  const isBusy = Boolean(saving) || polishingAll;
  // Every ANSWERABLE field reaching this popup is required by construction
  // — an adapter only ever pushes a real question's label into
  // manualReviewFields when field.required was true (see e.g. greenhouse.js's
  // own per-field loop) — so a blank answer here isn't "optional, skip it",
  // it's a guaranteed repeat of the exact same manual-review outcome.
  // Confirmed live this was the actual failure mode behind "Answer & Retry
  // doesn't work": nothing stopped Save & Retry with a field left blank, it
  // just silently submitted an empty override for it (ignored by
  // resolveManualOverride, same as never having answered at all) with no
  // indication that's what happened. A resume-upload flag is excluded here —
  // see isResumeUploadFlag's own comment for why nothing typed there could
  // ever do anything, so it can't be allowed to block Save & Retry the same
  // way a real blank question does.
  const answerableFields = fields.filter((f) => !isResumeUploadFlag(f.label));
  const blankLabels = answerableFields.map((f) => f.label).filter((label) => !(answers[label] || "").trim());
  const allAnswered = blankLabels.length === 0;

  // Fields with captured options are excluded below — no free-text draft to
  // polish, and hiding the whole button (further down) when nothing left is
  // actually polishable relies on this same set.
  const optionLabels = new Set(fields.filter(hasCapturedOptions).map((f) => f.label));
  // Neither a select-backed field nor a resume-upload flag (see
  // isResumeUploadFlag above — no textarea is even rendered for one) has a
  // free-text draft to polish — used below to hide "Polish all with AI"
  // entirely when nothing in this popup actually qualifies.
  const polishableFieldCount = fields.filter((f) => !hasCapturedOptions(f) && !isResumeUploadFlag(f.label)).length;

  // One button polishes every field with a draft in it, one request at a
  // time (not concurrently — this shares the same daily LLM-call budget as
  // everything else, and firing them all at once would just race each other
  // against it). Each field's own draft is read from this closure once, up
  // front — later iterations' setAnswers calls only ever touch OTHER
  // fields, so there's no stale-state dependency between them.
  async function handlePolishAll() {
    const labelsWithDrafts = Object.keys(answers)
      .filter((label) => (answers[label] || "").trim())
      .filter((label) => !optionLabels.has(label));
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
    if (!allAnswered) {
      setSaveError(
        blankLabels.length === 1
          ? `"${blankLabels[0]}" is still blank — every field here is required, so retrying now would just land back in Manual Review on that one again.`
          : `${blankLabels.length} fields are still blank — every field here is required, so retrying now would just land back in Manual Review on those again.`
      );
      return;
    }
    setSaveError("");
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
          its own {answerableFields.length > 0
            ? `(${answerableFields.length - blankLabels.length}/${answerableFields.length} answered — every one is `
              + "required, scroll down if that count looks off). "
            : "— nothing here needs an answer from you (see below). "}
          A dropdown was a real widget on the page, so it only offers its actual options — pick one rather than
          typing. "Polish all with AI" refines every free-text draft's wording without inventing anything you didn't
          say; it's optional. Saving retries the submission using these answers.
        </p>

        {fields.map((field) => {
          if (isResumeUploadFlag(field.label)) {
            return (
              <Field key={field.label} label={`ℹ ${field.label}`}>
                <p className="job-search-panel-hint">
                  Not a question — the submit worker couldn't confirm your resume actually attached. There's nothing
                  to type here; retrying re-attempts the upload itself, and that alone might just work this time.
                  If it keeps landing back here, something about this posting's upload widget may need a closer
                  look.
                </p>
              </Field>
            );
          }
          const answered = Boolean((answers[field.label] || "").trim());
          const optioned = hasCapturedOptions(field);
          return (
            <Field key={field.label} label={`${answered ? "✓ " : "○ "}${field.label}`}>
              {optioned ? (
                <select
                  value={answers[field.label] || ""}
                  disabled={isBusy}
                  className={answered ? "" : "job-search-field-required-empty"}
                  onChange={(e) => setAnswers((prev) => ({ ...prev, [field.label]: e.target.value }))}
                >
                  <option value="">— select an answer —</option>
                  {field.options.map((optionText) => (
                    <option key={optionText} value={optionText}>{optionText}</option>
                  ))}
                </select>
              ) : (
                <textarea
                  rows={3}
                  value={answers[field.label] || ""}
                  disabled={isBusy}
                  className={answered ? "" : "job-search-field-required-empty"}
                  onChange={(e) => setAnswers((prev) => ({ ...prev, [field.label]: e.target.value }))}
                />
              )}
              {polishNotes[field.label] ? <small>{polishNotes[field.label]}</small> : null}
            </Field>
          );
        })}

        {saveError ? <p className="job-search-alert job-search-alert-error">{saveError}</p> : null}

        {polishNotes._all ? <p className="job-search-alert">{polishNotes._all}</p> : null}

        <div className="job-search-form-actions">
          {polishableFieldCount > 0 ? (
            <button type="button" disabled={isBusy} onClick={handlePolishAll}>
              {polishingAll ? "Polishing..." : "Polish all with AI"}
            </button>
          ) : null}
          <button type="button" disabled={isBusy} onClick={handleSaveAndRetry}>Save &amp; Retry</button>
          <button type="button" disabled={isBusy} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export default function ReviewQueueTable({
  postings, scoredLow, autoApplySkipped, approvedWaiting, autoApplyQueue, autoApplyEnabled,
  needsManualReview, failedPostings, applications, profile, answerMemory,
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

  // One lookup, built once — `applications` already comes back newest-first
  // (see jobSearchApplicationStore.js's listApplications), so the first hit
  // per postingId is the latest attempt. Lets a row link straight to the
  // screenshot from whatever actually just happened to it, instead of
  // guessing blind at what a stubbornly-failing field's real widget looks
  // like.
  const latestApplicationByPostingId = new Map();
  for (const application of applications || []) {
    if (!latestApplicationByPostingId.has(application.postingId)) {
      latestApplicationByPostingId.set(application.postingId, application);
    }
  }

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
                  latestApplication={latestApplicationByPostingId.get(posting.id)}
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
          profile={profile}
          answerMemory={answerMemory}
          applications={applications}
          saving={saving}
          onClose={() => setManualAnswerPosting(null)}
          onPolish={onPolishManualAnswer}
          onSaveAndRetry={onSaveManualAnswersAndRetry}
        />
      ) : null}
    </section>
  );
}
