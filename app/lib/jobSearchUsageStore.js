import { ensureJobSearchSchema, requirePool } from "./jobSearchDb.js";

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

// One row per calendar day, incremented per Gemini call. This is the data
// behind the daily LLM-call budget in jobSearchScoringPipeline.js — a
// code-enforced ceiling independent of whatever quota the provider allows.
export async function incrementLlmUsage(kind) {
  const pool = requirePool(await ensureJobSearchSchema());
  const column = kind === "embed" ? "embed_calls" : "score_calls";
  const now = new Date();

  await pool.query(
    `INSERT INTO job_search_llm_usage (usage_date, ${column}, updated_at)
     VALUES (?, 1, ?)
     ON DUPLICATE KEY UPDATE ${column} = ${column} + 1, updated_at = VALUES(updated_at)`,
    [todayDateString(), now]
  );
}

export async function getTodayLlmUsage() {
  const pool = requirePool(await ensureJobSearchSchema());
  const [rows] = await pool.query(
    "SELECT embed_calls, score_calls FROM job_search_llm_usage WHERE usage_date = ? LIMIT 1",
    [todayDateString()]
  );
  const row = rows[0] || { embed_calls: 0, score_calls: 0 };
  const embedCalls = Number(row.embed_calls);
  const scoreCalls = Number(row.score_calls);
  return { embedCalls, scoreCalls, totalCalls: embedCalls + scoreCalls };
}
