// Cross-posting "answer memory" — every answer typed into the Review Queue's
// "Answer & Retry" popup (see app/api/job-search/review-queue/route.js's
// saveManualAnswersAndRetryOne) is saved here, one row per DISTINCT
// remembered question, so a similarly-worded question on a LATER, unrelated
// posting can be auto-filled from it instead of landing in manual review
// again — see the adapters (greenhouse.js etc.), which call
// findBestMemoryMatch() as one more resolution strategy in their per-field
// loop, and jobSearchDb.js's own comment on the table this backs.
//
// Deliberately reuses embedText()/cosineSimilarity() from jobSearchLlm.js
// rather than any new matching machinery — same asymmetric query/document
// embedding convention job_search_postings already uses to match a posting
// against the candidate's profile, just matching a question against past
// questions instead.
import { cleanId, cleanText, ensureJobSearchSchema, parseJsonColumn, requirePool, toJsonParam } from "./jobSearchDb.js";
import { cosineSimilarity, embedText, getEmbeddingModel, isJobSearchLlmConfigured } from "./jobSearchLlm.js";
import { normalizeLabel } from "./jobSearchAdapters/profileMapping.js";
import { incrementLlmUsage } from "./jobSearchUsageStore.js";

// A conservative starting point, not derived from any live corpus (none
// exists yet) — auto-filling a real form field needs to be far stricter than
// e.g. resumeMatchThreshold (which only decides whether a POSTING is worth
// looking at, default 0.55). Worth promoting to a Find Settings field if it
// ever turns out to need tuning; not worth the extra UI surface up front.
const MIN_MEMORY_MATCH_SIMILARITY = 0.86;

const ANSWER_MAX_LENGTH = 2000;
const LABEL_MAX_LENGTH = 500;

function mapAnswerMemoryRow(row) {
  return {
    id: Number(row.id),
    questionLabel: row.question_label,
    normalizedLabel: row.normalized_label,
    answer: row.answer,
    sourceCompanyName: row.source_company_name,
    timesReused: Number(row.times_reused),
    lastReusedAt: row.last_reused_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// A question's raw text literally naming the company it came from is
// definitionally posting-specific ("Have you previously worked at or
// consulted for GitLab?") — a semantic-similarity matcher would otherwise
// happily treat that and the same question about a different company as a
// near-perfect match, since they differ only in one proper noun. Applied on
// BOTH the write side (never memorize) and the read side (never match
// against), as defense in depth — this is the one guard this whole feature
// depends on to be safe to auto-fill from at all.
function isCompanySpecific(rawLabel, companyName) {
  const company = String(companyName || "").trim().toLowerCase();
  return Boolean(company) && rawLabel.toLowerCase().includes(company);
}

// UI-facing — the Memory tab's "review everything ever saved" list. Excludes
// the embedding vector (a ~750-number array per row, no reason to ship it to
// the browser) — see listAnswerMemoryForMatching() below for the adapter-
// facing equivalent that needs it.
export async function listAnswerMemory() {
  const pool = requirePool(await ensureJobSearchSchema());
  const [rows] = await pool.query(
    `SELECT id, question_label, normalized_label, answer, source_company_name,
            times_reused, last_reused_at, created_at, updated_at
     FROM job_search_answer_memory ORDER BY updated_at DESC`
  );
  return rows.map(mapAnswerMemoryRow);
}

// Adapter-facing — fetched ONCE per submission attempt (before the per-field
// loop starts), then reused for every field's own findBestMemoryMatch() call
// below, so a posting with N unresolved fields costs one DB round trip, not N.
export async function listAnswerMemoryForMatching() {
  const pool = requirePool(await ensureJobSearchSchema());
  const [rows] = await pool.query(
    "SELECT id, answer, embedding FROM job_search_answer_memory WHERE embedding IS NOT NULL"
  );
  return rows.map((row) => ({ id: Number(row.id), answer: row.answer, embedding: parseJsonColumn(row.embedding) }));
}

// Called once per non-empty answered field from saveManualAnswersAndRetryOne
// — best-effort by design (the caller wraps this in its own .catch(); saving
// to memory is an enhancement, never a reason a retry itself should fail).
// Upserts by normalized_label: "save everything automatically" (the user's
// own choice) means re-answering the same recurring question later should
// update the existing entry, not pile up a duplicate — most recent answer
// wins.
export async function upsertAnswerMemory({ label, answer, postingCompanyName, sourcePostingId }) {
  const cleanAnswer = cleanText(answer, ANSWER_MAX_LENGTH);
  if (!cleanAnswer) return { saved: false, reason: "empty answer" };

  const rawLabel = cleanText(label, LABEL_MAX_LENGTH);
  if (!rawLabel) return { saved: false, reason: "empty label" };

  if (isCompanySpecific(rawLabel, postingCompanyName)) {
    return { saved: false, reason: "company-specific question" };
  }

  const normalized = normalizeLabel(rawLabel);
  if (!normalized) return { saved: false, reason: "empty normalized label" };

  if (!isJobSearchLlmConfigured()) return { saved: false, reason: "LLM not configured" };

  const embedding = await embedText({ text: rawLabel, taskType: "RETRIEVAL_DOCUMENT" });
  if (!embedding) return { saved: false, reason: "embedding failed" };
  await incrementLlmUsage("embed");

  const pool = requirePool(await ensureJobSearchSchema());
  const now = new Date();
  await pool.query(
    `INSERT INTO job_search_answer_memory
       (question_label, normalized_label, answer, embedding, embedding_model,
        source_posting_id, source_company_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       question_label = VALUES(question_label),
       answer = VALUES(answer),
       embedding = VALUES(embedding),
       embedding_model = VALUES(embedding_model),
       source_posting_id = VALUES(source_posting_id),
       source_company_name = VALUES(source_company_name),
       updated_at = VALUES(updated_at)`,
    [
      rawLabel, normalized, cleanAnswer, toJsonParam(embedding), getEmbeddingModel(),
      sourcePostingId || null, cleanText(postingCompanyName, 160), now, now
    ]
  );
  return { saved: true };
}

// The read-path match — called by each adapter once per otherwise-unresolved
// field, only after the caller has already checked the shared daily LLM-call
// budget (same convention every other per-field LLM check in this codebase
// already follows) and confirmed `memoryRows` (from
// listAnswerMemoryForMatching(), fetched once up front) isn't empty.
// Deliberately increments usage itself (unlike answerFreeText/
// chooseFromOptions, which leave that to their callers) — this same function
// is now called identically from 6 separate adapter files, and keeping the
// spend-accounting inside the one shared place it actually happens is more
// robust than trusting 6 call sites to each remember it consistently.
export async function findBestMemoryMatch(label, postingCompanyName, memoryRows) {
  const rawLabel = cleanText(label, LABEL_MAX_LENGTH);
  if (!rawLabel || !memoryRows?.length) return null;
  if (isCompanySpecific(rawLabel, postingCompanyName)) return null;

  const queryEmbedding = await embedText({ text: rawLabel, taskType: "RETRIEVAL_QUERY" }).catch(() => null);
  if (!queryEmbedding) return null;
  await incrementLlmUsage("embed");

  let best = null;
  for (const row of memoryRows) {
    if (!Array.isArray(row.embedding) || !row.embedding.length) continue;
    const similarity = cosineSimilarity(queryEmbedding, row.embedding);
    if (similarity >= MIN_MEMORY_MATCH_SIMILARITY && (!best || similarity > best.similarity)) {
      best = { id: row.id, answer: row.answer, similarity };
    }
  }
  return best;
}

// Trust signal for the Memory tab ("used 6 times") — best-effort, called
// after a successful auto-fill; never allowed to fail the submission it's
// attached to.
export async function recordMemoryReuse(id) {
  const pool = requirePool(await ensureJobSearchSchema());
  const memoryId = cleanId(id, "Answer memory");
  const now = new Date();
  await pool.query(
    "UPDATE job_search_answer_memory SET times_reused = times_reused + 1, last_reused_at = ?, updated_at = ? WHERE id = ?",
    [now, now, memoryId]
  );
}

// Answer-only edit from the Memory tab — no re-embedding needed, the stored
// embedding is of the QUESTION label, which this never changes.
export async function updateAnswerMemory(id, answer) {
  const pool = requirePool(await ensureJobSearchSchema());
  const memoryId = cleanId(id, "Answer memory");
  const cleanAnswer = cleanText(answer, ANSWER_MAX_LENGTH);
  const now = new Date();
  await pool.query(
    "UPDATE job_search_answer_memory SET answer = ?, updated_at = ? WHERE id = ?",
    [cleanAnswer, now, memoryId]
  );
  return { id: memoryId };
}

export async function deleteAnswerMemory(id) {
  const pool = requirePool(await ensureJobSearchSchema());
  const memoryId = cleanId(id, "Answer memory");
  await pool.query("DELETE FROM job_search_answer_memory WHERE id = ?", [memoryId]);
  return { id: memoryId };
}
