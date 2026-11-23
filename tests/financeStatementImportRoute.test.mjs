import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAllowedOrigin } from "../app/api/utils/origin.js";

// Temporary route coverage. Every credential, account and statement below is
// synthetic; the handler's database and import dependencies never run here.
const require = createRequire(import.meta.url);
const { transformSync } = require("next/dist/build/swc");
const routeSource = await readFile(new URL("../app/api/admin/finance-statement-import/route.js", import.meta.url), "utf8");
const operation = { accountId: 91, currency: "PHP", statementBalance: 37.5,
  minimumPayment: 10, dueDate: "2030-04-15", lastStatementDate: "2030-03-20" };
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function routeHarness({ admin = "synthetic-admin-token", expiresAt = Date.now() + 60000, databaseAvailable = true,
  importError, verificationError } = {}) {
  const nonce = randomBytes(32).toString("hex");
  let source = routeSource;
  for (const [name, value] of [
    ["IMPORT_KEY_SHA256", JSON.stringify(sha256(nonce))],
    ["IMPORT_OPERATION_SHA256", JSON.stringify(sha256(JSON.stringify(operation)))],
    ["IMPORT_EXPIRES_AT", String(expiresAt)],
  ]) {
    const constant = new RegExp(`const ${name} = [^;]+;`);
    assert.match(source, constant);
    source = source.replace(constant, `const ${name} = ${value};`);
  }
  const { code } = transformSync(source, { jsc: { parser: { syntax: "ecmascript" }, target: "es2022" },
    module: { type: "commonjs" } });
  const events = [];
  const pool = { synthetic: true };
  const account = { id: 91, name: "Synthetic card", type: "credit", currency: "PHP", nativeCurrentBalance: 80 };
  const module = { exports: {} };
  new Function("require", "module", "exports", "process", code)((specifier) => {
    if (specifier === "next/server") return { NextResponse: { json: (value, options) => ({ value, ...options }) } };
    if (specifier === "node:crypto") return require(specifier);
    if (specifier === "../../../lib/financeStore") return { ensureFinanceSchema: async () => {
      events.push("schema");
      return databaseAvailable ? pool : null;
    } };
    if (specifier === "../../../lib/financePlanner.mjs") return { localDate: () => "2030-03-25" };
    if (specifier === "../../../lib/financeStatementImport.mjs") return { importFinanceCardStatement: async (database, requested, options) => {
      events.push({ action: "import", database, operation: requested, options });
      if (importError) throw importError;
      return { account, applied: options.apply };
    } };
    if (specifier === "../../../lib/financeStatementImportVerification.mjs") return { verifyFinanceStatementPlan: async (database, requested, saved, today) => {
      events.push({ action: "verify", database, operation: requested, account: saved, today });
      if (verificationError) throw verificationError;
      return { matched: true };
    } };
    if (specifier === "../../utils/origin") return { isAllowedOrigin: (request) => {
      events.push("origin");
      return isAllowedOrigin(request);
    } };
    throw new Error(`Unexpected import: ${specifier}`);
  }, module, module.exports, { env: admin === undefined || admin === null ? {} : { ANALYTICS_ADMIN_TOKEN: admin } });
  const request = (payload = { mode: "preview", operation }, changes = {}) => {
    const headers = new Headers({ "x-admin-token": "synthetic-admin-token", "x-finance-import-key": nonce,
      origin: "https://finance.example.invalid", "content-type": "application/json" });
    for (const [name, value] of Object.entries(changes)) {
      if (value == null) headers.delete(name);
      else headers.set(name, value);
    }
    return { url: "https://finance.example.invalid/api/admin/finance-statement-import", headers,
      text: async () => { events.push("body"); return typeof payload === "string" ? payload : JSON.stringify(payload); } };
  };
  return { api: module.exports, events, pool, account, request };
}

function assertNoDatabase(harness) {
  assert.ok(!harness.events.some((event) => event === "schema" || typeof event === "object"));
}
function assertPrivate(result) {
  assert.equal(result.headers["Cache-Control"], "private, no-store, max-age=0");
  assert.equal(result.headers.Vary, "X-Admin-Token, X-Finance-Import-Key");
}

test("the temporary import rejects absent or incorrect admin credentials and nonce before any body or database work", async () => {
  for (const changes of [
    { "x-admin-token": null }, { "x-admin-token": "incorrect-admin" },
    { "x-finance-import-key": null }, { "x-finance-import-key": "incorrect-nonce" },
  ]) {
    const harness = routeHarness();
    const result = await harness.api.POST(harness.request("invalid JSON", changes));
    assert.equal(result.status, 401);
    assertPrivate(result);
    assert.deepEqual(harness.events, []);
  }
  const unconfigured = routeHarness({ admin: null });
  assert.equal((await unconfigured.api.POST(unconfigured.request())).status, 401);
  assert.deepEqual(unconfigured.events, []);
});

test("the temporary import expires and rejects cross-origin requests before parsing or touching the database", async () => {
  const expired = routeHarness({ expiresAt: Date.now() - 1 });
  assert.equal((await expired.api.POST(expired.request())).status, 401);
  assert.deepEqual(expired.events, []);
  const crossOrigin = routeHarness();
  const result = await crossOrigin.api.POST(crossOrigin.request("invalid JSON", { origin: "https://attacker.example.invalid" }));
  assert.equal(result.status, 403);
  assertPrivate(result);
  assert.deepEqual(crossOrigin.events, ["origin"]);
});

test("only JSON requests within the declared and actual UTF-8 size limit can reach the import", async () => {
  for (const contentType of [null, "text/plain"]) {
    const harness = routeHarness();
    assert.equal((await harness.api.POST(harness.request(undefined, { "content-type": contentType }))).status, 415);
    assert.deepEqual(harness.events, ["origin"]);
  }
  const declared = routeHarness();
  assert.equal((await declared.api.POST(declared.request(undefined, { "content-length": "4097" }))).status, 413);
  assert.deepEqual(declared.events, ["origin"]);
  for (const payload of [" ".repeat(4097), { mode: "preview", operation, padding: "€".repeat(1500) }]) {
    const harness = routeHarness();
    assert.equal((await harness.api.POST(harness.request(payload))).status, 413);
    assert.deepEqual(harness.events, ["origin", "body"]);
    assertNoDatabase(harness);
  }
});

test("malformed JSON, nulls, arrays and unsupported modes cannot invoke a statement import", async () => {
  const malformed = routeHarness();
  assert.equal((await malformed.api.POST(malformed.request("{"))).status, 400);
  assertNoDatabase(malformed);
  for (const payload of [null, [], [operation], true, 1, {},
    { mode: "delete", operation }, { mode: "APPLY", operation }, { mode: "preview", operation: null },
    { mode: "preview", operation: [] }, { operation }]) {
    const harness = routeHarness();
    const result = await harness.api.POST(harness.request(payload));
    assert.equal(result.status, 403);
    assert.deepEqual(harness.events, ["origin", "body"]);
    assertNoDatabase(harness);
  }
});

test("the exact authorized operation digest binds every statement field and its serialized property order", async () => {
  for (const requested of [
    { ...operation, accountId: 92 }, { ...operation, statementBalance: 37.51 },
    { ...operation, dueDate: "2030-04-16" }, { ...operation, extra: true },
    { currency: operation.currency, accountId: operation.accountId, statementBalance: operation.statementBalance,
      minimumPayment: operation.minimumPayment, dueDate: operation.dueDate, lastStatementDate: operation.lastStatementDate },
  ]) {
    const harness = routeHarness();
    const result = await harness.api.POST(harness.request({ mode: "apply", operation: requested }));
    assert.equal(result.status, 403);
    assertNoDatabase(harness);
  }
});

test("preview and apply call the pinned import once and enable writes only in apply mode", async () => {
  for (const mode of ["preview", "apply"]) {
    const harness = routeHarness();
    const result = await harness.api.POST(harness.request({ mode, operation }, { "content-type": "application/json; charset=utf-8" }));
    assert.equal(result.status, 200);
    assertPrivate(result);
    assert.deepEqual(harness.events, ["origin", "body", "schema", { action: "import", database: harness.pool,
      operation, options: { apply: mode === "apply", today: "2030-03-25" } }]);
    assert.equal(result.value.ok, true);
    assert.equal(result.value.receipt.applied, mode === "apply");
    assert.equal("planner" in result.value, false);
  }
});

test("verify keeps the import read-only and checks the resulting account with the verification helper", async () => {
  const harness = routeHarness();
  const result = await harness.api.POST(harness.request({ mode: "verify", operation }));
  assert.equal(result.status, 200);
  assertPrivate(result);
  assert.deepEqual(harness.events, ["origin", "body", "schema",
    { action: "import", database: harness.pool, operation, options: { apply: false, today: "2030-03-25" } },
    { action: "verify", database: harness.pool, operation, account: harness.account, today: "2030-03-25" }]);
  assert.deepEqual(result.value.planner, { matched: true });
});

test("an unavailable database and failed imports cannot return a successful or unverified receipt", async () => {
  const unavailable = routeHarness({ databaseAvailable: false });
  assert.equal((await unavailable.api.POST(unavailable.request())).status, 503);
  assert.deepEqual(unavailable.events, ["origin", "body", "schema"]);
  const conflict = routeHarness({ importError: Object.assign(new Error("Synthetic conflict"), { status: 409 }) });
  const result = await conflict.api.POST(conflict.request({ mode: "apply", operation }));
  assert.equal(result.status, 409);
  assert.deepEqual(result.value, { error: "Synthetic conflict" });
  assert.equal(conflict.events.some((event) => event?.action === "verify"), false);
  const failure = routeHarness({ importError: new Error("Synthetic internal details") });
  const failed = await failure.api.POST(failure.request());
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.value, { error: "Statement import failed" });
  const verification = routeHarness({ verificationError: new Error("Synthetic verification failure") });
  assert.equal((await verification.api.POST(verification.request({ mode: "verify", operation }))).status, 500);
});
