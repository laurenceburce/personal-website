import { NextResponse } from "next/server";
import { jsonError, requireAccessOrRespond } from "../../../lib/jobSearchApiHelpers";
import { runDiscoveryPass } from "../../../lib/jobSearchDiscovery";
import { recordDiscoveryRun } from "../../../lib/jobSearchDiscoveryRunStore";
import { runDirectPollPass } from "../../../lib/jobSearchDirectPoll";
import { requeuePostingsForRescoring } from "../../../lib/jobSearchPostingsStore";
import { scoreNewPostings } from "../../../lib/jobSearchScoringPipeline";
import { getFindSettings } from "../../../lib/jobSearchSettingsStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Manual triggers for the Overview tab's "Run Discovery Now" / "Score New
// Postings Now" buttons, plus Find Settings' "Re-score filtered/low-scored"
// bulk action — all three otherwise only run on the poll-worker's own cron
// schedule, which can mean waiting up to 15 minutes to see anything happen
// after a settings change.
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
        return NextResponse.json({ ok: true, result });
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
