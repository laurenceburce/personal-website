"use client";

import { useRef, useState } from "react";
import { Panel } from "./JobSearchUi";

function timeAgo(value) {
  if (!value) return "—";
  const ms = Date.now() - new Date(value).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Oracle Recruiting Cloud (Fusion)'s apply flow needs a one-time emailed
// verification code per company before it lets an application through — see
// app/lib/jobSearchAdapters/oracleFusion.js's header comment. This panel
// only manages the sessions a human already connected themselves via
// scripts/job-search-oracle-connect.mjs (check email, type the code): one
// row per tenant, since a session on one company's Oracle instance doesn't
// carry over to another's. The uploaded file's own tenantHost field decides
// which tenant a session belongs to — never a hand-typed hostname here, so
// there's no chance of attaching a session to the wrong company.
export default function OracleSessionsPanel({ sessions, saving, onUploadSession, onDeleteSession }) {
  const [label, setLabel] = useState("");
  const fileInputRef = useRef(null);
  const isBusy = Boolean(saving);

  async function handleUpload(event) {
    event.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append("file", file);
    if (label) formData.append("label", label);

    await onUploadSession(formData);
    setLabel("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  return (
    <Panel title="Oracle Recruiting Cloud sessions" className="job-search-oracle-panel">
      <p className="job-search-panel-hint">
        Oracle Recruiting Cloud requires a one-time emailed verification code before it lets an application
        through — no password, no third-party SSO, just your email. Run{" "}
        <code>node scripts/job-search-oracle-connect.mjs --url=&lt;a job&apos;s apply link on that company&apos;s
        Oracle-hosted careers site&gt;</code> once per company, check your email and type in the code when
        prompted, then upload the session file it saves below.
      </p>

      {sessions.length === 0 ? (
        <p className="job-search-empty">No Oracle sessions connected yet.</p>
      ) : (
        <ul className="job-search-resume-list">
          {sessions.map((session) => (
            <li key={session.id} className="job-search-resume-row">
              <div>
                <strong>{session.label || session.tenantHost}</strong>
                <span className="job-search-cell-note">
                  {session.tenantHost} · connected {timeAgo(session.capturedAt)} · uploaded {timeAgo(session.updatedAt)}
                </span>
              </div>
              <button type="button" disabled={isBusy} onClick={() => onDeleteSession(session.id)}>Remove</button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleUpload} className="job-search-form job-search-inline-form">
        <input ref={fileInputRef} type="file" accept=".json" required />
        <input
          type="text"
          placeholder="Label (optional)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <button type="submit" disabled={isBusy}>Upload session</button>
      </form>
    </Panel>
  );
}
