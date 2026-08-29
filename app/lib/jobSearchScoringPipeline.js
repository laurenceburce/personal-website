import { evaluateAutoApply } from "./jobSearchAutoApply.js";
import { runHardFilters } from "./jobSearchHardFilters.js";
import { cosineSimilarity, embedText, getEmbeddingModel, isJobSearchLlmConfigured, scoreJob } from "./jobSearchLlm.js";
import { listPostingsByStatus, updatePostingScore } from "./jobSearchPostingsStore.js";
import { assessScamRisk } from "./jobSearchScamDetection.js";
import { SCORE_DIMENSIONS, SCORE_WEIGHTS } from "./jobSearchScoringConfig.js";
import { getDefaultResume, getFindSettings, getProfile, saveProfileEmbeddingCache } from "./jobSearchSettingsStore.js";
import { getTodayLlmUsage, incrementLlmUsage } from "./jobSearchUsageStore.js";

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
  if (embedding) {
    await saveProfileEmbeddingCache({ embedding, model: currentModel });
    await incrementLlmUsage("embed");
  }
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

  // Daily LLM-call budget — a hard, code-enforced ceiling independent of
  // whatever quota the provider allows, checked fresh per posting (not cached
  // across a run) so a bulk run stops the moment the cap is actually hit
  // rather than overshooting by however many postings were already in flight.
  // Applies to every entry point (worker script, manual "Re-score"), not just
  // the batch loop below, since this check lives in scorePosting() itself.
  const usage = await getTodayLlmUsage();
  if (usage.totalCalls >= findSettings.maxLlmCallsPerDay) {
    return { status: posting.status, reasons: ["Daily LLM call budget reached"], budgetExceeded: true };
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
      if (embedding) {
        await incrementLlmUsage("embed");
        similarity = cosineSimilarity(profileEmbedding, embedding);
      }
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
  await incrementLlmUsage("score");
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

  // Auto-apply: opt-in, evaluated only once a posting has cleared the
  // ordinary human-review bar above. Never runs for scored_low — auto-apply
  // is strictly an accelerant on top of the existing review-queue bar, never
  // a way around it.
  if (nextStatus === "pending_review" && findSettings.autoApplyEnabled) {
    const profile = context.profile || await getProfile();
    const autoApplyResult = await evaluateAutoApply({
      posting: {
        ...posting,
        llmOverallScore: overall,
        embeddingSimilarity: similarity,
        scamRiskScore: scamRisk.score,
        scamRiskLevel: scamRisk.level
      },
      findSettings,
      profile
    }).catch((error) => {
      // Auto-apply failing outright (bug, infra error) must never lose a
      // posting that already earned pending_review — worst case, a human
      // sees it in the review queue exactly like auto-apply was never on.
      console.error(`[jobSearchScoringPipeline] auto-apply evaluation failed for posting ${posting.id}:`, error?.message || error);
      return null;
    });

    if (autoApplyResult) {
      await updatePostingScore(posting.id, {
        status: autoApplyResult.status,
        autoApplySkipReason: autoApplyResult.skipReason || null,
        decisionNote: autoApplyResult.skipDetail || (autoApplyResult.status === "submitted" ? "Auto-applied." : "")
      });
      return { status: autoApplyResult.status, overall, scamRisk };
    }
  }

  return { status: nextStatus, overall, scamRisk };
}

// Batch entry point for the worker script: scores every posting still sitting at
// 'new' (hard-filter-passing edits reset a posting back to 'new' too — see
// jobSearchPostingsStore.upsertPosting). Ordered newest-posted-first so a
// backlog bigger than `limit` processes the freshest postings first, not
// whichever rows happen to have been touched most recently.
export async function scoreNewPostings({ limit = 100 } = {}) {
  const findSettings = await getFindSettings();
  const profile = await getProfile();
  const postings = await listPostingsByStatus("new", { limit, orderBy: "posted_at" });

  const tally = {
    total: postings.length,
    filteredOut: 0,
    belowThreshold: 0,
    pendingReview: 0,
    scoredLow: 0,
    autoSubmitted: 0,
    autoSkipped: 0,
    errors: 0,
    budgetExceeded: 0
  };

  for (const posting of postings) {
    try {
      const outcome = await scorePosting(posting, { findSettings, profile });
      if (outcome.budgetExceeded) {
        // Every remaining posting this run would hit the same cap — stop
        // iterating rather than re-checking (and logging) it postings.length
        // more times. They stay at 'new' and get picked up on the next run,
        // once tomorrow's budget resets or the cap is raised.
        tally.budgetExceeded = postings.length - (tally.filteredOut + tally.belowThreshold + tally.pendingReview + tally.scoredLow + tally.errors);
        console.warn(`[jobSearchScoringPipeline] Daily LLM call budget (${findSettings.maxLlmCallsPerDay}) reached — stopping early, ${tally.budgetExceeded} posting(s) deferred to the next run.`);
        break;
      }
      if (outcome.status === "filtered_out") tally.filteredOut += 1;
      else if (outcome.status === "below_threshold") tally.belowThreshold += 1;
      else if (outcome.status === "pending_review") tally.pendingReview += 1;
      else if (outcome.status === "scored_low") tally.scoredLow += 1;
      else if (outcome.status === "submitted") tally.autoSubmitted += 1;
      else if (outcome.status === "skipped_auto_apply") tally.autoSkipped += 1;
    } catch (error) {
      tally.errors += 1;
      console.error(`[jobSearchScoringPipeline] scoring failed for posting ${posting.id}:`, error?.message || error);
    }
  }

  return tally;
}
