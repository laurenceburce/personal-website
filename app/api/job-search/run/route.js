import { NextResponse } from "next/server";
import { jsonError, requireAccessOrRespond } from "../../../lib/jobSearchApiHelpers";
import { runDiscoveryPass } from "../../../lib/jobSearchDiscovery";
import { recordDiscoveryRun } from "../../../lib/jobSearchDiscoveryRunStore";
import { runDirectPollPass } from "../../../lib/jobSearchDirectPoll";
import { requeuePostingsForRescoring } from "../../../lib/jobSearchPostingsStore";
import { scoreNewPostings } from "../../../lib/jobSearchScoringPipeline";
import { getFindSettings } from "../../../lib/jobSearchSettingsStore";
import { triggerSubmitWorker } from "../../../lib/jobSearchSubmitTrigger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Manual triggers for the Overview tab's "Run Discovery Now" / "Score New
// Postings Now" / "Run Submit Worker Now" buttons, plus Find Settings'
// "Re-score filtered/low-scored" bulk action — the first three otherwise
// only run on a cron schedule or an incidental event (an approve, a scoring
// pass), which can mean waiting a while to see anything happen after a
// settings change or just wanting to nudge the queue right now.
export async function POST(request) {
  const { unauthorizedResponse } = await requireAccessOrRespond();
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    const body = await request.json().catch(() => ({}));
    const action = body?.action;

    switch (action) {
      case "discoveryNow": {
        const findSettings = await getFindSettings();
        const discoveryResult = await runDiscoveryPass(findSettings);
        // Mirrors the cron worker: a manual discovery run also direct-polls
        // every company already known to be on a supported ATS, not just
        // Adzuna's own results for this one run.
        const directPollResult = await runDirectPollPass();

        // Same history table the cron worker writes to — a manually-triggered
        // run should show up in "Recent Discovery Runs" too, not just the
        // scheduled ones.
        await recordDiscoveryRun({
          discoveryRan: discoveryResult.ok,
          discoverySkipReason: discoveryResult.ok ? "" : discoveryResult.reason,
          jobsFound: discoveryResult.found || 0,
          jobsCreated: discoveryResult.created || 0,
          companiesProbed: discoveryResult.companiesProbed || 0,
          companiesFound: discoveryResult.companiesFound || 0,
          directPollCompaniesTotal: directPollResult.companiesTotal,
          directPollCompaniesPolled: directPollResult.companiesPolled,
          directPollCreated: directPollResult.created,
          directPollSkipped: directPollResult.skipped,
          directPollErrors: directPollResult.errors,
          jobsFoundByAts: directPollResult.jobsFoundByAts,
          ok: true
        }).catch(() => {});

        return NextResponse.json({ ok: discoveryResult.ok, result: { ...discoveryResult, directPoll: directPollResult } });
      }
      case "scoreNow": {
        const result = await scoreNewPostings({ limit: 200 });
        // A fresh scoring pass can put a posting straight into pending_review
        // at auto-apply-eligible thresholds — unlike an "approve", that never
        // goes through a route this file controls, so scoring completing is
        // its own separate "there might be new work" event. Only worth the
        // call when auto-apply is actually on; otherwise the submit-worker
        // would just wake up, find nothing eligible, and go back to sleep.
        const findSettings = await getFindSettings();
        if (findSettings.autoApplyEnabled) await triggerSubmitWorker("scoreNow");
        return NextResponse.json({ ok: true, result });
      }
      case "submitNow": {
        // Just the wake-up call, not the pass itself — the submit worker is
        // a separate always-on Railway service (see
        // jobSearchSubmitTrigger.js's own header comment), so this can't
        // run the batch inline and report a real outcome the way
        // discoveryNow/scoreNow above do. triggerSubmitWorker() never
        // throws (a missing/unreachable worker URL just no-ops), so this
        // always reports success — the toolbar's "Working" banner and the
        // Submit Worker card's live status are what actually confirm a pass
        // picked it up, within a couple seconds if it did.
        await triggerSubmitWorker("manual");
        return NextResponse.json({ ok: true, result: { triggered: true } });
      }
      case "requeueForRescoring": {
        const result = await requeuePostingsForRescoring();
        return NextResponse.json({ ok: true, result });
      }
      default:
        return NextResponse.json({ error: "Unknown run action." }, { status: 400 });
    }
  } catch (error) {
    return jsonError(error);
  }
}
