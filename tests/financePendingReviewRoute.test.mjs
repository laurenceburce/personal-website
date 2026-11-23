import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { isAllowedOrigin } from "../app/api/utils/origin.js";
const require = createRequire(import.meta.url);
const { transformSync } = require("next/dist/build/swc");
const operation = { purpose: "pending-charge-review", description: "Example", date: "2026-11-20", currency: "USD", amount: 20 };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const codeFor = (expired = false) => transformSync(readFileSync(new URL("../app/api/admin/finance-pending-review/route.js", import.meta.url), "utf8")
  .replace(/const REVIEW_KEY_SHA256 = "[a-f0-9]+";/, `const REVIEW_KEY_SHA256 = "${hash("review-test")}";`)
  .replace(/const REVIEW_OPERATION_SHA256 = "[a-f0-9]+";/, `const REVIEW_OPERATION_SHA256 = "${hash(JSON.stringify(operation))}";`)
  .replace(/const REVIEW_EXPIRES_AT = \d+;/, `const REVIEW_EXPIRES_AT = ${expired ? 0 : Date.now() + 60000};`),
{ jsc: { parser: { syntax: "ecmascript" }, target: "es2022" }, module: { type: "commonjs" } }).code;
function harness({ expired = false } = {}) {
  const events = [];
  const module = { exports: {} };
  const refresh = async () => {};
  new Function("require", "module", "exports", codeFor(expired))((name) => {
    if (name === "next/server") return { NextResponse: { json: (value, options) => ({ value, ...options }) } };
    if (name === "../../../lib/financeStore") return { ensureFinanceSchema: async () => { events.push("database"); return {}; } };
    if (name === "../../../lib/financePlanPostings.mjs") return { refreshFinancePlanPostings: refresh };
    if (name === "../../../lib/financePendingPlannerReview.mjs") return { reviewFinancePendingPlanner: async (pool, scope, options) => {
      events.push({ scope, refresh: options.refresh === refresh }); return { matched: true };
    } };
    if (name === "../../utils/origin") return { isAllowedOrigin };
    return require(name);
  }, module, module.exports);
  const request = (body = { mode: "review", operation }, headers = {}) => ({ url: "https://finance.example.com/api/admin/finance-pending-review",
    headers: new Headers({ "x-admin-token": "admin-test", "x-finance-review-key": "review-test", "content-type": "application/json",
      origin: "https://finance.example.com", ...headers }),
    text: async () => { events.push("body"); return typeof body === "string" ? body : JSON.stringify(body); } });
  return { api: module.exports, request, events };
}
test("pending review rejects missing credentials, an expired key, and a wrong origin before body or database access", async () => {
  const previous = process.env.ANALYTICS_ADMIN_TOKEN;
  process.env.ANALYTICS_ADMIN_TOKEN = "admin-test";
  try {
    for (const [options, headers, status] of [[{}, { "x-admin-token": "wrong" }, 401], [{}, { "x-finance-review-key": "wrong" }, 401],
      [{ expired: true }, {}, 401], [{}, { origin: "https://untrusted.example" }, 403]]) {
      const context = harness(options);
      assert.equal((await context.api.POST(context.request(undefined, headers))).status, status);
      assert.deepEqual(context.events, []);
    }
  } finally { if (previous == null) delete process.env.ANALYTICS_ADMIN_TOKEN; else process.env.ANALYTICS_ADMIN_TOKEN = previous; }
});
test("pending review binds the exact scope and only enables normal reconciliation when refresh is explicit", async () => {
  const previous = process.env.ANALYTICS_ADMIN_TOKEN;
  process.env.ANALYTICS_ADMIN_TOKEN = "admin-test";
  try {
    for (const body of [{ mode: "apply", operation }, { mode: "review", operation: { ...operation, amount: 99 } }, "invalid"]) {
      const context = harness();
      assert.ok((await context.api.POST(context.request(body))).status >= 400);
      assert.deepEqual(context.events, ["body"]);
    }
    for (const mode of ["review", "refresh"]) {
      const context = harness();
      const result = await context.api.POST(context.request({ mode, operation }));
      assert.equal(result.status, 200);
      assert.deepEqual(context.events, ["body", "database", { scope: operation, refresh: mode === "refresh" }]);
      assert.equal(result.headers["Cache-Control"], "private, no-store, max-age=0");
    }
  } finally { if (previous == null) delete process.env.ANALYTICS_ADMIN_TOKEN; else process.env.ANALYTICS_ADMIN_TOKEN = previous; }
});
