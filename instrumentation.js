// Next's documented hook for starting a background task once when the
// server process boots — see app/lib/jobSearchHeldChallengeWatcher.js and
// app/lib/jobSearchSubmitProgressWatcher.js for what actually runs. Guarded
// to the Node runtime (not edge): both watchers touch mysql2/node:events,
// neither of which exist in an edge worker, and Next calls register() once
// per runtime it initializes.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { startHeldChallengeWatcher } = await import("./app/lib/jobSearchHeldChallengeWatcher.js");
  startHeldChallengeWatcher();

  const { startSubmitProgressWatcher } = await import("./app/lib/jobSearchSubmitProgressWatcher.js");
  startSubmitProgressWatcher();
}
