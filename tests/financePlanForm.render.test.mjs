import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as planner from "../app/lib/financePlanner.mjs";

const require = createRequire(import.meta.url);
const { transformSync } = require("next/dist/build/swc");
const modules = new Map();
function load(filename, reactOverride) {
  if (!reactOverride && modules.has(filename))
    return modules.get(filename).exports;
  const module = { exports: {} };
  if (!reactOverride) modules.set(filename, module);
  const { code } = transformSync(readFileSync(filename, "utf8"), {
    filename,
    jsc: {
      parser: { syntax: "ecmascript", jsx: true },
      transform: { react: { runtime: "automatic" } },
      target: "es2022",
    },
    module: { type: "commonjs" },
  });
  new Function("require", "module", "exports", code)(
    (specifier) => {
      if (specifier === "react" && reactOverride) return reactOverride;
      if (specifier === "../lib/financePlanner.mjs") return planner;
      if (specifier.startsWith("./"))
        return load(resolve(dirname(filename), `${specifier}.js`));
      return require(specifier);
    },
    module,
    module.exports,
  );
  return module.exports;
}
const filename = fileURLToPath(
  new URL("../app/finance/FinancePlanForm.js", import.meta.url),
);
const PlanForm = load(filename).default;
const account = {
  id: 1,
  name: "Checking",
  institutionName: "Test Bank",
  mask: "1001",
  type: "checking",
  currency: "USD",
  nativeCurrentBalance: 1000,
};
const document = {
  salary: {
    amount: 2000,
    currency: "USD",
    payFrequency: "biweekly",
    firstPayDate: "2026-10-23",
  },
  bills: [],
  allocations: [],
};
const plan = {
  id: "plan",
  name: "November",
  startDate: "2026-11-02",
  endDate: "2026-11-30",
  openingUsd: 100,
  openingPhp: 0,
  openingReserveUsd: 0,
  openingReservePhp: 0,
  startingAccounts: [{ accountId: 1, percentage: 80 }],
  entries: [],
  completedRows: [],
  includeIncome: false,
  includeTransactions: true,
  includeAllocations: false,
  includeAnnualReserve: false,
};
const plain = (html) => html.replace(/<[^>]*>/g, "");
function find(node, predicate) {
  if (Array.isArray(node))
    return node.map((child) => find(child, predicate)).find(Boolean);
  if (node && typeof node === "object")
    return predicate(node) ? node : find(node.props?.children, predicate);
}

test("plan editor previews percentage of current actual bank funds plus flat amounts", () => {
  for (const [balance, expected] of [
    [1000, "$900.00"],
    [1250, "$1,100.00"],
  ]) {
    const html = renderToStaticMarkup(
      createElement(PlanForm, {
        plan,
        document,
        accounts: [{ ...account, nativeCurrentBalance: balance }],
        onSave() {},
      }),
    );
    assert.ok(plain(html).includes(`Available starting balance: ${expected}`));
    assert.ok(plain(html).includes("80%"));
    assert.ok(html.includes("Flat starting amount · USD"));
    assert.ok(!html.includes('type="number"'));
    assert.ok(!html.includes("Use current account balances"));
  }
});

test("bank refresh preserves partially typed percentages and flat amounts until explicit save", () => {
  const state = [];
  let cursor = 0,
    saved;
  const Component = load(filename, {
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
  }).default;
  let accounts = [account];
  const render = () => {
    cursor = 0;
    return Component({
      plan: { ...plan },
      document,
      accounts,
      onSave(value) {
        saved = value;
      },
    });
  };
  let tree = render();
  const percentage = find(tree, (node) => node.props?.label === "Percentage");
  find(
    percentage,
    (node) => node.type?.name === "FinanceNumberInput",
  ).props.onChange({ target: { value: "80." } });
  tree = render();
  const flat = find(
    tree,
    (node) => node.props?.label === "Flat starting amount · USD",
  );
  flat.props.children.props.onChange({ target: { value: "17.50" } });
  accounts = [{ ...account, nativeCurrentBalance: 1200 }];
  tree = render();
  const html = renderToStaticMarkup(tree);
  assert.ok(html.includes('value="80."'));
  assert.ok(html.includes('value="17.50"'));
  assert.ok(plain(html).includes("Available starting balance: $977.50"));
  assert.equal(saved, undefined);
  tree.props.onSubmit({ preventDefault() {} });
  assert.equal(saved.openingUsd, 17.5);
  assert.deepEqual(saved.startingAccounts, [{ accountId: 1, percentage: 80 }]);
  assert.deepEqual(saved.accountOpeningBalances, []);
});

test("an unknown current balance stays unavailable and annual earmarks are included only once", () => {
  const unknown = plain(
    renderToStaticMarkup(
      createElement(PlanForm, {
        plan,
        document,
        accounts: [
          { ...account, nativeCurrentBalance: null, currentBalance: 9000 },
        ],
        onSave() {},
      }),
    ),
  );
  assert.ok(unknown.includes("current bank balance is unavailable"));
  assert.ok(unknown.includes("Available starting balance: $100.00"));
  const reserved = plain(
    renderToStaticMarkup(
      createElement(PlanForm, {
        plan: {
          ...plan,
          startingAccounts: [{ accountId: 1, percentage: 100 }],
        },
        document: {
          ...document,
          bills: [
            {
              id: "annual",
              cadence: "annual",
              amount: 1000,
              savedAmount: 1000,
              currency: "USD",
              reserveAccountId: 1,
            },
          ],
        },
        accounts: [account],
        onSave() {},
      }),
    ),
  );
  assert.ok(reserved.includes("Already reserved for annual bills: −$1,000.00"));
  assert.ok(reserved.includes("Available starting balance: $100.00"));
});

test("linked column editor shows separate bank balances and saves exclusive native account links", () => {
  const linkedAccounts = [account,
    { ...account, id: 2, name: "Annual savings", mask: "1002", type: "savings", nativeCurrentBalance: 526.59 },
    { ...account, id: 28, name: "Smartly Savings", mask: "1003", type: "savings", nativeCurrentBalance: 500 },
  ];
  const links = { availableUsdAccountId: 1, availablePhpAccountId: null, annualReserveUsdAccountId: 2,
    annualReservePhpAccountId: null, savingsUsdAccountId: 28, savingsPhpAccountId: null };
  let saved;
  const Component = load(filename, { ...require("react"), useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}] }).default;
  const tree = Component({ plan: { ...plan, accountLinks: links }, document, accounts: linkedAccounts, onSave(value) { saved = value; } });
  const html = renderToStaticMarkup(tree);
  assert.ok(plain(html).includes("Current balance: $526.59"));
  assert.ok(plain(html).includes("Current balance: $500.00"));
  assert.ok(!plain(html).includes("Flat starting amount"));
  const annual = find(tree, (node) => node.props?.label === "Annual reserve · USD").props.children;
  assert.deepEqual(annual.props.accounts.map((item) => item.id), [2]);
  assert.equal(annual.props.value, 2);
  tree.props.onSubmit({ preventDefault() {} });
  assert.deepEqual(saved.accountLinks, links);
  assert.equal(saved.openingUsd, 0);
  assert.equal(saved.openingPhp, 0);
  assert.deepEqual(saved.startingAccounts, [{ accountId: 1, percentage: 100 }]);
  assert.deepEqual(saved.accountOpeningBalances, []);
});

test("enabling column links suggests the configured salary, annual reserve and savings destinations", () => {
  let state;
  const Component = load(filename, {
    ...require("react"),
    useState(initial) {
      state ??= typeof initial === "function" ? initial() : initial;
      return [state, (next) => { state = typeof next === "function" ? next(state) : next; }];
    },
  }).default;
  const props = { plan, document: { ...document, salary: { ...document.salary, accountId: 1 },
    bills: [{ cadence: "annual", currency: "USD", reserveAccountId: 2 }],
    allocations: [{ kind: "savings", currency: "USD", accountId: 28 }] },
    accounts: [account, { ...account, id: 2, type: "savings" }, { ...account, id: 28, type: "savings" }], onSave() {} };
  let tree = Component(props);
  const toggle = find(tree, (node) => node.type === "input" && node.props.type === "checkbox" && node.props.checked === false);
  toggle.props.onChange({ target: { checked: true } });
  tree = Component(props);
  assert.equal(state.accountLinks.availableUsdAccountId, 1);
  assert.equal(state.accountLinks.annualReserveUsdAccountId, 2);
  assert.equal(state.accountLinks.savingsUsdAccountId, 28);
  assert.ok(renderToStaticMarkup(tree).includes("Column accounts"));
});
