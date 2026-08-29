import { cleanId, cleanText, ensureJobSearchSchema, parseJsonColumn, requirePool, toJsonParam } from "./jobSearchDb.js";

export function mapApplicationRow(row) {
  return {
    id: Number(row.id),
    postingId: Number(row.posting_id),
    companyName: row.company_name,
    jobTitle: row.job_title,
    atsType: row.ats_type,
    applyUrl: row.apply_url,
    resumeId: row.resume_id == null ? null : Number(row.resume_id),
    resumeLabel: row.resume_label,
    submittedAnswers: parseJsonColumn(row.submitted_answers, {}),
    scoreSnapshot: parseJsonColumn(row.score_snapshot, {}),
    submissionStatus: row.submission_status,
    errorMessage: row.error_message,
    atsConfirmationText: row.ats_confirmation_text,
    hasScreenshot: Boolean(row.has_screenshot),
    userNote: row.user_note || "",
    attemptedAt: row.attempted_at,
    submittedAt: row.submitted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function listApplications({ limit = 200 } = {}) {
  const pool = requirePool(await ensureJobSearchSchema());
  const [rows] = await pool.query(
    // screenshot is a LONGBLOB — never select it in a list query, it's streamed
    // separately by the screenshot route (Milestone 5) when actually needed.
    `SELECT id, posting_id, company_name, job_title, ats_type, apply_url, resume_id, resume_label,
            submitted_answers, score_snapshot, submission_status, error_message, ats_confirmation_text,
            (screenshot IS NOT NULL) AS has_screenshot, user_note, attempted_at, submitted_at, created_at, updated_at
     FROM job_search_applications
     ORDER BY attempted_at DESC
     LIMIT ?`,
    [Number(limit) || 200]
  );
  return rows.map(mapApplicationRow);
}

export async function getApplicationById(id) {
  const pool = requirePool(await ensureJobSearchSchema());
  const applicationId = cleanId(id, "Application");
  const [rows] = await pool.query(
    `SELECT id, posting_id, company_name, job_title, ats_type, apply_url, resume_id, resume_label,
            submitted_answers, score_snapshot, submission_status, error_message, ats_confirmation_text,
            (screenshot IS NOT NULL) AS has_screenshot, user_note, attempted_at, submitted_at, created_at, updated_at
     FROM job_search_applications WHERE id = ? LIMIT 1`,
    [applicationId]
  );
  return rows[0] ? mapApplicationRow(rows[0]) : null;
}

export async function getApplicationScreenshot(id) {
  const pool = requirePool(await ensureJobSearchSchema());
  const applicationId = cleanId(id, "Application");
  const [rows] = await pool.query("SELECT screenshot FROM job_search_applications WHERE id = ? LIMIT 1", [applicationId]);
  return rows[0]?.screenshot || null;
}

// Called once per Playwright submit attempt (success, failure, or manual-review
// hand-off) by the submit worker — one row per attempt, so a retry creates a
// new row rather than overwriting the history of what was tried.
export async function insertApplicationAttempt({
  postingId,
  companyName,
  jobTitle,
  atsType,
  applyUrl,
  resumeId,
  resumeLabel,
  submittedAnswers,
  scoreSnapshot,
  submissionStatus,
  errorMessage,
  atsConfirmationText,
  screenshotBuffer
}) {
  const pool = requirePool(await ensureJobSearchSchema());
  const now = new Date();

  const [result] = await pool.query(
    `INSERT INTO job_search_applications
       (posting_id, company_name, job_title, ats_type, apply_url, resume_id, resume_label,
        submitted_answers, score_snapshot, submission_status, error_message, ats_confirmation_text,
        screenshot, attempted_at, submitted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      cleanId(postingId, "Posting"),
      cleanText(companyName, 160),
      cleanText(jobTitle, 300),
      cleanText(atsType, 16),
      cleanText(applyUrl, 600),
      resumeId ? cleanId(resumeId, "Resume") : null,
      cleanText(resumeLabel, 120),
      toJsonParam(submittedAnswers || {}),
      toJsonParam(scoreSnapshot || {}),
      cleanText(submissionStatus, 24, "failed"),
      cleanText(errorMessage, 500),
      cleanText(atsConfirmationText, 500),
      screenshotBuffer || null,
      now,
      submissionStatus === "submitted" ? now : null,
      now,
      now
    ]
  );

  return { id: Number(result.insertId) };
}

export async function updateApplicationNote(id, note) {
  const pool = requirePool(await ensureJobSearchSchema());
  const applicationId = cleanId(id, "Application");
  await pool.query(
    "UPDATE job_search_applications SET user_note = ?, updated_at = ? WHERE id = ?",
    [cleanText(note, 500), new Date(), applicationId]
  );
  return { id: applicationId };
}
