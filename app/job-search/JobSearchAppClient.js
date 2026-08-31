"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import AnswerMemoryPanel from "./AnswerMemoryPanel";
import AppliedJobsTable from "./AppliedJobsTable";
import { callJobSearchAction } from "./JobSearchUi";
import FindSettingsPanel from "./FindSettingsPanel";
import OracleSessionsPanel from "./OracleSessionsPanel";
import OverviewPanel from "./OverviewPanel";
import ProfileSettingsPanel from "./ProfileSettingsPanel";
import ReviewQueueTable from "./ReviewQueueTable";
import SecurityChallengesPanel from "./SecurityChallengesPanel";

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
        <button type="button" className="job-search-header-home" onClick={() => router.push("/")}>Home</button>
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

      <SecurityChallengesPanel
        initialChallenges={snapshot.securityChallenges}
        saving={saving}
        onSubmitCode={(id, code) => runAction(
          "/api/job-search/security-challenges",
          "submitSecurityCode",
          { id, code },
          "Security code submitted."
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
            onRunDiscovery={() => runAction("/api/job-search/run", "discoveryNow", {}, "Discovery run complete.")}
            onScoreNow={() => runAction("/api/job-search/run", "scoreNow", {}, "Scoring run complete.")}
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
