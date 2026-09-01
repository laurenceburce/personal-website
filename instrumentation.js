// Next's documented hook for starting a background task once when the
// server process boots — see app/lib/jobSearchHeldChallengeWatcher.js for
// what actually runs. Guarded to the Node runtime (not edge): the watcher
// touches mysql2/node:events, neither of which exist in an edge worker, and
// Next calls register() once per runtime it initializes.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { startHeldChallengeWatcher } = await import("./app/lib/jobSearchHeldChallengeWatcher.js");
  startHeldChallengeWatcher();
}
