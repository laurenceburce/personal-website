import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as planner from "../app/lib/financePlanner.mjs";
import * as insights from "../app/lib/financeInsights.mjs";

// Compile the actual JSX with the same SWC shipped by Next. Only the stylesheet
// import is ignored: calculations and React rendering remain the real modules.
const require = createRequire(import.meta.url);
const componentUrl = new URL(
  "../app/finance/FinanceOverview.js",
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
  if (specifier === "./finance-overview.css") return {};
  if (specifier === "../lib/financePlanner.mjs") return planner;
  if (specifier === "../lib/financeInsights.mjs") return insights;
  return require(specifier);
};
new Function("require", "module", "exports", code)(
  componentRequire,
  componentModule,
  componentModule.exports,
);
const FinanceOverview = componentModule.exports.default;

const document = {
  salary: {
    amount: 2000,
    currency: "USD",
    payFrequency: "semimonthly",
    firstPayDate: "2024-01-06",
  },
  bills: [
    {
      id: "usd",
      name: "USD bill",
      amount: 40,
      currency: "USD",
      cadence: "monthly",
      dueDay: 18,
      dueMonths: [],
    },
    {
      id: "php",
      name: "PHP bill",
      amount: 2520,
      currency: "PHP",
      cadence: "monthly",
      dueDay: 11,
      dueMonths: [],
    },
    {
      id: "annual",
      name: "Annual bill",
      amount: 120,
      currency: "USD",
      cadence: "annual",
      dueDay: 7,
      dueMonths: [1],
    },
  ],
  allocations: [
    {
      id: "savings",
      name: "Savings",
      amount: 500,
      currency: "USD",
      kind: "savings",
    },
  ],
  plans: [],
};
const activity = {
  configured: true,
  month: "2024-01",
  accounts: [
    { id: 1, type: "checking", currency: "USD", nativeCurrentBalance: 1000 },
    { id: 2, type: "savings", currency: "PHP", nativeCurrentBalance: 6300 },
    { id: 3, type: "credit", currency: "USD", nativeCurrentBalance: 100 },
  ],
  transactions: [
    {
      id: 1,
      date: "2024-01-06",
      kind: "income",
      amount: 1000,
      currency: "USD",
      category: "Income",
      merchant: "Salary",
    },
    {
      id: 2,
      date: "2024-01-07",
      kind: "income",
      amount: 6300,
      currency: "PHP",
      category: "Income",
      merchant: "Freelance",
    },
    {
      id: 3,
      date: "2024-01-08",
      kind: "expense",
      amount: 100,
      currency: "USD",
      category: "Shopping",
      merchant: "One-time purchase",
    },
    {
      id: 4,
      date: "2024-01-09",
      kind: "expense",
      amount: 630,
      currency: "PHP",
      category: "Groceries",
      merchant: "Groceries",
    },
    {
      id: 5,
      date: "2024-01-10",
      kind: "expense",
      amount: 999,
      currency: "USD",
      category: "Travel",
      pending: true,
    },
    {
      id: 6,
      date: "2024-01-10",
      kind: "income",
      amount: 9000,
      currency: "USD",
      category: "Transfer In",
    },
  ],
};
const render = (overrides = {}) =>
  renderToStaticMarkup(
    createElement(FinanceOverview, {
      document,
      activity,
      rate: 63,
      month: "2024-01",
      today: "2024-01-31",
      currency: "USD",
      onNavigate() {},
      onAddTransaction() {},
      ...overrides,
    }),
  );
const metricValues = (html) =>
  [
    ...html.matchAll(
      /<article class="fpi-metric[^\"]*">([\s\S]*?)<\/article>/g,
    ),
  ].map(
    ([, article]) =>
      article.match(/<strong class="[^\"]*">([^<]*)<\/strong>/)?.[1],
  );

test("the real overview renders actual USD metrics separately from planned salary and commitments", () => {
  const html = render();
  assert.deepEqual(metricValues(html), [
    "$1,000.00",
    "$1,100.00",
    "$110.00",
    "+$990.00",
  ]);
  assert.equal((html.match(/class="fpi-month-bars[^\"]*"/g) || []).length, 6);
  assert.match(
    html,
    /role="group" aria-label="Six-month income and spending in USD/,
  );
  assert.match(html, /<caption>Recorded income and spending in USD<\/caption>/);
  const allocationDescription =
    html.match(/<desc[^>]*>([^<]*)<\/desc>/)?.[1] || "";
  assert.deepEqual(allocationDescription.match(/\$[\d,]+\.\d{2}/g), [
    "$40.00",
    "$40.00",
    "$10.44",
    "$1,000.00",
    "$909.56",
  ]);
  assert.match(html, /USD bill/);
  assert.match(html, /PHP bill/);
  assert.match(html, /Annual bill/);
  assert.match(html, /One-time purchase/);
  assert.match(html, /Groceries/);
  assert.doesNotMatch(html, /NaN|Infinity|undefined/);
  const barHeights = [...html.matchAll(/height:([\d.]+)%/g)].map((match) =>
    Number(match[1]),
  );
  assert.equal(barHeights.length, 12);
  assert.ok(barHeights.every((height) => height >= 0 && height <= 100));
});

test("switching to PHP changes every actual metric and chart currency without corrupting native bills", () => {
  const html = render({ currency: "PHP" });
  assert.deepEqual(metricValues(html), [
    planner.money(63000, "PHP"),
    planner.money(69300, "PHP"),
    planner.money(6930, "PHP"),
    `+${planner.money(62370, "PHP")}`,
  ]);
  assert.match(html, /Six-month income and spending in PHP/);
  assert.match(html, /Recorded income and spending in PHP/);
  assert.ok(html.includes(planner.money(2520, "PHP")));
  assert.doesNotMatch(html, /NaN|Infinity|undefined/);
});

test("the overview rerenders annual reserve funding and unallocated salary when saved balances change", () => {
  const initialMetrics = metricValues(render());
  for (const [saved, reserve, remaining] of [
    [0, "$10.44", "$909.56"],
    [60, "$5.22", "$914.78"],
    [120, "$0.00", "$920.00"],
    [60, "$5.22", "$914.78"],
  ]) {
    const html = render({
      document: {
        ...document,
        bills: document.bills.map((bill) =>
          bill.cadence === "annual" ? { ...bill, savedAmount: saved } : bill,
        ),
      },
    });
    const annualLegend = html.match(
      /Annual reserve<\/span><strong>([^<]*)<\/strong>/,
    )?.[1];
    const remainingLegend = html.match(
      /Unallocated<\/span><strong>([^<]*)<\/strong>/,
    )?.[1];
    assert.equal(annualLegend, reserve);
    assert.equal(remainingLegend, remaining);
    assert.deepEqual(metricValues(html), initialMetrics);
    assert.match(html, /Annual payment[\s\S]*?\$120\.00/);
    assert.match(
      html,
      /Annual reserves show the monthly equivalent of contributions needed across the paydays left before each next payment/,
    );
    assert.doesNotMatch(html, /NaN|Infinity|undefined/);
  }
});

test("the negative case renders debt, negative cash flow, and an over-budget forecast", () => {
  const html = render({
    document: {
      ...document,
      bills: [],
      allocations: [
        {
          id: "saving",
          name: "Savings",
          amount: 1100,
          currency: "USD",
          kind: "savings",
        },
      ],
    },
    activity: {
      ...activity,
      accounts: [
        { id: 1, type: "credit", currency: "USD", nativeCurrentBalance: 500 },
      ],
      transactions: [
        {
          id: 1,
          date: "2024-01-07",
          kind: "income",
          amount: 20,
          currency: "USD",
        },
        {
          id: 2,
          date: "2024-01-08",
          kind: "expense",
          amount: 300,
          currency: "USD",
        },
      ],
    },
  });
  assert.deepEqual(metricValues(html), [
    "-$500.00",
    "$20.00",
    "$300.00",
    "-$280.00",
  ]);
  assert.match(html, /class="fpi-negative">-\$500\.00/);
  assert.match(html, /class="fpi-negative">-\$280\.00/);
  assert.match(html, /class="fpi-plan-note fpi-plan-over">[\s\S]*?\$200\.00/);
  const arcs = [...html.matchAll(/stroke-dasharray="([\d.]+) ([\d.]+)"/g)];
  assert.ok(arcs.length > 0);
  assert.ok(
    arcs.every((match) => Number(match[1]) >= 0 && Number(match[2]) > 0),
  );
  assert.doesNotMatch(html, /NaN|Infinity|undefined/);
});

test("empty data leaves honest zero values, a missing balance, and no invented chart bars", () => {
  const html = render({
    document: {
      ...document,
      salary: { ...document.salary, amount: 0 },
      bills: [],
      allocations: [],
    },
    activity: {
      configured: true,
      month: "2024-01",
      accounts: [],
      transactions: [],
    },
  });
  assert.deepEqual(metricValues(html), ["—", "$0.00", "$0.00", "$0.00"]);
  assert.equal((html.match(/height:0%/g) || []).length, 12);
  assert.equal((html.match(/stroke-dasharray=/g) || []).length, 0);
  assert.match(html, /No posted income or spending in this period/);
  assert.match(html, /No transactions recorded this month/);
  assert.match(html, /Connect a bank/);
  assert.match(html, /Add a transaction/);
  assert.doesNotMatch(html, /NaN|Infinity|undefined/);
});

test("the overview shows the next-installment contribution using the supplied current date", () => {
  const datedDocument = {
    ...document,
    salary: {
      ...document.salary,
      payFrequency: "biweekly",
      firstPayDate: "2026-10-23",
    },
    allocations: [],
    bills: [
      {
        id: "car",
        name: "Car Maintenance",
        cadence: "annual",
        amount: 500,
        savedAmount: 85.64,
        currency: "USD",
        dueDay: 1,
        dueMonths: [3, 9],
      },
    ],
  };
  for (const month of ["2026-11", "2026-08", "2027-03"]) {
    const html = render({
      document: datedDocument,
      activity: { accounts: [], transactions: [] },
      month,
      today: "2026-11-02",
    });
    const reserve = html.match(
      /Annual reserve<\/span><strong>([^<]*)<\/strong>/,
    )?.[1];
    assert.equal(reserve, "$39.59");
    assert.match(html, /paydays left before each next payment/);
    assert.doesNotMatch(html, /NaN|Infinity|undefined/);
  }
});

test("overview warnings retain urgent native PHP cents and identify undated estimates", () => {
  const html = render({
    month: "2026-11",
    today: "2026-11-02",
    document: {
      ...document,
      salary: {
        ...document.salary,
        payFrequency: "biweekly",
        firstPayDate: "2026-10-23",
      },
      allocations: [],
      bills: [
        {
          id: "urgent",
          name: "Small urgent fee",
          cadence: "annual",
          amount: 0.01,
          savedAmount: 0,
          currency: "PHP",
          dueDay: 4,
          dueMonths: [11],
        },
        {
          id: "estimate",
          name: "Open annual fee",
          cadence: "annual",
          amount: 260,
          savedAmount: 0,
          currency: "USD",
          dueDay: null,
          dueMonths: [11],
        },
      ],
    },
  });
  assert.match(
    html,
    /Annual bills need ₱0\.01 before the next eligible payday/,
  );
  assert.match(html, /1 annual bill uses an estimate/);
  assert.doesNotMatch(html, /NaN|Infinity|undefined/);
});
