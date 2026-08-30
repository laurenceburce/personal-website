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

// Oracle Recruiting Cloud's own login step never happens inside this app —
// see app/lib/jobSearchAdapters/oracleRecruiting.js's header comment for
// why. This panel only manages the sessions a human already captured
// themselves via scripts/job-search-oracle-login.mjs: one row per tenant
// (a login on one company's Oracle instance doesn't carry over to another's),
// upload to replace/add, remove to disconnect. The uploaded file's own
// tenantHost field decides which tenant a session belongs to — never a
// hand-typed hostname here, so there's no chance of attaching a session to
// the wrong company.
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
        Most Oracle Recruiting Cloud tenants require a signed-in candidate before the apply form even renders, and
        this app never types a password or SSO login into a third-party site on your behalf — that step always
        happens in a real browser you control, on your own machine. Run{" "}
        <code>node scripts/job-search-oracle-login.mjs --url=&lt;a company&apos;s Oracle career site&gt;</code>{" "}
        once per company, sign in yourself in the window it opens, then upload the session file it saves below.
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
                  {session.tenantHost} · captured {timeAgo(session.capturedAt)} · uploaded {timeAgo(session.updatedAt)}
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
