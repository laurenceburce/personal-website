"use client";

import { useEffect, useRef, useState } from "react";

const FRAME_POLL_MS = 500;
const MOUSE_MOVE_THROTTLE_MS = 60;
// Relayed events are buffered locally and flushed as one batched request on
// this cadence, instead of one HTTP round-trip per event — under any real
// network latency (this call crosses browser -> web app -> the submit-
// worker's private network -> CDP -> back), sending each mouseMove/keyDown
// as its own serialized request meant a drag or a fast typed answer visibly
// lagged behind the user's actual input by however long that chain took,
// compounding with every event. The worker's /live/:id/input already
// accepted a batched {events:[...]} body from the start; this is what
// actually uses it.
const FLUSH_INTERVAL_MS = 50;

async function postInputBatch(challengeId, events) {
  if (events.length === 0) return;
  await fetch(`/api/job-search/live-sessions/${challengeId}/input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events })
  }).catch(() => {});
}

// Polls a live frame of the paused employer page (~2fps — see
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
  // Events queued here are plain synchronous pushes — the actual network
  // send happens on the flush interval below, batched and serialized
  // (awaiting the previous flush's request) so requests can never overlap
  // or arrive out of order.
  const bufferRef = useRef([]);
  const sendQueueRef = useRef(Promise.resolve());

  function queueInput(event) {
    bufferRef.current.push(event);
  }

  // Self-paced, not a fixed setInterval — each fetch is awaited before the
  // next is scheduled, so a slow response delays the NEXT frame instead of
  // piling up concurrent in-flight requests (which, since they all compete
  // for the same CDP session on the worker, would only make every frame
  // arrive later and later).
  useEffect(() => {
    let cancelled = false;
    let timer = null;

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

    async function loop() {
      await pollFrame();
      if (!cancelled) timer = setTimeout(loop, FRAME_POLL_MS);
    }

    loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, [challenge.id]);

  // Batches whatever queued up since the last tick into one request. Runs
  // independently of the frame poll above (different cadence, different
  // purpose) but shares the same "await before sending the next one" posture
  // so a slow input request can't pile up either.
  useEffect(() => {
    const flush = setInterval(() => {
      if (bufferRef.current.length === 0) return;
      const raw = bufferRef.current;
      bufferRef.current = [];

      // Consecutive mouseMove events collapse to just the latest position —
      // during a fast drag, replaying every intermediate point isn't needed
      // for correctness and is exactly what was queuing up and falling
      // behind under real latency. mouseDown/mouseUp/wheel/key events are
      // never collapsed or reordered.
      const collapsed = [];
      for (const evt of raw) {
        if (evt.type === "mouseMove" && collapsed.length > 0 && collapsed[collapsed.length - 1].type === "mouseMove") {
          collapsed[collapsed.length - 1] = evt;
        } else {
          collapsed.push(evt);
        }
      }

      sendQueueRef.current = sendQueueRef.current
        .then(() => postInputBatch(challenge.id, collapsed))
        .catch(() => {});
    }, FLUSH_INTERVAL_MS);

    return () => clearInterval(flush);
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
    event.currentTarget.focus();
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

  // Missing before — every keypress relayed a keyDown and nothing else. Most
  // pages tolerate that for plain typed characters, but Backspace/Enter/Tab
  // etc. (which carry no `text`, only a key name) need the matching keyUp to
  // behave like a real keystroke, and some pages key auto-advance-to-next-
  // box logic off keyup specifically.
  function handleKeyUp(event) {
    event.preventDefault();
    queueInput({ type: "keyUp", key: event.key });
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
          This is the live employer page. Click into it first, then click, drag, and type
          directly on it to solve the CAPTCHA, then press Continue Submission below.
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
          onKeyUp={handleKeyUp}
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
