import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as planner from "../app/lib/financePlanner.mjs";

const require = createRequire(import.meta.url);
const componentUrl = new URL("../app/finance/FinanceBills.js", import.meta.url);
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
function loadComponents(reactOverride) {
  const componentModule = { exports: {} };
  const componentRequire = (specifier) => {
    if (specifier === "./finance-bills.css") return {};
    if (specifier === "../lib/financePlanner.mjs") return planner;
    if (specifier === "react" && reactOverride) return reactOverride;
    return require(specifier);
  };
  new Function("require", "module", "exports", code)(
    componentRequire,
    componentModule,
    componentModule.exports,
  );
  return componentModule.exports;
}
const { BillForm, BillsTable, DueLabel } = loadComponents();
const baseBill = {
  id: "bill-1",
  name: "Insurance",
  amount: 1200,
  currency: "USD",
  cadence: "annual",
  dueDay: 1,
  dueMonths: [1],
  paymentMethod: "Credit card",
  isAutopay: true,
};
const document = (bills) => ({
  salary: { amount: 2000, currency: "USD" },
  bills,
  allocations: [],
});
function renderTable(bills, overrides = {}) {
  const rate = overrides.rate || 63;
  return renderToStaticMarkup(
    createElement(BillsTable, {
      bills,
      cadence: "annual",
      summary: planner.getSummary(document(bills), rate),
      rate,
      asOf: "2026-07-02",
      onAdd() {},
      onEdit() {},
      onDelete() {},
      ...overrides,
    }),
  );
}

test("annual bills display the suggested target, its date basis, and the next installment", () => {
  const html = renderTable([baseBill]);
  assert.match(html, /Target saved by now/);
  assert.match(html, /As of Jul 2, 2026/);
  assert.match(
    html,
    /data-label="Target saved by now"[^>]*><strong>\$598\.36<\/strong>/,
  );
  assert.match(html, /₱37,696\.68/);
  assert.match(
    html,
    /Target from Jan 1, 2026 to Jan 1, 2027; next payment \$1,200\.00/,
  );
  assert.match(html, /Next: Jan 1, 2027/);
  assert.match(html, /suggested savings amount, not a bank balance/);
  assert.match(html, /aria-label="Edit Insurance"/);
  assert.match(html, /aria-label="Delete Insurance"/);
  assert.doesNotMatch(html, /NaN|undefined|Infinity/);
});

test("the annual target total aggregates native currencies without losing pesos in a USD roundtrip", () => {
  const bills = [
    { ...baseBill, amount: 1, dueDay: 2, dueMonths: [7] },
    {
      ...baseBill,
      id: "php",
      name: "PHP renewal",
      currency: "PHP",
      amount: 1,
      dueDay: 2,
      dueMonths: [7],
    },
  ];
  const html = renderTable(bills);
  const footer = html.match(/<tfoot>([\s\S]*?)<\/tfoot>/)?.[1];
  assert.match(
    footer,
    /class="fb-target"><strong>\$1\.02<\/strong><small>₱64\.00<\/small>/,
  );
  assert.match(html, /fp-native fp-currency-usd/);
  assert.match(html, /fp-native fp-currency-php/);
});

test("undated annual bills show no invented target and are clearly excluded from the total", () => {
  const html = renderTable([{ ...baseBill, dueDay: null }]);
  assert.match(
    html,
    /data-label="Target saved by now"[^>]*><span class="fp-needs-date">Set due date/,
  );
  assert.match(html, /1 bill needs a due date/);
  assert.match(
    html,
    /Bills without a due date are excluded from the target total/,
  );
  assert.doesNotMatch(html, /Next:|next payment/);
});

test("a due-today target uses the full upcoming installment for split annual bills", () => {
  const html = renderTable([
    { ...baseBill, amount: 1000, dueMonths: [1, 7], dueDay: 2 },
  ]);
  assert.match(html, /2 installments/);
  assert.match(
    html,
    /data-label="Target saved by now"[^>]*><strong>\$500\.00<\/strong>/,
  );
  assert.match(html, /Next: Jul 2, 2026/);
});

test("monthly two-payment bills show their monthly total, native split amounts, and both days", () => {
  const bill = {
    ...baseBill,
    cadence: "monthly",
    amount: 600.01,
    dueDays: [6, 20],
    dueMonths: [],
  };
  const html = renderTable([bill], { cadence: "monthly" });
  assert.match(html, /\$600\.01/);
  assert.match(html, /2 payments \/ month · \$300\.00 \+ \$300\.01/);
  assert.match(html, /Days 6 &amp; 20/);
  assert.match(html, /Annual bills reserve/);
  assert.doesNotMatch(html, /Target saved by now|\$1,200\.02/);
  assert.equal(
    renderToStaticMarkup(
      createElement(DueLabel, {
        bill: { ...bill, dueDays: undefined, dueDay: 9 },
      }),
    ),
    "Day 9",
  );
});

test("bill forms explain the total monthly amount and restore both dates when editing", () => {
  const html = renderToStaticMarkup(
    createElement(BillForm, {
      bill: {
        ...baseBill,
        cadence: "monthly",
        amount: 600,
        dueDays: [6, 20],
        dueMonths: [],
      },
      cadence: "monthly",
      rate: 63,
      onSave() {},
    }),
  );
  assert.match(html, /Total monthly amount/);
  assert.match(html, /combined total of all payments in one month/);
  assert.match(html, /option value="2" selected="">Twice a month/);
  assert.match(html, /First due day/);
  assert.match(html, /Second due day/);
  assert.match(html, /value="6"/);
  assert.match(html, /value="20"/);
  assert.match(html, /2 payments per month · \$300\.00 each/);
  assert.match(html, /Save changes/);
});

// Exercise the real submit handler directly with fixed hook state, avoiding a
// browser dependency while checking the data sent to persistence.
function submitDraft(overrides, props = {}) {
  const draft = {
    ...baseBill,
    cadence: "monthly",
    amount: "600.01",
    name: " Rent ",
    dueDay: 20,
    dueDays: ["20", "6"],
    dueMonths: [],
    monthlyPayments: "2",
    paymentMethod: " Cash ",
    ...overrides,
  };
  const errors = [];
  let hook = 0;
  const components = loadComponents({
    ...require("react"),
    useState() {
      hook += 1;
      return hook === 1
        ? [draft, () => {}]
        : ["", (error) => errors.push(error)];
    },
  });
  let saved;
  const form = components.BillForm({
    bill: baseBill,
    cadence: "monthly",
    rate: 63,
    onSave(value) {
      saved = value;
    },
    ...props,
  });
  form.props.onSubmit({ preventDefault() {} });
  return { saved, errors };
}

test("saving a split monthly bill normalizes dates while preserving its total amount", () => {
  const { saved, errors } = submitDraft({});
  assert.deepEqual(errors, []);
  assert.deepEqual(saved.dueDays, [6, 20]);
  assert.equal(saved.dueDay, 6);
  assert.equal(saved.amount, 600.01);
  assert.equal(saved.name, "Rent");
  assert.equal(saved.paymentMethod, "Cash");
  assert.deepEqual(saved.dueMonths, []);
  assert.equal(saved.monthlyPayments, undefined);
});

test("saving prevents duplicate, incomplete, or invalid split dates and invalid amounts", () => {
  for (const draft of [
    { dueDays: ["6", "06"] },
    { dueDays: ["6", ""] },
    { dueDays: ["6", "32"] },
    { dueDays: ["6", "7.5"] },
    { amount: "10.005" },
    { amount: "Infinity" },
    { name: " " },
  ]) {
    const result = submitDraft(draft);
    assert.equal(result.saved, undefined);
    assert.equal(result.errors.length, 1);
  }
  assert.equal(submitDraft({}, { busy: true }).saved, undefined);
  assert.equal(submitDraft({}, { disabled: true }).saved, undefined);
});

test("undated monthly bills remain supported and annual editing preserves installment months", () => {
  const monthly = submitDraft({ monthlyPayments: "1", dueDays: [""] });
  assert.equal(monthly.saved.dueDay, null);
  assert.deepEqual(monthly.saved.dueDays, []);
  const annual = submitDraft({
    cadence: "annual",
    dueDay: "9",
    dueMonths: [11, 3, 11],
  });
  assert.equal(annual.saved.dueDay, 9);
  assert.deepEqual(annual.saved.dueDays, []);
  assert.deepEqual(annual.saved.dueMonths, [3, 11]);
});
