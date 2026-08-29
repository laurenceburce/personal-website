// Picks up every posting at status='approved', runs it through the matching
// ATS adapter, and records the result. Run-once script, meant to be triggered
// on a Railway Cron Schedule (see the plan doc for the recommended `*/10 * * * *`
// cadence) rather than looping internally.
import { submitApplication } from "../app/lib/jobSearchAdapters/index.js";
import { insertApplicationAttempt } from "../app/lib/jobSearchApplicationStore.js";
import { getPool, isJobSearchDbConfigured } from "../app/lib/jobSearchDb.js";
import { listPostingsByStatus, updatePostingScore } from "../app/lib/jobSearchPostingsStore.js";
import { getDefaultResume, getProfile, getResumeById } from "../app/lib/jobSearchSettingsStore.js";

if (!isJobSearchDbConfigured()) {
  console.error("JOB_SEARCH_DATABASE_URL, DATABASE_URL, or MYSQL_URL is required.");
  process.exit(1);
}

// Local-only escape hatch to watch the browser while debugging a new adapter —
// never set false on the Railway cron service.
const headless = process.env.JOB_SEARCH_PLAYWRIGHT_HEADLESS !== "false";

function toApplicationStatus(adapterStatus) {
  if (adapterStatus === "submitted") return "submitted";
  if (adapterStatus === "needs_manual_review") return "needs_manual_review";
  if (adapterStatus === "unsupported_ats") return "unsupported_ats";
  return "failed";
}

try {
  // Highest-match jobs get submitted first when there's a backlog bigger than
  // one run's limit.
  const approved = await listPostingsByStatus("approved", { limit: 20, orderBy: "score" });
  console.log(`Found ${approved.length} approved posting(s) to submit.`);

  if (approved.length > 0) {
    const profile = await getProfile();
    const defaultResume = await getDefaultResume();
    const resumeWithBlob = defaultResume ? await getResumeById(defaultResume.id, { includeBlob: true }) : null;

    for (const posting of approved) {
      console.log(`Submitting: "${posting.title}" at ${posting.companyName} (${posting.atsType})...`);

      const result = await submitApplication(posting.atsType, {
        posting,
        profile,
        resumeBuffer: resumeWithBlob?.fileBlob || null,
        resumeFileName: resumeWithBlob?.fileName || "resume.pdf",
        headless
      });

      const applicationStatus = toApplicationStatus(result.status);

      await insertApplicationAttempt({
        postingId: posting.id,
        companyName: posting.companyName,
        jobTitle: posting.title,
        atsType: posting.atsType,
        applyUrl: posting.applyUrl,
        resumeId: defaultResume?.id || null,
        resumeLabel: defaultResume?.label || "",
        submittedAnswers: result.submittedAnswers,
        scoreSnapshot: {
          overall: posting.llmOverallScore,
          scamRiskScore: posting.scamRiskScore,
          scamRiskLevel: posting.scamRiskLevel
        },
        submissionStatus: applicationStatus,
        errorMessage: result.manualReviewFields?.length
          ? `Needs manual review: ${result.manualReviewFields.join(", ")}`
          : result.errorMessage,
        atsConfirmationText: result.confirmationText,
        screenshotBuffer: result.screenshotBuffer
      });

      await updatePostingScore(posting.id, { status: applicationStatus });
      console.log(`  -> ${applicationStatus}`);
    }
  }

  console.log("Submit run complete.");
} finally {
  const pool = await getPool();
  if (pool) await pool.end();
}
