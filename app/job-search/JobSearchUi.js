"use client";

import { useEffect, useState } from "react";

// Small presentational helpers shared across the job-search panels/tables.
// Finance keeps equivalents inline since it's one 2600-line file; job-search is
// deliberately split into several smaller files, so these live in one shared spot.

export function Field({ label, children }) {
  return (
    <label className="job-search-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Metric({ label, value, tone, detail }) {
  return (
    <div className={`job-search-metric${tone ? ` job-search-metric-${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

export function Panel({ title, action, children, className }) {
  return (
    <section className={`job-search-panel${className ? ` ${className}` : ""}`}>
      <header className="job-search-panel-header">
        <h2>{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

export function Badge({ text, tone = "neutral" }) {
  return <span className={`job-search-badge job-search-badge-${tone}`}>{text}</span>;
}

// Shared modal shell — originally lived only in OverviewPanel.js (as
// HistoryModal) for the worker Activity History popups; pulled out here once
// NotificationsBell.js needed the identical backdrop/header/close pattern for
// its own detail popups, so both stay visually identical for free.
export function Modal({ title, hint, onClose, children, wide = true }) {
  return (
    <div className="job-search-modal-backdrop" onClick={onClose}>
      <div className={`job-search-modal${wide ? " job-search-modal-wide" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="job-search-modal-header">
          <h2>{title}</h2>
          <button type="button" onClick={onClose}>Close</button>
        </div>
        {hint ? <p className="job-search-panel-hint">{hint}</p> : null}
        {children}
      </div>
    </div>
  );
}

// Powers the "New" badge on Applied Jobs / Review Queue rows — a row is
// "new" if its timestamp falls after the LAST time this tab was open, not
// the current moment (which would make everything stop being new the
// instant you look at it). The threshold is frozen once per mount (read
// from localStorage before the first render) and only overwritten with
// "now" afterward, in an effect — so this visit still shows what arrived
// since the last one, and only the NEXT visit's threshold moves forward.
// On a genuinely first-ever visit (nothing stored yet) it defaults to "now"
// rather than 0, so a fresh install doesn't highlight the entire existing
// backlog as new.
//
// Storage-only, same reasoning as NotificationsBell's own read state — see
// jobSearchNotifications.js's comment on why none of this lives server-side.
export function useIsNewSince(storageKey) {
  const [threshold] = useState(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored ? Number(stored) || 0 : Date.now();
    } catch {
      return Date.now();
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(Date.now()));
    } catch {
      // Private-browsing/storage-blocked — the highlight just won't persist
      // across visits, not worth surfacing as an error over.
    }
    // Deliberately no cleanup/dependency beyond the key itself — writing on
    // every render would keep pushing the threshold forward while the tab
    // stays open, making rows go "not new" mid-session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  return (value) => {
    if (!value) return false;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) && ms > threshold;
  };
}

export function scamBadgeTone(level) {
  if (level === "high") return "danger";
  if (level === "medium") return "warn";
  return "neutral";
}

const ATS_TYPE_LABELS = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  workable: "Workable",
  recruitee: "Recruitee",
  personio: "Personio",
  breezy: "Breezy HR",
  smartrecruiters: "SmartRecruiters",
  workday: "Workday",
  icims: "iCIMS",
  oracle_fusion: "Oracle Recruiting Cloud",
  oracle_taleo: "Oracle/Taleo (legacy)",
  // Adzuna-sourced postings are stored with ats_type='external' until
  // something actually resolves the real platform (auto-apply, or a human
  // approving it) — labeled "Adzuna" (not the generic "External" fallback
  // below) so the source is obvious at a glance, distinct from a posting
  // found via direct-poll of a company's own board.
  external: "Adzuna"
};

// Link text for "go to the actual posting" — shows which ATS it's really on
// (or which discovery source, for an unresolved one) instead of a generic
// "Posting" label. The bare "External" fallback is only for a genuinely
// unmapped/unexpected ats_type value, not the normal Adzuna case above.
export function atsTypeLabel(atsType) {
  return ATS_TYPE_LABELS[atsType] || "External";
}

export async function callJobSearchAction(endpoint, action, data) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, data })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || "Something went wrong.");
  return payload.result;
}
