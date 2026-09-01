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
    autoApplied: Boolean(row.auto_applied),
    userNote: row.user_note || "",
    attemptedAt: row.attempted_at,
    submittedAt: row.submitted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // The posting's CURRENT status, not this attempt's own outcome — this is
    // what actually lets the UI know a retry is in flight. "Retry submission"
    // resets the posting back to 'approved' (see /api/job-search/applications
    // route.js) so the submit-worker cron picks it up again, but that action
    // never touches this application row (each attempt is its own permanent
    // history entry, by design) — without this join, the UI had no way to
    // tell a retry had been queued at all short of checking a different tab.
    postingStatus: row.posting_status || null
  };
}

const APPLICATION_SELECT_COLUMNS = `
  a.id, a.posting_id, a.company_name, a.job_title, a.ats_type, a.apply_url, a.resume_id, a.resume_label,
  a.submitted_answers, a.score_snapshot, a.submission_status, a.error_message, a.ats_confirmation_text,
  a.auto_applied, a.user_note, a.attempted_at, a.submitted_at,
  a.created_at, a.updated_at, p.status AS posting_status
`;

export async function listApplications({ limit = 200 } = {}) {
  const pool = requirePool(await ensureJobSearchSchema());
  const [rows] = await pool.query(
    // LEFT JOIN (not INNER) so an application whose posting was somehow
    // removed still shows up rather than silently vanishing.
    `SELECT ${APPLICATION_SELECT_COLUMNS}
     FROM job_search_applications a
     LEFT JOIN job_search_postings p ON p.id = a.posting_id
     ORDER BY a.attempted_at DESC
     LIMIT ?`,
    [Number(limit) || 200]
  );

  const applications = rows.map(mapApplicationRow);

  // The newest row per posting is "current"; any older row for the same
  // posting has since been superseded by a later attempt (a retry) — flagged
  // here so the UI can distinguish "this is what happened" from "this is
  // what happened, but there's since been a newer attempt". Cheap to compute
  // client-side since the list is already ordered attempted_at DESC.
  const seenPostingIds = new Set();
  for (const application of applications) {
    application.isLatestAttemptForPosting = !seenPostingIds.has(application.postingId);
    seenPostingIds.add(application.postingId);
  }

  return applications;
}

export async function getApplicationById(id) {
  const pool = requirePool(await ensureJobSearchSchema());
  const applicationId = cleanId(id, "Application");
  const [rows] = await pool.query(
    `SELECT ${APPLICATION_SELECT_COLUMNS}
     FROM job_search_applications a
     LEFT JOIN job_search_postings p ON p.id = a.posting_id
     WHERE a.id = ? LIMIT 1`,
    [applicationId]
  );
  return rows[0] ? mapApplicationRow(rows[0]) : null;
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
  autoApplied = false
}) {
  const pool = requirePool(await ensureJobSearchSchema());
  const now = new Date();

  const [result] = await pool.query(
    `INSERT INTO job_search_applications
       (posting_id, company_name, job_title, ats_type, apply_url, resume_id, resume_label,
        submitted_answers, score_snapshot, submission_status, error_message, ats_confirmation_text,
        auto_applied, attempted_at, submitted_at, created_at, updated_at)
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
      autoApplied ? 1 : 0,
      now,
      submissionStatus === "submitted" ? now : null,
      now,
      now
    ]
  );

  return { id: Number(result.insertId) };
}

// Removes only the application record — never touches the posting itself, so
// deleting a stray/duplicate/test entry from Applied Jobs doesn't silently
// reopen or reclassify the posting it came from. Same "just delete the one
// thing asked for" scope as the existing deleteResume().
export async function deleteApplication(id) {
  const pool = requirePool(await ensureJobSearchSchema());
  const applicationId = cleanId(id, "Application");
  await pool.query("DELETE FROM job_search_applications WHERE id = ?", [applicationId]);
  return { id: applicationId };
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
