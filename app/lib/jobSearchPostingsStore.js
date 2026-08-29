import {
  cleanId,
  ensureJobSearchSchema,
  parseJsonColumn,
  requirePool,
  toJsonParam
} from "./jobSearchDb.js";

// Statuses a posting can sit in before a human ever makes a decision on it. A
// changed content_hash only resets one of these back to 'new' for reprocessing —
// anything past this point (pending_review, approved, submitted, etc.) is left
// alone on a JD edit so a human decision or an in-flight submission never gets
// silently reset out from under them.
const PRE_DECISION_STATUSES = new Set(["new", "filtered_out", "below_threshold", "scored_low", "scored"]);

// Terminal, no-longer-actionable statuses — safe to prune after a retention
// window. Deliberately excludes anything still relevant: pending_review,
// approved, submitted, needs_manual_review, and failed (kept in case of retry)
// are never touched here.
const PRUNABLE_STATUSES = ["filtered_out", "below_threshold", "scored_low", "rejected", "closed", "skipped_auto_apply"];

export function mapPostingRow(row) {
  return {
    id: Number(row.id),
    atsType: row.ats_type,
    boardToken: row.board_token,
    externalJobId: row.external_job_id,
    companyName: row.company_name,
    title: row.title,
    department: row.department,
    locationText: row.location_text,
    remoteType: row.remote_type,
    seniorityGuess: row.seniority_guess,
    salaryMin: row.salary_min == null ? null : Number(row.salary_min),
    salaryMax: row.salary_max == null ? null : Number(row.salary_max),
    salaryCurrency: row.salary_currency,
    descriptionText: row.description_text,
    applyUrl: row.apply_url,
    postedAt: row.posted_at,
    contentHash: row.content_hash,
    status: row.status,
    filterReasons: parseJsonColumn(row.filter_reasons, []),
    embedding: parseJsonColumn(row.embedding),
    embeddingModel: row.embedding_model,
    embeddingSimilarity: row.embedding_similarity == null ? null : Number(row.embedding_similarity),
    embeddedAt: row.embedded_at,
    llmDimensionScores: parseJsonColumn(row.llm_dimension_scores),
    llmOverallScore: row.llm_overall_score == null ? null : Number(row.llm_overall_score),
    llmSummary: row.llm_summary,
    llmConcerns: parseJsonColumn(row.llm_concerns, []),
    llmModel: row.llm_model,
    scoredAt: row.scored_at,
    scamRiskScore: row.scam_risk_score == null ? null : Number(row.scam_risk_score),
    scamRiskLevel: row.scam_risk_level,
    scamRiskFlags: parseJsonColumn(row.scam_risk_flags, []),
    autoApplySkipReason: row.auto_apply_skip_reason,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    decisionNote: row.decision_note,
    isActive: Boolean(row.is_active),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Upserts one normalized posting (see jobSearchAtsSources.js / jobSearchDiscovery.js)
// on its natural key (ats_type, board_token, external_job_id). Returns whether
// the row was freshly created and whether it was reopened from a previously-closed state.
export async function upsertPosting(normalized) {
  const pool = requirePool(await ensureJobSearchSchema());
  const now = new Date();

  const [existingRows] = await pool.query(
    "SELECT id, status, content_hash FROM job_search_postings WHERE ats_type = ? AND board_token = ? AND external_job_id = ? LIMIT 1",
    [normalized.atsType, normalized.boardToken, normalized.externalJobId]
  );
  const existing = existingRows[0];

  const commonFields = [
    normalized.companyName,
    normalized.title,
    normalized.department || "",
    normalized.locationText || "",
    normalized.remoteType || "unknown",
    normalized.seniorityGuess || "unknown",
    normalized.salaryMin ?? null,
    normalized.salaryMax ?? null,
    normalized.salaryCurrency ?? null,
    normalized.descriptionText || null,
    normalized.applyUrl || "",
    normalized.postedAt || null,
    normalized.contentHash
  ];

  if (!existing) {
    const [result] = await pool.query(
      `INSERT INTO job_search_postings
         (ats_type, board_token, external_job_id, company_name, title, department,
          location_text, remote_type, seniority_guess, salary_min, salary_max, salary_currency,
          description_text, apply_url, posted_at, content_hash,
          status, is_active, first_seen_at, last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 1, ?, ?, ?, ?)`,
      [
        normalized.atsType, normalized.boardToken, normalized.externalJobId,
        ...commonFields, now, now, now, now
      ]
    );
    return { id: Number(result.insertId), isNew: true, reopened: false };
  }

  const reopened = existing.status === "closed";
  const shouldReprocess = reopened
    || (PRE_DECISION_STATUSES.has(existing.status) && existing.content_hash !== normalized.contentHash);
  const nextStatus = shouldReprocess ? "new" : existing.status;

  await pool.query(
    `UPDATE job_search_postings
     SET company_name = ?, title = ?, department = ?, location_text = ?,
         remote_type = ?, seniority_guess = ?, salary_min = ?, salary_max = ?, salary_currency = ?,
         description_text = ?, apply_url = ?, posted_at = ?,
         content_hash = ?, status = ?, is_active = 1, last_seen_at = ?, updated_at = ?
     WHERE id = ?`,
    [...commonFields, nextStatus, now, now, existing.id]
  );

  return { id: Number(existing.id), isNew: false, reopened };
}

export async function getPostingById(id) {
  const pool = requirePool(await ensureJobSearchSchema());
  const postingId = cleanId(id, "Posting");
  const [rows] = await pool.query("SELECT * FROM job_search_postings WHERE id = ? LIMIT 1", [postingId]);
  return rows[0] ? mapPostingRow(rows[0]) : null;
}

// Persists a posting's real ATS destination once resolveAtsDestination() (see
// jobSearchAdapters/atsResolver.js) figures it out — a discovery-sourced
// posting always starts tagged 'external' since Adzuna never reveals this.
// Deliberately narrow and separate from updatePostingScore: this never
// touches status or any scoring field, only relabels what the posting
// actually is, so it's safe to call regardless of what stage a posting is at.
export async function updatePostingAtsResolution(id, { atsType, boardToken, applyUrl }) {
  const pool = requirePool(await ensureJobSearchSchema());
  const postingId = cleanId(id, "Posting");
  await pool.query(
    "UPDATE job_search_postings SET ats_type = ?, board_token = ?, apply_url = ?, updated_at = ? WHERE id = ?",
    [atsType, boardToken || "", applyUrl, new Date(), postingId]
  );
  return { id: postingId };
}

// Whitelisted, never interpolated from caller input directly — orderBy only
// ever selects one of these three fixed clauses. NULLs sort last under MySQL's
// default DESC ordering in both cases, which is exactly right: a posting with
// an unknown post date or no score yet shouldn't jump the queue over ones that
// actually have the data being prioritized on.
const ORDER_BY_CLAUSES = {
  updated_at: "updated_at DESC",
  // Scoring priority: newest-posted jobs get processed first when there's a
  // backlog larger than one run's limit — freshness is the whole point.
  posted_at: "posted_at DESC",
  // Submission priority: highest-match jobs get applied to first.
  score: "llm_overall_score DESC"
};

export async function listPostingsByStatus(status, { limit = 200, orderBy = "updated_at" } = {}) {
  const pool = requirePool(await ensureJobSearchSchema());
  const statuses = Array.isArray(status) ? status : [status];
  const orderClause = ORDER_BY_CLAUSES[orderBy] || ORDER_BY_CLAUSES.updated_at;
  const [rows] = await pool.query(
    `SELECT * FROM job_search_postings WHERE status IN (?) ORDER BY ${orderClause} LIMIT ?`,
    [statuses, Number(limit) || 200]
  );
  return rows.map(mapPostingRow);
}

// Single flexible writer for every scoring-pipeline stage (hard filters, embedding
// rank, LLM rubric, and later the Milestone 3 scam-risk check) — each stage only
// passes the keys it touches, so this builds its SET clause dynamically.
export async function updatePostingScore(id, patch) {
  const pool = requirePool(await ensureJobSearchSchema());
  const postingId = cleanId(id, "Posting");
  const now = new Date();

  const setClauses = ["updated_at = ?"];
  const values = [now];
  const assign = (column, value) => {
    setClauses.push(`${column} = ?`);
    values.push(value);
  };

  if ("status" in patch) assign("status", patch.status);
  if ("filterReasons" in patch) assign("filter_reasons", toJsonParam(patch.filterReasons));

  if ("embedding" in patch) {
    assign("embedding", toJsonParam(patch.embedding));
    assign("embedding_model", patch.embeddingModel ?? null);
    assign("embedding_similarity", patch.similarity ?? null);
    assign("embedded_at", patch.embedding ? now : null);
  }

  if ("dimensionScores" in patch) {
    assign("llm_dimension_scores", toJsonParam({ scores: patch.dimensionScores, reasoning: patch.reasoning || {} }));
    assign("llm_overall_score", patch.overall ?? null);
    assign("llm_summary", patch.summary || "");
    assign("llm_concerns", toJsonParam(patch.concerns || []));
    assign("llm_model", patch.model || null);
    assign("scored_at", now);
  }

  if ("scamRiskScore" in patch) {
    assign("scam_risk_score", patch.scamRiskScore ?? null);
    assign("scam_risk_level", patch.scamRiskLevel ?? null);
    assign("scam_risk_flags", toJsonParam(patch.scamRiskFlags || []));
  }

  // Auto-apply outcome — set together whenever the pipeline itself decided
  // (submitted/skipped) rather than a human via decidePosting(). decisionNote
  // carries the specific detail (exact score/threshold, etc.); the reason
  // code is what's filterable/badge-able in the UI.
  if ("autoApplySkipReason" in patch) {
    assign("auto_apply_skip_reason", patch.autoApplySkipReason ?? null);
    assign("decision_note", String(patch.decisionNote || "").slice(0, 500));
    assign("decided_at", now);
    assign("decided_by", "auto-apply");
  }

  values.push(postingId);
  await pool.query(`UPDATE job_search_postings SET ${setClauses.join(", ")} WHERE id = ?`, values);
  return { id: postingId };
}

// Records a human decision on a posting (approve/reject/skip) — separate from
// updatePostingScore() since this is driven by the review queue UI, not the
// scoring pipeline, and always carries who/when/why.
export async function decidePosting(id, { status, decidedBy, decisionNote = "" }) {
  const pool = requirePool(await ensureJobSearchSchema());
  const postingId = cleanId(id, "Posting");
  const now = new Date();

  await pool.query(
    `UPDATE job_search_postings
     SET status = ?, decided_at = ?, decided_by = ?, decision_note = ?, updated_at = ?
     WHERE id = ?`,
    [status, now, decidedBy || null, String(decisionNote || "").slice(0, 500), now, postingId]
  );

  return { id: postingId };
}

// Recent activity feed for the Overview tab — every posting regardless of
// status, newest-updated first, so the dashboard can show "what just happened"
// rather than only what's currently pending review.
export async function listRecentPostings({ limit = 20 } = {}) {
  const pool = requirePool(await ensureJobSearchSchema());
  const [rows] = await pool.query(
    "SELECT * FROM job_search_postings ORDER BY updated_at DESC LIMIT ?",
    [Number(limit) || 20]
  );
  return rows.map(mapPostingRow);
}

export async function countPostingsByStatus() {
  const pool = requirePool(await ensureJobSearchSchema());
  const [rows] = await pool.query(
    "SELECT status, COUNT(*) AS total FROM job_search_postings GROUP BY status"
  );
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.total)]));
}

// Storage safety net #1: deletes postings that are no longer actionable (see
// PRUNABLE_STATUSES) and haven't changed in `retentionDays`. Called on every
// poll run (see job-search-worker.mjs) so storage stays bounded continuously
// rather than only reactively — the incident that motivated this happened
// because nothing ever pruned old data regardless of how much accumulated.
export async function cleanupOldPostings(retentionDays) {
  const pool = requirePool(await ensureJobSearchSchema());
  const days = Number(retentionDays) > 0 ? Number(retentionDays) : 30;
  // Computed in Node rather than SQL NOW() — this Railway MySQL server's system
  // clock runs several hours off true UTC (found during the storage incident
  // investigation), which matters little at day-granularity retention, but
  // every other timestamp in this codebase is Node-computed for consistency.
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [result] = await pool.query(
    "DELETE FROM job_search_postings WHERE status IN (?) AND updated_at < ?",
    [PRUNABLE_STATUSES, cutoff]
  );

  return { deletedCount: result.affectedRows, retentionDays: days };
}

// Bulk "try again with current settings" — resets postings the pipeline
// already ruled on automatically back to 'new' so the next scoring pass
// re-evaluates them against whatever Job Find Settings changes were just
// made. Deliberately excludes 'rejected'/'closed' (human/terminal decisions,
// never silently reopened) and 'scored' (mid-pipeline, not a rested state).
// 'skipped_auto_apply' is included since it's the same kind of automatic
// (non-human) decision as the other three — a raised threshold or a fixed
// adapter bug both warrant giving auto-apply another shot.
const REQUEUABLE_STATUSES = ["filtered_out", "below_threshold", "scored_low", "skipped_auto_apply"];

export async function requeuePostingsForRescoring() {
  const pool = requirePool(await ensureJobSearchSchema());
  const [result] = await pool.query(
    "UPDATE job_search_postings SET status = 'new', updated_at = ? WHERE status IN (?)",
    [new Date(), REQUEUABLE_STATUSES]
  );
  return { requeuedCount: result.affectedRows };
}
