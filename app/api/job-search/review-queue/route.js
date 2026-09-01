import { NextResponse } from "next/server";
import { upsertAnswerMemory } from "../../../lib/jobSearchAnswerMemoryStore";
import { insertApplicationAttempt } from "../../../lib/jobSearchApplicationStore";
import { jsonError, requireAccessOrRespond } from "../../../lib/jobSearchApiHelpers";
import { polishFreeTextAnswer } from "../../../lib/jobSearchLlm";
import { decidePosting, getPostingById, updatePostingScore } from "../../../lib/jobSearchPostingsStore";
import { scorePosting } from "../../../lib/jobSearchScoringPipeline";
import { getDefaultResume, getFindSettings, getProfile } from "../../../lib/jobSearchSettingsStore";
import { triggerSubmitWorker } from "../../../lib/jobSearchSubmitTrigger";
import { getTodayLlmUsage, incrementLlmUsage } from "../../../lib/jobSearchUsageStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Retry reuses this same function (see applications/route.js's own comment)
// so a retried submission also gets this same immediate wake-up, not just a
// fresh "approve".
async function approveOne(id, email) {
  return decidePosting(id, { status: "approved", decidedBy: email });
}

async function rejectOne(id, email, note) {
  return decidePosting(id, { status: "rejected", decidedBy: email, decisionNote: note });
}

// For postings automation can't (or didn't) submit — an 'external'/
// unsupported-ATS posting, or one the user just preferred to apply to by
// hand — recorded exactly like a real submission would be, so it shows up in
// Applied Jobs and stops sitting in the review queue, but tagged distinctly
// (autoApplied: false, no submitted answers) so it's honest about
// having no automation trail.
async function markAppliedManuallyOne(id, email) {
  const posting = await getPostingById(id);
  if (!posting) throw new Error("Posting not found.");

  const defaultResume = await getDefaultResume();
  await insertApplicationAttempt({
    postingId: posting.id,
    companyName: posting.companyName,
    jobTitle: posting.title,
    atsType: posting.atsType,
    applyUrl: posting.applyUrl,
    resumeId: defaultResume?.id || null,
    resumeLabel: defaultResume?.label || "",
    submittedAnswers: {},
    scoreSnapshot: {
      overall: posting.llmOverallScore,
      scamRiskScore: posting.scamRiskScore,
      scamRiskLevel: posting.scamRiskLevel
    },
    submissionStatus: "submitted",
    errorMessage: "",
    atsConfirmationText: "Marked as applied manually.",
    autoApplied: false
  });

  return decidePosting(id, { status: "submitted", decidedBy: email, decisionNote: "Marked as applied manually." });
}

// Rewrites a candidate's own draft answer to one flagged manual-review
// question (see profileMapping.js's resolveManualOverride) — read-only, never
// touches the posting's stored answers or status. Metered against the same
// daily LLM budget as every other Gemini call in this system (scoring,
// embedding, the adapters' own free-text fallback) since it's the same model
// call, just seeded with the candidate's draft instead of generating from
// scratch — see jobSearchLlm.js's polishFreeTextAnswer.
async function polishManualAnswerOne(id, label, draftAnswer) {
  const posting = await getPostingById(id);
  if (!posting) throw new Error("Posting not found.");

  const findSettings = await getFindSettings();
  const usage = await getTodayLlmUsage();
  if (usage.totalCalls >= findSettings.maxLlmCallsPerDay) {
    throw new Error("Today's LLM call budget is used up — try again tomorrow, or save your answer as-is.");
  }

  const [profile, defaultResume] = await Promise.all([getProfile(), getDefaultResume()]);
  const polished = await polishFreeTextAnswer({
    question: label,
    draftAnswer,
    posting,
    profile,
    resumeText: defaultResume?.parsedText || ""
  });
  await incrementLlmUsage("score");

  return { polished };
}

// Persists the user's answers for a needs_manual_review posting's flagged
// fields, then does exactly what "Retry" already does (approveOne +
// triggerSubmitWorker) — see profileMapping.js's resolveManualOverride for
// where each adapter reads these back on the next attempt. Only labels
// already present in the posting's own stored manual_review_fields are
// written — anything else in the request is silently dropped, guarding
// against a stale client submitting answers for fields that no longer apply
// (e.g. the posting was retried again by some other means in between).
async function saveManualAnswersAndRetryOne(id, answers, email) {
  const posting = await getPostingById(id);
  if (!posting) throw new Error("Posting not found.");

  const submitted = new Map((Array.isArray(answers) ? answers : []).map((a) => [a.label, a.answer]));
  // Keeps f.options on the merged entry — dropping it here would blank out
  // the popup's real <select> back to a free-text textarea for the brief
  // window between this save and the next submit-worker attempt's own
  // (re-captured) fieldOptions overwriting it.
  const merged = (posting.manualReviewFields || []).map((f) => (
    submitted.has(f.label) ? { label: f.label, answer: submitted.get(f.label), options: f.options || null } : f
  ));
  await updatePostingScore(id, { manualReviewFields: merged });

  // Cross-posting answer memory — best-effort per field, never allowed to
  // fail (or even slow down noticeably) the retry itself; upsertAnswerMemory
  // already silently declines a company-specific question on its own (see
  // its own comment). See jobSearchAnswerMemoryStore.js / the adapters'
  // findBestMemoryMatch() call for where this gets read back on a LATER,
  // unrelated posting.
  await Promise.all(
    merged
      .filter((f) => submitted.has(f.label) && f.answer)
      .map((f) => upsertAnswerMemory({
        label: f.label,
        answer: f.answer,
        postingCompanyName: posting.companyName,
        sourcePostingId: posting.id
      }).catch((error) => console.error(`[answer-memory] Failed to save "${f.label}":`, error?.message || error)))
  );

  return approveOne(id, email);
}

export async function POST(request) {
  const { access, unauthorizedResponse } = await requireAccessOrRespond();
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    const body = await request.json().catch(() => ({}));
    const action = body?.action;
    const data = body?.data || {};

    switch (action) {
      case "approve": {
        const result = await approveOne(data.id, access.email);
        // Fire-and-forget: never blocks the response beyond its own short
        // internal timeout, and never throws — see jobSearchSubmitTrigger.js.
        // There's no fallback timer on the submit-worker side, so this call
        // landing is actually what gets this posting picked up promptly; see
        // that file's header comment for the failure mode if it doesn't.
        await triggerSubmitWorker("approve");
        return NextResponse.json({ ok: true, result });
      }
      case "reject":
        return NextResponse.json({ ok: true, result: await rejectOne(data.id, access.email, data.note) });
      case "markAppliedManually":
        return NextResponse.json({ ok: true, result: await markAppliedManuallyOne(data.id, access.email) });
      // Per-id isolation on both batch actions: each decidePosting() call is
      // its own independent write, not wrapped in a transaction, so without
      // this one bad id (or one transient DB hiccup) partway through a batch
      // would throw, aborting the loop and silently leaving every id after
      // it unprocessed while returning a bare error for the whole request —
      // masking that some of the batch actually did succeed.
      case "batchApprove": {
        const ids = Array.isArray(data.ids) ? data.ids : [];
        let succeeded = 0;
        const failed = [];
        for (const id of ids) {
          try {
            await approveOne(id, access.email);
            succeeded += 1;
          } catch (error) {
            failed.push({ id, error: error?.message || String(error) });
          }
        }
        // One trigger call for the whole batch, not one per id — the
        // submit-worker's own coalescing already handles overlapping
        // triggers fine, but there's no reason to make N network calls when
        // one wake-up covers everything this batch just approved.
        if (succeeded > 0) await triggerSubmitWorker("batchApprove");
        return NextResponse.json({ ok: true, result: { count: succeeded, failed } });
      }
      case "batchReject": {
        const ids = Array.isArray(data.ids) ? data.ids : [];
        let succeeded = 0;
        const failed = [];
        for (const id of ids) {
          try {
            await rejectOne(id, access.email, data.note);
            succeeded += 1;
          } catch (error) {
            failed.push({ id, error: error?.message || String(error) });
          }
        }
        return NextResponse.json({ ok: true, result: { count: succeeded, failed } });
      }
      case "rescoreNow": {
        const posting = await getPostingById(data.id);
        if (!posting) return NextResponse.json({ error: "Posting not found." }, { status: 404 });
        const outcome = await scorePosting(posting);
        return NextResponse.json({ ok: true, result: outcome });
      }
      case "polishManualAnswer":
        return NextResponse.json({ ok: true, result: await polishManualAnswerOne(data.id, data.label, data.draftAnswer) });
      case "saveManualAnswersAndRetry": {
        const result = await saveManualAnswersAndRetryOne(data.id, data.answers, access.email);
        // Same reasoning as the plain "approve" case above — no fallback
        // timer on the submit-worker side, so this call landing is what
        // actually gets the posting picked up promptly.
        await triggerSubmitWorker("answerManualReview");
        return NextResponse.json({ ok: true, result });
      }
      default:
        return NextResponse.json({ error: "Unknown review-queue action." }, { status: 400 });
    }
  } catch (error) {
    return jsonError(error);
  }
}
