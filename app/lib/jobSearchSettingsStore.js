import {
  appError,
  cleanId,
  cleanText,
  ensureJobSearchSchema,
  parseJsonColumn,
  requirePool,
  toJsonParam
} from "./jobSearchDb.js";

const REMOTE_PREFERENCES = new Set(["remote_only", "remote_friendly", "onsite_only"]);

function cleanRemotePreference(value) {
  const preference = String(value || "").trim();
  return REMOTE_PREFERENCES.has(preference) ? preference : "remote_friendly";
}

function cleanStringArray(value, maxItems = 50, maxLength = 120) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanText(item, maxLength)).filter(Boolean).slice(0, maxItems);
}

function cleanFloat(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function cleanIntOrNull(value) {
  if (value === "" || value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num) : null;
}

async function clearProfileEmbeddingCache(pool) {
  await pool.query(
    `UPDATE job_search_find_settings
     SET profile_embedding = NULL, profile_embedding_model = NULL, profile_embedding_updated_at = NULL
     WHERE id = 1`
  );
}

// ---------- Profile ----------

function mapProfileRow(row) {
  return {
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    addressLine1: row.address_line1,
    city: row.city,
    stateRegion: row.state_region,
    postalCode: row.postal_code,
    country: row.country,
    linkedinUrl: row.linkedin_url,
    githubUrl: row.github_url,
    portfolioUrl: row.portfolio_url,
    otherLinks: parseJsonColumn(row.other_links, []),
    workHistory: parseJsonColumn(row.work_history, []),
    education: parseJsonColumn(row.education, []),
    workAuthorization: parseJsonColumn(row.work_authorization, {}),
    eeoAnswers: parseJsonColumn(row.eeo_answers, {}),
    defaultResumeId: row.default_resume_id == null ? null : Number(row.default_resume_id),
    coverLetterTemplate: row.cover_letter_template || "",
    updatedAt: row.updated_at
  };
}

export async function getProfile() {
  const pool = requirePool(await ensureJobSearchSchema());
  const [rows] = await pool.query("SELECT * FROM job_search_profile WHERE id = 1 LIMIT 1");
  return rows[0] ? mapProfileRow(rows[0]) : null;
}

export async function updateProfile(data) {
  const pool = requirePool(await ensureJobSearchSchema());
  const now = new Date();

  await pool.query(
    `UPDATE job_search_profile
     SET full_name = ?, email = ?, phone = ?, address_line1 = ?, city = ?, state_region = ?,
         postal_code = ?, country = ?, linkedin_url = ?, github_url = ?, portfolio_url = ?,
         other_links = ?, work_history = ?, education = ?, work_authorization = ?, eeo_answers = ?,
         cover_letter_template = ?, updated_at = ?
     WHERE id = 1`,
    [
      cleanText(data?.fullName, 160),
      cleanText(data?.email, 160),
      cleanText(data?.phone, 40),
      cleanText(data?.addressLine1, 200),
      cleanText(data?.city, 120),
      cleanText(data?.stateRegion, 120),
      cleanText(data?.postalCode, 20),
      cleanText(data?.country, 120),
      cleanText(data?.linkedinUrl, 300),
      cleanText(data?.githubUrl, 300),
      cleanText(data?.portfolioUrl, 300),
      toJsonParam(Array.isArray(data?.otherLinks) ? data.otherLinks : []),
      toJsonParam(Array.isArray(data?.workHistory) ? data.workHistory : []),
      toJsonParam(Array.isArray(data?.education) ? data.education : []),
      toJsonParam(data?.workAuthorization && typeof data.workAuthorization === "object" ? data.workAuthorization : {}),
      toJsonParam(data?.eeoAnswers && typeof data.eeoAnswers === "object" ? data.eeoAnswers : {}),
      cleanText(data?.coverLetterTemplate, 8000),
      now
    ]
  );

  // Resume/keyword changes both feed the cached profile-query embedding —
  // invalidate it here rather than risk scoring against a stale vector.
  await clearProfileEmbeddingCache(pool);

  return { ok: true };
}

// ---------- Find settings ----------

function mapFindSettingsRow(row) {
  return {
    titleKeywords: parseJsonColumn(row.title_keywords, []),
    excludeKeywords: parseJsonColumn(row.exclude_keywords, []),
    locations: parseJsonColumn(row.locations, []),
    remotePreference: row.remote_preference,
    seniorityLevels: parseJsonColumn(row.seniority_levels, []),
    salaryFloorUsd: row.salary_floor_usd == null ? null : Number(row.salary_floor_usd),
    maxPostingAgeHours: row.max_posting_age_hours == null ? null : Number(row.max_posting_age_hours),
    resumeMatchThreshold: Number(row.resume_match_threshold),
    minLlmScore: Number(row.min_llm_score),
    // Defaulted here (not just at the DB level) so every consumer gets a sane
    // number without null-checking — these are safety-net values, not
    // user-facing filter criteria, so "unset" should mean "use a safe default".
    maxLlmCallsPerDay: row.max_llm_calls_per_day == null ? 500 : Number(row.max_llm_calls_per_day),
    retentionDays: row.retention_days == null ? 30 : Number(row.retention_days),
    excludedCompanies: parseJsonColumn(row.excluded_companies, []),
    profileEmbedding: parseJsonColumn(row.profile_embedding),
    profileEmbeddingModel: row.profile_embedding_model,
    profileEmbeddingUpdatedAt: row.profile_embedding_updated_at,
    updatedAt: row.updated_at
  };
}

export async function getFindSettings() {
  const pool = requirePool(await ensureJobSearchSchema());
  const [rows] = await pool.query("SELECT * FROM job_search_find_settings WHERE id = 1 LIMIT 1");
  return rows[0] ? mapFindSettingsRow(rows[0]) : null;
}

export async function updateFindSettings(data) {
  const pool = requirePool(await ensureJobSearchSchema());
  const now = new Date();

  await pool.query(
    `UPDATE job_search_find_settings
     SET title_keywords = ?, exclude_keywords = ?, locations = ?, remote_preference = ?,
         seniority_levels = ?, salary_floor_usd = ?, max_posting_age_hours = ?,
         resume_match_threshold = ?, min_llm_score = ?, max_llm_calls_per_day = ?, retention_days = ?,
         excluded_companies = ?, profile_embedding = NULL, profile_embedding_model = NULL,
         profile_embedding_updated_at = NULL, updated_at = ?
     WHERE id = 1`,
    [
      toJsonParam(cleanStringArray(data?.titleKeywords)),
      toJsonParam(cleanStringArray(data?.excludeKeywords)),
      toJsonParam(cleanStringArray(data?.locations)),
      cleanRemotePreference(data?.remotePreference),
      toJsonParam(cleanStringArray(data?.seniorityLevels, 20, 20)),
      cleanIntOrNull(data?.salaryFloorUsd),
      cleanIntOrNull(data?.maxPostingAgeHours),
      cleanFloat(data?.resumeMatchThreshold, 0.55, { min: 0, max: 1 }),
      cleanFloat(data?.minLlmScore, 65, { min: 0, max: 100 }),
      Math.round(cleanFloat(data?.maxLlmCallsPerDay, 500, { min: 1, max: 100000 })),
      Math.round(cleanFloat(data?.retentionDays, 30, { min: 1, max: 3650 })),
      toJsonParam(cleanStringArray(data?.excludedCompanies, 200, 160)),
      now
    ]
  );

  return { ok: true };
}

// Called by the scoring pipeline once it computes a fresh profile-query embedding.
export async function saveProfileEmbeddingCache({ embedding, model }) {
  const pool = requirePool(await ensureJobSearchSchema());
  await pool.query(
    `UPDATE job_search_find_settings
     SET profile_embedding = ?, profile_embedding_model = ?, profile_embedding_updated_at = ?
     WHERE id = 1`,
    [toJsonParam(embedding), cleanText(model, 64), new Date()]
  );
}

// ---------- Resumes ----------

function mapResumeRow(row) {
  return {
    id: Number(row.id),
    label: row.label,
    fileName: row.file_name,
    mimeType: row.mime_type,
    fileSize: Number(row.file_size),
    parsedText: row.parsed_text ?? null,
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function listResumes() {
  const pool = requirePool(await ensureJobSearchSchema());
  const [rows] = await pool.query(
    `SELECT id, label, file_name, mime_type, file_size, is_default, created_at, updated_at
     FROM job_search_resumes ORDER BY is_default DESC, created_at DESC`
  );
  return rows.map(mapResumeRow);
}

export async function getResumeById(id, { includeBlob = false } = {}) {
  const pool = requirePool(await ensureJobSearchSchema());
  const resumeId = cleanId(id, "Resume");
  const columns = includeBlob
    ? "id, label, file_name, mime_type, file_size, file_blob, parsed_text, is_default, created_at, updated_at"
    : "id, label, file_name, mime_type, file_size, parsed_text, is_default, created_at, updated_at";
  const [rows] = await pool.query(`SELECT ${columns} FROM job_search_resumes WHERE id = ? LIMIT 1`, [resumeId]);
  if (!rows[0]) return null;
  return { ...mapResumeRow(rows[0]), ...(includeBlob ? { fileBlob: rows[0].file_blob } : {}) };
}

export async function getDefaultResume() {
  const pool = requirePool(await ensureJobSearchSchema());
  const [rows] = await pool.query(
    `SELECT id, label, file_name, mime_type, file_size, parsed_text, is_default, created_at, updated_at
     FROM job_search_resumes WHERE is_default = 1 LIMIT 1`
  );
  return rows[0] ? mapResumeRow(rows[0]) : null;
}

export async function createResume({ label, fileName, mimeType, fileBuffer, parsedText, makeDefault }) {
  const pool = requirePool(await ensureJobSearchSchema());
  const now = new Date();

  if (!Buffer.isBuffer(fileBuffer) || !fileBuffer.length) {
    throw appError("Resume file is required.");
  }

  const [existingCountRows] = await pool.query("SELECT COUNT(*) AS total FROM job_search_resumes");
  const isFirstResume = Number(existingCountRows[0]?.total || 0) === 0;
  const shouldBeDefault = isFirstResume || makeDefault === true;

  const [result] = await pool.query(
    `INSERT INTO job_search_resumes
       (label, file_name, mime_type, file_size, file_blob, parsed_text, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      cleanText(label, 120, "Default"),
      cleanText(fileName, 255, "resume.pdf"),
      cleanText(mimeType, 120, "application/pdf"),
      fileBuffer.length,
      fileBuffer,
      cleanText(parsedText, 200000),
      shouldBeDefault ? 1 : 0,
      now,
      now
    ]
  );

  const resumeId = Number(result.insertId);
  if (shouldBeDefault) await setDefaultResume(resumeId);

  return { id: resumeId };
}

export async function setDefaultResume(id) {
  const pool = requirePool(await ensureJobSearchSchema());
  const resumeId = cleanId(id, "Resume");
  const now = new Date();

  const [existing] = await pool.query("SELECT id FROM job_search_resumes WHERE id = ? LIMIT 1", [resumeId]);
  if (!existing[0]) throw appError("Resume not found.", 404);

  await pool.query(
    "UPDATE job_search_resumes SET is_default = (id = ?), updated_at = ? WHERE is_default = 1 OR id = ?",
    [resumeId, now, resumeId]
  );
  await pool.query("UPDATE job_search_profile SET default_resume_id = ?, updated_at = ? WHERE id = 1", [resumeId, now]);
  await clearProfileEmbeddingCache(pool);

  return { id: resumeId };
}

export async function deleteResume(id) {
  const pool = requirePool(await ensureJobSearchSchema());
  const resumeId = cleanId(id, "Resume");

  const [rows] = await pool.query("SELECT is_default FROM job_search_resumes WHERE id = ? LIMIT 1", [resumeId]);
  if (!rows[0]) return { id: resumeId };

  await pool.query("DELETE FROM job_search_resumes WHERE id = ?", [resumeId]);

  if (rows[0].is_default) {
    await pool.query("UPDATE job_search_profile SET default_resume_id = NULL, updated_at = ? WHERE id = 1", [new Date()]);
    await clearProfileEmbeddingCache(pool);

    // Promote the most recently uploaded remaining resume, if any, so there's
    // always a usable default whenever at least one resume exists.
    const [remaining] = await pool.query("SELECT id FROM job_search_resumes ORDER BY created_at DESC LIMIT 1");
    if (remaining[0]) await setDefaultResume(remaining[0].id);
  }

  return { id: resumeId };
}
