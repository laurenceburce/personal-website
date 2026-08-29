"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import AppliedJobsTable from "./AppliedJobsTable";
import { callJobSearchAction } from "./JobSearchUi";
import FindSettingsPanel from "./FindSettingsPanel";
import OverviewPanel from "./OverviewPanel";
import ProfileSettingsPanel from "./ProfileSettingsPanel";
import ReviewQueueTable from "./ReviewQueueTable";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "review", label: "Review Queue" },
  { id: "applied", label: "Applied Jobs" },
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

  async function uploadResume(formData) {
    setSaving("uploadResume");
    setError("");
    try {
      const response = await fetch("/api/job-search/resumes", { method: "POST", body: formData });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "Upload failed.");
      setNotice("Resume uploaded.");
      router.refresh();
    } catch (err) {
      setError(err?.message || "Upload failed.");
    } finally {
      setSaving("");
    }
  }

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
            {t.id === "review" && snapshot.reviewQueue.length > 0 && (
              <span className="job-search-tab-badge">{snapshot.reviewQueue.length}</span>
            )}
          </button>
        ))}
      </nav>

      {error ? <div className="job-search-alert job-search-alert-error">{error}</div> : null}
      {notice && !error ? <div className="job-search-alert">{notice}</div> : null}

      <main className="job-search-main">
        {tab === "overview" && (
          <OverviewPanel
            findSettings={snapshot.findSettings}
            statusCounts={snapshot.statusCounts}
            recentActivity={snapshot.recentActivity}
            llmUsage={snapshot.llmUsage}
            maxLlmCallsPerDay={snapshot.findSettings.maxLlmCallsPerDay}
            dbSizeMb={snapshot.dbSizeMb}
            companyDirectoryStats={snapshot.companyDirectoryStats}
            workerStatus={snapshot.workerStatus}
            adzunaConfigured={snapshot.adzunaConfigured}
            defaultResume={snapshot.defaultResume}
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
            saving={saving}
            onApprove={(id) => runAction("/api/job-search/review-queue", "approve", { id }, "Approved.")}
            onReject={(id, note) => runAction("/api/job-search/review-queue", "reject", { id, note }, "Rejected.")}
            onBatchApprove={(ids) => runAction("/api/job-search/review-queue", "batchApprove", { ids }, `Approved ${ids.length}.`)}
            onBatchReject={(ids, note) => runAction("/api/job-search/review-queue", "batchReject", { ids, note }, `Rejected ${ids.length}.`)}
            onRescore={(id) => runAction("/api/job-search/review-queue", "rescoreNow", { id }, "Re-scored.")}
          />
        )}

        {tab === "applied" && (
          <AppliedJobsTable
            applications={snapshot.applications}
            saving={saving}
            onUpdateNote={(id, note) => runAction("/api/job-search/applications", "updateApplicationNote", { id, note }, "Note saved.")}
            onRetry={(id) => runAction("/api/job-search/applications", "retrySubmission", { id }, "Re-queued for the next submit run.")}
          />
        )}

        {tab === "settings" && (
          <ProfileSettingsPanel
            profile={snapshot.profile}
            resumes={snapshot.resumes}
            saving={saving}
            onSaveProfile={(data) => runAction("/api/job-search/settings", "updateProfile", data, "Profile saved.")}
            onUploadResume={uploadResume}
            onSetDefaultResume={(id) => runAction("/api/job-search/resumes", "setDefaultResume", { id }, "Default resume updated.")}
            onDeleteResume={(id) => runAction("/api/job-search/resumes", "deleteResume", { id }, "Resume deleted.")}
          />
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
