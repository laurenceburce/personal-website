import crypto from "node:crypto";
import { appError, cleanText, ensureJobSearchSchema, requirePool } from "./jobSearchDb.js";

const ROW_ID = 1;

function tokenSecret() {
  const secret = process.env.JOB_SEARCH_TOKEN_SECRET
    || process.env.AUTH_SECRET
    || process.env.FINANCE_TOKEN_SECRET
    || (process.env.NODE_ENV === "production" ? "" : "local-development-job-search-token-secret");
  if (!secret) {
    throw appError("JOB_SEARCH_TOKEN_SECRET or AUTH_SECRET is required for Gmail token storage.", 503);
  }
  return crypto.createHash("sha256").update(secret).digest();
}

function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", tokenSecret(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value || ""), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

function decryptSecret(value) {
  const encryptedValue = String(value || "");
  if (!encryptedValue) return "";
  const [ivText, tagText, encryptedText] = encryptedValue.split(".");
  if (!ivText || !tagText || !encryptedText) throw appError("Stored Gmail token is invalid.", 500);
  const decipher = crypto.createDecipheriv("aes-256-gcm", tokenSecret(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

function env(value) {
  return String(process.env[value] || "").trim();
}

function mapConnectionRow(row) {
  return {
    connected: Boolean(row),
    provider: row?.provider || "gmail",
    email: row?.email || "",
    source: row ? "database" : "none",
    scopes: row?.scopes ? String(row.scopes).split(/\s+/).filter(Boolean) : [],
    connectedAt: row?.connected_at || null,
    updatedAt: row?.updated_at || null
  };
}

export async function getGmailConnectionStatus() {
  if (env("JOB_SEARCH_GMAIL_REFRESH_TOKEN")) {
    return {
      connected: true,
      provider: "gmail",
      email: env("JOB_SEARCH_GMAIL_USER"),
      source: "environment",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      connectedAt: null,
      updatedAt: null
    };
  }

  const pool = requirePool(await ensureJobSearchSchema());
  const [rows] = await pool.query(
    "SELECT provider, email, scopes, connected_at, updated_at FROM job_search_email_connections WHERE id = ? LIMIT 1",
    [ROW_ID]
  );
  return mapConnectionRow(rows[0]);
}

export async function getStoredGmailRefreshToken() {
  const pool = requirePool(await ensureJobSearchSchema());
  const [rows] = await pool.query(
    "SELECT encrypted_refresh_token FROM job_search_email_connections WHERE id = ? AND provider = 'gmail' LIMIT 1",
    [ROW_ID]
  );
  const token = decryptSecret(rows[0]?.encrypted_refresh_token || "");
  return token;
}

export async function upsertGmailConnection({ email, refreshToken, scopes = "" }) {
  const cleanRefreshToken = String(refreshToken || "").trim();
  if (!cleanRefreshToken) throw appError("Google did not return a Gmail refresh token.", 400);

  const pool = requirePool(await ensureJobSearchSchema());
  const now = new Date();
  await pool.query(
    `INSERT INTO job_search_email_connections
       (id, provider, email, encrypted_refresh_token, scopes, connected_at, updated_at)
     VALUES (?, 'gmail', ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       provider = VALUES(provider),
       email = VALUES(email),
       encrypted_refresh_token = VALUES(encrypted_refresh_token),
       scopes = VALUES(scopes),
       updated_at = VALUES(updated_at)`,
    [
      ROW_ID,
      cleanText(email, 160),
      encryptSecret(cleanRefreshToken),
      cleanText(scopes, 1000),
      now,
      now
    ]
  );

  return { ok: true };
}

export async function deleteGmailConnection() {
  const pool = requirePool(await ensureJobSearchSchema());
  await pool.query("DELETE FROM job_search_email_connections WHERE id = ?", [ROW_ID]);
  return { ok: true };
}
