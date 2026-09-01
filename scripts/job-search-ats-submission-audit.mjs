#!/usr/bin/env node

import fs from "node:fs";
import mysql from "mysql2/promise";

import { fetchAtsJobs } from "../app/lib/jobSearchAtsSources.js";
import { clickWithBrowserMouse } from "../app/lib/jobSearchAdapters/browserEngineClick.js";
import { ATS_DOMAIN_PATTERNS } from "../app/lib/jobSearchAdapters/atsTypes.js";
import { detectSubmissionBlocker } from "../app/lib/jobSearchAdapters/blockerDetection.js";
import { launchJobSearchBrowser } from "../app/lib/jobSearchAdapters/jobSearchBrowser.js";

const DEFAULT_ATS_TYPES = [
  "greenhouse",
  "ashby",
  "workable",
  "personio",
  "breezy",
  "oracle_fusion",
  "lever",
  "recruitee",
  "smartrecruiters",
  "workday"
];
const DEFAULT_MAX_PER_ATS = 1;

const FALLBACK_TARGETS = [
  { atsType: "greenhouse", companyName: "GitLab", boardToken: "gitlab" },
  { atsType: "ashby", companyName: "Ramp", boardToken: "ramp" },
  { atsType: "workable", companyName: "Codurance", boardToken: "codurance" },
  { atsType: "personio", companyName: "OpenProject GmbH", boardToken: "openproject-gmbh" },
  { atsType: "breezy", companyName: "Anytime Fitness", boardToken: "anytime-fitness" },
  { atsType: "oracle_fusion", companyName: "Oracle", boardToken: "eeho.fa.us2.oraclecloud.com::jobsearch::CX_45001" },
  { atsType: "lever", companyName: "Palantir", boardToken: "palantir" },
  { atsType: "recruitee", companyName: "Attendi", boardToken: "attendi" },
  { atsType: "smartrecruiters", companyName: "ServiceTitan", boardToken: "servicetitan" },
  { atsType: "workday", companyName: "Workday", boardToken: "workday::wd5::Workday" }
];

function parseArgs(argv) {
  const args = {
    atsTypes: DEFAULT_ATS_TYPES,
    maxPerAts: DEFAULT_MAX_PER_ATS,
    headless: true,
    urls: []
  };

  for (const arg of argv) {
    if (arg === "--headed") {
      args.headless = false;
    } else if (arg.startsWith("--ats=")) {
      args.atsTypes = arg.slice("--ats=".length).split(",").map((value) => value.trim()).filter(Boolean);
    } else if (arg.startsWith("--max-per-ats=")) {
      const value = Number(arg.slice("--max-per-ats=".length));
      if (Number.isInteger(value) && value > 0) args.maxPerAts = value;
    } else if (arg.startsWith("--url=")) {
      const value = arg.slice("--url=".length);
      const separator = value.indexOf("=");
      if (separator > 0) {
        args.urls.push({
          atsType: value.slice(0, separator).trim(),
          companyName: "Manual URL",
          applyUrl: value.slice(separator + 1).trim(),
          source: "cli-url"
        });
      }
    }
  }

  return args;
}

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

function databaseUrl() {
  return process.env.JOB_SEARCH_DATABASE_URL
    || process.env.DATABASE_URL
    || process.env.MYSQL_URL
    || process.env.MYSQL_PUBLIC_URL
    || "";
}

function orderAndCapTargets(targets, atsTypes, maxPerAts) {
  const wanted = new Set(atsTypes);
  const byKey = new Map();

  for (const target of targets) {
    if (!wanted.has(target.atsType)) continue;
    const key = target.applyUrl
      ? `${target.atsType}:url:${target.applyUrl}`
      : `${target.atsType}:board:${target.boardToken}`;
    if (!byKey.has(key)) byKey.set(key, target);
  }

  const deduped = [...byKey.values()].sort((a, b) => {
    const atsDelta = atsTypes.indexOf(a.atsType) - atsTypes.indexOf(b.atsType);
    if (atsDelta !== 0) return atsDelta;
    const priority = (target) => target.source === "cli-url" ? 0 : target.source === "fallback" ? 1 : 2;
    const priorityDelta = priority(a) - priority(b);
    if (priorityDelta !== 0) return priorityDelta;
    return (Number(b.jobsFoundLastPoll) || 0) - (Number(a.jobsFoundLastPoll) || 0);
  });

  const counts = new Map();
  return deduped.filter((target) => {
    const count = counts.get(target.atsType) || 0;
    if (count >= maxPerAts) return false;
    counts.set(target.atsType, count + 1);
    return true;
  });
}

async function loadDbTargets(atsTypes) {
  const uri = databaseUrl();
  if (!uri) return [];

  let conn = null;
  try {
    conn = await mysql.createConnection({ uri });
    const [rows] = await conn.query(
      `SELECT ats_type, company_name, board_token, jobs_found_last_poll
       FROM job_search_known_companies
       WHERE ats_type IN (?) AND board_token != ''
       ORDER BY jobs_found_last_poll DESC, company_name ASC
       LIMIT 200`,
      [atsTypes]
    );

    return rows.map((row) => ({
      atsType: row.ats_type,
      companyName: row.company_name,
      boardToken: row.board_token,
      jobsFoundLastPoll: Number(row.jobs_found_last_poll) || 0,
      source: "job_search_known_companies"
    }));
  } catch (error) {
    return [{
      atsType: "audit_error",
      companyName: "Database target lookup",
      error: error?.message || String(error),
      source: "job_search_known_companies"
    }];
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

async function resolveApplyTarget(target) {
  if (target.applyUrl) {
    return { ...target, jobsFetched: null, jobTitle: "", externalJobId: "" };
  }

  const jobs = await fetchAtsJobs({
    atsType: target.atsType,
    boardToken: target.boardToken,
    companyName: target.companyName
  });
  const job = jobs.find((candidate) => candidate.applyUrl) || jobs[0];

  if (!job?.applyUrl) {
    return {
      ...target,
      jobsFetched: jobs.length,
      error: "No applyUrl was available from the ATS feed."
    };
  }

  return {
    ...target,
    applyUrl: job.applyUrl,
    jobsFetched: jobs.length,
    jobTitle: job.title || "",
    externalJobId: job.externalJobId || ""
  };
}

async function summarizePage(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      return style.display !== "none"
        && style.visibility !== "hidden"
        && style.opacity !== "0"
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const textOf = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ");
    const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ");
    const controls = [...document.querySelectorAll("input, textarea, select, button")].filter(visible);
    const inputs = [...document.querySelectorAll("input")].filter(visible);
    const submitCandidates = [...document.querySelectorAll("button, input[type='submit'], a[role='button'], a")]
      .filter(visible)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: (el.getAttribute("type") || "").toLowerCase(),
        text: textOf(el).slice(0, 80),
        href: el.getAttribute("href") || ""
      }))
      .filter((item) => item.type === "submit" || /\b(apply|submit|send|interested)\b/i.test(`${item.text} ${item.href}`))
      .slice(0, 12);

    return {
      url: location.href,
      title: document.title,
      forms: document.querySelectorAll("form").length,
      controls: controls.length,
      visibleInputs: inputs.length,
      textInputs: inputs.filter((el) => !["hidden", "file", "checkbox", "radio", "submit", "button"].includes((el.type || "text").toLowerCase())).length,
      fileInputs: inputs.filter((el) => (el.type || "").toLowerCase() === "file").length,
      radios: inputs.filter((el) => (el.type || "").toLowerCase() === "radio").length,
      checkboxes: inputs.filter((el) => (el.type || "").toLowerCase() === "checkbox").length,
      textareas: [...document.querySelectorAll("textarea")].filter(visible).length,
      selects: [...document.querySelectorAll("select")].filter(visible).length,
      captchaWidgets: document.querySelectorAll(".g-recaptcha, [name='g-recaptcha-response'], iframe[src*='recaptcha'], .h-captcha, iframe[src*='hcaptcha'], iframe[src*='turnstile'], [data-sitekey]").length,
      submitCandidates,
      textSignals: {
        account: /(create an account|sign in|log in|already have an account|candidate home|candidate account)/i.test(bodyText),
        captcha: /(captcha|hcaptcha|recaptcha|human verification|prove you.?re not a bot|not a robot)/i.test(bodyText)
      }
    };
  }).catch((error) => ({
    error: error?.message || String(error)
  }));
}

function atsHostMatches(atsType, host) {
  const entry = ATS_DOMAIN_PATTERNS.find((pattern) => pattern.atsType === atsType);
  return entry ? entry.pattern.test(host) : false;
}

function hostReview(atsType, applyUrl, finalUrl) {
  try {
    const applyHost = new URL(applyUrl).hostname.toLowerCase();
    const finalHost = new URL(finalUrl || applyUrl).hostname.toLowerCase();
    const sameHost = applyHost === finalHost;

    if (sameHost) return { applyHost, finalHost, redirectedAway: false };
    if (atsHostMatches(atsType, finalHost)) {
      return { applyHost, finalHost, redirectedAway: false };
    }

    return { applyHost, finalHost, redirectedAway: true };
  } catch {
    return { applyHost: "", finalHost: "", redirectedAway: false };
  }
}

function looksLikeForm(summary) {
  return Boolean(summary?.fileInputs)
    || Number(summary?.textInputs) + Number(summary?.textareas) + Number(summary?.selects) >= 3
    || Number(summary?.forms) > 0 && Number(summary?.controls) >= 3;
}

async function clickRevealCta(page, summary) {
  if (looksLikeForm(summary)) return { attempted: false, reason: "form_already_visible" };

  const candidates = [
    page.getByRole("link", { name: /apply|i.?m interested|application/i }).first(),
    page.getByRole("button", { name: /apply|i.?m interested|application/i }).first(),
    page.locator("a:has-text('Apply'), button:has-text('Apply'), a:has-text(\"I'm interested\"), button:has-text(\"I'm interested\")").first()
  ];

  for (const candidate of candidates) {
    if ((await candidate.count().catch(() => 0)) === 0) continue;
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const label = await candidate.innerText({ timeout: 1000 }).catch(() => "");
    if (/\bsubmit\b/i.test(label) && Number(summary?.controls) > 0) continue;

    const method = await clickWithBrowserMouse(page, candidate, { timeout: 5000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2500).catch(() => {});
    return { attempted: true, method, label: label.trim().replace(/\s+/g, " ").slice(0, 80) };
  }

  return { attempted: false, reason: "no_reveal_cta_found" };
}

async function cdpFocusProbe(page, blockerReason, summary, host) {
  if (host?.redirectedAway) {
    return { attempted: false, skipped: "redirected_away_from_application_host" };
  }
  if (blockerReason || summary?.captchaWidgets || summary?.textSignals?.captcha) {
    return { attempted: false, skipped: "submission_blocker_detected" };
  }

  const selectors = [
    "input:not([type='hidden']):not([type='file']):not([type='submit']):not([type='button']):not([disabled])",
    "textarea:not([disabled])",
    "select:not([disabled])",
    "[contenteditable='true']",
    "body"
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count().catch(() => 0)) === 0) continue;
    if (!(await locator.isVisible().catch(() => selector === "body"))) continue;
    const method = await clickWithBrowserMouse(page, locator, { timeout: 5000 });
    const focused = await locator.evaluate((el) => document.activeElement === el || el.contains(document.activeElement)).catch(() => false);
    return { attempted: true, selector, method, focused };
  }

  return { attempted: false, skipped: "no_visible_target" };
}

function verdict(blockerReason, summary, host) {
  if (host?.redirectedAway) return "redirected_away_from_application";
  if (blockerReason) {
    if (/captcha|challenge|automation|bot/i.test(blockerReason)) return "blocked_by_bot_or_captcha";
    if (/signing|account|login|log/i.test(blockerReason)) return "blocked_by_login_or_account";
    return "blocked";
  }
  if (summary?.captchaWidgets || summary?.textSignals?.captcha) return "blocked_by_bot_or_captcha";
  if (summary?.textSignals?.account) return "blocked_by_login_or_account";
  if (looksLikeForm(summary) && summary?.submitCandidates?.length) return "candidate_for_adapter";
  if (looksLikeForm(summary)) return "candidate_needs_manual_form_mapping";
  return "no_application_form_detected";
}

async function auditTarget(browserSession, target) {
  const resolved = await resolveApplyTarget(target).catch((error) => ({
    ...target,
    error: error?.message || String(error)
  }));

  if (!resolved.applyUrl) {
    return {
      atsType: resolved.atsType,
      companyName: resolved.companyName,
      boardToken: resolved.boardToken || "",
      source: resolved.source || "",
      jobsFetched: resolved.jobsFetched ?? null,
      status: "feed_error",
      error: resolved.error || "No apply URL."
    };
  }

  const page = await browserSession.newPage();
  try {
    await page.goto(resolved.applyUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
    const beforeReveal = await summarizePage(page);
    const reveal = await clickRevealCta(page, beforeReveal);
    const afterReveal = reveal.attempted ? await summarizePage(page) : beforeReveal;
    const blockerReason = await detectSubmissionBlocker(page).catch(() => null);
    const host = hostReview(resolved.atsType, resolved.applyUrl, afterReveal.url);
    const cdpProbe = await cdpFocusProbe(page, blockerReason, afterReveal, host);
    const finalSummary = await summarizePage(page);

    return {
      atsType: resolved.atsType,
      companyName: resolved.companyName,
      boardToken: resolved.boardToken || "",
      source: resolved.source || "",
      jobsFetched: resolved.jobsFetched,
      jobTitle: resolved.jobTitle,
      externalJobId: resolved.externalJobId,
      applyUrl: resolved.applyUrl,
      finalUrl: finalSummary.url || afterReveal.url,
      pageTitle: finalSummary.title || afterReveal.title,
      host,
      reveal,
      blockerReason,
      cdpProbe,
      form: {
        forms: finalSummary.forms,
        controls: finalSummary.controls,
        textInputs: finalSummary.textInputs,
        fileInputs: finalSummary.fileInputs,
        textareas: finalSummary.textareas,
        selects: finalSummary.selects,
        radios: finalSummary.radios,
        checkboxes: finalSummary.checkboxes,
        captchaWidgets: finalSummary.captchaWidgets,
        submitCandidates: finalSummary.submitCandidates
      },
      textSignals: finalSummary.textSignals,
      verdict: verdict(blockerReason, finalSummary, host)
    };
  } catch (error) {
    return {
      atsType: resolved.atsType,
      companyName: resolved.companyName,
      boardToken: resolved.boardToken || "",
      source: resolved.source || "",
      jobsFetched: resolved.jobsFetched ?? null,
      jobTitle: resolved.jobTitle || "",
      applyUrl: resolved.applyUrl,
      status: "navigation_error",
      error: error?.message || String(error)
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadLocalEnv();

  const dbTargets = await loadDbTargets(args.atsTypes);
  const dbErrors = dbTargets.filter((target) => target.atsType === "audit_error");
  const candidates = [
    ...args.urls,
    ...dbTargets.filter((target) => target.atsType !== "audit_error"),
    ...FALLBACK_TARGETS.map((target) => ({ ...target, source: "fallback" }))
  ];
  const targets = orderAndCapTargets(candidates, args.atsTypes, args.maxPerAts);
  const browserSession = await launchJobSearchBrowser({ headless: args.headless });
  const results = [];

  try {
    for (const target of targets) {
      results.push(await auditTarget(browserSession, target));
    }
  } finally {
    await browserSession.close().catch(() => {});
  }

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    browserProvider: browserSession.provider,
    cdpMouseEnabled: process.env.JOB_SEARCH_CDP_MOUSE_ENABLED !== "false",
    policy: "Read-only audit: no final submit clicks, no CAPTCHA solving, no account creation, no resume upload.",
    dbLookupErrors: dbErrors.map((target) => target.error).filter(Boolean),
    targets: targets.map((target) => ({
      atsType: target.atsType,
      companyName: target.companyName,
      boardToken: target.boardToken || "",
      source: target.source || ""
    })),
    results
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    generatedAt: new Date().toISOString(),
    status: "audit_failed",
    error: error?.message || String(error)
  }, null, 2));
  process.exitCode = 1;
});
