import { appError, cleanId, cleanText, ensureJobSearchSchema, requirePool } from "./jobSearchDb.js";

export const ATS_TYPES = ["greenhouse", "lever", "ashby"];
const ATS_TYPE_SET = new Set(ATS_TYPES);

function cleanAtsType(value) {
  const atsType = String(value || "").trim().toLowerCase();
  if (!ATS_TYPE_SET.has(atsType)) {
    throw appError(`ATS type must be one of: ${ATS_TYPES.join(", ")}.`);
  }
  return atsType;
}

function mapWatchlistRow(row) {
  return {
    id: Number(row.id),
    companyName: row.company_name,
    atsType: row.ats_type,
    boardToken: row.board_token,
    isActive: Boolean(row.is_active),
    lastPolledAt: row.last_polled_at,
    lastPollStatus: row.last_poll_status,
    lastPollError: row.last_poll_error,
    consecutiveFailures: Number(row.consecutive_failures),
    jobsFoundLastPoll: Number(row.jobs_found_last_poll),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function listWatchlist({ activeOnly = false } = {}) {
  const pool = requirePool(await ensureJobSearchSchema());
  const [rows] = await pool.query(
    activeOnly
      ? "SELECT * FROM job_search_watchlist WHERE is_active = 1 ORDER BY company_name ASC"
      : "SELECT * FROM job_search_watchlist ORDER BY company_name ASC"
  );
  return rows.map(mapWatchlistRow);
}

export async function createWatchlistEntry(data) {
  const pool = requirePool(await ensureJobSearchSchema());
  const now = new Date();
  const companyName = cleanText(data?.companyName, 160);
  if (!companyName) throw appError("Company name is required.");

  const atsType = cleanAtsType(data?.atsType);
  const boardToken = cleanText(data?.boardToken, 160);
  if (!boardToken) throw appError("Board token is required.");

  const isActive = data?.isActive === false ? 0 : 1;

  try {
    const [result] = await pool.query(
      `INSERT INTO job_search_watchlist
         (company_name, ats_type, board_token, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [companyName, atsType, boardToken, isActive, now, now]
    );
    return { id: Number(result.insertId) };
  } catch (err) {
    if (err?.errno === 1062) {
      throw appError("This ATS type + board token is already on the watchlist.");
    }
    throw err;
  }
}

export async function updateWatchlistEntry(id, data) {
  const pool = requirePool(await ensureJobSearchSchema());
  const watchlistId = cleanId(id, "Watchlist entry");
  const companyName = cleanText(data?.companyName, 160);
  if (!companyName) throw appError("Company name is required.");

  const atsType = cleanAtsType(data?.atsType);
  const boardToken = cleanText(data?.boardToken, 160);
  if (!boardToken) throw appError("Board token is required.");

  const isActive = data?.isActive === false ? 0 : 1;

  await pool.query(
    `UPDATE job_search_watchlist
     SET company_name = ?, ats_type = ?, board_token = ?, is_active = ?, updated_at = ?
     WHERE id = ?`,
    [companyName, atsType, boardToken, isActive, new Date(), watchlistId]
  );

  return { id: watchlistId };
}

export async function deleteWatchlistEntry(id) {
  const pool = requirePool(await ensureJobSearchSchema());
  const watchlistId = cleanId(id, "Watchlist entry");
  await pool.query("DELETE FROM job_search_watchlist WHERE id = ?", [watchlistId]);
  return { id: watchlistId };
}

// Called once per watchlist entry per poll run — records success/failure so the
// dashboard can surface stale/broken board tokens without a human having to guess.
export async function recordPollResult(id, { ok, error = "", jobsFound = 0 }) {
  const pool = requirePool(await ensureJobSearchSchema());
  const watchlistId = cleanId(id, "Watchlist entry");
  const now = new Date();

  if (ok) {
    await pool.query(
      `UPDATE job_search_watchlist
       SET last_polled_at = ?, last_poll_status = 'ok', last_poll_error = '',
           consecutive_failures = 0, jobs_found_last_poll = ?, updated_at = ?
       WHERE id = ?`,
      [now, jobsFound, now, watchlistId]
    );
  } else {
    await pool.query(
      `UPDATE job_search_watchlist
       SET last_polled_at = ?, last_poll_status = 'error', last_poll_error = ?,
           consecutive_failures = consecutive_failures + 1, updated_at = ?
       WHERE id = ?`,
      [now, cleanText(error, 500), now, watchlistId]
    );
  }
}
