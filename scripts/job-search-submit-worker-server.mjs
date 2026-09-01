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
import { recordWorkerRunResult } from "../app/lib/jobSearchWorkerStatusStore.js";

if (!isJobSearchDbConfigured()) {
  console.error("JOB_SEARCH_DATABASE_URL, DATABASE_URL, or MYSQL_URL is required.");
  process.exit(1);
}

const PORT = Number(process.env.JOB_SEARCH_SUBMIT_WORKER_PORT || 8080);
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
let lastRunSummary = null;
let lastRunError = null;

// Pathological-case safety valve, not a normal-operation limit: if for some
// reason triggers keep arriving faster than passes can drain them, this
// stops the loop from spinning forever inside one process tick and instead
// yields to the next scheduled/triggered run — matches the same
// "safety valve, not pacing" posture already used elsewhere in this project
// (e.g. jobSearchCompanyDirectory.js's discoverNewCompanies limit).
const MAX_CONSECUTIVE_RERUNS = 5;

async function triggerRun(reason) {
  if (isRunning) {
    rerunRequested = true;
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
    try {
      do {
        rerunRequested = false;
        console.log(`[run] Starting submit-worker pass (reason: ${reason}).`);
        try {
          lastRunSummary = await runSubmitWorkerPass();
          lastRunError = null;
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
async function handleLiveFrame(res, challengeId) {
  const session = getLiveSession(challengeId);
  if (!session) {
    sendJson(res, 404, { error: "No live session for that challenge — it may have already resolved, timed out, or this server restarted." });
    return;
  }

  try {
    const result = await session.cdpSession.send("Page.captureScreenshot", { format: "jpeg", quality: 60 });
    const buffer = Buffer.from(result.data, "base64");
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
    await cdpSession.send("Input.dispatchKeyEvent", {
      type,
      key: evt.key,
      text: type === "keyDown" ? (evt.text || evt.key) : undefined
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
      try {
        const parsed = JSON.parse(rawBody || "{}");
        if (parsed?.reason) reason = String(parsed.reason).slice(0, 100);
      } catch {
        // A non-JSON or empty body is fine — reason just stays the default.
      }

      const outcome = await triggerRun(reason);
      sendJson(res, 202, outcome);
      return;
    }

    const liveMatch = (req.url || "").match(/^\/live\/(\d+)\/(frame|input|resolve)$/);
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
