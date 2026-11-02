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

test("annual bills distinguish actual saved funds from targets and show remaining annual funding", () => {
  const html = renderTable([
    { ...baseBill, name: "Venture X", amount: 395, savedAmount: 100 },
  ]);
  assert.match(html, /Saved so far/);
  assert.match(html, /Still to fund/);
  assert.match(
    html,
    /data-label="Saved so far"[^>]*><strong[^>]*>\$100\.00<\/strong>/,
  );
  assert.match(
    html,
    /data-label="Still to fund"[^>]*><strong>\$295\.00<\/strong><small>₱18,585\.00<\/small>/,
  );
  assert.match(html, /data-label="Target saved by now"/);
  assert.match(html, /earmarked for that bill in budget plans/);
  assert.match(html, /projections do not change your saved balance/);
  // Saving for a bill does not change its total annual cost.
  assert.match(html, /data-label="USD"><span[^>]*>\$395\.00<\/span>/);
});

test("annual funding suggestions and target feedback recalculate when savings increase or decrease", () => {
  const bill = { ...baseBill, name: "Venture X", amount: 395 };
  const target = planner.annualSavingsTarget(bill, "2026-07-02").target;
  for (const [savedAmount, monthly, remaining, status] of [
    [0, "$32.92", "$395.00", `${planner.money(target)} behind target`],
    [100, "$24.58", "$295.00", `${planner.money(target - 100)} behind target`],
    [200, "$16.25", "$195.00", "Target met"],
    [395, "$0.00", "$0.00", "Fully funded"],
    [500, "$0.00", "$0.00", "Fully funded"],
    // Reducing an existing saved balance must restore the funding requirement.
    [100, "$24.58", "$295.00", `${planner.money(target - 100)} behind target`],
  ]) {
    const html = renderTable([{ ...bill, savedAmount }]);
    const cell = (label) =>
      html.match(
        new RegExp(`data-label="${label}"[^>]*>([\\s\\S]*?)<\\/td>`),
      )?.[1];
    assert.ok(cell("Save / month").includes(`<strong>${monthly}</strong>`));
    assert.ok(cell("Still to fund").includes(`<strong>${remaining}</strong>`));
    assert.ok(cell("Target saved by now").includes(status));
    assert.ok(
      cell("Target saved by now").includes(
        `<strong>${planner.money(target)}</strong>`,
      ),
    );
    assert.match(html, /data-label="USD"><span[^>]*>\$395\.00<\/span>/);
    assert.doesNotMatch(html, /NaN|undefined|Infinity/);
    if (savedAmount >= 395) {
      const footer = html.match(/<tfoot>([\s\S]*?)<\/tfoot>/)?.[1];
      assert.match(footer, /<td>\$0\.00<small>₱0\.00 \/ month<\/small><\/td>/);
      assert.match(footer, /All targets met/);
    }
  }
});

test("annual monthly funding converts native remaining balances before rounding", () => {
  const usd = renderTable([{ ...baseBill, amount: 395, savedAmount: 100 }]);
  assert.match(
    usd,
    /data-label="Save \/ month"><strong>\$24\.58<\/strong><small>₱1,548\.75<\/small>/,
  );
  const php = renderTable([
    { ...baseBill, amount: 1200, savedAmount: 1000, currency: "PHP" },
  ]);
  assert.match(
    php,
    /data-label="Save \/ month"><strong>\$0\.26<\/strong><small>₱16\.67<\/small>/,
  );
});

test("saved and remaining totals retain native pesos and overfunding stays with its bill", () => {
  const bills = [
    { ...baseBill, amount: 2, savedAmount: 1 },
    {
      ...baseBill,
      id: "php",
      name: "PHP renewal",
      currency: "PHP",
      amount: 2,
      savedAmount: 1,
    },
  ];
  const footer = renderTable(bills).match(/<tfoot>([\s\S]*?)<\/tfoot>/)?.[1];
  assert.match(
    footer,
    /class="fb-balance fb-saved"><strong>\$1\.02<\/strong><small>₱64\.00<\/small>/,
  );
  assert.match(
    footer,
    /class="fb-balance fb-remaining"><strong>\$1\.02<\/strong><small>₱64\.00<\/small>/,
  );
  const overfunded = renderTable([
    { ...baseBill, amount: 395, savedAmount: 500 },
    { ...baseBill, id: "other", name: "Other renewal", amount: 395 },
  ]);
  assert.match(
    overfunded,
    /data-label="Saved so far"[^>]*><strong[^>]*>\$500\.00<\/strong>/,
  );
  assert.match(
    overfunded,
    /data-label="Still to fund"[^>]*><strong>\$0\.00<\/strong>/,
  );
  const remainingTotal = overfunded.match(/<tfoot>([\s\S]*?)<\/tfoot>/)?.[1];
  assert.match(
    remainingTotal,
    /class="fb-balance fb-remaining"><strong>\$395\.00<\/strong>/,
  );
});

test("annual forms expose the actual saved balance in the payment currency and legacy bills default to zero", () => {
  const renderForm = (bill) =>
    renderToStaticMarkup(
      createElement(BillForm, {
        bill,
        cadence: "annual",
        rate: 63,
        onSave() {},
      }),
    );
  const legacy = renderForm(baseBill);
  assert.match(legacy, /Saved so far · USD/);
  assert.match(
    legacy,
    /min="0" max="999999999" step="0\.01" inputMode="decimal" value="0"/,
  );
  assert.match(legacy, /Budget plans start with these earmarked funds/);
  assert.match(legacy, /projected plans do not change this saved balance/);
  const php = renderForm({ ...baseBill, currency: "PHP", savedAmount: 100 });
  assert.match(php, /Saved so far · PHP/);
  assert.match(
    php,
    /min="0" max="999999999" step="0\.01" inputMode="decimal" value="100"/,
  );
  assert.match(
    renderTable([baseBill]),
    /data-label="Saved so far"[^>]*><strong[^>]*>\$0\.00<\/strong>/,
  );
});

test("editing saved funds updates the annual form preview immediately", () => {
  const state = [];
  let cursor = 0;
  const components = loadComponents({
    ...require("react"),
    useState(initialValue) {
      const index = cursor++;
      if (!(index in state))
        state[index] =
          typeof initialValue === "function" ? initialValue() : initialValue;
      return [
        state[index],
        (next) => {
          state[index] = typeof next === "function" ? next(state[index]) : next;
        },
      ];
    },
  });
  const renderForm = () => {
    cursor = 0;
    return components.BillForm({
      bill: { ...baseBill, amount: 395, savedAmount: 100 },
      cadence: "annual",
      rate: 63,
      onSave() {},
    });
  };
  let form = renderForm();
  assert.match(
    renderToStaticMarkup(form),
    /Save \$24\.58\/month · \$295\.00 still to fund/,
  );
  const savedField = form.props.children.find(
    (child) => child?.props?.label === "Saved so far · USD",
  );
  savedField.props.children.props.onChange({ target: { value: "395" } });
  form = renderForm();
  assert.match(
    renderToStaticMarkup(form),
    /Save \$0\.00\/month · Fully funded/,
  );
  const updatedField = form.props.children.find(
    (child) => child?.props?.label === "Saved so far · USD",
  );
  updatedField.props.children.props.onChange({ target: { value: "100" } });
  assert.match(
    renderToStaticMarkup(renderForm()),
    /Save \$24\.58\/month · \$295\.00 still to fund/,
  );
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
  assert.doesNotMatch(html, /Saved so far/);
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

test("annual saved balances serialize numerically, allow carryover, and default omitted balances to zero", () => {
  const annual = { cadence: "annual", dueDay: "28", dueMonths: [11] };
  for (const [input, expected] of [
    ["100.25", 100.25],
    ["800", 800],
    [999999999, 999999999],
    [undefined, 0],
    [null, 0],
    ["", 0],
  ]) {
    const result = submitDraft({ ...annual, savedAmount: input });
    assert.deepEqual(result.errors, []);
    assert.equal(result.saved.savedAmount, expected);
  }
  // A monthly bill cannot retain an annual reserve, even after cadence changes.
  assert.equal(submitDraft({ savedAmount: "100" }).saved.savedAmount, 0);
  assert.equal(submitDraft({ savedAmount: "NaN" }).saved.savedAmount, 0);
});

test("annual saved balances reject negative, nonfinite, out-of-range and fractional-cent values", () => {
  for (const savedAmount of [
    -0.01,
    "NaN",
    "Infinity",
    "1000000000",
    "100.001",
  ]) {
    const result = submitDraft({
      cadence: "annual",
      dueDay: "28",
      dueMonths: [11],
      savedAmount,
    });
    assert.equal(result.saved, undefined);
    assert.deepEqual(result.errors, [
      "Enter saved funds from 0 to 999,999,999 with up to two decimal places.",
    ]);
  }
});
