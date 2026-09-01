"use client";

import { useEffect, useRef, useState } from "react";
import { atsTypeLabel, Badge, Modal } from "./JobSearchUi";

// How often to check for new notifications — same idea as OverviewPanel's
// WORKER_STATUS_POLL_MS, just a bit longer since "a new run happened" is a
// coarser signal than worker heartbeats and doesn't need sub-minute latency.
const POLL_MS = 45000;

// Read/unread lives in the browser, not the server — see
// jobSearchNotifications.js's own comment on why this feed has no DB-backed
// read state at all.
const LAST_SEEN_KEY = "job-search-notifications-seen-at";

function timeAgo(value) {
  if (!value) return "—";
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return "—";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function readLastSeen() {
  try {
    return Number(localStorage.getItem(LAST_SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeLastSeen(value) {
  try {
    localStorage.setItem(LAST_SEEN_KEY, String(value));
  } catch {
    // Private-browsing/storage-blocked — the badge just won't remember
    // across visits, not worth surfacing as an error over.
  }
}

// A posting surfaced in a "Found X new jobs" popup didn't necessarily land
// on the same path — some clear auto-apply's free thresholds immediately,
// most wait on a human. This reads the posting's CURRENT status (a live
// join, not a snapshot of the moment it was found), so re-opening an old
// notification shows what actually happened to it since.
const POSTING_STATUS_META = {
  new: { label: "Not yet scored", tone: "neutral" },
  filtered_out: { label: "Filtered out", tone: "neutral" },
  below_threshold: { label: "Below match threshold", tone: "neutral" },
  scored_low: { label: "Scored low", tone: "warn" },
  pending_review: { label: "Needs your review", tone: "warn" },
  approved: { label: "Approved — queued", tone: "neutral" },
  rejected: { label: "Rejected", tone: "danger" },
  skipped_auto_apply: { label: "Skipped auto-apply", tone: "neutral" },
  submitted: { label: "Auto-applied", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  needs_manual_review: { label: "Needs manual review", tone: "danger" },
  unsupported_ats: { label: "Unsupported ATS", tone: "danger" },
  closed: { label: "Closed / delisted", tone: "neutral" },
  duplicate: { label: "Duplicate", tone: "neutral" }
};

function PostingStatusBadge({ status }) {
  const meta = POSTING_STATUS_META[status] || { label: status || "Unknown", tone: "neutral" };
  return <Badge text={meta.label} tone={meta.tone} />;
}

function JobsFoundDetail({ state }) {
  if (state.loading) return <p className="job-search-empty">Loading…</p>;
  if (state.error) return <p className="job-search-alert job-search-alert-error">{state.error}</p>;
  const { newPostings } = state.data;
  if (newPostings.length === 0) return <p className="job-search-empty">No new postings recorded for this run.</p>;
  return (
    <div className="job-search-table-scroll">
      <table className="job-search-table">
        <thead><tr><th>Job</th><th>ATS</th><th>Status</th><th>Link</th></tr></thead>
        <tbody>
          {newPostings.map((p) => (
            <tr key={p.id}>
              <td><strong>{p.title}</strong><div className="job-search-cell-note">{p.companyName}</div></td>
              <td>{atsTypeLabel(p.atsType)}</td>
              <td><PostingStatusBadge status={p.status} /></td>
              <td>{p.applyUrl ? <a href={p.applyUrl} target="_blank" rel="noreferrer">View</a> : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ApplicationsDetail({ state, kind }) {
  if (state.loading) return <p className="job-search-empty">Loading…</p>;
  if (state.error) return <p className="job-search-alert job-search-alert-error">{state.error}</p>;
  const list = kind === "applied_failed" ? state.data.failed : state.data.submitted;
  if (list.length === 0) return <p className="job-search-empty">Nothing recorded for this run.</p>;
  return (
    <div className="job-search-table-scroll">
      <table className="job-search-table">
        <thead>
          <tr>
            <th>Job</th>
            <th>Applied</th>
            {kind === "applied_failed" ? <th>Reason</th> : <th>Resume used</th>}
            <th>Link</th>
          </tr>
        </thead>
        <tbody>
          {list.map((a) => (
            <tr key={a.id}>
              <td><strong>{a.jobTitle}</strong><div className="job-search-cell-note">{a.companyName} · {a.atsType}</div></td>
              <td><Badge text={a.autoApplied ? "Auto" : "Manual"} tone={a.autoApplied ? "success" : "neutral"} /></td>
              {kind === "applied_failed"
                ? <td className="job-search-cell-note">{a.errorMessage || "No error message recorded."}</td>
                : <td>{a.resumeLabel || "—"}</td>}
              <td>{a.applyUrl ? <a href={a.applyUrl} target="_blank" rel="noreferrer">{atsTypeLabel(a.atsType)}</a> : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const NOTIF_MODAL_TITLES = {
  jobs_found: "New jobs found",
  applied_success: "Applications submitted",
  applied_failed: "Applications that failed"
};

export default function NotificationsBell() {
  const [notifications, setNotifications] = useState([]);
  const [open, setOpen] = useState(false);
  const [lastSeen, setLastSeen] = useState(0);
  // null | { notification, loading, data, error }
  const [detail, setDetail] = useState(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    setLastSeen(readLastSeen());
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const response = await fetch("/api/job-search/notifications");
        if (!response.ok) return;
        const payload = await response.json().catch(() => null);
        if (!cancelled && Array.isArray(payload?.notifications)) setNotifications(payload.notifications);
      } catch {
        // Best-effort — a missed poll just means the next one catches up.
      }
    }
    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // The dropdown has no backdrop of its own (unlike the detail popup below,
  // which reuses the full-screen Modal) — this is what makes an outside
  // click close it.
  useEffect(() => {
    if (!open) return undefined;
    function onDocClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const unreadCount = notifications.filter((n) => new Date(n.ranAt).getTime() > lastSeen).length;

  // Opening the dropdown is what marks everything currently in it as seen —
  // same convention as a typical bell icon (Gmail/Slack-style), not a
  // separate "mark all read" step.
  function toggleOpen() {
    setOpen((wasOpen) => {
      const willOpen = !wasOpen;
      if (willOpen && notifications.length > 0) {
        const newest = Math.max(...notifications.map((n) => new Date(n.ranAt).getTime()));
        writeLastSeen(newest);
        setLastSeen(newest);
      }
      return willOpen;
    });
  }

  async function openDetail(notification) {
    setOpen(false);
    setDetail({ notification, loading: true, data: null, error: "" });
    try {
      const endpoint = notification.type === "jobs_found"
        ? `/api/job-search/discovery-runs/${notification.refId}`
        : `/api/job-search/submit-runs/${notification.refId}`;
      const response = await fetch(endpoint);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "Failed to load details.");
      setDetail({ notification, loading: false, data: payload, error: "" });
    } catch (err) {
      setDetail({ notification, loading: false, data: null, error: err?.message || "Failed to load details." });
    }
  }

  return (
    <div className="job-search-notif-wrap" ref={wrapRef}>
      <button
        type="button"
        className="job-search-notif-btn"
        aria-label={unreadCount > 0 ? `${unreadCount} new updates` : "Notifications"}
        title="Notifications"
        onClick={toggleOpen}
      >
        🔔
        {unreadCount > 0 ? <span className="job-search-notif-dot">{unreadCount > 9 ? "9+" : unreadCount}</span> : null}
      </button>

      {open ? (
        <div className="job-search-notif-dropdown">
          <div className="job-search-notif-dropdown-header">Latest updates</div>
          {notifications.length === 0 ? (
            <p className="job-search-empty">Nothing to report yet.</p>
          ) : (
            <ul className="job-search-notif-list">
              {notifications.map((n) => (
                <li key={n.id}>
                  <button type="button" className="job-search-notif-item" onClick={() => openDetail(n)}>
                    <span>{n.message}</span>
                    <span className="job-search-notif-item-time">{timeAgo(n.ranAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {detail ? (
        <Modal title={NOTIF_MODAL_TITLES[detail.notification.type] || "Details"} onClose={() => setDetail(null)}>
          {detail.notification.type === "jobs_found"
            ? <JobsFoundDetail state={detail} />
            : <ApplicationsDetail state={detail} kind={detail.notification.type} />}
        </Modal>
      ) : null}
    </div>
  );
}
