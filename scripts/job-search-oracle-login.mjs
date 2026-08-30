#!/usr/bin/env node
// One-time interactive helper: opens a REAL headed browser, lets a human
// complete an Oracle Recruiting Cloud sign-in by hand (SSO or otherwise —
// whatever the tenant actually presents, including any MFA/device
// verification step), then saves the resulting Playwright `storageState`
// (Oracle's own post-login session cookies) to a local JSON file. That file
// then gets uploaded through the Job Search dashboard (User Settings ->
// "Oracle Recruiting Cloud sessions") — the dashboard stores it in the
// database, keyed by tenant host, and
// app/lib/jobSearchAdapters/oracleRecruiting.js reads it from there for
// every later submission attempt on that same tenant, without ever
// touching a login form itself.
//
// Why this exists instead of scripting the sign-in form directly: see
// oracleRecruiting.js's header comment. Short version — Google/Microsoft/
// LinkedIn all actively challenge automated sign-in (MFA prompts, "this
// browser may not be secure", device verification) the same way they'd
// challenge real credential stuffing, so nothing here should try to defeat
// that. This script hands the entire login step to a human in a real
// browser window; only the cookies that come out the other side get reused.
//
// Usage:
//   node scripts/job-search-oracle-login.mjs --url=https://<tenant>.oraclecloud.com/hcmUI/CandidateExperience/...
//   node scripts/job-search-oracle-login.mjs --url=https://<tenant>.taleo.net/careersection/... --out=./oracle-session.json
//
// The saved file is a real session credential — treat it like a password
// (never commit it, delete it once it's uploaded to the dashboard). Re-run
// this and re-upload whenever oracleRecruiting.js starts reporting "blocked"
// with an expired-session message for that tenant.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline/promises";

import { launchJobSearchBrowser } from "../app/lib/jobSearchAdapters/jobSearchBrowser.js";

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
  const args = { url: "", out: "" };
  for (const arg of argv) {
    if (arg.startsWith("--url=")) args.url = arg.slice("--url=".length).trim();
    else if (arg.startsWith("--out=")) args.out = arg.slice("--out=".length).trim();
  }
  return args;
}

function defaultOutputPath() {
  return path.join(os.tmpdir(), "job-search-oracle-session.json");
}

// The dashboard upload trusts this field as the session's real tenant (see
// oracle-session/route.js) rather than asking a human to re-type a hostname
// by hand — derived directly from the URL actually navigated to and signed
// into, so it can't drift from what the session cookies are really scoped to.
function deriveTenantHost(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

async function main() {
  loadLocalEnv();
  const args = parseArgs(process.argv.slice(2));

  if (!args.url) {
    console.error(
      "Usage: node scripts/job-search-oracle-login.mjs --url=<a real Oracle Recruiting Cloud career-site or apply URL> [--out=<path>]\n\n"
      + "Point --url at the same tenant you'll actually be applying through — a career-site home page is fine, it doesn't need to be a specific job's apply link."
    );
    process.exitCode = 1;
    return;
  }

  const tenantHost = deriveTenantHost(args.url);
  if (!/(^|\.)(taleo\.net|oraclecloud\.com)$/i.test(tenantHost)) {
    console.error(`--url's host ("${tenantHost || args.url}") isn't a taleo.net or oraclecloud.com address — this script only saves Oracle Recruiting Cloud/Taleo sessions.`);
    process.exitCode = 1;
    return;
  }

  const outputPath = args.out || defaultOutputPath();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  console.log("Launching a real (headed) browser — this window is for YOU to use, nothing here is automated.");
  const browserSession = await launchJobSearchBrowser({ headless: false });

  try {
    const page = await browserSession.newPage();
    await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((error) => {
      console.warn(`Navigation warning (continuing anyway — you can navigate manually in the window): ${error?.message || error}`);
    });

    console.log("\n" + "-".repeat(72));
    console.log("A browser window is open. In THAT window:");
    console.log("  1. Complete sign-in yourself — SSO, password, MFA, whatever the site asks for.");
    console.log("  2. Navigate until you can see your signed-in candidate account/dashboard.");
    console.log("-".repeat(72));

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("\nOnce you're fully signed in, come back here and press Enter to save the session... ");
    rl.close();

    const storageState = await page.context().storageState();
    const capturedAt = new Date().toISOString();
    // tenantHost/capturedAt travel alongside the raw storageState so the
    // dashboard upload (app/api/job-search/oracle-session/route.js) never
    // has to ask you to re-type a hostname by hand — see that route's own
    // comment.
    fs.writeFileSync(outputPath, JSON.stringify({ tenantHost, capturedAt, storageState }, null, 2));

    console.log(`\nSaved session for ${tenantHost} to: ${outputPath}`);
    console.log('Now upload that file in the Job Search dashboard: User Settings -> "Oracle Recruiting Cloud sessions".');
  } finally {
    await browserSession.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error("Failed to save Oracle Recruiting Cloud session:", error?.message || error);
  process.exitCode = 1;
});
