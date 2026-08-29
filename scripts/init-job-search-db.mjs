import { ensureJobSearchSchema, getPool, isJobSearchDbConfigured } from "../app/lib/jobSearchDb.js";

if (!isJobSearchDbConfigured()) {
  console.error("JOB_SEARCH_DATABASE_URL, DATABASE_URL, or MYSQL_URL is required.");
  process.exit(1);
}

try {
  await ensureJobSearchSchema();
  const pool = await getPool();

  const [tables] = await pool.query(`
    SELECT table_name AS tableName
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_name LIKE 'job_search_%'
    ORDER BY table_name
  `);

  console.log(`Job search schema ready: ${tables.length} tables.`);
  for (const { tableName } of tables) console.log(`  - ${tableName}`);
} finally {
  const pool = await getPool();
  if (pool) await pool.end();
}
