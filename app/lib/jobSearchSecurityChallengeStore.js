import { appError, cleanId, cleanText, ensureJobSearchSchema, requirePool } from "./jobSearchDb.js";

const DEFAULT_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_POLL_MS = 1500;

function mapChallengeRow(row, { includeCode = false } = {}) {
  const challenge = {
    id: Number(row.id),
    postingId: Number(row.posting_id),
    applicationId: row.application_id == null ? null : Number(row.application_id),
    companyName: row.company_name || "",
    jobTitle: row.job_title || "",
    atsType: row.ats_type || "",
    applyUrl: row.apply_url || "",
    challengeKind: row.challenge_kind || "security_code",
    promptText: row.prompt_text || "",
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    answeredAt: row.answered_at,
    updatedAt: row.updated_at
  };

  if (includeCode) challenge.code = row.code || "";
  return challenge;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function expireStaleSecurityChallenges() {
  const pool = requirePool(await ensureJobSearchSchema());
  const now = new Date();
  await pool.query(
    `UPDATE job_search_security_challenges
     SET status = 'expired', code = '', updated_at = ?
     WHERE status = 'pending' AND expires_at <= ?`,
    [now, now]
  );
}

export async function createSecurityChallenge({
  postingId,
  applicationId = null,
  companyName,
  jobTitle,
  atsType,
  applyUrl,
  challengeKind = "security_code",
  promptText = "",
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS
}) {
  const pool = requirePool(await ensureJobSearchSchema());
  const now = new Date();
  const expiresAt = new Date(now.getTime() + Math.max(30_000, Number(timeoutMs) || DEFAULT_WAIT_TIMEOUT_MS));
  const cleanPostingId = cleanId(postingId, "Posting");

  await pool.query(
    `UPDATE job_search_security_challenges
     SET status = 'expired', code = '', updated_at = ?
     WHERE posting_id = ? AND status = 'pending'`,
    [now, cleanPostingId]
  );

  const [result] = await pool.query(
    `INSERT INTO job_search_security_challenges
       (posting_id, application_id, company_name, job_title, ats_type, apply_url,
        challenge_kind, prompt_text, status, code, created_at, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', ?, ?, ?)`,
    [
      cleanPostingId,
      applicationId ? cleanId(applicationId, "Application") : null,
      cleanText(companyName, 160),
      cleanText(jobTitle, 300),
      cleanText(atsType, 24),
      cleanText(applyUrl, 600),
      cleanText(challengeKind, 40, "security_code"),
      cleanText(promptText, 500),
      now,
      expiresAt,
      now
    ]
  );

  return { id: Number(result.insertId), expiresAt };
}

export async function listPendingSecurityChallenges({ limit = 20 } = {}) {
  const pool = requirePool(await ensureJobSearchSchema());
  await expireStaleSecurityChallenges();
  const [rows] = await pool.query(
    `SELECT id, posting_id, application_id, company_name, job_title, ats_type, apply_url,
            challenge_kind, prompt_text, status, created_at, expires_at, answered_at, updated_at
     FROM job_search_security_challenges
     WHERE status = 'pending' AND expires_at > ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [new Date(), Number(limit) || 20]
  );
  return rows.map((row) => mapChallengeRow(row));
}

export async function answerSecurityChallenge(id, code) {
  const pool = requirePool(await ensureJobSearchSchema());
  const challengeId = cleanId(id, "Security challenge");
  const cleanCode = cleanText(code, 80);
  if (!cleanCode) throw appError("Security code is required.");

  const now = new Date();
  const [result] = await pool.query(
    `UPDATE job_search_security_challenges
     SET status = 'answered', code = ?, answered_at = ?, updated_at = ?
     WHERE id = ? AND status = 'pending' AND expires_at > ?`,
    [cleanCode, now, now, challengeId, now]
  );

  if (result.affectedRows === 0) {
    throw appError("That security-code prompt is no longer active. Retry the submission to generate a fresh prompt.", 409);
  }

  return { id: challengeId };
}

async function getSecurityChallengeForWorker(id) {
  const pool = requirePool(await ensureJobSearchSchema());
  const challengeId = cleanId(id, "Security challenge");
  const [rows] = await pool.query(
    `SELECT id, posting_id, application_id, company_name, job_title, ats_type, apply_url,
            challenge_kind, prompt_text, status, code, created_at, expires_at, answered_at, updated_at
     FROM job_search_security_challenges
     WHERE id = ?
     LIMIT 1`,
    [challengeId]
  );
  return rows[0] ? mapChallengeRow(rows[0], { includeCode: true }) : null;
}

export async function waitForSecurityChallengeCode(id, { timeoutMs = DEFAULT_WAIT_TIMEOUT_MS, pollMs = DEFAULT_POLL_MS } = {}) {
  const startedAt = Date.now();
  const waitMs = Math.max(30_000, Number(timeoutMs) || DEFAULT_WAIT_TIMEOUT_MS);
  const intervalMs = Math.max(500, Number(pollMs) || DEFAULT_POLL_MS);

  while (Date.now() - startedAt < waitMs) {
    const challenge = await getSecurityChallengeForWorker(id);
    if (!challenge) return { status: "missing", code: "" };
    if (challenge.status === "answered" && challenge.code) return { status: "answered", code: challenge.code };
    if (challenge.status !== "pending") return { status: challenge.status, code: "" };
    if (challenge.expiresAt && new Date(challenge.expiresAt).getTime() <= Date.now()) {
      await markSecurityChallengeExpired(id);
      return { status: "expired", code: "" };
    }
    await sleep(intervalMs);
  }

  await markSecurityChallengeExpired(id);
  return { status: "timeout", code: "" };
}

export async function markSecurityChallengeUsed(id) {
  const pool = requirePool(await ensureJobSearchSchema());
  const challengeId = cleanId(id, "Security challenge");
  await pool.query(
    "UPDATE job_search_security_challenges SET status = 'used', code = '', updated_at = ? WHERE id = ?",
    [new Date(), challengeId]
  );
}

export async function markSecurityChallengeExpired(id) {
  const pool = requirePool(await ensureJobSearchSchema());
  const challengeId = cleanId(id, "Security challenge");
  await pool.query(
    "UPDATE job_search_security_challenges SET status = 'expired', code = '', updated_at = ? WHERE id = ? AND status IN ('pending', 'answered')",
    [new Date(), challengeId]
  );
}
