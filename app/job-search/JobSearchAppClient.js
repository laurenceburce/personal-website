"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import AnswerMemoryPanel from "./AnswerMemoryPanel";
import AppliedJobsTable from "./AppliedJobsTable";
import { callJobSearchAction } from "./JobSearchUi";
import FindSettingsPanel from "./FindSettingsPanel";
import HeldSubmissionsPanel from "./HeldSubmissionsPanel";
import NotificationsBell from "./NotificationsBell";
import OracleSessionsPanel from "./OracleSessionsPanel";
import OverviewPanel from "./OverviewPanel";
import ProfileSettingsPanel from "./ProfileSettingsPanel";
import ReviewQueueTable from "./ReviewQueueTable";
import SubmitWorkerBanner from "./SubmitWorkerBanner";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "review", label: "Review" },
  { id: "applied", label: "Applied Jobs" },
  { id: "memory", label: "Memory" },
  { id: "settings", label: "User Settings" },
  { id: "find", label: "Job Find Settings" }
];

export default function JobSearchAppClient({ snapshot, initialTab }) {
  const router = useRouter();
  const [tab, setTab] = useState(initialTab || "overview");
  const [saving, setSaving] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [heldToast, setHeldToast] = useState("");
  // null until the first poll lands. Lives here (not in OverviewPanel, which
  // only mounts on the Overview tab) so the topbar's SubmitWorkerBanner and
  // OverviewPanel's own live-progress block share one poll loop instead of
  // each running its own — both just read this prop.
  const [submitProgress, setSubmitProgress] = useState(null);
  // How many items the worker had finished as of the last poll — used only
  // to detect "the worker just did something" so the whole snapshot
  // (Review's In Queue list, Applied Jobs, statusCounts, etc.) can be
  // refreshed the moment it happens, not just the progress display itself.
  // A ref, not state: it must never itself trigger a re-render.
  const lastProcessedCountRef = useRef(null);

  // Real-time counterpart to HeldSubmissionsPanel's own poll — wakes the
  // dashboard up the moment a new held item appears (security code /
  // anti-bot question / CAPTCHA) instead of waiting for the next 4s poll.
  // The panel below still does the actual polling/rendering; this only
  // raises a toast and nudges it via router.refresh() so a currently-open
  // tab doesn't sit for up to 4s showing a stale count.
  useEffect(() => {
    const source = new EventSource("/api/job-search/held-events");
    source.addEventListener("new", (event) => {
      try {
        const challenge = JSON.parse(event.data);
        setHeldToast(`Action needed: ${challenge.jobTitle} at ${challenge.companyName}.`);
        router.refresh();
      } catch {
        // Malformed event payload — ignore rather than crash the listener.
      }
    });
    return () => source.close();
  }, [router]);

  // Shared by both the poll below and the push stream further down — either
  // one just hands this a fresh snapshot whenever it gets one. Also the
  // thing that keeps the REST of the dashboard in sync with what the worker
  // is doing in the background: whenever processedCount moves (the worker
  // just finished a posting — queue counts, Applied Jobs, and Review's In
  // Queue list all just changed as a result), this calls router.refresh()
  // so those pick it up immediately instead of only ever updating when the
  // user happens to trigger some other action in this tab. Wrapped in
  // useCallback so its identity stays stable across the frequent re-renders
  // setSubmitProgress itself causes — the push-stream effect below depends
  // on this function, and a fresh identity every render would tear down and
  // reopen that connection on every single poll tick.
  const applyProgress = useCallback((progress) => {
    setSubmitProgress(progress);

    const processedCount = progress.processedCount ?? 0;
    if (lastProcessedCountRef.current !== null && processedCount !== lastProcessedCountRef.current) {
      router.refresh();
    }
    lastProcessedCountRef.current = processedCount;
  }, [router]);

  // Baseline feed for the submit worker's progress — powers both
  // SubmitWorkerBanner (below) and OverviewPanel's own Submit Worker card.
  // This used to be an SSE push, which turned out to be silently buffered by
  // Railway's proxy in production even after the fix held-events/route.js's
  // own SSE still relies on today (see submit-progress/stream/route.js's own
  // comment for the full story) — a plain poll is less elegant but is the
  // mechanism actually proven to work in this deployment (same as
  // NotificationsBell's poll and OverviewPanel's own worker-status poll).
  // Kept running unconditionally, even once the push stream below is also
  // connected, as the fallback that needs no cooperation from anything else
  // to keep working.
  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const response = await fetch("/api/job-search/submit-progress");
        if (!response.ok) return;
        const payload = await response.json().catch(() => null);
        if (cancelled || !payload?.progress) return;
        applyProgress(payload.progress);
      } catch {
        // Best-effort — a missed poll just means the next one catches up.
      }
    }

    poll();
    const interval = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [applyProgress]);

  // Latency upgrade layered on top of the poll above, not a replacement for
  // it: only opens while a pass is actually running (an idle dashboard costs
  // nothing extra here) and parses the multipart JSON stream from
  // submit-progress/stream/route.js for near-instant updates instead of
  // waiting up to 2s. If this connection fails or the stream turns out to be
  // silently buffered in production exactly like the earlier SSE attempts,
  // the poll above notices nothing and keeps the dashboard working exactly
  // as before — this effect only ever adds, never gates, real functionality.
  const isSubmitRunning = submitProgress?.status === "running";
  useEffect(() => {
    if (!isSubmitRunning) return;

    let cancelled = false;
    let reader = null;

    async function connect() {
      try {
        const response = await fetch("/api/job-search/submit-progress/stream", { cache: "no-store" });
        if (!response.ok || !response.body) return;

        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let streamDone = false;
        const BOUNDARY_MARKER = "--submit-progress\r\n";
        const HEADER_END = "\r\n\r\n";

        // Same framing as the live-frame MJPEG stream, minus a declared
        // Content-Length: a JSON part can't contain a raw CRLF, so the NEXT
        // part's boundary marker safely doubles as this part's own closing
        // delimiter — except for the very last part the server ever writes
        // (right before it closes the connection, e.g. the finished-run
        // state), which has no "next" boundary to close it out. `finalFlush`
        // treats end-of-stream itself as that closing delimiter so that part
        // isn't silently dropped; otherwise a still-open part just waits for
        // more data. Either way this stays at most one part behind reality,
        // invisible at this stream's ~350ms cadence for a progress banner
        // (unlike a video frame, nothing here needs sub-tick precision).
        function consumeParts(finalFlush) {
          for (;;) {
            const start = buffer.indexOf(BOUNDARY_MARKER);
            if (start === -1) return;
            const headerEndIndex = buffer.indexOf(HEADER_END, start);
            if (headerEndIndex === -1) return;
            const bodyStart = headerEndIndex + HEADER_END.length;
            const nextStart = buffer.indexOf(BOUNDARY_MARKER, bodyStart);
            const partEnd = nextStart === -1 ? (finalFlush ? buffer.length : -1) : nextStart;
            if (partEnd === -1) return;

            const body = buffer.slice(bodyStart, partEnd).replace(/\r\n$/, "");
            buffer = buffer.slice(partEnd);

            try {
              applyProgress(JSON.parse(body));
            } catch {
              // Malformed part — ignore rather than crash the reader loop.
            }
          }
        }

        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) { streamDone = true; break; }
          buffer += decoder.decode(value, { stream: true });
          consumeParts(false);
        }

        if (streamDone) consumeParts(true);
      } catch {
        // Best-effort — the poll above is running independently and covers
        // for a dropped/failed stream connection.
      } finally {
        reader?.cancel().catch(() => {});
      }
    }

    connect();
    return () => {
      cancelled = true;
      reader?.cancel().catch(() => {});
    };
  }, [isSubmitRunning, applyProgress]);

  function setTabAndUrl(nextTab) {
    setTab(nextTab);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", nextTab);
    window.history.replaceState({}, "", url);
  }

  // Every mutation goes through this: POST {action,data}, then router.refresh()
  // re-runs the server component for fresh data — same convention as finance,
  // no client-side cache library.
  async function runAction(endpoint, action, data, successMessage) {
    setSaving(action);
    setError("");
    try {
      const result = await callJobSearchAction(endpoint, action, data);
      setNotice(successMessage || "Saved.");
      router.refresh();
      return result;
    } catch (err) {
      setError(err?.message || "Something went wrong.");
      throw err;
    } finally {
      setSaving("");
    }
  }

  async function lookupEmailCode(id) {
    setSaving("fetchEmailCode");
    setError("");
    try {
      const result = await callJobSearchAction("/api/job-search/security-challenges", "fetchEmailCode", { id });
      setNotice("Email code found.");
      return result;
    } catch (err) {
      setError(err?.message || "Email lookup failed.");
      throw err;
    } finally {
      setSaving("");
    }
  }

  // Multipart file uploads can't go through runAction (that one only ever
  // sends JSON via callJobSearchAction) but need the identical saving/error/
  // notice/rethrow shape — shared here so both callers behave the same and a
  // fix to this pattern (like the rethrow below) only has to happen once.
  // Rethrowing matters: the caller's own submit handler (ProfileSettingsPanel
  // .js/OracleSessionsPanel.js) needs to tell success from failure so it only
  // clears the file input/label after a real save, not after every attempt.
  async function uploadFile(endpoint, formData, savingKey, successMessage) {
    setSaving(savingKey);
    setError("");
    try {
      const response = await fetch(endpoint, { method: "POST", body: formData });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "Upload failed.");
      setNotice(successMessage);
      router.refresh();
    } catch (err) {
      setError(err?.message || "Upload failed.");
      throw err;
    } finally {
      setSaving("");
    }
  }

  const uploadResume = (formData) => uploadFile("/api/job-search/resumes", formData, "uploadResume", "Resume uploaded.");
  const uploadOracleSession = (formData) => uploadFile("/api/job-search/oracle-session", formData, "uploadOracleSession", "Oracle session connected.");

  return (
    <div className="job-search-app">
      <header className="job-search-topbar">
        <h1>Job Search</h1>
        <div className="job-search-topbar-actions">
          <SubmitWorkerBanner progress={submitProgress} />
          <NotificationsBell />
          <button type="button" className="job-search-header-home" onClick={() => router.push("/")}>Home</button>
        </div>
      </header>

      <nav className="job-search-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tab === t.id ? "job-search-tab job-search-tab-active" : "job-search-tab"}
            onClick={() => setTabAndUrl(t.id)}
          >
            {t.label}
            {/* Pending review + Needs Manual Review + Failed are the three
                tabs something is actually waiting on a human decision in —
                Scored Low/Skipped/Waiting-for-worker/Auto-Apply Queue are
                informational, not "needs your attention right now". */}
            {t.id === "review" && (snapshot.reviewQueue.length + (snapshot.needsManualReview?.length || 0) + (snapshot.failedPostings?.length || 0)) > 0 && (
              <span className="job-search-tab-badge">
                {snapshot.reviewQueue.length + (snapshot.needsManualReview?.length || 0) + (snapshot.failedPostings?.length || 0)}
              </span>
            )}
          </button>
        ))}
      </nav>

      {error ? <div className="job-search-alert job-search-alert-error">{error}</div> : null}
      {notice && !error ? <div className="job-search-alert">{notice}</div> : null}
      {heldToast ? (
        <div className="job-search-alert job-search-alert-toast">
          {heldToast}
          <button type="button" onClick={() => setHeldToast("")} aria-label="Dismiss">×</button>
        </div>
      ) : null}

      <HeldSubmissionsPanel
        initialChallenges={snapshot.securityChallenges}
        saving={saving}
        onSubmitCode={(id, code) => runAction(
          "/api/job-search/security-challenges",
          "submitSecurityCode",
          { id, code },
          "Answer submitted."
        )}
        onFetchEmailCode={lookupEmailCode}
        onResolveLiveCaptcha={(id) => runAction(
          "/api/job-search/security-challenges",
          "resolveLiveCaptcha",
          { id },
          "Submission resumed."
        )}
        onCancelChallenge={(id) => runAction(
          "/api/job-search/security-challenges",
          "cancelChallenge",
          { id },
          "Cancelled."
        )}
      />

      <main className="job-search-main">
        {tab === "overview" && (
          <OverviewPanel
            findSettings={snapshot.findSettings}
            statusCounts={snapshot.statusCounts}
            discoveryRuns={snapshot.discoveryRuns}
            submitRuns={snapshot.submitRuns}
            llmUsage={snapshot.llmUsage}
            maxLlmCallsPerDay={snapshot.findSettings.maxLlmCallsPerDay}
            dbSizeMb={snapshot.dbSizeMb}
            companyDirectoryStats={snapshot.companyDirectoryStats}
            workerStatus={snapshot.workerStatus}
            adzunaConfigured={snapshot.adzunaConfigured}
            defaultResume={snapshot.defaultResume}
            approvedWaiting={snapshot.approvedWaiting}
            autoApplyQueue={snapshot.autoApplyQueue}
            saving={saving}
            submitProgress={submitProgress}
            onRunDiscovery={() => runAction("/api/job-search/run", "discoveryNow", {}, "Discovery run complete.")}
            onScoreNow={() => runAction("/api/job-search/run", "scoreNow", {}, "Scoring run complete.")}
            onRunSubmitNow={() => runAction("/api/job-search/run", "submitNow", {}, "Submit worker triggered — watch the banner up top for live progress.")}
            onToggleWorker={(workerName, enabled) => runAction(
              "/api/job-search/settings",
              "setWorkerEnabled",
              { workerName, enabled },
              `${workerName === "poll" ? "Poll" : "Submit"} worker ${enabled ? "enabled" : "disabled"}.`
            )}
          />
        )}

        {tab === "review" && (
          <ReviewQueueTable
            postings={snapshot.reviewQueue}
            scoredLow={snapshot.scoredLow}
            autoApplySkipped={snapshot.autoApplySkipped}
            approvedWaiting={snapshot.approvedWaiting}
            autoApplyQueue={snapshot.autoApplyQueue}
            autoApplyEnabled={snapshot.findSettings.autoApplyEnabled}
            needsManualReview={snapshot.needsManualReview}
            failedPostings={snapshot.failedPostings}
            applications={snapshot.applications}
            profile={snapshot.profile}
            answerMemory={snapshot.answerMemory}
            saving={saving}
            onApprove={(id) => runAction("/api/job-search/review-queue", "approve", { id }, "Approved.")}
            onReject={(id, note) => runAction("/api/job-search/review-queue", "reject", { id, note }, "Rejected.")}
            onBatchApprove={(ids) => runAction("/api/job-search/review-queue", "batchApprove", { ids }, `Approved ${ids.length}.`)}
            onBatchReject={(ids, note) => runAction("/api/job-search/review-queue", "batchReject", { ids, note }, `Rejected ${ids.length}.`)}
            onRescore={(id) => runAction("/api/job-search/review-queue", "rescoreNow", { id }, "Re-scored.")}
            onMarkApplied={(id) => runAction("/api/job-search/review-queue", "markAppliedManually", { id }, "Marked as applied.")}
            // Read-only preview, no posting state changes — called directly
            // rather than through runAction so it doesn't show a misleading
            // "Saved." banner or force a full-page refresh for nothing.
            onPolishManualAnswer={(id, label, draftAnswer) => callJobSearchAction(
              "/api/job-search/review-queue", "polishManualAnswer", { id, label, draftAnswer }
            )}
            onSaveManualAnswersAndRetry={(id, answers) => runAction(
              "/api/job-search/review-queue", "saveManualAnswersAndRetry", { id, answers }, "Answers saved — retrying."
            )}
          />
        )}

        {tab === "applied" && (
          <AppliedJobsTable
            applications={snapshot.applications}
            saving={saving}
            onUpdateNote={(id, note) => runAction("/api/job-search/applications", "updateApplicationNote", { id, note }, "Note saved.")}
            onDelete={(id) => runAction("/api/job-search/applications", "deleteApplication", { id }, "Application deleted.")}
          />
        )}

        {tab === "memory" && (
          <AnswerMemoryPanel
            entries={snapshot.answerMemory}
            saving={saving}
            onSave={(id, answer) => runAction("/api/job-search/answer-memory", "updateAnswerMemory", { id, answer }, "Answer updated.")}
            onDelete={(id) => runAction("/api/job-search/answer-memory", "deleteAnswerMemory", { id }, "Memory entry deleted.")}
          />
        )}

        {tab === "settings" && (
          <>
            <ProfileSettingsPanel
              profile={snapshot.profile}
              resumes={snapshot.resumes}
              saving={saving}
              onSaveProfile={(data) => runAction("/api/job-search/settings", "updateProfile", data, "Profile saved.")}
              onUploadResume={uploadResume}
              onSetDefaultResume={(id) => runAction("/api/job-search/resumes", "setDefaultResume", { id }, "Default resume updated.")}
              onDeleteResume={(id) => runAction("/api/job-search/resumes", "deleteResume", { id }, "Resume deleted.")}
            />
            <OracleSessionsPanel
              sessions={snapshot.oracleSessions}
              saving={saving}
              onUploadSession={uploadOracleSession}
              onDeleteSession={(id) => runAction("/api/job-search/oracle-session", "deleteOracleSession", { id }, "Oracle session removed.")}
            />
          </>
        )}

        {tab === "find" && (
          <FindSettingsPanel
            findSettings={snapshot.findSettings}
            saving={saving}
            onSave={(data) => runAction("/api/job-search/settings", "updateFindSettings", data, "Find settings saved.")}
            onRequeueForRescoring={() => runAction("/api/job-search/run", "requeueForRescoring", {}, "Requeued for re-scoring.")}
          />
        )}
      </main>
    </div>
  );
}
