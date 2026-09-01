"use client";

import { useEffect, useState } from "react";
import { atsTypeLabel, Badge, Field } from "./JobSearchUi";
import LiveCaptchaModal from "./LiveCaptchaModal";

const HELD_ITEM_POLL_MS = 4000;
const COUNTDOWN_TICK_MS = 1000;

function formatTimeLeft(expiresAt, now) {
  if (!expiresAt) return "";
  const ms = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return "expiring now";
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

// Same DB row (job_search_security_challenges), three flavors — see
// heldChallengeRelay.js. security_code/anti_bot_text share one type-an-
// answer form; captcha gets a "Solve Now" button into the live-relay modal
// instead, since there's no text to type.
function kindLabel(kind) {
  if (kind === "captcha") return "CAPTCHA";
  if (kind === "anti_bot_text") return "Anti-bot Question";
  return "Security Code";
}

export default function HeldSubmissionsPanel({ initialChallenges = [], saving, onSubmitCode, onResolveLiveCaptcha, onCancelChallenge }) {
  const [challenges, setChallenges] = useState(initialChallenges || []);
  const [codes, setCodes] = useState({});
  const [pollError, setPollError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [liveChallenge, setLiveChallenge] = useState(null);

  useEffect(() => {
    setChallenges(initialChallenges || []);
  }, [initialChallenges]);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const response = await fetch("/api/job-search/security-challenges");
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.error || "Failed to load held-submission prompts.");
        if (!cancelled) {
          setChallenges(Array.isArray(payload?.challenges) ? payload.challenges : []);
          setPollError("");
        }
      } catch (error) {
        if (!cancelled) setPollError(error?.message || "Failed to load held-submission prompts.");
      }
    }

    const interval = setInterval(poll, HELD_ITEM_POLL_MS);
    poll();
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Separate from the data poll above (which only re-fetches every 4s) — a
  // per-second display-only tick is what makes the "Xm XXs" countdown next
  // to each item actually count down smoothly instead of jumping every 4s.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS);
    return () => clearInterval(tick);
  }, []);

  function removeChallenge(id) {
    setChallenges((current) => current.filter((item) => item.id !== id));
  }

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
    removeChallenge(challenge.id);
  }

  async function handleLiveResolve(challenge) {
    await onResolveLiveCaptcha(challenge.id);
    setLiveChallenge(null);
    removeChallenge(challenge.id);
  }

  async function handleCancel(challenge) {
    if (liveChallenge?.id === challenge.id) setLiveChallenge(null);
    await onCancelChallenge(challenge.id);
    removeChallenge(challenge.id);
  }

  if (challenges.length === 0) return null;

  return (
    <section className="job-search-panel job-search-security-panel">
      <header className="job-search-panel-header">
        <h2>Held For You</h2>
        <Badge text={`${challenges.length} waiting`} tone="warn" />
      </header>

      <p className="job-search-panel-hint">
        The submit worker is paused on the employer page. Answer or solve these to let it continue.
      </p>

      {pollError ? <p className="job-search-alert job-search-alert-error">{pollError}</p> : null}

      <div className="job-search-security-list">
        {challenges.map((challenge) => {
          const isBusy = Boolean(saving);
          const kind = challenge.challengeKind || "security_code";

          if (kind === "captcha") {
            return (
              <div key={challenge.id} className="job-search-security-item job-search-security-item-captcha">
                <div className="job-search-security-context">
                  <strong>{challenge.jobTitle}</strong>
                  <span>{challenge.companyName} · {atsTypeLabel(challenge.atsType)} · <Badge text={kindLabel(kind)} tone="danger" /></span>
                  <small>Expires in {formatTimeLeft(challenge.expiresAt, now)}</small>
                  {challenge.applyUrl ? <a href={challenge.applyUrl} target="_blank" rel="noreferrer">View posting</a> : null}
                </div>
                <div className="job-search-security-actions">
                  <button type="button" className="job-search-btn-ghost" disabled={isBusy} onClick={() => handleCancel(challenge)}>
                    Cancel
                  </button>
                  <button type="button" disabled={isBusy} onClick={() => setLiveChallenge(challenge)}>
                    Solve Now
                  </button>
                </div>
              </div>
            );
          }

          const code = codes[challenge.id] || "";
          return (
            <form key={challenge.id} className="job-search-security-item" onSubmit={(event) => submitCode(event, challenge)}>
              <div className="job-search-security-context">
                <strong>{challenge.jobTitle}</strong>
                <span>{challenge.companyName} · {atsTypeLabel(challenge.atsType)} · <Badge text={kindLabel(kind)} /></span>
                {challenge.promptText ? <small>{challenge.promptText}</small> : null}
                {challenge.applyUrl ? <a href={challenge.applyUrl} target="_blank" rel="noreferrer">View posting</a> : null}
              </div>

              <Field label={`Answer · ${formatTimeLeft(challenge.expiresAt, now)}`}>
                <input
                  value={code}
                  onChange={(event) => setCodes((current) => ({ ...current, [challenge.id]: event.target.value }))}
                  autoComplete="one-time-code"
                  inputMode={kind === "security_code" ? "numeric" : "text"}
                  placeholder={kind === "anti_bot_text" ? "Your answer" : "Security code"}
                />
              </Field>

              <div className="job-search-security-actions">
                <button type="button" className="job-search-btn-ghost" disabled={isBusy} onClick={() => handleCancel(challenge)}>
                  Cancel
                </button>
                <button type="submit" disabled={isBusy || !code.trim()}>
                  {saving === "submitSecurityCode" ? "Sending..." : "Submit"}
                </button>
              </div>
            </form>
          );
        })}
      </div>

      {liveChallenge ? (
        <LiveCaptchaModal
          challenge={liveChallenge}
          saving={saving}
          onClose={() => setLiveChallenge(null)}
          onResolve={() => handleLiveResolve(liveChallenge)}
        />
      ) : null}
    </section>
  );
}
