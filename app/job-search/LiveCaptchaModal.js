"use client";

import { useEffect, useRef, useState } from "react";

const FRAME_POLL_MS = 500;
const MOUSE_MOVE_THROTTLE_MS = 60;

async function postInput(challengeId, event) {
  await fetch(`/api/job-search/live-sessions/${challengeId}/input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event)
  }).catch(() => {});
}

// Polls a screenshot of the paused employer page (~2fps — see
// heldChallengeRelay.js's own comment on why this is polling, not a true
// video stream) and relays clicks/drags/keystrokes back onto it. Coordinates
// are translated from the rendered <img>'s on-screen size to the real page's
// viewport size (reported via response headers on the first frame) so a
// click lands where it visually appears to, regardless of how the modal
// scales the image.
export default function LiveCaptchaModal({ challenge, saving, onClose, onResolve }) {
  const imgRef = useRef(null);
  const [frameSrc, setFrameSrc] = useState("");
  const [viewport, setViewport] = useState(null);
  const [error, setError] = useState("");
  const lastMoveSentRef = useRef(0);
  const isPressedRef = useRef(false);
  const objectUrlRef = useRef("");
  // Input events are relayed as a strictly ordered queue (each send awaits
  // the previous one) rather than fired concurrently — a mouseDown/mouseUp
  // pair arriving out of order over the wire would break a drag-based
  // challenge (e.g. a slider), and plain concurrent fetches give no such
  // ordering guarantee.
  const sendQueueRef = useRef(Promise.resolve());

  function queueInput(event) {
    sendQueueRef.current = sendQueueRef.current.then(() => postInput(challenge.id, event)).catch(() => {});
  }

  useEffect(() => {
    let cancelled = false;

    async function pollFrame() {
      try {
        const response = await fetch(`/api/job-search/live-sessions/${challenge.id}/frame`, { cache: "no-store" });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload?.error || `Frame request failed (${response.status}).`);
        }
        const width = Number(response.headers.get("x-live-viewport-width")) || null;
        const height = Number(response.headers.get("x-live-viewport-height")) || null;
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = url;
        setFrameSrc(url);
        if (width && height) setViewport((current) => current || { width, height });
        setError("");
      } catch (err) {
        if (!cancelled) setError(err?.message || "Failed to load the live view.");
      }
    }

    const interval = setInterval(pollFrame, FRAME_POLL_MS);
    pollFrame();
    return () => {
      cancelled = true;
      clearInterval(interval);
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, [challenge.id]);

  function toRealCoords(clientX, clientY) {
    const el = imgRef.current;
    if (!el || !viewport) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * viewport.width;
    const y = ((clientY - rect.top) / rect.height) * viewport.height;
    return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) };
  }

  function handlePointerDown(event) {
    event.preventDefault();
    isPressedRef.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const { x, y } = toRealCoords(event.clientX, event.clientY);
    queueInput({ type: "mouseMove", x, y });
    queueInput({ type: "mouseDown", x, y, button: "left" });
  }

  function handlePointerMove(event) {
    if (!isPressedRef.current) return;
    const now = Date.now();
    if (now - lastMoveSentRef.current < MOUSE_MOVE_THROTTLE_MS) return;
    lastMoveSentRef.current = now;
    const { x, y } = toRealCoords(event.clientX, event.clientY);
    queueInput({ type: "mouseMove", x, y });
  }

  function handlePointerUp(event) {
    if (!isPressedRef.current) return;
    isPressedRef.current = false;
    const { x, y } = toRealCoords(event.clientX, event.clientY);
    queueInput({ type: "mouseUp", x, y, button: "left" });
  }

  function handleWheel(event) {
    event.preventDefault();
    const { x, y } = toRealCoords(event.clientX, event.clientY);
    queueInput({ type: "wheel", x, y, deltaX: event.deltaX, deltaY: event.deltaY });
  }

  function handleKeyDown(event) {
    event.preventDefault();
    queueInput({ type: "keyDown", key: event.key, text: event.key.length === 1 ? event.key : undefined });
  }

  const isBusy = Boolean(saving);

  return (
    <div className="job-search-live-overlay" role="dialog" aria-modal="true">
      <div className="job-search-live-modal">
        <header className="job-search-live-header">
          <div>
            <strong>{challenge.jobTitle}</strong>
            <span>{challenge.companyName}</span>
          </div>
          <button type="button" className="job-search-live-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        <p className="job-search-panel-hint">
          This is the live employer page. Click, drag, and type directly on it to solve the
          CAPTCHA, then press Continue Submission below.
        </p>

        {error ? <p className="job-search-alert job-search-alert-error">{error}</p> : null}

        <div
          className="job-search-live-frame"
          tabIndex={0}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onWheel={handleWheel}
          onKeyDown={handleKeyDown}
        >
          {frameSrc ? (
            <img ref={imgRef} src={frameSrc} alt="Live employer application page" draggable={false} />
          ) : (
            <div className="job-search-live-loading">Connecting…</div>
          )}
        </div>

        <div className="job-search-live-actions">
          <button type="button" onClick={onClose} disabled={isBusy}>Cancel</button>
          <button type="button" onClick={onResolve} disabled={isBusy}>
            {saving === "resolveLiveCaptcha" ? "Continuing..." : "Continue Submission"}
          </button>
        </div>
      </div>
    </div>
  );
}
