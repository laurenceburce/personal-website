"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const MOUSE_MOVE_THROTTLE_MS = 16;
// Relayed events are buffered locally and flushed as one batched request on
// this cadence, instead of one HTTP round-trip per event — under any real
// network latency (this call crosses browser -> web app -> the submit-
// worker's private network -> CDP -> back), sending each mouseMove/keyDown
// as its own serialized request meant a drag or a fast typed answer visibly
// lagged behind the user's actual input by however long that chain took,
// compounding with every event. The worker's /live/:id/input already
// accepted a batched {events:[...]} body from the start; this is what
// actually uses it.
const FLUSH_INTERVAL_MS = 16;
const STREAM_RETRY_MS = 1200;

async function postInputBatch(challengeId, events) {
  if (events.length === 0) return;
  await fetch(`/api/job-search/live-sessions/${encodeURIComponent(challengeId)}/input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events })
  }).catch(() => {});
}

function streamUrl(challengeId) {
  return `/api/job-search/live-sessions/${encodeURIComponent(challengeId)}/stream?t=${Date.now()}`;
}

function collapseInputEvents(events) {
  const collapsed = [];
  for (const evt of events) {
    if (evt.type === "mouseMove" && collapsed.length > 0 && collapsed[collapsed.length - 1].type === "mouseMove") {
      collapsed[collapsed.length - 1] = evt;
    } else {
      collapsed.push(evt);
    }
  }
  return collapsed;
}

// Displays the paused employer page as an MJPEG stream and relays clicks/
// drags/keystrokes back onto it. Coordinates are translated from the rendered
// <img>'s on-screen size to the stream's natural image size, which matches
// the real page viewport captured by the submit worker.
export default function LiveCaptchaModal({ challenge, saving, onClose, onResolve }) {
  const imgRef = useRef(null);
  const retryTimerRef = useRef(null);
  const [streamSrc, setStreamSrc] = useState("");
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [error, setError] = useState("");
  const lastMoveSentRef = useRef(0);
  const isPressedRef = useRef(false);
  // Events queued here are plain synchronous pushes — the actual network
  // send happens on the flush interval below, batched and serialized
  // (awaiting the previous flush's request) so requests can never overlap
  // or arrive out of order.
  const bufferRef = useRef([]);
  const sendQueueRef = useRef(Promise.resolve());

  function queueInput(event) {
    bufferRef.current.push(event);
  }

  useEffect(() => {
    clearTimeout(retryTimerRef.current);
    setFrameLoaded(false);
    setError("");
    setStreamSrc(streamUrl(challenge.id));

    return () => clearTimeout(retryTimerRef.current);
  }, [challenge.id]);

  const isCaptcha = (challenge?.challengeKind || "security_code") === "captcha";
  const canResolve = isCaptcha && typeof onResolve === "function";

  function scheduleStreamRetry() {
    clearTimeout(retryTimerRef.current);
    setFrameLoaded(false);
    setError("Live stream is not ready yet or disconnected. Retrying...");
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      setStreamSrc(streamUrl(challenge.id));
    }, STREAM_RETRY_MS);
  }

  const flushInputBuffer = useCallback(() => {
    if (bufferRef.current.length === 0) return;
    const raw = bufferRef.current;
    bufferRef.current = [];
    const collapsed = collapseInputEvents(raw);
    sendQueueRef.current = sendQueueRef.current
      .then(() => postInputBatch(challenge.id, collapsed))
      .catch(() => {});
  }, [challenge.id]);

  // Batches whatever queued up since the last tick into one request. Runs
  // independently of the image stream above (different cadence, different
  // purpose) but shares the same "await before sending the next one" posture
  // so a slow input request can't pile up either.
  useEffect(() => {
    const flush = setInterval(() => {
      flushInputBuffer();
    }, FLUSH_INTERVAL_MS);

    return () => clearInterval(flush);
  }, [challenge.id, flushInputBuffer]);

  function toRealCoords(clientX, clientY) {
    const el = imgRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    const width = el.naturalWidth || rect.width || 1;
    const height = el.naturalHeight || rect.height || 1;
    const x = ((clientX - rect.left) / rect.width) * width;
    const y = ((clientY - rect.top) / rect.height) * height;
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
    flushInputBuffer();
  }

  function handleWheel(event) {
    event.preventDefault();
    const { x, y } = toRealCoords(event.clientX, event.clientY);
    queueInput({ type: "wheel", x, y, deltaX: event.deltaX, deltaY: event.deltaY });
    flushInputBuffer();
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
    flushInputBuffer();
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
          {isCaptcha
            ? "This is the live employer page. Click into it first, then click, drag, and type directly on it to solve the CAPTCHA, then press Continue Submission below."
            : "This is the live employer page the submit worker is using. Click into it first, then click, scroll, and type directly on it if you need to help it through a prompt."}
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
          {streamSrc ? (
            <img
              ref={imgRef}
              src={streamSrc}
              alt="Live employer application page"
              draggable={false}
              onLoad={() => {
                clearTimeout(retryTimerRef.current);
                setFrameLoaded(true);
                setError("");
              }}
              onError={scheduleStreamRetry}
            />
          ) : null}
          {!frameLoaded ? (
            <div className="job-search-live-loading">Connecting…</div>
          ) : null}
        </div>

        <div className="job-search-live-actions">
          <button type="button" onClick={onClose} disabled={isBusy}>{canResolve ? "Cancel" : "Close"}</button>
          {canResolve ? (
            <button type="button" onClick={onResolve} disabled={isBusy}>
              {saving === "resolveLiveCaptcha" ? "Continuing..." : "Continue Submission"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
