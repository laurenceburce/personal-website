import { redirect } from "next/navigation";
import JobSearchAppClient from "./JobSearchAppClient";
import { listApplications } from "../lib/jobSearchApplicationStore";
import { getJobSearchAccess } from "../lib/jobSearchAuth";
import { getCompanyDirectoryStats } from "../lib/jobSearchCompanyDirectory";
import { getDatabaseSizeMb } from "../lib/jobSearchDb";
import { isAdzunaConfigured } from "../lib/jobSearchDiscovery";
import { listRecentDiscoveryRuns } from "../lib/jobSearchDiscoveryRunStore";
import { countPostingsByStatus, listPostingsByStatus } from "../lib/jobSearchPostingsStore";
import { getDefaultResume, getFindSettings, getProfile, listResumes } from "../lib/jobSearchSettingsStore";
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
    reviewQueue,
    scoredLow,
    autoApplySkipped,
    applications,
    statusCounts,
    discoveryRuns,
    llmUsage,
    dbSizeMb,
    companyDirectoryStats,
    workerStatus
  ] = await Promise.all([
    getProfile(),
    getFindSettings(),
    listResumes(),
    getDefaultResume(),
    listPostingsByStatus("pending_review", { limit: 200 }),
    listPostingsByStatus("scored_low", { limit: 200 }),
    listPostingsByStatus("skipped_auto_apply", { limit: 200 }),
    listApplications({ limit: 200 }),
    countPostingsByStatus(),
    listRecentDiscoveryRuns({ limit: 20 }),
    getTodayLlmUsage(),
    getDatabaseSizeMb(),
    getCompanyDirectoryStats(),
    getAllWorkerStatus()
  ]);

  return {
    profile, findSettings, resumes, defaultResume, reviewQueue, scoredLow, autoApplySkipped, applications,
    statusCounts, discoveryRuns, llmUsage, dbSizeMb, companyDirectoryStats, workerStatus,
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
