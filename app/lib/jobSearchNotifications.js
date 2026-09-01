import { listRecentDiscoveryRuns } from "./jobSearchDiscoveryRunStore.js";
import { listRecentSubmitRuns } from "./jobSearchSubmitRunStore.js";

// Toolbar notification feed — deliberately not its own stored table.
// Everything here is reconstructed from run history that's already recorded
// for other reasons (the same rows that power Overview's own Activity
// History popups), same "derive, don't duplicate storage" approach as
// jobSearchDiscoveryRunStore's getDiscoveryRunDetails. "Read/unread" is
// tracked client-side (localStorage, see NotificationsBell.js) rather than
// server-side — this is a single-owner dashboard, not a multi-user inbox
// that needs read-state to sync across devices.
const RUNS_TO_SCAN = 30;

function plural(n) {
  return n === 1 ? "" : "s";
}

export async function listRecentNotifications({ limit = 20 } = {}) {
  const [discoveryRuns, submitRuns] = await Promise.all([
    listRecentDiscoveryRuns({ limit: RUNS_TO_SCAN }),
    listRecentSubmitRuns({ limit: RUNS_TO_SCAN })
  ]);

  const notifications = [];

  // "New postings" only (jobsCreated/directPollCreated), not every posting
  // seen — same distinction getDiscoveryRunDetails' own comment makes: a
  // normal direct-poll run re-touches everything already known, so a raw
  // "jobs found" count would be noise on every single run.
  for (const run of discoveryRuns) {
    const count = run.jobsCreated + run.directPollCreated;
    if (count <= 0) continue;
    notifications.push({
      id: `discovery:${run.id}`,
      type: "jobs_found",
      message: `Found ${count} new job${plural(count)}`,
      count,
      ranAt: run.ranAt,
      refId: run.id
    });
  }

  // One submit-worker pass can produce both a success notification and a
  // failure notification (some approved postings went through, others
  // didn't) — split into two entries rather than one mixed one so each reads
  // as a single clear headline, matching how the user described the three
  // notification types as distinct.
  for (const run of submitRuns) {
    const appliedCount = run.submittedCount + run.autoAppliedCount;
    if (appliedCount > 0) {
      notifications.push({
        id: `submit-success:${run.id}`,
        type: "applied_success",
        message: `Successfully applied to ${appliedCount} job${plural(appliedCount)}`,
        count: appliedCount,
        ranAt: run.ranAt,
        refId: run.id
      });
    }
    if (run.failedCount > 0) {
      notifications.push({
        id: `submit-failed:${run.id}`,
        type: "applied_failed",
        message: `${run.failedCount} application${plural(run.failedCount)} failed`,
        count: run.failedCount,
        ranAt: run.ranAt,
        refId: run.id
      });
    }
  }

  notifications.sort((a, b) => new Date(b.ranAt).getTime() - new Date(a.ranAt).getTime());
  return notifications.slice(0, limit);
}
