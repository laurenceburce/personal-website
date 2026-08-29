"use client";

import { useMemo, useState } from "react";
import { Badge, Field, Panel } from "./JobSearchUi";

// Kept as a local constant rather than importing from jobSearchWatchlistStore.js —
// that file pulls in mysql2, which is Node-only and can't ship to the browser.
const ATS_TYPES = ["greenhouse", "lever", "ashby"];

const EMPTY_FORM = { companyName: "", atsType: "greenhouse", boardToken: "", isActive: true };

function pollStatusTone(entry) {
  if (entry.lastPollStatus === "error") return "danger";
  if (entry.lastPollStatus === "pending") return "neutral";
  return "success";
}

export default function WatchlistPanel({ watchlist, saving, onCreate, onUpdate, onDelete }) {
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const isBusy = Boolean(saving);

  const sorted = useMemo(
    () => [...watchlist].sort((a, b) => a.companyName.localeCompare(b.companyName)),
    [watchlist]
  );

  function openCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setShowModal(true);
  }

  function openEdit(entry) {
    setEditingId(entry.id);
    setForm({ companyName: entry.companyName, atsType: entry.atsType, boardToken: entry.boardToken, isActive: entry.isActive });
    setShowModal(true);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (editingId) await onUpdate(editingId, form);
    else await onCreate(form);
    setShowModal(false);
  }

  async function handleDelete(entry) {
    if (!window.confirm(`Remove ${entry.companyName} from the watchlist?`)) return;
    await onDelete(entry.id);
  }

  return (
    <Panel
      title="Watchlist"
      className="job-search-watchlist-panel"
      action={<button type="button" onClick={openCreate} disabled={isBusy}>Add company</button>}
    >
      <p className="job-search-panel-hint">
        Companies the poller checks every cron cycle. The board token is the identifier from the
        company&apos;s own careers page URL (e.g. boards.greenhouse.io/<strong>asana</strong>, jobs.lever.co/<strong>company</strong>,
        jobs.ashbyhq.com/<strong>company</strong>).
      </p>

      {sorted.length === 0 ? (
        <p className="job-search-empty">No companies on the watchlist yet.</p>
      ) : (
        <div className="job-search-table-scroll">
          <table className="job-search-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>ATS</th>
                <th>Board token</th>
                <th>Status</th>
                <th>Last poll</th>
                <th>Jobs found</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.companyName}</td>
                  <td>{entry.atsType}</td>
                  <td><code>{entry.boardToken}</code></td>
                  <td>
                    <Badge text={entry.isActive ? "Active" : "Paused"} tone={entry.isActive ? "success" : "neutral"} />
                  </td>
                  <td>
                    <Badge text={entry.lastPollStatus} tone={pollStatusTone(entry)} />
                    {entry.lastPollError ? <div className="job-search-cell-note">{entry.lastPollError}</div> : null}
                  </td>
                  <td>{entry.jobsFoundLastPoll}</td>
                  <td className="job-search-row-actions">
                    <button type="button" onClick={() => openEdit(entry)} disabled={isBusy}>Edit</button>
                    <button type="button" onClick={() => handleDelete(entry)} disabled={isBusy}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal ? (
        <div
          className="job-search-modal-backdrop"
          role="presentation"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setShowModal(false); }}
        >
          <section className="job-search-modal" role="dialog" aria-modal="true" aria-labelledby="job-search-watchlist-modal-title">
            <header className="job-search-modal-header">
              <h2 id="job-search-watchlist-modal-title">{editingId ? "Edit company" : "Add company"}</h2>
              <button type="button" onClick={() => setShowModal(false)} aria-label="Close">Close</button>
            </header>

            <form onSubmit={handleSubmit} className="job-search-form">
              <Field label="Company name">
                <input
                  value={form.companyName}
                  onChange={(e) => setForm((f) => ({ ...f, companyName: e.target.value }))}
                  required
                />
              </Field>
              <Field label="ATS">
                <select
                  value={form.atsType}
                  onChange={(e) => setForm((f) => ({ ...f, atsType: e.target.value }))}
                >
                  {ATS_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </Field>
              <Field label="Board token">
                <input
                  value={form.boardToken}
                  onChange={(e) => setForm((f) => ({ ...f, boardToken: e.target.value }))}
                  required
                />
              </Field>
              <Field label="Active">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
                />
              </Field>

              <div className="job-search-form-actions">
                <button type="submit" disabled={isBusy}>{editingId ? "Save changes" : "Add company"}</button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </Panel>
  );
}
