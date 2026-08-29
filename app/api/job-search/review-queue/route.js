import { NextResponse } from "next/server";
import { insertApplicationAttempt } from "../../../lib/jobSearchApplicationStore";
import { jsonError, requireAccessOrRespond } from "../../../lib/jobSearchApiHelpers";
import { decidePosting, getPostingById } from "../../../lib/jobSearchPostingsStore";
import { scorePosting } from "../../../lib/jobSearchScoringPipeline";
import { getDefaultResume } from "../../../lib/jobSearchSettingsStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
// (autoApplied: false, no screenshot/submitted answers) so it's honest about
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
    screenshotBuffer: null,
    autoApplied: false
  });

  return decidePosting(id, { status: "submitted", decidedBy: email, decisionNote: "Marked as applied manually." });
}

export async function POST(request) {
  const { access, unauthorizedResponse } = await requireAccessOrRespond();
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    const body = await request.json().catch(() => ({}));
    const action = body?.action;
    const data = body?.data || {};

    switch (action) {
      case "approve":
        return NextResponse.json({ ok: true, result: await approveOne(data.id, access.email) });
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
      default:
        return NextResponse.json({ error: "Unknown review-queue action." }, { status: 400 });
    }
  } catch (error) {
    return jsonError(error);
  }
}
