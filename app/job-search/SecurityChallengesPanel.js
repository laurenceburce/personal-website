"use client";

import { useEffect, useState } from "react";
import { atsTypeLabel, Badge, Field } from "./JobSearchUi";

const SECURITY_CHALLENGE_POLL_MS = 4000;

function formatTimeLeft(expiresAt, now) {
  if (!expiresAt) return "";
  const ms = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return "expiring now";
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

export default function SecurityChallengesPanel({ initialChallenges = [], saving, onSubmitCode }) {
  const [challenges, setChallenges] = useState(initialChallenges || []);
  const [codes, setCodes] = useState({});
  const [pollError, setPollError] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setChallenges(initialChallenges || []);
  }, [initialChallenges]);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      setNow(Date.now());
      try {
        const response = await fetch("/api/job-search/security-challenges");
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.error || "Failed to load security-code prompts.");
        if (!cancelled) {
          setChallenges(Array.isArray(payload?.challenges) ? payload.challenges : []);
          setPollError("");
        }
      } catch (error) {
        if (!cancelled) setPollError(error?.message || "Failed to load security-code prompts.");
      }
    }

    const interval = setInterval(poll, SECURITY_CHALLENGE_POLL_MS);
    poll();
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  async function submitCode(event, challenge) {
    event.preventDefault();
    const code = String(codes[challenge.id] || "").trim();
    if (!code) return;
    await onSubmitCode(challenge.id, code);
    setCodes((current) => {
      const next = { ...current };
      delete next[challenge.id];
      return next;
    });
    setChallenges((current) => current.filter((item) => item.id !== challenge.id));
  }

  if (challenges.length === 0) return null;

  return (
    <section className="job-search-panel job-search-security-panel">
      <header className="job-search-panel-header">
        <h2>Security Code Required</h2>
        <Badge text={`${challenges.length} waiting`} tone="warn" />
      </header>

      <p className="job-search-panel-hint">
        The submit worker is paused on the employer page. Enter the code you received to let it continue this submission.
      </p>

      {pollError ? <p className="job-search-alert job-search-alert-error">{pollError}</p> : null}

      <div className="job-search-security-list">
        {challenges.map((challenge) => {
          const code = codes[challenge.id] || "";
          const isBusy = Boolean(saving);
          return (
            <form key={challenge.id} className="job-search-security-item" onSubmit={(event) => submitCode(event, challenge)}>
              <div className="job-search-security-context">
                <strong>{challenge.jobTitle}</strong>
                <span>{challenge.companyName} · {atsTypeLabel(challenge.atsType)}</span>
                {challenge.promptText ? <small>{challenge.promptText}</small> : null}
                {challenge.applyUrl ? <a href={challenge.applyUrl} target="_blank" rel="noreferrer">View posting</a> : null}
              </div>

              <Field label={`Code · ${formatTimeLeft(challenge.expiresAt, now)}`}>
                <input
                  value={code}
                  onChange={(event) => setCodes((current) => ({ ...current, [challenge.id]: event.target.value }))}
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  placeholder="Security code"
                />
              </Field>

              <button type="submit" disabled={isBusy || !code.trim()}>
                {saving === "submitSecurityCode" ? "Sending..." : "Submit Code"}
              </button>
            </form>
          );
        })}
      </div>
    </section>
  );
}
