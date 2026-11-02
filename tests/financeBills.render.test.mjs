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
const numberUrl = new URL(
  "../app/finance/FinanceNumberInput.js",
  import.meta.url,
);
const numberCode = transformSync(await readFile(numberUrl, "utf8"), {
  filename: fileURLToPath(numberUrl),
  jsc: {
    parser: { syntax: "ecmascript", jsx: true },
    transform: { react: { runtime: "automatic" } },
    target: "es2022",
  },
  module: { type: "commonjs" },
}).code;
const numberModule = { exports: {} };
new Function("require", "module", "exports", numberCode)(
  require,
  numberModule,
  numberModule.exports,
);
const selectUrl = new URL(
  "../app/finance/FinanceAccountSelect.js",
  import.meta.url,
);
const selectCode = transformSync(await readFile(selectUrl, "utf8"), {
  filename: fileURLToPath(selectUrl),
  jsc: {
    parser: { syntax: "ecmascript", jsx: true },
    transform: { react: { runtime: "automatic" } },
    target: "es2022",
  },
  module: { type: "commonjs" },
}).code;
const selectModule = { exports: {} };
new Function("require", "module", "exports", selectCode)(
  require,
  selectModule,
  selectModule.exports,
);
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
    if (specifier === "./FinanceAccountSelect") return selectModule.exports;
    if (specifier === "./FinanceNumberInput") return numberModule.exports;
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
const annualSalary = {
  amount: 2000,
  currency: "USD",
  payFrequency: "semimonthly",
  firstPayDate: "2026-01-01",
};
const document = (bills) => ({
  salary: annualSalary,
  bills,
  allocations: [],
});
function renderTable(bills, overrides = {}) {
  const rate = overrides.rate || 63;
  const salary = overrides.salary || annualSalary;
  const asOf = overrides.asOf || "2026-07-02";
  return renderToStaticMarkup(
    createElement(BillsTable, {
      bills,
      cadence: "annual",
      summary: planner.getSummary({ ...document(bills), salary }, rate, asOf),
      rate,
      salary,
      asOf,
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
  assert.doesNotMatch(html, /Next:|Next payment funded/);
  assert.match(html, /Estimate · Set a due date/);
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
  for (const [savedAmount, contribution, remaining, status] of [
    [0, "$32.92", "$395.00", `${planner.money(target)} behind target`],
    [100, "$24.59", "$295.00", `${planner.money(target - 100)} behind target`],
    [200, "$16.25", "$195.00", "On track today"],
    [395, "$0.00", "$0.00", "Fully funded"],
    [500, "$0.00", "$0.00", "Fully funded"],
    // Reducing an existing saved balance must restore the funding requirement.
    [100, "$24.59", "$295.00", `${planner.money(target - 100)} behind target`],
  ]) {
    const html = renderTable([{ ...bill, savedAmount }]);
    const cell = (label) =>
      html.match(
        new RegExp(`data-label="${label}"[^>]*>([\\s\\S]*?)<\\/td>`),
      )?.[1];
    assert.ok(
      cell("Save / payday").includes(`<strong>${contribution}</strong>`),
    );
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
      assert.match(footer, /<td>\$0\.00<small>₱0\.00 \/ payday<\/small>/);
      assert.match(footer, /All on track today/);
    }
  }
});

test("annual payday funding retains native currency and labels its monthly equivalent", () => {
  const usd = renderTable([{ ...baseBill, amount: 395, savedAmount: 100 }]);
  assert.match(
    usd,
    /data-label="Save \/ payday"[^>]*><strong>\$24\.59<\/strong><small>₱1,549\.17<\/small>/,
  );
  const php = renderTable([
    { ...baseBill, amount: 1200, savedAmount: 1000, currency: "PHP" },
  ]);
  assert.match(
    php,
    /data-label="Save \/ payday"[^>]*><strong>\$0\.26<\/strong><small>₱16\.67<\/small>/,
  );
  assert.match(usd, /Monthly equivalent: \$49\.18 · ₱3,098\.34/);
  assert.match(php, /Monthly equivalent: \$0\.53 · ₱33\.34/);
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
  const legacySaved = legacy.match(/<input[^>]*min="0"[^>]*>/)?.[0];
  assert.match(legacySaved, /type="text" inputMode="decimal"/);
  assert.match(legacySaved, /step="0\.01"/);
  assert.match(legacySaved, /value="0"/);
  assert.match(legacy, /Budget plans start with these earmarked funds/);
  assert.match(legacy, /projected plans do not change this saved balance/);
  const php = renderForm({ ...baseBill, currency: "PHP", savedAmount: 100 });
  assert.match(php, /Saved so far · PHP/);
  assert.match(php.match(/<input[^>]*min="0"[^>]*>/)?.[0], /value="100"/);
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
      salary: annualSalary,
      asOf: "2026-07-02",
      onSave() {},
    });
  };
  let form = renderForm();
  assert.match(
    renderToStaticMarkup(form),
    /Save \$24\.59\/payday<br\/>Monthly equivalent: \$49\.18 · \$295\.00 still to fund/,
  );
  const savedField = form.props.children.find(
    (child) => child?.props?.label === "Saved so far · USD",
  );
  savedField.props.children.props.onChange({ target: { value: "395" } });
  form = renderForm();
  assert.match(
    renderToStaticMarkup(form),
    /Save \$0\.00\/payday<br\/>Monthly equivalent: \$0\.00.*Fully funded/,
  );
  const updatedField = form.props.children.find(
    (child) => child?.props?.label === "Saved so far · USD",
  );
  updatedField.props.children.props.onChange({ target: { value: "100" } });
  assert.match(
    renderToStaticMarkup(renderForm()),
    /Save \$24\.59\/payday<br\/>Monthly equivalent: \$49\.18 · \$295\.00 still to fund/,
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

const paydaySalary = {
  amount: 2600,
  currency: "USD",
  payFrequency: "biweekly",
  firstPayDate: "2026-10-23",
};
const paydayBill = {
  ...baseBill,
  name: "House",
  cadence: "payday",
  amount: 19000,
  currency: "PHP",
  dueDay: null,
  dueDays: [],
  dueMonths: [],
};

test("payday forms show one full payment and the next salary date without fixed monthly controls", () => {
  const html = renderToStaticMarkup(
    createElement(BillForm, {
      bill: paydayBill,
      cadence: "payday",
      rate: 63,
      salary: paydaySalary,
      asOf: "2026-11-02",
      onSave() {},
    }),
  );
  assert.match(html, /Amount per payday/);
  assert.match(html, /full amount you pay each payday/);
  assert.match(html, /option value="payday" selected="">Every payday/);
  assert.match(html, /₱19,000\.00 each payday · Every 2 weeks/);
  assert.match(html, /Next payment: Nov 6, 2026/);
  assert.match(html, /Changing your first payday or pay frequency/);
  assert.doesNotMatch(
    html,
    /Total monthly amount|Payments per month|First due day|Second due day|<span>Due day|Payment month|Saved so far|Add a due day|2 payments per month/,
  );
});

test("changing a monthly bill to every payday updates labels and submits only the per-payment amount", () => {
  const state = [];
  let cursor = 0;
  let saved;
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
  const findField = (element, label) => {
    if (!element?.props) return undefined;
    if (element?.props?.label === label) return element;
    const children = element?.props?.children;
    for (const child of Array.isArray(children) ? children : [children]) {
      const match = findField(child, label);
      if (match) return match;
    }
    return undefined;
  };
  const renderForm = () => {
    cursor = 0;
    return components.BillForm({
      bill: {
        ...paydayBill,
        cadence: "monthly",
        amount: 38000,
        dueDays: [14, 28],
        dueDay: 14,
      },
      cadence: "monthly",
      rate: 63,
      salary: paydaySalary,
      asOf: "2026-11-02",
      onSave(value) {
        saved = value;
      },
    });
  };
  let form = renderForm();
  findField(form, "Repeats").props.children.props.onChange({
    target: { value: "payday" },
  });
  form = renderForm();
  assert.equal(
    findField(form, "Amount per payday").props.children.props.value,
    38000,
  );
  assert.equal(findField(form, "Payments per month"), undefined);
  assert.equal(findField(form, "First due day"), undefined);
  assert.doesNotMatch(renderToStaticMarkup(form), /2 payments per month/);
  findField(form, "Amount per payday").props.children.props.onChange({
    target: { value: "19000" },
  });
  form = renderForm();
  assert.match(renderToStaticMarkup(form), /₱19,000\.00 each payday/);
  form.props.onSubmit({ preventDefault() {} });
  assert.equal(saved.cadence, "payday");
  assert.equal(saved.amount, 19000);
  assert.equal(saved.currency, "PHP");
  assert.equal(saved.dueDay, null);
  assert.deepEqual(saved.dueDays, []);
  assert.deepEqual(saved.dueMonths, []);
  assert.equal(saved.savedAmount, 0);
});

test("payday saves ignore stale fixed dates and annual balances while validating payment amounts", () => {
  const result = submitDraft({
    cadence: "payday",
    amount: "19000.25",
    dueDay: "99",
    dueDays: ["0", "0"],
    dueMonths: [13],
    savedAmount: "NaN",
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.saved.amount, 19000.25);
  assert.equal(result.saved.dueDay, null);
  assert.deepEqual(result.saved.dueDays, []);
  assert.deepEqual(result.saved.dueMonths, []);
  assert.equal(result.saved.savedAmount, 0);
  for (const amount of ["0", "-1", "19000.001", "Infinity"]) {
    const invalid = submitDraft({ cadence: "payday", amount });
    assert.equal(invalid.saved, undefined);
    assert.equal(invalid.errors.length, 1);
  }
});

test("payday due labels follow salary changes instead of showing an undated warning", () => {
  const renderDue = (salary) =>
    renderToStaticMarkup(
      createElement(DueLabel, {
        bill: paydayBill,
        salary,
        asOf: "2026-11-02",
      }),
    );
  assert.match(renderDue(paydaySalary), /Every payday.*Next: Nov 6, 2026/);
  assert.match(
    renderDue({ ...paydaySalary, firstPayDate: "2026-10-30" }),
    /Next: Nov 13, 2026/,
  );
  assert.match(
    renderDue({ ...paydaySalary, payFrequency: "semimonthly" }),
    /Next: Nov 8, 2026/,
  );
  assert.match(
    renderDue({ ...paydaySalary, firstPayDate: "2028-01-07" }),
    /Next: Jan 7, 2028/,
  );
  assert.match(renderDue(), /Every payday.*Follows your salary schedule/);
  assert.doesNotMatch(renderDue(), /Date not set|fp-needs-date/);
});

test("payday bill tables show native per-payment values with converted totals and no monthly reserve row", () => {
  const bills = [
    paydayBill,
    {
      ...paydayBill,
      id: "usd-payday",
      name: "USD payday bill",
      amount: 50,
      currency: "USD",
    },
  ];
  const summary = planner.getSummary(
    { ...document(bills), salary: paydaySalary },
    100,
  );
  const html = renderTable(bills, {
    cadence: "payday",
    salary: paydaySalary,
    asOf: "2026-11-02",
    summary,
    rate: 100,
  });
  assert.match(html, /Amount · USD<small>Per payday/);
  assert.match(html, /Paid in PHP · Per payday/);
  assert.match(
    html,
    /data-label="PHP"><span class="fp-native fp-currency-php">₱19,000\.00/,
  );
  assert.match(html, /Every payday.*Next: Nov 6, 2026/);
  const footer = html.match(/<tfoot>([\s\S]*?)<\/tfoot>/)?.[1];
  assert.match(
    footer,
    /Total per payday<\/td><td>\$240\.00<\/td><td>₱24,000\.00/,
  );
  assert.doesNotMatch(
    html,
    /Annual bills reserve|2 payments \/ month|Date not set/,
  );
  assert.match(html, /Each amount is paid in full every payday/);
});

test("monthly views reconcile payday monthly averages even without any fixed monthly bills", () => {
  const summary = planner.getSummary(
    { ...document([paydayBill]), salary: paydaySalary },
    100,
  );
  const html = renderTable([], {
    cadence: "monthly",
    salary: paydaySalary,
    summary,
    rate: 100,
  });
  assert.match(html, /Payday bills · monthly average/);
  assert.match(html, /Annual cost divided by 12/);
  assert.match(html, /₱41,166\.67/);
  const footer = html.match(/<tfoot>([\s\S]*?)<\/tfoot>/)?.[1];
  assert.match(
    footer,
    /Total monthly bills<\/td><td>\$411\.67<\/td><td>₱41,166\.67/,
  );
  assert.doesNotMatch(html, /Your monthly bills go here/);
});

test("annual funding shows the screenshot bills' actual remaining paydays and next installment", () => {
  const bills = [
    {
      ...baseBill,
      id: "microsoft",
      name: "Microsoft",
      amount: 100,
      savedAmount: 14.79,
      dueDay: 9,
      dueMonths: [9],
    },
    {
      ...baseBill,
      id: "domain",
      name: "Namecheap",
      amount: 20,
      savedAmount: 8.27,
      dueDay: 4,
      dueMonths: [6],
    },
    {
      ...baseBill,
      id: "venture",
      name: "Venture X",
      amount: 395,
      savedAmount: 395,
      dueDay: 28,
      dueMonths: [11],
    },
    {
      ...baseBill,
      id: "car",
      name: "Car Maintenance",
      amount: 500,
      savedAmount: 85.64,
      dueDay: 1,
      dueMonths: [3, 9],
    },
  ];
  const html = renderTable(bills, { salary: paydaySalary, asOf: "2026-11-02" });
  const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(
    ([, row]) => row,
  );
  const find = (name) =>
    rows.find((row) => row.includes(`<strong>${name}</strong>`));
  assert.match(
    find("Microsoft"),
    /data-label="Save \/ payday"[^>]*><strong>\$3\.88<\/strong>/,
  );
  assert.match(find("Microsoft"), /22 paydays through Sep 9, 2027/);
  assert.match(
    find("Namecheap"),
    /data-label="Save \/ payday"[^>]*><strong>\$0\.74<\/strong>/,
  );
  assert.match(find("Namecheap"), /16 paydays through Jun 4, 2027/);
  assert.match(
    find("Venture X"),
    /data-label="Save \/ payday"[^>]*><strong>\$0\.00<\/strong>/,
  );
  assert.match(find("Venture X"), /Fully funded/);
  assert.match(
    find("Car Maintenance"),
    /data-label="Save \/ payday"[^>]*><strong>\$18\.27<\/strong>/,
  );
  assert.match(find("Car Maintenance"), /9 paydays through Mar 1, 2027/);
  assert.match(find("Car Maintenance"), /\$164\.36 needed for next payment/);
  assert.match(
    find("Car Maintenance"),
    /data-label="Still to fund"[^>]*><strong>\$414\.36<\/strong>/,
  );
  const footer = html.match(/<tfoot>([\s\S]*?)<\/tfoot>/)?.[1];
  assert.match(footer, /<td>\$22\.89<small>₱1,442\.07 \/ payday/);
  assert.match(footer, /Monthly equivalent: \$49\.60 · ₱3,124\.80/);
  assert.match(footer, /All on track today/);
  assert.doesNotMatch(html, /Remaining funding ÷ 12|\$19\.67/);
});

test("a covered next installment pauses contributions while preserving the remaining annual cost", () => {
  const bill = {
    ...baseBill,
    amount: 500,
    savedAmount: 250,
    dueDay: 1,
    dueMonths: [3, 9],
  };
  const html = renderTable([bill], {
    salary: paydaySalary,
    asOf: "2026-11-02",
  });
  assert.match(
    html,
    /data-label="Save \/ payday"[^>]*><strong>\$0\.00<\/strong>/,
  );
  assert.match(html, /Next payment funded/);
  assert.match(
    html,
    /data-label="Still to fund"[^>]*><strong>\$250\.00<\/strong>/,
  );
  assert.doesNotMatch(html, /Fully funded/);
});

test("annual bills due before another payday show an explicit immediate cash requirement", () => {
  const bill = {
    ...baseBill,
    amount: 100,
    savedAmount: 20,
    dueDay: 5,
    dueMonths: [11],
  };
  const html = renderTable([bill], {
    salary: paydaySalary,
    asOf: "2026-11-02",
  });
  assert.match(
    html,
    /data-label="Save \/ payday"[^>]*><strong>\$0\.00<\/strong>/,
  );
  assert.match(html, /Needed before next payday: \$80\.00/);
  assert.doesNotMatch(html, /Next payment funded|Fully funded/);
  const php = renderTable(
    [{ ...bill, currency: "PHP", amount: 0.01, savedAmount: 0 }],
    {
      salary: paydaySalary,
      asOf: "2026-11-02",
    },
  );
  assert.match(php, /Needed before next payday: ₱0\.01/);
  assert.match(
    php.match(/<tfoot>([\s\S]*?)<\/tfoot>/)?.[1],
    /Needed before next payday: \$0\.00 · ₱0\.01/,
  );
});

test("an annual editor without a salary schedule labels its fallback as an estimate", () => {
  const html = renderToStaticMarkup(
    createElement(BillForm, {
      bill: { ...baseBill, amount: 100, savedAmount: 20 },
      cadence: "annual",
      rate: 63,
      asOf: "2026-11-02",
      onSave() {},
    }),
  );
  assert.match(html, /Estimate · Set your salary schedule/);
  assert.match(html, /Save \$3\.33\/payday/);
  assert.doesNotMatch(html, /undefined|NaN|Infinity/);
});

const linkedAccounts = [
  {
    id: 10,
    name: "Checking",
    currency: "USD",
    type: "checking",
    mask: "1234",
    institutionName: "Example Bank",
  },
  {
    id: 20,
    name: "Savings",
    currency: "USD",
    type: "savings",
    mask: "2345",
    institutionName: "Example Bank",
  },
  {
    id: 30,
    name: "Savings",
    currency: "USD",
    type: "savings",
    mask: "3456",
    institutionName: "Example Bank",
  },
  {
    id: 40,
    name: "Peso savings",
    currency: "PHP",
    type: "savings",
    mask: "4567",
  },
  {
    id: 50,
    name: "Credit card",
    currency: "USD",
    type: "credit",
    mask: "5678",
  },
];

test("account selectors distinguish matching-currency accounts and preserve unavailable assignments", () => {
  const Select = selectModule.exports.default;
  const html = renderToStaticMarkup(
    createElement(Select, {
      accounts: linkedAccounts,
      currency: "USD",
      value: 20,
    }),
  );
  assert.match(html, /Savings · ••2345 · Example Bank · savings · USD/);
  assert.match(html, /Savings · ••3456 · Example Bank · savings · USD/);
  assert.doesNotMatch(html, /Peso savings/);
  const unavailable = renderToStaticMarkup(
    createElement(Select, {
      accounts: [
        ...linkedAccounts,
        { id: 60, name: "Old account", currency: "USD", isArchived: true },
      ],
      currency: "USD",
      value: 60,
    }),
  );
  assert.match(unavailable, /value="60" disabled="" selected=""/);
  assert.match(unavailable, /Old account · USD — choose another/);
  const required = renderToStaticMarkup(
    createElement(Select, {
      accounts: linkedAccounts,
      currency: "USD",
      value: null,
      allowNone: false,
      required: true,
    }),
  );
  assert.match(
    required,
    /option value="" disabled="" selected="">Choose an account/,
  );
});

test("annual bills display and save separate payment, reserve, and funding accounts", () => {
  const bill = {
    ...baseBill,
    accountId: 10,
    reserveAccountId: 20,
    sourceAccountId: 10,
  };
  const html = renderToStaticMarkup(
    createElement(BillForm, {
      bill,
      cadence: "annual",
      rate: 63,
      accounts: linkedAccounts,
      salary: annualSalary,
      asOf: "2026-07-02",
      onSave() {},
    }),
  );
  assert.match(html, /Pay from account \(optional\)/);
  assert.match(html, /Annual savings account \(optional\)/);
  assert.match(html, /Fund reserve from \(optional\)/);
  assert.match(html, /Salary receiving account/);
  const table = renderTable([bill], { accounts: linkedAccounts });
  assert.match(table, /Pay from: Checking · ••1234/);
  assert.match(table, /Reserve: Savings · ••2345/);
  const result = submitDraft(
    {
      cadence: "annual",
      dueDay: "28",
      dueMonths: [11],
      accountId: "10",
      reserveAccountId: "20",
      sourceAccountId: "10",
    },
    { accounts: linkedAccounts },
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.saved.accountId, 10);
  assert.equal(result.saved.reserveAccountId, 20);
  assert.equal(result.saved.sourceAccountId, 10);
  const monthly = submitDraft(
    { accountId: 10, reserveAccountId: 20, sourceAccountId: 10 },
    { accounts: linkedAccounts },
  );
  assert.equal(monthly.saved.reserveAccountId, null);
  assert.equal(monthly.saved.sourceAccountId, null);
});

test("bill account validation rejects unavailable, wrong-currency and credit reserve assignments", () => {
  for (const accountId of [999, 40]) {
    const result = submitDraft({ accountId }, { accounts: linkedAccounts });
    assert.equal(result.saved, undefined);
    assert.match(result.errors[0], /available USD payment account/);
  }
  const creditReserve = submitDraft(
    { cadence: "annual", dueDay: 9, dueMonths: [11], reserveAccountId: 50 },
    { accounts: linkedAccounts },
  );
  assert.equal(creditReserve.saved, undefined);
  assert.match(creditReserve.errors[0], /savings, checking, or cash/);
  const archived = submitDraft(
    { accountId: 10 },
    {
      accounts: linkedAccounts.map((account) =>
        account.id === 10 ? { ...account, isArchived: true } : account,
      ),
    },
  );
  assert.equal(archived.saved, undefined);
});

test("changing a bill currency clears all account assignments before saving", () => {
  const state = [];
  let cursor = 0;
  const components = loadComponents({
    ...require("react"),
    useState(initial) {
      const index = cursor++;
      if (!(index in state))
        state[index] = typeof initial === "function" ? initial() : initial;
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
      bill: {
        ...baseBill,
        accountId: 10,
        reserveAccountId: 20,
        sourceAccountId: 10,
      },
      cadence: "annual",
      accounts: linkedAccounts,
      rate: 63,
      onSave() {},
    });
  };
  const findField = (node, label) => {
    if (!node?.props) return null;
    if (node.props.label === label) return node;
    for (const child of Array.isArray(node.props.children)
      ? node.props.children
      : [node.props.children]) {
      const found = findField(child, label);
      if (found) return found;
    }
    return null;
  };
  let form = renderForm();
  findField(form, "Paid in").props.children.props.onChange({
    target: { value: "PHP" },
  });
  form = renderForm();
  assert.equal(
    findField(form, "Pay from account (optional)").props.children.props.value,
    null,
  );
  assert.equal(
    findField(form, "Annual savings account (optional)").props.children.props
      .value,
    null,
  );
  assert.equal(
    findField(form, "Fund reserve from (optional)").props.children.props.value,
    null,
  );
});

test("bill drafts keep raw decimal edits through refreshed props and only save explicitly", () => {
  const slots = [];
  let cursor = 0;
  let saved;
  const components = loadComponents({
    ...require("react"),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots))
        slots[index] = typeof initial === "function" ? initial() : initial;
      return [
        slots[index],
        (next) => {
          slots[index] = typeof next === "function" ? next(slots[index]) : next;
        },
      ];
    },
  });
  const findField = (node, label) => {
    if (Array.isArray(node)) {
      for (const child of node) {
        const match = findField(child, label);
        if (match) return match;
      }
    } else if (node?.props) {
      if (node.props.label === label) return node.props.children;
      return findField(node.props.children, label);
    }
    return null;
  };
  const renderForm = () => {
    cursor = 0;
    return components.BillForm({
      bill: { ...baseBill },
      cadence: "annual",
      rate: 63,
      salary: { ...annualSalary },
      accounts: [],
      onSave: (value) => {
        saved = value;
      },
    });
  };
  let form = renderForm();
  for (const raw of ["", "0.", "12.30"]) {
    findField(form, "Total annual amount").props.onChange({
      target: { value: raw },
    });
    form = renderForm();
    assert.equal(findField(form, "Total annual amount").props.value, raw);
    assert.equal(saved, undefined);
  }
  form.props.onSubmit({ preventDefault() {} });
  assert.equal(saved.amount, 12.3);
});
