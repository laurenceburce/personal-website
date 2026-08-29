import { runHardFilters } from "./jobSearchHardFilters.js";
import { cosineSimilarity, embedText, getEmbeddingModel, isJobSearchLlmConfigured, scoreJob } from "./jobSearchLlm.js";
import { listPostingsByStatus, updatePostingScore } from "./jobSearchPostingsStore.js";
import { assessScamRisk } from "./jobSearchScamDetection.js";
import { SCORE_DIMENSIONS, SCORE_WEIGHTS } from "./jobSearchScoringConfig.js";
import { getDefaultResume, getFindSettings, getProfile, saveProfileEmbeddingCache } from "./jobSearchSettingsStore.js";

const POSTING_EMBEDDING_CHARS = 8000;

function computeOverallScore(dimensionScores) {
  let total = 0;
  for (const dimension of SCORE_DIMENSIONS) {
    const weight = SCORE_WEIGHTS[dimension.key] || 0;
    const score = dimensionScores[dimension.key] ?? 0;
    total += (score / 10) * weight;
  }
  return Math.round(total * 1000) / 10; // 0-100 scale, one decimal
}

function buildProfileQueryText(findSettings, resume) {
  const parts = [
    (findSettings.titleKeywords || []).join(", "),
    (findSettings.seniorityLevels || []).join(", "),
    resume?.parsedText || ""
  ].filter(Boolean);
  return parts.join("\n\n");
}

// Cached on job_search_find_settings.profile_embedding, recomputed only when the
// cache is empty or was built with a different embedding model than is
// currently configured (findSettings/profile edits already null the cache out).
async function getOrBuildProfileQueryEmbedding(findSettings) {
  const currentModel = getEmbeddingModel();
  if (findSettings.profileEmbedding && findSettings.profileEmbeddingModel === currentModel) {
    return findSettings.profileEmbedding;
  }

  const resume = await getDefaultResume();
  const queryText = buildProfileQueryText(findSettings, resume);
  if (!queryText.trim()) return null;

  const embedding = await embedText({ text: queryText, taskType: "RETRIEVAL_QUERY" });
  if (embedding) await saveProfileEmbeddingCache({ embedding, model: currentModel });
  return embedding;
}

// Runs one posting through hard filters -> embedding rank -> LLM rubric, writing
// results back at whichever stage it stops. Never throws for an ordinary
// "this job doesn't qualify" outcome — only for genuine infrastructure errors
// (DB/LLM failures), which the caller (scoreNewPostings) catches per-posting so
// one bad posting can't abort an entire poll run.
export async function scorePosting(posting, context = {}) {
  const findSettings = context.findSettings || await getFindSettings();

  const filterResult = runHardFilters(posting, findSettings);
  if (!filterResult.passed) {
    await updatePostingScore(posting.id, { status: "filtered_out", filterReasons: filterResult.reasons });
    return { status: "filtered_out", reasons: filterResult.reasons };
  }

  if (!isJobSearchLlmConfigured()) {
    // Leave it at 'new' — we can tell it passed hard filters, but can't rank/score
    // without an API key, so don't guess a status for it.
    return { status: posting.status, reasons: ["LLM not configured"] };
  }

  const embeddingModel = getEmbeddingModel();
  let embedding = null;
  let similarity = null;
  try {
    const profileEmbedding = await getOrBuildProfileQueryEmbedding(findSettings);
    if (profileEmbedding) {
      embedding = await embedText({
        text: `${posting.title}\n\n${(posting.descriptionText || "").slice(0, POSTING_EMBEDDING_CHARS)}`,
        taskType: "RETRIEVAL_DOCUMENT"
      });
      if (embedding) similarity = cosineSimilarity(profileEmbedding, embedding);
    }
  } catch (error) {
    // Embedding is a pre-filter, not a requirement — fall through to LLM scoring
    // unranked rather than losing the posting entirely over a transient API error.
    console.error(`[jobSearchScoringPipeline] embedding failed for posting ${posting.id}:`, error?.message || error);
  }

  if (similarity != null && similarity < findSettings.resumeMatchThreshold) {
    await updatePostingScore(posting.id, { status: "below_threshold", embedding, embeddingModel, similarity });
    return { status: "below_threshold", similarity };
  }

  const resume = await getDefaultResume();
  const scoreResult = await scoreJob({ posting, findSettings, resumeText: resume?.parsedText });
  const overall = computeOverallScore(scoreResult.dimensionScores);
  const nextStatus = overall >= findSettings.minLlmScore ? "pending_review" : "scored_low";

  // Scam risk is a pure rules+RDAP check, no LLM — informational only, so a
  // failure here should never lose an otherwise-good LLM score.
  let scamRisk = { score: 0, level: "low", flags: [] };
  try {
    scamRisk = await assessScamRisk(posting);
  } catch (error) {
    console.error(`[jobSearchScoringPipeline] scam-risk check failed for posting ${posting.id}:`, error?.message || error);
  }

  await updatePostingScore(posting.id, {
    status: nextStatus,
    embedding,
    embeddingModel,
    similarity,
    dimensionScores: scoreResult.dimensionScores,
    reasoning: scoreResult.reasoning,
    overall,
    summary: scoreResult.summary,
    concerns: scoreResult.concerns,
    model: scoreResult.model,
    scamRiskScore: scamRisk.score,
    scamRiskLevel: scamRisk.level,
    scamRiskFlags: scamRisk.flags
  });

  return { status: nextStatus, overall, scamRisk };
}

// Batch entry point for the worker script: scores every posting still sitting at
// 'new' (hard-filter-passing edits reset a posting back to 'new' too — see
// jobSearchPostingsStore.upsertPosting).
export async function scoreNewPostings({ limit = 100 } = {}) {
  const findSettings = await getFindSettings();
  const profile = await getProfile();
  const postings = await listPostingsByStatus("new", { limit });

  const tally = { total: postings.length, filteredOut: 0, belowThreshold: 0, pendingReview: 0, scoredLow: 0, errors: 0 };

  for (const posting of postings) {
    try {
      const outcome = await scorePosting(posting, { findSettings, profile });
      if (outcome.status === "filtered_out") tally.filteredOut += 1;
      else if (outcome.status === "below_threshold") tally.belowThreshold += 1;
      else if (outcome.status === "pending_review") tally.pendingReview += 1;
      else if (outcome.status === "scored_low") tally.scoredLow += 1;
    } catch (error) {
      tally.errors += 1;
      console.error(`[jobSearchScoringPipeline] scoring failed for posting ${posting.id}:`, error?.message || error);
    }
  }

  return tally;
}
