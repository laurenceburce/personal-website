import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as planner from "../app/lib/financePlanner.mjs";

const require = createRequire(import.meta.url);
const componentUrl = new URL(
  "../app/finance/FinancePlanLedger.js",
  import.meta.url,
);
const { transformSync } = require("next/dist/build/swc");
const { code } = transformSync(await readFile(componentUrl, "utf8"), {
  filename: fileURLToPath(componentUrl),
  jsc: {
    parser: { syntax: "ecmascript", jsx: true },
    transform: { react: { runtime: "automatic" } },
    target: "es2022",
  },
  module: { type: "commonjs" },
});
const componentModule = { exports: {} };
const componentRequire = (specifier) => {
  if (specifier === "./finance-plan-ledger.css") return {};
  if (specifier === "../lib/financePlanner.mjs") return planner;
  return require(specifier);
};
new Function("require", "module", "exports", code)(
  componentRequire,
  componentModule,
  componentModule.exports,
);
const Ledger = componentModule.exports.default;

const plan = {
  startDate: "2026-11-06",
  endDate: "2026-11-30",
  openingUsd: 750,
  openingPhp: 500,
  openingReserveUsd: 200,
  openingReservePhp: 12600,
  entries: [
    {
      id: "manual",
      description: "Extra expense",
      date: "2026-11-10",
      kind: "expense",
      currency: "USD",
      amount: 25,
    },
  ],
};
const row = (overrides = {}) => ({
  id: "row",
  date: "2026-11-06",
  description: "Flow",
  source: "bill",
  kind: "expense",
  usd: 0,
  php: 0,
  balanceUsd: 750,
  balancePhp: 500,
  reserveUsd: 200,
  reservePhp: 12600,
  reserveDeltaUsd: 0,
  reserveDeltaPhp: 0,
  ...overrides,
});
const render = (rows = [], overrides = {}) =>
  renderToStaticMarkup(
    createElement(Ledger, {
      plan,
      rows,
      onEdit() {},
      onDelete() {},
      ...overrides,
    }),
  );
const plain = (html) => html.replace(/<[^>]*>/g, "");
const cells = (html) =>
  [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, value]) =>
    plain(value),
  );
const findRow = (html, className) =>
  html.match(
    new RegExp(`<tr class="[^"]*${className}[^"]*">([\\s\\S]*?)<\\/tr>`),
  )?.[1] || "";

test("opening balances keep annual reserve pockets distinct from available USD and PHP", () => {
  const html = render();
  const opening = cells(findRow(html, "fpl-opening-row"));
  assert.equal(opening.length, 9);
  assert.equal(opening[4], "$750.00");
  assert.equal(opening[5], "₱500.00");
  assert.equal(opening[6], "$200.00");
  assert.equal(opening[7], "₱12,600.00");
  assert.ok(html.includes("Available · USD"));
  assert.ok(html.includes("Annual reserve · PHP"));
  assert.ok(html.includes('role="region"'));
  assert.ok(html.includes('tabindex="0"'));
});

test("the starting annual reserve includes item savings supplied by the opening helper", () => {
  const savedPlan = { ...plan, openingReserveUsd: 0, openingReservePhp: 0 };
  const openingReserve = planner.getAnnualReserveOpening(savedPlan, {
    bills: [
      { id: "venture", cadence: "annual", currency: "USD", savedAmount: 100 },
    ],
  });
  const opening = cells(
    findRow(render([], { plan: savedPlan, openingReserve }), "fpl-opening-row"),
  );
  assert.equal(opening[4], "$750.00");
  assert.equal(opening[6], "$100.00");
  assert.equal(opening[7], "₱0.00");
});

test("an annual payment displays one net cash row with its full fee and reserve use", () => {
  const html = render([
    row({
      id: "venture",
      description: "Venture X",
      annualPayment: true,
      currency: "USD",
      amount: 395,
      grossAmount: 395,
      reserveUsed: 100,
      reserveShortfall: 295,
      usd: -295,
      balanceUsd: 455,
      reserveUsd: 0,
      reserveDeltaUsd: -100,
    }),
  ]);
  assert.equal((html.match(/class="fpl-row /g) || []).length, 1);
  const bill = cells(findRow(html, "fpl-row-bill"));
  assert.equal(bill[2], "-$295.00");
  assert.equal(bill[3], "—");
  assert.equal(bill[4], "$455.00");
  assert.equal(bill[6], "$0.00-$100.00 used");
  assert.ok(
    html.includes(
      "Total bill $395.00 · $100.00 from reserves · $295.00 additional cash",
    ),
  );
  assert.ok(!html.includes("Use annual reserve"));
  assert.ok(!html.includes("Reserve shortfall:"));
  assert.ok(
    html.includes(
      "Annual payments show only additional available funds needed",
    ),
  );
  assert.ok(html.includes("Saved amounts are earmarked for each annual bill"));
});

test("fully funded annual bills show a zero native cash flow and leave the other currency blank", () => {
  for (const currency of ["USD", "PHP"]) {
    const html = render([
      row({
        annualPayment: true,
        currency,
        amount: 395,
        grossAmount: 395,
        reserveUsed: 395,
        reserveShortfall: 0,
        reserveUsd: currency === "USD" ? 0 : 200,
        reservePhp: currency === "PHP" ? 12205 : 12600,
        reserveDeltaUsd: currency === "USD" ? -395 : 0,
        reserveDeltaPhp: currency === "PHP" ? -395 : 0,
      }),
    ]);
    const bill = cells(findRow(html, "fpl-row-bill"));
    assert.equal(bill[2], currency === "USD" ? "$0.00" : "—");
    assert.equal(bill[3], currency === "PHP" ? "₱0.00" : "—");
    assert.equal(bill[4], "$750.00");
    assert.equal(bill[5], "₱500.00");
    assert.ok(
      plain(html).includes(
        `${planner.money(395, currency)} from reserves · ${planner.money(0, currency)} additional cash`,
      ),
    );
  }
});

test("reserve set-asides display signed available flows and their reserve movement", () => {
  const html = render([
    row({
      id: "save",
      source: "reserve",
      kind: "reserve",
      description: "Annual set-aside",
      usd: -50,
      balanceUsd: 700,
      reserveUsd: 250,
      reserveDeltaUsd: 50,
    }),
  ]);
  const save = cells(findRow(html, "fpl-row-reserve"));
  assert.equal(save[2], "-$50.00");
  assert.equal(save[4], "$700.00");
  assert.equal(save[6], "$250.00+$50.00 set aside");
  assert.ok(html.includes("Annual bills set-aside"));
});

test("recorded annual payments retain the full payment detail while showing only additional cash", () => {
  const html = render([
    row({
      source: "transaction",
      description: "Venture X card payment",
      annualPayment: true,
      currency: "USD",
      amount: 395,
      grossAmount: 395,
      reserveUsed: 100,
      reserveShortfall: 295,
      usd: -295,
      balanceUsd: 455,
      reserveUsd: 0,
      reserveDeltaUsd: -100,
      scheduledSource: "bill",
      scheduledDate: "2026-11-28",
    }),
  ]);
  const actual = cells(findRow(html, "fpl-row-transaction"));
  assert.equal(actual[2], "-$295.00");
  assert.ok(html.includes("Recorded transaction"));
  assert.ok(html.includes("Replaces scheduled bill"));
  assert.ok(
    html.includes(
      "Total bill $395.00 · $100.00 from reserves · $295.00 additional cash",
    ),
  );
  assert.ok(!html.includes('aria-label="Edit '));
  assert.ok(!html.includes('aria-label="Delete '));
});

test("only original manual plan entries have edit and delete controls", () => {
  const html = render([
    row({
      id: "manual-row",
      source: "manual",
      entryId: "manual",
      description: "Extra expense",
      usd: -25,
      balanceUsd: 725,
    }),
    row({
      id: "missing-row",
      source: "manual",
      entryId: "missing",
      description: "Removed manual entry",
    }),
    row({
      id: "actual-row",
      source: "transaction",
      entryId: "manual",
      description: "Recorded expense",
      usd: -25,
      balanceUsd: 700,
      scheduledSource: "manual",
      matchedForecast: { id: "manual", source: "manual" },
    }),
    row({
      id: "salary",
      source: "salary",
      kind: "income",
      description: "Salary",
      usd: 1000,
      balanceUsd: 1700,
    }),
    row({
      id: "allocation",
      source: "allocation",
      description: "Savings allocation",
      usd: -500,
      balanceUsd: 1200,
    }),
  ]);
  assert.equal((html.match(/aria-label="Edit /g) || []).length, 1);
  assert.equal((html.match(/aria-label="Delete /g) || []).length, 1);
  assert.ok(html.includes('aria-label="Edit Extra expense"'));
  assert.ok(!html.includes('aria-label="Edit Recorded expense"'));
  assert.ok(!html.includes('aria-label="Edit Removed manual entry"'));
  assert.ok(html.includes("Replaces plan entry"));
  assert.ok(html.includes("Payday allocation"));
});

test("recorded matches, future dates and reserve shortfalls stay visible alongside negative available balances", () => {
  const html = render([
    row({
      id: "actual",
      source: "transaction",
      description: "Insurance",
      php: -9000,
      balancePhp: -8500,
      currency: "PHP",
      reserveShortfall: 9000,
      scheduled: true,
      scheduledSource: "bill",
      scheduledDate: "2026-11-09",
      matchedForecast: { id: "bill", source: "bill" },
    }),
    row({
      id: "convert",
      source: "manual",
      kind: "conversion",
      description: "Convert",
      usd: -100,
      php: 6300,
      balanceUsd: 650,
      balancePhp: -2200,
    }),
  ]);
  assert.ok(html.includes("Recorded transaction · future date"));
  assert.ok(html.includes("Replaces scheduled bill"));
  assert.ok(html.includes("Reserve shortfall: ₱9,000.00"));
  assert.match(html, /class="fp-running fp-negative">-₱8,500\.00/);
  assert.ok(html.includes("Planned currency conversion"));
});
