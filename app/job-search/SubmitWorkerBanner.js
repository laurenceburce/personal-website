"use client";

import { useState } from "react";
import { Badge, Metric, Modal } from "./JobSearchUi";

// Same attempt-outcome vocabulary as OverviewPanel.js's PROGRESS_ITEM_META —
// kept as its own copy rather than a shared export since it's a small fixed
// lookup, not worth the indirection of a third shared file for two callers.
const PROGRESS_ITEM_META = {
  in_progress: { label: "Working…", tone: "warn" },
  submitted: { label: "Submitted", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  needs_manual_review: { label: "Needs manual review", tone: "danger" },
  unsupported_ats: { label: "Unsupported ATS", tone: "danger" },
  skipped_auto_apply: { label: "Skipped", tone: "neutral" }
};

function timeAgo(value) {
  if (!value) return "—";
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return "—";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

// Toolbar pill — beside NotificationsBell.js — that only exists while the
// submit worker actually has a pass in flight (see `progress` prop, fed by
// the shared SSE subscription in JobSearchAppClient.js). Clicking it opens a
// popup with the full item-by-item breakdown of the run; that popup keeps
// updating live too (same shared `progress` object), and deliberately stays
// open through the run finishing rather than disappearing out from under
// whoever's reading it the moment the last job wraps up.
export default function SubmitWorkerBanner({ progress }) {
  const [open, setOpen] = useState(false);
  const isRunning = progress?.status === "running";

  if (!isRunning && !open) return null;

  const total = (progress?.submittingTotal || 0) + (progress?.autoApplyTotal || 0);
  const pct = total > 0 ? Math.min(100, Math.round(((progress?.processedCount || 0) / total) * 100)) : 0;
  const items = progress?.items || [];

  return (
    <>
      {isRunning ? (
        <button type="button" className="job-search-submit-banner" onClick={() => setOpen(true)}>
          <span className="job-search-submit-banner-dot" aria-hidden="true" />
          Working{total > 0 ? ` — ${progress.processedCount}/${total}` : ""}
          <span className="job-search-submit-banner-bar" style={{ width: `${pct}%` }} aria-hidden="true" />
        </button>
      ) : null}

      {open ? (
        <Modal title="Submit Worker — Current Run" onClose={() => setOpen(false)}>
          <div className="job-search-field-grid">
            <Metric label="Status" value={isRunning ? "Working" : "Finished"} tone={isRunning ? "warn" : "success"} />
            <Metric label="Progress" value={`${progress?.processedCount || 0} / ${total || "?"}`} />
            <Metric label="Started" value={timeAgo(progress?.startedAt)} />
          </div>

          {isRunning && progress?.currentItem ? (
            <p className="job-search-cell-note">
              Now processing: <strong>{progress.currentItem.title}</strong> at {progress.currentItem.companyName}
              {" — "}{progress.currentItem.phase === "auto_apply" ? "auto-apply" : "approved queue"}
            </p>
          ) : null}

          {items.length === 0 ? (
            <p className="job-search-empty">Nothing processed yet.</p>
          ) : (
            <div className="job-search-table-scroll">
              <table className="job-search-table">
                <thead><tr><th>Job</th><th>Queue</th><th>Outcome</th></tr></thead>
                <tbody>
                  {[...items].reverse().map((item, i) => {
                    const meta = PROGRESS_ITEM_META[item.status] || { label: "Working…", tone: "warn" };
                    return (
                      <tr key={`${item.postingId}-${i}`}>
                        <td><strong>{item.title}</strong><div className="job-search-cell-note">{item.companyName}</div></td>
                        <td>{item.phase === "auto_apply" ? "Auto-apply" : "Approved queue"}</td>
                        <td><Badge text={meta.label} tone={meta.tone} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      ) : null}
    </>
  );
}
