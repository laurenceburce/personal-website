import { cleanText, ensureJobSearchSchema, requirePool } from "./jobSearchDb.js";

// One row per subscribed browser/device — see jobSearchDb.js's own comment
// on job_search_push_subscriptions for why this isn't keyed per-user.

export async function listPushSubscriptions() {
  const pool = requirePool(await ensureJobSearchSchema());
  const [rows] = await pool.query("SELECT id, endpoint, p256dh, auth FROM job_search_push_subscriptions");
  return rows.map((row) => ({ id: Number(row.id), endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth }));
}

export async function savePushSubscription({ endpoint, p256dh, auth }) {
  const pool = requirePool(await ensureJobSearchSchema());
  const cleanEndpoint = cleanText(endpoint, 600);
  const cleanP256dh = cleanText(p256dh, 255);
  const cleanAuth = cleanText(auth, 255);
  if (!cleanEndpoint || !cleanP256dh || !cleanAuth) return;

  await pool.query(
    `INSERT INTO job_search_push_subscriptions (endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE p256dh = VALUES(p256dh), auth = VALUES(auth)`,
    [cleanEndpoint, cleanP256dh, cleanAuth, new Date()]
  );
}

export async function deletePushSubscriptionByEndpoint(endpoint) {
  const pool = requirePool(await ensureJobSearchSchema());
  const cleanEndpoint = cleanText(endpoint, 600);
  if (!cleanEndpoint) return;
  await pool.query("DELETE FROM job_search_push_subscriptions WHERE endpoint = ?", [cleanEndpoint]);
}

// Called by jobSearchPushSender.js when a send comes back 404/410 — that
// status code means the push service itself says this subscription is gone
// for good (browser data cleared, permission revoked, etc.), so there's no
// point keeping it around for the next challenge.
export async function deletePushSubscriptionById(id) {
  const pool = requirePool(await ensureJobSearchSchema());
  await pool.query("DELETE FROM job_search_push_subscriptions WHERE id = ?", [Number(id)]);
}
