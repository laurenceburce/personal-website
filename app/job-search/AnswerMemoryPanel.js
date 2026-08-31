"use client";

import { useState } from "react";
import { Badge } from "./JobSearchUi";

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// One row per remembered question — see jobSearchAnswerMemoryStore.js for
// where these come from (every answer typed into the Review Queue's
// "Answer & Retry" popup, minus anything that named its own posting's
// company — never memorized in the first place, see that file's
// isCompanySpecific()) and where they get read back (findBestMemoryMatch(),
// called from each ATS adapter's per-field loop on a LATER, unrelated
// posting). Editing here only ever touches the answer text — the question
// label and its embedding are fixed at whatever wording first produced this
// entry, since matching is keyed off that wording.
function AnswerMemoryRow({ entry, saving, onSave, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.answer);
  const isBusy = Boolean(saving);

  async function handleSave() {
    await onSave(entry.id, draft);
    setEditing(false);
  }

  return (
    <tr className="job-search-row">
      <td>
        <strong>{entry.questionLabel}</strong>
      </td>
      <td>
        {editing ? (
          <textarea rows={2} value={draft} disabled={isBusy} onChange={(e) => setDraft(e.target.value)} />
        ) : (
          <span>{entry.answer}</span>
        )}
      </td>
      <td>{entry.sourceCompanyName || "—"}</td>
      <td>
        <Badge text={`${entry.timesReused} reuse${entry.timesReused === 1 ? "" : "s"}`} tone={entry.timesReused > 0 ? "success" : "neutral"} />
        {entry.lastReusedAt ? <div className="job-search-cell-note">Last: {formatDate(entry.lastReusedAt)}</div> : null}
      </td>
      <td>{formatDate(entry.createdAt)}</td>
      <td className="job-search-row-actions">
        {editing ? (
          <>
            <button type="button" disabled={isBusy} onClick={handleSave}>Save</button>
            <button type="button" disabled={isBusy} onClick={() => { setDraft(entry.answer); setEditing(false); }}>Cancel</button>
          </>
        ) : (
          <>
            <button type="button" disabled={isBusy} onClick={() => setEditing(true)}>Edit</button>
            <button type="button" disabled={isBusy} onClick={() => onDelete(entry.id)}>Delete</button>
          </>
        )}
      </td>
    </tr>
  );
}

export default function AnswerMemoryPanel({ entries, saving, onSave, onDelete }) {
  const list = entries || [];

  return (
    <section className="job-search-panel">
      <header className="job-search-panel-header">
        <h2>Memory</h2>
      </header>

      <p className="job-search-panel-hint">
        Every answer you've typed into a "Answer &amp; Retry" popup, saved so a similarly-worded question on a
        LATER, unrelated posting gets auto-filled instead of landing in manual review again — matched by meaning,
        not exact wording. A question that named its own posting's company (e.g. "Have you worked at Acme before?")
        is never saved here — that kind of answer is never reusable across postings. Edit an answer if it's gone
        stale, or delete one you don't want reused anymore.
      </p>

      {list.length === 0 ? (
        <p className="job-search-empty">
          Nothing remembered yet — answer a flagged field via "Answer &amp; Retry" in the Review tab to start
          building this up.
        </p>
      ) : (
        <div className="job-search-table-scroll">
          <table className="job-search-table">
            <thead>
              <tr>
                <th>Question</th>
                <th>Answer</th>
                <th>Learned from</th>
                <th>Reused</th>
                <th>Saved</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {list.map((entry) => (
                <AnswerMemoryRow key={entry.id} entry={entry} saving={saving} onSave={onSave} onDelete={onDelete} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
