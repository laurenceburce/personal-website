import { redirect } from "next/navigation";
import JobSearchAppClient from "./JobSearchAppClient";
import { listApplications } from "../lib/jobSearchApplicationStore";
import { evaluateCheapGates } from "../lib/jobSearchAutoApplyGates";
import { getJobSearchAccess } from "../lib/jobSearchAuth";
import { getCompanyDirectoryStats } from "../lib/jobSearchCompanyDirectory";
import { getDatabaseSizeMb } from "../lib/jobSearchDb";
import { isAdzunaConfigured } from "../lib/jobSearchDiscovery";
import { listRecentDiscoveryRuns } from "../lib/jobSearchDiscoveryRunStore";
import { listOracleSessions } from "../lib/jobSearchOracleSessionStore";
import { countPostingsByStatus, listPostingsByStatus } from "../lib/jobSearchPostingsStore";
import { getDefaultResume, getFindSettings, getProfile, listResumes } from "../lib/jobSearchSettingsStore";
import { listRecentSubmitRuns } from "../lib/jobSearchSubmitRunStore";
import { getTodayLlmUsage } from "../lib/jobSearchUsageStore";
import { getAllWorkerStatus } from "../lib/jobSearchWorkerStatusStore";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Job Search",
  robots: {
    index: false,
    follow: false
  }
};

async function getDashboardSnapshot() {
  const [
    profile,
    findSettings,
    resumes,
    defaultResume,
    oracleSessions,
    reviewQueue,
    scoredLow,
    autoApplySkipped,
    approvedWaiting,
    needsManualReview,
    failedPostings,
    applications,
    statusCounts,
    discoveryRuns,
    submitRuns,
    llmUsage,
    dbSizeMb,
    companyDirectoryStats,
    workerStatus
  ] = await Promise.all([
    getProfile(),
    getFindSettings(),
    listResumes(),
    getDefaultResume(),
    listOracleSessions(),
    listPostingsByStatus("pending_review", { limit: 200 }),
    listPostingsByStatus("scored_low", { limit: 200 }),
    listPostingsByStatus("skipped_auto_apply", { limit: 200 }),
    // Approved postings sat with no dashboard visibility at all between
    // approval and the submit-worker actually picking them up — a human
    // approving one had no way to see it again until it either succeeded or
    // failed. Shown in Review's "In Queue" tab, tagged "Waiting for worker".
    listPostingsByStatus("approved", { limit: 200, orderBy: "score" }),
    // Same gap, worse: a posting whose submission attempt (manual approval OR
    // auto-apply) actually failed or needed manual review had NO Review view
    // at all until now — the only trace was on the application row in
    // Applied Jobs, with no path back to act on the posting itself
    // (re-approve, reject, mark applied by hand). See jobSearchPostingsStore
    // .js's new submissionNote handling for how the reason gets here.
    listPostingsByStatus("needs_manual_review", { limit: 200 }),
    listPostingsByStatus(["failed", "unsupported_ats"], { limit: 200 }),
    listApplications({ limit: 200 }),
    countPostingsByStatus(),
    listRecentDiscoveryRuns({ limit: 20 }),
    listRecentSubmitRuns({ limit: 20 }),
    getTodayLlmUsage(),
    getDatabaseSizeMb(),
    getCompanyDirectoryStats(),
    getAllWorkerStatus()
  ]);

  // Postings that would actually be attempted on the NEXT submit-worker run
  // — a preview, not a guarantee: it only re-runs the free, Playwright-free
  // checks (score/match/scam-risk/age thresholds — see
  // jobSearchAutoApplyGates.js), the same ones evaluateAutoApply() itself
  // checks first before ever resolving the real ATS or launching a browser.
  // A posting can still pass this preview and later get skipped for a
  // reason only discoverable by actually attempting it (unsupported ATS,
  // CAPTCHA, an unanswerable required field) — those only show up in the
  // "Auto-apply Failed" tab once a real run has actually tried. Sorted by
  // score, matching the submit-worker's own processing order.
  const autoApplyQueue = findSettings.autoApplyEnabled
    ? reviewQueue
        .filter((posting) => evaluateCheapGates(posting, findSettings) === null)
        .sort((a, b) => (b.llmOverallScore ?? 0) - (a.llmOverallScore ?? 0))
    : [];

  return {
    profile, findSettings, resumes, defaultResume, oracleSessions, reviewQueue, scoredLow, autoApplySkipped, approvedWaiting,
    needsManualReview, failedPostings, autoApplyQueue, applications,
    statusCounts, discoveryRuns, submitRuns, llmUsage, dbSizeMb, companyDirectoryStats, workerStatus,
    adzunaConfigured: isAdzunaConfigured()
  };
}

export default async function JobSearchPage({ searchParams }) {
  const params = await searchParams;
  const tab = typeof params?.tab === "string" ? params.tab : "overview";
  const access = await getJobSearchAccess();

  if (!access.session) {
    redirect(`/job-search/login?callbackUrl=${encodeURIComponent(`/job-search?tab=${tab}`)}`);
  }

  if (!access.authorized) {
    return (
      <main className="job-search-private-page">
        <section className="job-search-auth-card">
          <p className="job-search-kicker">Job Search</p>
          <h1>Access restricted</h1>
          <p>This dashboard is only available to the owner account.</p>
          <a href="/job-search/login" className="job-search-link-button">Use another account</a>
        </section>
      </main>
    );
  }

  const snapshot = await getDashboardSnapshot();

  return <JobSearchAppClient snapshot={snapshot} initialTab={tab} />;
}
