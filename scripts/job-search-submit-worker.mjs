// Thin one-shot CLI wrapper around the real logic in
// app/lib/jobSearchSubmitWorkerRun.js. Kept as its own script (rather than
// folded entirely into the new event-driven server) for two reasons: local
// manual/dry-run testing (`node scripts/job-search-submit-worker.mjs`, exits
// after one pass, exactly as before), and as a Railway Cron Schedule you can
// still point at this file directly if you'd rather not run the persistent
// server in scripts/job-search-submit-worker-server.mjs at all. If you ARE
// running that server, you don't need this on a cron too — its own internal
// fallback timer already covers the same "make sure a run always eventually
// happens" job.
import { runSubmitWorkerPass } from "../app/lib/jobSearchSubmitWorkerRun.js";
import { getPool, isJobSearchDbConfigured } from "../app/lib/jobSearchDb.js";
import { recordWorkerRunResult } from "../app/lib/jobSearchWorkerStatusStore.js";

if (!isJobSearchDbConfigured()) {
  console.error("JOB_SEARCH_DATABASE_URL, DATABASE_URL, or MYSQL_URL is required.");
  process.exit(1);
}

try {
  await runSubmitWorkerPass();
} catch (error) {
  await recordWorkerRunResult("submit", { ok: false, error: error?.message || String(error) }).catch(() => {});
  throw error;
} finally {
  const pool = await getPool();
  if (pool) await pool.end();
}
