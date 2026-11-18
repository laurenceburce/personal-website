import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAllowedOrigin } from "../app/api/utils/origin.js";

const require = createRequire(import.meta.url);
const { transformSync } = require("next/dist/build/swc");
const { code } = transformSync(await readFile(new URL("../app/api/finance/planner/route.js", import.meta.url), "utf8"), {
  jsc: { parser: { syntax: "ecmascript" }, target: "es2022" }, module: { type: "commonjs" },
});
function routeHarness() {
  let authorized = true;
  let revision = 7;
  let stored;
  const events = [];
  const module = { exports: {} };
  new Function("require", "module", "exports", code)((specifier) => {
    if (specifier === "next/server") return { NextResponse: { json: (value, options) => ({ value, ...options }) } };
    if (specifier === "../../../lib/financeAuth") return { requireFinanceAccess: async () => { events.push("auth"); return authorized ? {} : null; } };
    if (specifier === "../../utils/origin") return { isAllowedOrigin: (request) => { events.push("origin"); return isAllowedOrigin(request); } };
    if (specifier === "../../../lib/financePlannerStore") return {
      getFinancePlanner: async () => { events.push("get"); return { configured: true }; },
      refreshPlannerExchangeRate: async () => { events.push("rate"); return { rate: 58 }; },
      saveFinancePlanner: async (document, expectedRevision) => {
        events.push({ action: "save", document, revision: expectedRevision });
        if (expectedRevision !== revision) throw Object.assign(new Error("Reload the latest planner before saving."), { status: 409 });
        stored = structuredClone(document);
        return { configured: true, document, revision: ++revision };
      },
    };
    throw new Error(`Unexpected import: ${specifier}`);
  }, module, module.exports);
  const request = (payload, origin = "https://finance.example.com") => ({
    url: "https://finance.example.com/api/finance/planner", headers: new Headers({ origin }),
    text: async () => { events.push("body"); return typeof payload === "string" ? payload : JSON.stringify(payload); },
  });
  return { api: module.exports, events, request, deny: () => { authorized = false; }, stored: () => stored };
}

test("planner mutations reject unauthorized and cross-origin requests before reading a body or invoking account-affecting saves", async () => {
  for (const method of ["PUT", "POST"]) {
    const unauthorized = routeHarness();
    unauthorized.deny();
    const denied = await unauthorized.api[method](unauthorized.request("invalid JSON"));
    assert.equal(denied.status, 401);
    assert.deepEqual(unauthorized.events, ["auth"]);
    const crossOrigin = routeHarness();
    const forbidden = await crossOrigin.api[method](crossOrigin.request("invalid JSON", "https://untrusted.example.org"));
    assert.equal(forbidden.status, 403);
    assert.deepEqual(crossOrigin.events, ["auth", "origin"]);
    assert.equal(forbidden.headers["Cache-Control"], "private, no-store, max-age=0");
  }
});

test("same-origin planner PUT invokes the revision-checked save once with the entire document, preserving atomic store ownership", async () => {
  const harness = routeHarness();
  const document = { plans: [{ id: "main", completedRows: [{ rowId: "entry:payment", completedAt: "2026-11-18T12:00:00.000Z" }] }] };
  const result = await harness.api.PUT(harness.request({ document, revision: 7 }));
  assert.equal(result.status, 200);
  assert.equal(result.value.revision, 8);
  assert.deepEqual(harness.events, ["auth", "origin", "body", { action: "save", document, revision: 7 }]);
  assert.deepEqual(harness.stored(), document);
  const stale = await harness.api.PUT(harness.request({ document: { plans: [] }, revision: 7 }));
  assert.equal(stale.status, 409);
  assert.deepEqual(harness.stored(), document, "a stale request cannot publish a replacement document");
  assert.equal(harness.events.filter((event) => event?.action === "save").length, 2);
});

test("same-origin rate refresh is protected while planner GET retains its read-only access behavior", async () => {
  const refresh = routeHarness();
  const rate = await refresh.api.POST(refresh.request({ action: "refreshRate" }));
  assert.equal(rate.status, 200);
  assert.deepEqual(rate.value, { exchangeRate: { rate: 58 } });
  assert.deepEqual(refresh.events, ["auth", "origin", "body", "rate"]);
  const read = routeHarness();
  assert.equal((await read.api.GET()).status, 200);
  assert.deepEqual(read.events, ["auth", "get"]);
  read.events.length = 0;
  read.deny();
  assert.equal((await read.api.GET()).status, 401);
  assert.deepEqual(read.events, ["auth"]);
});

test("allowed-origin malformed JSON cannot reach planner persistence or a rate refresh", async () => {
  for (const method of ["PUT", "POST"]) {
    const harness = routeHarness();
    assert.equal((await harness.api[method](harness.request("invalid JSON"))).status, 400);
    assert.deepEqual(harness.events, ["auth", "origin", "body"]);
  }
});
