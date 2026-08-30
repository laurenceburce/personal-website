#!/usr/bin/env node
// One-time-per-tenant helper for Oracle Recruiting Cloud (Fusion —
// oracle_fusion, NOT legacy Taleo): navigates a job's apply page, starts the
// application, and enters the email/terms step — all automated, since none
// of that involves a third-party identity provider. The one thing this
// can't do for you is the verification code Oracle emails at that point
// (confirmed live: no way around it, and this codebase never scripts past
// an anti-bot/identity check — see oracleFusion.js's header comment) — so
// this prompts you for it right here in the terminal. Once verified, it
// saves the resulting Playwright `storageState` to a local JSON file, which
// you then upload through the Job Search dashboard (User Settings ->
// "Oracle Recruiting Cloud sessions") the same way resumes get uploaded.
//
// Runs headless by default — pass --headed only if you want to watch it
// (e.g. debugging a step that stopped matching a real page's markup).
//
// Usage:
//   node scripts/job-search-oracle-connect.mjs --url=<a job's apply link on that company's Oracle-hosted careers site>
//   node scripts/job-search-oracle-connect.mjs --url=... --email=you@example.com --out=./oracle-session.json
//
// The saved file is a real session credential — treat it like a password
// (never commit it, delete it once it's uploaded to the dashboard). Re-run
// this and re-upload whenever oracleFusion.js starts reporting "blocked"
// with an expired-session message for that tenant.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline/promises";

import { clickWithBrowserMouse } from "../app/lib/jobSearchAdapters/browserEngineClick.js";
import { launchJobSearchBrowser } from "../app/lib/jobSearchAdapters/jobSearchBrowser.js";

const NAV_TIMEOUT_MS = 45000;

function loadLocalEnv() {
  for (const file of [".env.local", ".env"]) {
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
      if (!match || process.env[match[1]]) continue;
      let value = match[2].trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[match[1]] = value;
    }
  }
}

function parseArgs(argv) {
  const args = { url: "", email: "", out: "", headless: true };
  for (const arg of argv) {
    if (arg.startsWith("--url=")) args.url = arg.slice("--url=".length).trim();
    else if (arg.startsWith("--email=")) args.email = arg.slice("--email=".length).trim();
    else if (arg.startsWith("--out=")) args.out = arg.slice("--out=".length).trim();
    else if (arg === "--headed") args.headless = false;
  }
  return args;
}

function defaultOutputPath() {
  return path.join(os.tmpdir(), "job-search-oracle-session.json");
}

// The dashboard upload trusts this field as the session's real tenant (see
// oracle-session/route.js) rather than asking a human to re-type a hostname
// by hand — derived directly from the URL actually connected to, so it
// can't drift from what the session cookies are really scoped to.
function deriveTenantHost(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// The native checkbox input is a zero-size a11y target (confirmed live —
// getBoundingClientRect() is 0x0) with a "terms and conditions" link
// embedded IN its own label text, so a plain label click can land on that
// link instead of toggling the box. Clicking the label's far-left edge
// (before any link text starts) via raw CDP dispatch is the one approach
// confirmed live to actually check it.
async function checkTermsCheckbox(page) {
  const label = page.locator('#legal-disclaimer-checkbox-label, label:has-text("terms and conditions")').first();
  const box = await label.boundingBox().catch(() => null);
  if (!box) throw new Error("Could not find the terms-and-conditions checkbox label.");

  const client = await page.context().newCDPSession(page);
  const x = box.x + 10;
  const y = box.y + box.height / 2;
  try {
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0, clickCount: 0 });
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await page.waitForTimeout(50);
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  } finally {
    await client.detach().catch(() => {});
  }
}

async function main() {
  loadLocalEnv();
  const args = parseArgs(process.argv.slice(2));

  if (!args.url) {
    console.error(
      "Usage: node scripts/job-search-oracle-connect.mjs --url=<a job's apply link on an Oracle Recruiting Cloud careers site> [--email=you@example.com] [--out=<path>] [--headed]"
    );
    process.exitCode = 1;
    return;
  }

  const tenantHost = deriveTenantHost(args.url);
  if (!/(^|\.)oraclecloud\.com$/i.test(tenantHost)) {
    console.error(`--url's host ("${tenantHost || args.url}") isn't an oraclecloud.com address — this script only connects Oracle Recruiting Cloud (Fusion) sessions, not legacy Taleo or anything else.`);
    process.exitCode = 1;
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const email = args.email || await rl.question("Email address to apply with: ");
  if (!email) {
    console.error("An email address is required.");
    rl.close();
    process.exitCode = 1;
    return;
  }

  const browserSession = await launchJobSearchBrowser({ headless: args.headless });

  try {
    const page = await browserSession.newPage();
    console.log(`Navigating to ${args.url} ...`);
    await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(2000);

    console.log('Clicking "Apply Now"...');
    await clickWithBrowserMouse(page, page.getByRole("button", { name: /apply now/i }).first(), { timeout: 15000 });
    await page.waitForTimeout(2000);

    const emailField = page.locator('input[type="email"]').first();
    await emailField.waitFor({ state: "visible", timeout: 15000 });
    await emailField.fill(email);
    console.log(`Filled email: ${email}`);

    await checkTermsCheckbox(page);
    console.log("Checked the terms-and-conditions box.");

    await clickWithBrowserMouse(page, page.getByRole("button", { name: /^next$/i }).first(), { timeout: 10000 });
    await page.waitForTimeout(2500);

    const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    if (!/verification code|confirm your identity/i.test(bodyText)) {
      console.warn("\nDidn't see the expected \"verification code\" screen — the page may not match what this script expects.");
      console.warn("Current page text (first 500 chars):\n", bodyText.slice(0, 500));
      console.warn("Continuing anyway in case the wording differs; if the next steps fail, rerun with --headed to see what's actually on screen.\n");
    } else {
      console.log(`A verification code was sent to ${email}. Check your inbox.`);
    }

    const code = await rl.question("Enter the verification code: ");
    rl.close();

    // Not confirmed-live past this exact point (deliberately stopped short
    // during live testing rather than complete a real application) — this
    // targets the single most-visible text input on the confirmation
    // screen, which matches every other Oracle JET form field seen so far
    // (one primary input per step). If Oracle's real markup differs, rerun
    // with --headed and adjust the selector below.
    const codeField = page.locator('input[type="text"], input[type="tel"], input:not([type])').first();
    await codeField.waitFor({ state: "visible", timeout: 10000 });
    await codeField.fill(code.trim());

    await clickWithBrowserMouse(page, page.getByRole("button", { name: /^verify$/i }).first(), { timeout: 10000 });
    await page.waitForTimeout(3000);

    const afterVerifyText = (await page.locator("body").innerText().catch(() => "")).slice(0, 500);
    console.log("\nPage after verification (first 500 chars):\n", afterVerifyText);

    const storageState = await page.context().storageState();
    const capturedAt = new Date().toISOString();
    const outputPath = args.out || defaultOutputPath();
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify({ tenantHost, capturedAt, storageState }, null, 2));

    console.log(`\nSaved session for ${tenantHost} to: ${outputPath}`);
    console.log('Now upload that file in the Job Search dashboard: User Settings -> "Oracle Recruiting Cloud sessions".');
  } finally {
    await browserSession.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error("Failed to connect Oracle Recruiting Cloud session:", error?.message || error);
  process.exitCode = 1;
});
