import { runHardFilters } from "./jobSearchHardFilters.js";
import { cosineSimilarity, embedText, getEmbeddingModel, isJobSearchLlmConfigured, scoreJob } from "./jobSearchLlm.js";
import { listPostingsByStatus, updatePostingScore } from "./jobSearchPostingsStore.js";
import { assessScamRisk } from "./jobSearchScamDetection.js";
import { SCORE_DIMENSIONS, SCORE_WEIGHTS } from "./jobSearchScoringConfig.js";
import { getDefaultResume, getFindSettings, saveProfileEmbeddingCache } from "./jobSearchSettingsStore.js";
import { getTodayLlmUsage, incrementLlmUsage } from "./jobSearchUsageStore.js";

const POSTING_EMBEDDING_CHARS = 8000;

// Auto-reject threshold for a single hard-dealbreaker dimension, independent
// of the weighted overall score — locationRemoteFit only, on purpose (see
// SCORE_WEIGHTS in jobSearchScoringConfig.js). Confirmed live this needed to
// exist: a posting requiring a specific in-office schedule the candidate
// flatly cannot work scored locationRemoteFit=0/10 but still landed at
// overall=69.5 (well above the default 65 pending-review threshold) because
// six other, unrelated, genuinely-strong dimensions (culture/tech-stack/
// compensation/etc.) diluted that 0 into insignificance in the weighted
// average. A weighted average is the right model for soft preference
// dimensions trading off against each other; it's the wrong model for a
// dimension that's actually binary (you either can work the arrangement or
// you can't). 0-10 scale, matching every dimension's own scale.
const AUTO_REJECT_LOCATION_MAX_SCORE = 2;

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
// Takes the default resume as a param rather than fetching it itself — the
// caller (scorePosting) already needs it for scoreJob() too, so fetching it
// once and sharing it avoids a redundant DB round-trip on every re-score.
async function getOrBuildProfileQueryEmbedding(findSettings, resume) {
  const currentModel = getEmbeddingModel();
  if (findSettings.profileEmbedding && findSettings.profileEmbeddingModel === currentModel) {
    return findSettings.profileEmbedding;
  }

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

  // Fetched once up front and shared — both the profile-embedding cache build
  // (only on a cold/invalidated cache) and the LLM rubric call below need the
  // resume text, and re-fetching it a second time for the same posting was a
  // pure wasted DB round-trip.
  const resume = await getDefaultResume();

  const embeddingModel = getEmbeddingModel();
  let embedding = null;
  let similarity = null;
  try {
    const profileEmbedding = await getOrBuildProfileQueryEmbedding(findSettings, resume);
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

  // The LLM rubric call and the scam-risk check are fully independent of each
  // other (scam-risk only ever reads the posting itself, never the LLM's
  // scores) — run them concurrently instead of back to back. In the common
  // case scam-risk has no RDAP lookup to do at all (see
  // jobSearchScamDetection.js) and finishes near-instantly, so this mostly
  // helps the less-common case where it does have one to make (up to an 8s
  // timeout) by overlapping it with the LLM call instead of adding to it.
  const [scoreResult, scamRisk] = await Promise.all([
    scoreJob({ posting, findSettings, resumeText: resume?.parsedText }),
    assessScamRisk(posting).catch((error) => {
      // Scam risk is informational only — a failure here should never lose
      // an otherwise-good LLM score.
      console.error(`[jobSearchScoringPipeline] scam-risk check failed for posting ${posting.id}:`, error?.message || error);
      return { score: 0, level: "low", flags: [] };
    })
  ]);
  await incrementLlmUsage("score");
  const overall = computeOverallScore(scoreResult.dimensionScores);

  // A hard dealbreaker on location/remote fit skips the review queue
  // entirely — see AUTO_REJECT_LOCATION_MAX_SCORE's own comment for why this
  // needs to be a gate rather than just another weighted-average input.
  const locationScore = scoreResult.dimensionScores?.locationRemoteFit;
  const isAutoRejected = locationScore != null && locationScore <= AUTO_REJECT_LOCATION_MAX_SCORE;
  const nextStatus = isAutoRejected ? "rejected" : (overall >= findSettings.minLlmScore ? "pending_review" : "scored_low");

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
    scamRiskFlags: scamRisk.flags,
    ...(isAutoRejected ? {
      autoRejectNote: `Auto-rejected: location/remote fit ${locationScore}/10 — `
        + (scoreResult.reasoning?.locationRemoteFit || "incompatible location requirement.")
    } : {})
  });

  // Auto-apply evaluation deliberately does NOT happen here, even though a
  // posting reaching pending_review is exactly the condition it fires on —
  // it needs a real Playwright browser (jobSearchAutoApply.js ->
  // atsResolver.js -> `playwright`), and this function runs from contexts
  // that can't provide one: the main web app's API routes (Score Now,
  // Re-score) and the regular poll-worker cron, neither of which has
  // Playwright's browser binaries installed — only the separate
  // job-search-submit-worker service does, via its own Docker image.
  // Confirmed live: importing that chain from here once broke the main
  // app's production build outright ("Cannot find module .../playwright-
  // core/browsers.json"), not just failed at the point of actually launching
  // a browser. Auto-apply now runs as its own pass inside
  // app/lib/jobSearchSubmitWorkerRun.js, over postings already sitting at
  // pending_review — same outcome, just from the one place that can
  // actually do it.
  return { status: nextStatus, overall, scamRisk };
}

// Batch entry point for the worker script: scores every posting still sitting at
// 'new' (hard-filter-passing edits reset a posting back to 'new' too — see
// jobSearchPostingsStore.upsertPosting). Ordered newest-posted-first so a
// backlog bigger than `limit` processes the freshest postings first, not
// whichever rows happen to have been touched most recently.
export async function scoreNewPostings({ limit = 100 } = {}) {
  const findSettings = await getFindSettings();
  const postings = await listPostingsByStatus("new", { limit, orderBy: "posted_at" });

  const tally = {
    total: postings.length,
    filteredOut: 0,
    belowThreshold: 0,
    pendingReview: 0,
    scoredLow: 0,
    autoRejected: 0,
    errors: 0,
    budgetExceeded: 0
  };

  for (const posting of postings) {
    try {
      const outcome = await scorePosting(posting, { findSettings });
      if (outcome.budgetExceeded) {
        // Every remaining posting this run would hit the same cap — stop
        // iterating rather than re-checking (and logging) it postings.length
        // more times. They stay at 'new' and get picked up on the next run,
        // once tomorrow's budget resets or the cap is raised. Every outcome
        // Every outcome bucket has to be subtracted here so the "deferred"
        // count reflects only untouched postings.
        tally.budgetExceeded = postings.length - (
          tally.filteredOut + tally.belowThreshold + tally.pendingReview + tally.scoredLow + tally.autoRejected
          + tally.errors
        );
        console.warn(`[jobSearchScoringPipeline] Daily LLM call budget (${findSettings.maxLlmCallsPerDay}) reached — stopping early, ${tally.budgetExceeded} posting(s) deferred to the next run.`);
        break;
      }
      if (outcome.status === "filtered_out") tally.filteredOut += 1;
      else if (outcome.status === "below_threshold") tally.belowThreshold += 1;
      else if (outcome.status === "pending_review") tally.pendingReview += 1;
      else if (outcome.status === "scored_low") tally.scoredLow += 1;
      // Only ever reached from a 'new' posting scored just now — a human
      // rejection never lands here (decidePosting() only ever runs on a
      // posting already past this pipeline), so this unambiguously means
      // this run's own auto-reject gate fired (see AUTO_REJECT_LOCATION_
      // MAX_SCORE's comment).
      else if (outcome.status === "rejected") tally.autoRejected += 1;
    } catch (error) {
      tally.errors += 1;
      console.error(`[jobSearchScoringPipeline] scoring failed for posting ${posting.id}:`, error?.message || error);
    }
  }

  return tally;
}
