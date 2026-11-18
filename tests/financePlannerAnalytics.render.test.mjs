import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as planner from "../app/lib/financePlanner.mjs";
import { getLivePlannerAnalytics } from "../app/lib/financeLivePlanner.mjs";

const require = createRequire(import.meta.url);
const { transformSync } = require("next/dist/build/swc");
const source = new URL("../app/finance/FinancePlannerAnalytics.js", import.meta.url);
const { code } = transformSync(await readFile(source, "utf8"), {
  filename: fileURLToPath(source), jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "commonjs" },
});
const module = { exports: {} };
new Function("require", "module", "exports", code)((specifier) => specifier.endsWith(".css") ? {} : specifier === "../lib/financePlanner.mjs" ? planner : require(specifier), module, module.exports);
const Component = module.exports.default;
const today = "2026-11-18";
const accounts = [{ id: 1, name: "Checking", type: "checking", currency: "USD", nativeCurrentBalance: 1000 },
  { id: 2, name: "Credit card", type: "credit", currency: "USD", nativeCurrentBalance: 300 }];
const makeAnalytics = (extra = {}) => getLivePlannerAnalytics({ accounts, today, range: { startDate: today, endDate: "2027-01-01" },
  rows: [{ id: "bill", date: "2026-12-01", source: "bill", kind: "expense", amount: 100,
    accountMovements: [{ accountId: 1, currency: "USD", amount: -100, balanceDelta: -100 }] }], ...extra });
const render = (analytics, props = {}) => renderToStaticMarkup(createElement(Component, { analytics, ...props }));

test("balance analytics compare native current/projected values, show debt separately, and expose account details", () => {
  const html = render(makeAnalytics());
  assert.match(html, /Current balance/);
  assert.match(html, /Projected balance/);
  assert.match(html, /\$1,000\.00/);
  assert.match(html, /\$900\.00/);
  assert.match(html, /Card &amp; loan balances/);
  assert.match(html, /Balances by account/);
  assert.match(html, /USD account balance projection/);
  assert.doesNotMatch(html, /\$700\.00/);
});

test("loading preserves live current amounts while hiding incomplete projections and trends", () => {
  const html = render(makeAnalytics(), { loading: true });
  assert.match(html, /Current balance<\/dt><dd>\$1,000\.00/);
  assert.match(html, /Projected balance<\/dt><dd class="">—/);
  assert.match(html, /Updating projection/);
  assert.doesNotMatch(html, /role="img"/);
  assert.doesNotMatch(html, /\$900\.00/);
});

test("a historical window shows current live balances and an explicit absence of a future projection", () => {
  const html = render(makeAnalytics({ range: { startDate: "2026-10-01", endDate: "2026-10-31" } }));
  assert.match(html, /Viewing past transactions/);
  assert.match(html, /Current balances remain live/);
  assert.match(html, /no future balance projection/);
  assert.doesNotMatch(html, /role="img"/);
});
