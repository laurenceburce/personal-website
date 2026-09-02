// Event-driven submit-worker server: stays running and exposes an HTTP
// endpoint the main web app calls the moment something actually becomes
// submittable (an approve/batchApprove/retry in the Review Queue, or a
// scoring pass that might have made a posting auto-apply-eligible — see
// app/lib/jobSearchSubmitTrigger.js and its callers). Also runs once
// immediately on startup, so a deploy/restart doesn't sit idle until the
// next trigger before picking up anything already approved.
//
// Deliberately no periodic fallback timer: the trigger call (or startup) is
// the only thing that wakes this up. A dropped/failed trigger
// (JOB_SEARCH_SUBMIT_WORKER_URL misconfigured, a network blip, this service
// being mid-restart at the exact moment) leaves an approved posting
// untouched until either another trigger-worthy event fires — any pass
// processes ALL approved postings, not just the one that triggered it — or
// this service restarts. If that gap turns out to matter in practice, bring
// back a periodic check here.
//
// Deploy this as the submit-worker Railway service's Start Command, with NO
// Railway Cron Schedule attached — the service just stays up and waits for
// trigger calls.
//
// Concurrency: "account for multiple events" specifically means never
// running two passes at once (two concurrent Playwright launches racing over
// the same approved postings is worse than useless), while never silently
// dropping a trigger that arrives mid-run either. See triggerRun() below —
// N triggers while a pass is in flight coalesce into exactly ONE guaranteed
// follow-up pass, not N queued passes and not zero.
import { createServer } from "node:http";
import { runSubmitWorkerPass } from "../app/lib/jobSearchSubmitWorkerRun.js";
import { getPool, isJobSearchDbConfigured } from "../app/lib/jobSearchDb.js";
import { getLiveSession } from "../app/lib/jobSearchLiveSessionRegistry.js";
import { resolveLiveCaptchaSession } from "../app/lib/jobSearchSecurityChallengeStore.js";
import { getSubmitProgressSnapshot } from "../app/lib/jobSearchSubmitProgressStore.js";
import { recordWorkerRunResult } from "../app/lib/jobSearchWorkerStatusStore.js";

if (!isJobSearchDbConfigured()) {
  console.error("JOB_SEARCH_DATABASE_URL, DATABASE_URL, or MYSQL_URL is required.");
  process.exit(1);
}

const PORT = Number(process.env.JOB_SEARCH_SUBMIT_WORKER_PORT || 8080);
const LIVE_FRAME_INTERVAL_MS = Math.max(75, Number(process.env.JOB_SEARCH_LIVE_FRAME_INTERVAL_MS || 125));
const PROGRESS_STREAM_TICK_MS = 350;
// Safety valve, not a normal-operation limit — see MAX_CONSECUTIVE_RERUNS'
// own comment for the same posture. Guarantees this connection (and its DB
// polling) eventually recycles even if a client never notices/closes its end.
const PROGRESS_STREAM_MAX_MS = 30 * 60 * 1000;
const LIVE_FRAME_JPEG_QUALITY = Math.max(25, Math.min(85, Number(process.env.JOB_SEARCH_LIVE_FRAME_JPEG_QUALITY || 38)));
// Shared secret the caller must present — Railway's private networking
// (<service>.railway.internal) already isn't reachable from the public
// internet by default, so this is defense in depth, not the only thing
// standing between this endpoint and the world. Worth having anyway: this
// project has already had a real incident class where something meant to
// stay internal-only ended up reachable a different way than intended.
const TRIGGER_SECRET = process.env.JOB_SEARCH_SUBMIT_TRIGGER_SECRET || "";

if (!TRIGGER_SECRET) {
  console.warn("[startup] JOB_SEARCH_SUBMIT_TRIGGER_SECRET is not set — /run will accept unauthenticated requests from anything that can reach this service.");
}

let isRunning = false;
let rerunRequested = false;
let queuedRunOptions = null;
let lastRunSummary = null;
let lastRunError = null;

// Pathological-case safety valve, not a normal-operation limit: if for some
// reason triggers keep arriving faster than passes can drain them, this
// stops the loop from spinning forever inside one process tick and instead
// yields to the next scheduled/triggered run — matches the same
// "safety valve, not pacing" posture already used elsewhere in this project
// (e.g. jobSearchCompanyDirectory.js's discoverNewCompanies limit).
const MAX_CONSECUTIVE_RERUNS = 10;

function normalizeRunOptions(options = {}) {
  return { includeAutoApply: options.includeAutoApply !== false };
}

function mergeRunOptions(a, b) {
  const left = normalizeRunOptions(a);
  const right = normalizeRunOptions(b);
  return { includeAutoApply: left.includeAutoApply || right.includeAutoApply };
}

async function triggerRun(reason, options = {}) {
  const initialRunOptions = normalizeRunOptions(options);
  if (isRunning) {
    rerunRequested = true;
    queuedRunOptions = queuedRunOptions ? mergeRunOptions(queuedRunOptions, initialRunOptions) : initialRunOptions;
    console.log(`[trigger] Pass already in progress — queued exactly one follow-up run (reason: ${reason}).`);
    return { started: false, queued: true };
  }

  isRunning = true;
  // Fire-and-forget from triggerRun()'s own caller's perspective — the HTTP
  // handler below responds as soon as this promise is CREATED, not when the
  // whole (possibly many-minutes-long) pass finishes. Matches the original
  // plan's own principle that approving/scoring should never block on
  // Playwright.
  (async () => {
    let consecutiveReruns = 0;
    let runOptions = initialRunOptions;
    try {
      do {
        rerunRequested = false;
        queuedRunOptions = null;
        console.log(`[run] Starting submit-worker pass (reason: ${reason}, includeAutoApply: ${runOptions.includeAutoApply}).`);
        try {
          lastRunSummary = await runSubmitWorkerPass(runOptions);
          lastRunError = null;
          if (lastRunSummary?.needsRerun) {
            rerunRequested = true;
            queuedRunOptions = queuedRunOptions ? mergeRunOptions(queuedRunOptions, runOptions) : runOptions;
            console.log("[run] Submit-worker pass hit its batch cap — queued a follow-up pass to drain remaining work.");
          }
        } catch (error) {
          lastRunError = error?.message || String(error);
          console.error("[run] Pass failed:", lastRunError);
          await recordWorkerRunResult("submit", { ok: false, error: lastRunError }).catch(() => {});
        }

        if (rerunRequested) {
          consecutiveReruns += 1;
          if (consecutiveReruns >= MAX_CONSECUTIVE_RERUNS) {
            console.warn(`[run] Hit ${MAX_CONSECUTIVE_RERUNS} consecutive immediate reruns — yielding to the next scheduled/triggered run instead of looping further.`);
            rerunRequested = false;
          } else {
            runOptions = queuedRunOptions || normalizeRunOptions();
          }
        }
      } while (rerunRequested);
    } finally {
      isRunning = false;
    }
  })().catch((error) => {
    // The IIFE's own try/finally already handles normal run failures — this
    // only catches something going wrong in the loop machinery itself.
    isRunning = false;
    console.error("[run] Unexpected error in run loop:", error?.message || error);
  });

  return { started: true, queued: false };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasValidTriggerSecret(req) {
  if (!TRIGGER_SECRET) return true;
  return (req.headers["x-trigger-secret"] || "") === TRIGGER_SECRET;
}

// The three routes behind a live CAPTCHA-solve session (see
// app/lib/jobSearchAdapters/heldChallengeRelay.js's captcha branch and
// app/lib/jobSearchLiveSessionRegistry.js). Same auth posture as /run —
// private networking plus this shared secret, never reachable from the
// browser directly. The web app's own /api/job-search/live-sessions/[id]/*
// routes are the only caller, and they authenticate the real dashboard user
// first (requireAccessOrRespond) before ever reaching here.
async function captureLiveFrame(session) {
  const result = await session.cdpSession.send("Page.captureScreenshot", {
    format: "jpeg",
    quality: LIVE_FRAME_JPEG_QUALITY,
    captureBeyondViewport: false,
    optimizeForSpeed: true
  });
  return Buffer.from(result.data, "base64");
}

async function handleLiveFrame(res, challengeId) {
  const session = getLiveSession(challengeId);
  if (!session) {
    sendJson(res, 404, { error: "No live session for that challenge — it may have already resolved, timed out, or this server restarted." });
    return;
  }

  try {
    const buffer = await captureLiveFrame(session);
    res.writeHead(200, {
      "content-type": "image/jpeg",
      "content-length": buffer.length,
      "x-live-viewport-width": String(session.viewport.width || ""),
      "x-live-viewport-height": String(session.viewport.height || "")
    });
    res.end(buffer);
  } catch (error) {
    sendJson(res, 502, { error: `Failed to capture frame: ${error?.message || error}` });
  }
}

async function handleLiveStream(req, res, challengeId) {
  const session = getLiveSession(challengeId);
  if (!session) {
    sendJson(res, 404, { error: "No live session for that challenge — it may have already resolved, timed out, or this server restarted." });
    return;
  }

  const boundary = "job-search-live-frame";
  let closed = false;
  req.on("close", () => { closed = true; });
  res.writeHead(200, {
    "content-type": `multipart/x-mixed-replace; boundary=${boundary}`,
    "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    "connection": "keep-alive",
    "x-accel-buffering": "no",
    "x-live-viewport-width": String(session.viewport.width || ""),
    "x-live-viewport-height": String(session.viewport.height || "")
  });

  while (!closed && !res.destroyed && getLiveSession(challengeId) === session) {
    try {
      const buffer = await captureLiveFrame(session);
      res.write(`--${boundary}\r\n`);
      res.write("Content-Type: image/jpeg\r\n");
      res.write(`Content-Length: ${buffer.length}\r\n\r\n`);
      res.write(buffer);
      res.write("\r\n");
    } catch (error) {
      console.error(`[live-stream] Failed to capture frame for challenge ${challengeId}:`, error?.message || error);
      break;
    }
    await sleep(LIVE_FRAME_INTERVAL_MS);
  }

  if (!res.destroyed) res.end();
}

// Live push for a submit-worker pass in progress — see
// app/api/job-search/submit-progress/stream/route.js's own comment for why
// this has to be generated here rather than inside a Next.js route handler:
// two SSE attempts and one multipart attempt at the exact same feed, all
// generated by Next.js itself, silently never delivered a single update
// during a run in production. This is framed exactly like handleLiveStream
// above (same multipart/x-mixed-replace technique, confirmed working for
// the live-frame viewer) with a JSON snapshot part instead of a JPEG frame,
// on the theory that what actually matters is which process is generating
// the stream, not the protocol.
async function handleProgressStream(req, res) {
  const boundary = "submit-progress";
  let closed = false;
  req.on("close", () => { closed = true; });
  res.writeHead(200, {
    "content-type": `multipart/x-mixed-replace; boundary=${boundary}`,
    "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    "connection": "keep-alive",
    "x-accel-buffering": "no"
  });

  const startedAt = Date.now();
  let lastPayload = null;
  let sentIdleSinceRunning = false;

  while (!closed && !res.destroyed && Date.now() - startedAt < PROGRESS_STREAM_MAX_MS) {
    try {
      const snapshot = await getSubmitProgressSnapshot();
      const json = JSON.stringify(snapshot);
      if (json !== lastPayload) {
        lastPayload = json;
        res.write(`--${boundary}\r\n`);
        res.write("Content-Type: application/json\r\n\r\n");
        res.write(json);
        res.write("\r\n");
      }

      if (snapshot.status === "running") {
        sentIdleSinceRunning = false;
      } else if (!sentIdleSinceRunning) {
        // One more tick's grace after a run finishes so the client is
        // guaranteed to see the resting state, not just whatever the last
        // "running" snapshot happened to be, before this connection closes.
        sentIdleSinceRunning = true;
      } else {
        break;
      }
    } catch (error) {
      console.error("[progress-stream] Failed to read submit progress:", error?.message || error);
      break;
    }
    await sleep(PROGRESS_STREAM_TICK_MS);
  }

  if (!res.destroyed) res.end();
}

// CDP's Input.dispatchKeyEvent needs `code`/`windowsVirtualKeyCode` to do
// anything useful for a non-printable key — `text` alone (what the first cut
// of this sent) only ever inserts a character; Backspace/Enter/Tab/arrows
// have no `text` and were silently doing nothing. Windows Virtual-Key codes,
// same table Playwright's own keyboard layer uses. Only the keys an OTP/
// anti-bot-question/CAPTCHA field realistically needs — not a full layout.
const KEY_DEFINITIONS = {
  Backspace: { code: "Backspace", keyCode: 8 },
  Tab: { code: "Tab", keyCode: 9 },
  Enter: { code: "Enter", keyCode: 13 },
  Shift: { code: "ShiftLeft", keyCode: 16 },
  Control: { code: "ControlLeft", keyCode: 17 },
  Alt: { code: "AltLeft", keyCode: 18 },
  Escape: { code: "Escape", keyCode: 27 },
  " ": { code: "Space", keyCode: 32 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  Delete: { code: "Delete", keyCode: 46 }
};

function keyEventFields(key) {
  if (KEY_DEFINITIONS[key]) return KEY_DEFINITIONS[key];
  if (/^[0-9]$/.test(key)) return { code: `Digit${key}`, keyCode: key.charCodeAt(0) };
  if (/^[a-zA-Z]$/.test(key)) return { code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0) };
  // Punctuation and anything else unmapped — an approximate keyCode is still
  // better than none for pages that branch on it, and `text` (set by the
  // caller below) is what actually inserts the character either way.
  return { code: "", keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0 };
}

// One CDP call per relayed event — mirrors browserEngineClick.js's own
// dispatchCdpMouseClick shape (mouseMoved/mousePressed/mouseReleased), plus
// wheel/key events for drag-based and text-based challenges.
async function dispatchLiveInputEvent(cdpSession, evt) {
  const type = evt?.type;

  if (type === "mouseMove" || type === "mouseDown" || type === "mouseUp") {
    await cdpSession.send("Input.dispatchMouseEvent", {
      type: type === "mouseMove" ? "mouseMoved" : type === "mouseDown" ? "mousePressed" : "mouseReleased",
      x: Number(evt.x) || 0,
      y: Number(evt.y) || 0,
      button: evt.button || "left",
      buttons: type === "mouseUp" ? 0 : 1,
      clickCount: 1
    });
    return;
  }

  if (type === "wheel") {
    await cdpSession.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: Number(evt.x) || 0,
      y: Number(evt.y) || 0,
      deltaX: Number(evt.deltaX) || 0,
      deltaY: Number(evt.deltaY) || 0
    });
    return;
  }

  if (type === "keyDown" || type === "keyUp") {
    const key = evt.key || "";
    const { code, keyCode } = keyEventFields(key);
    const text = type === "keyDown" ? evt.text : undefined;
    await cdpSession.send("Input.dispatchKeyEvent", {
      type,
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      ...(text ? { text, unmodifiedText: text } : {})
    });
  }
}

async function handleLiveInput(res, challengeId, rawBody) {
  const session = getLiveSession(challengeId);
  if (!session) {
    sendJson(res, 404, { error: "No live session for that challenge — it may have already resolved, timed out, or this server restarted." });
    return;
  }

  let events;
  try {
    const parsed = JSON.parse(rawBody || "{}");
    events = Array.isArray(parsed.events) ? parsed.events : [parsed];
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body." });
    return;
  }

  try {
    for (const evt of events) {
      await dispatchLiveInputEvent(session.cdpSession, evt);
    }
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 502, { error: `Failed to dispatch input: ${error?.message || error}` });
  }
}

async function handleLiveResolve(res, challengeId) {
  try {
    await resolveLiveCaptchaSession(challengeId);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, Number(error?.status) || 500, { error: error?.message || "Failed to resolve." });
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { ok: true, isRunning, lastRunSummary, lastRunError });
      return;
    }

    if (req.method === "POST" && req.url === "/run") {
      if (!hasValidTriggerSecret(req)) {
        sendJson(res, 401, { error: "Invalid trigger secret." });
        return;
      }

      const rawBody = await readBody(req).catch(() => "");
      let reason = "http-trigger";
      let runOptions = normalizeRunOptions();
      try {
        const parsed = JSON.parse(rawBody || "{}");
        if (parsed?.reason) reason = String(parsed.reason).slice(0, 100);
        runOptions = normalizeRunOptions({ includeAutoApply: parsed?.includeAutoApply });
      } catch {
        // A non-JSON or empty body is fine — reason just stays the default.
      }

      const outcome = await triggerRun(reason, runOptions);
      sendJson(res, 202, outcome);
      return;
    }

    if (req.method === "GET" && req.url === "/progress/stream") {
      if (!hasValidTriggerSecret(req)) {
        sendJson(res, 401, { error: "Invalid trigger secret." });
        return;
      }

      await handleProgressStream(req, res);
      return;
    }

    const liveMatch = (req.url || "").match(/^\/live\/(\d+)\/(frame|stream|input|resolve)$/);
    if (liveMatch) {
      if (!hasValidTriggerSecret(req)) {
        sendJson(res, 401, { error: "Invalid trigger secret." });
        return;
      }

      const challengeId = Number(liveMatch[1]);
      const action = liveMatch[2];

      if (req.method === "GET" && action === "frame") {
        await handleLiveFrame(res, challengeId);
        return;
      }
      if (req.method === "GET" && action === "stream") {
        await handleLiveStream(req, res, challengeId);
        return;
      }
      if (req.method === "POST" && action === "input") {
        const rawBody = await readBody(req).catch(() => "");
        await handleLiveInput(res, challengeId, rawBody);
        return;
      }
      if (req.method === "POST" && action === "resolve") {
        await handleLiveResolve(res, challengeId);
        return;
      }
    }

    sendJson(res, 404, { error: "Not found." });
  } catch (error) {
    console.error("[http] Unhandled request error:", error?.message || error);
    sendJson(res, 500, { error: "Internal error." });
  }
});

server.listen(PORT, () => {
  console.log(`[startup] Submit-worker server listening on :${PORT}.`);
  // Run once immediately on startup rather than waiting for the first
  // trigger call after every deploy/restart before checking at all.
  triggerRun("startup").catch((error) => console.error("[startup] initial trigger failed:", error?.message || error));
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] Received ${signal}, shutting down...`);
  server.close();

  // Not waiting for an in-flight PASS to finish (that could be minutes) —
  // just a short grace window so the DB pool isn't yanked out from under a
  // query that happens to be mid-flight at the exact moment SIGTERM arrives.
  const deadline = Date.now() + 5000;
  while (isRunning && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const pool = await getPool();
  if (pool) await pool.end().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
