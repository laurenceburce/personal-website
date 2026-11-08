import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as planner from "../app/lib/financePlanner.mjs";
import * as presentation from "../app/lib/financePlanPresentation.mjs";

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
  if (specifier === "../lib/financePlanPresentation.mjs") return presentation;
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

test("linked account headers and embedded bank records keep one logical reserve row", () => {
  const html = render([row({ id: "reserve:USD:2026-11-06", source: "reserve", description: "Set aside for annual bills",
    completed: true, completionSource: "transaction", amount: 22.89, currency: "USD", usd: -22.89,
    balanceUsd: 854.23, reserveUsd: 526.59, savingsUsd: 500,
    recordedTransactions: [
      { id: "transaction:1", date: "2026-11-06", kind: "expense", amount: 22.89, currency: "USD", description: "Transfer withdrawal", accountName: "Checking" },
      { id: "transaction:2", date: "2026-11-06", kind: "income", amount: 22.89, currency: "USD", description: "Transfer deposit", accountName: "Savings" },
    ],
  })], {
    plan: { ...plan, accountLinks: { availableUsdAccountId: 1, annualReserveUsdAccountId: 2, savingsUsdAccountId: 28 } },
    accounts: [{ id: 1, name: "Checking", mask: "5483" }, { id: 2, name: "Savings", mask: "5742" }, { id: 28, name: "Smartly Savings", mask: "0230" }],
    openingBalances: { usd: 854.23, php: 0 }, openingReserve: { usd: 526.59, php: 0 }, openingSavings: { usd: 500, php: 0 },
  });
  assert.match(html, /Available · USD<small class="fpl-column-account">Checking · •5483/);
  assert.match(html, /Annual reserve · USD<small class="fpl-column-account">Savings · •5742/);
  assert.match(html, /Savings · USD<small class="fpl-column-account">Smartly Savings · •0230/);
  assert.equal((html.match(/class="fpl-row /g) || []).length, 1);
  assert.match(html, /Matched bank records · 2/);
  assert.match(html, /Done · matched transaction/);
});

test("unavailable linked available and reserve balances are never rendered as zero", () => {
  const html = render([row({ balanceUsd: null, reserveUsd: null })], {
    openingBalances: { usd: null, php: 0 }, openingReserve: { usd: null, php: 0 },
  });
  for (const field of ["available-usd", "reserve-usd"]) {
    const cells = [...html.matchAll(new RegExp(`<td data-column="${field}"[^>]*>([\\s\\S]*?)<\\/td>`, "g"))];
    assert.equal(cells.length, 2);
    assert.ok(cells.every((cell) => !cell[1].includes("$0.00") && cell[1].includes("—")));
  }
});

test("annual fees are attributed inside one card payment without another annual charge row", () => {
  const html = render([row({ source: "creditCardDue", description: "Venture X · estimated next statement", currency: "USD",
    estimated: true, amount: 1658.16, estimatedBalance: 1658.16, usd: -1263.16,
    annualBillCoverage: [{ billId: "venture", billName: "Venture X", chargeTransactionId: 2506,
      chargeDate: "2026-11-01", amount: 395, reserveUsed: 395, reserveAccountId: 2 }],
  })]);
  assert.equal((html.match(/class="fpl-row /g) || []).length, 1);
  assert.match(html, /Includes annual bill · \$395\.00/);
  assert.match(html, /Venture X · \$395\.00 charged Nov 1, 2026/);
  assert.match(html, /\$395\.00 covered by its annual reserve/);
  assert.match(html, /paid once with this statement/);
});

test("future annual card charges hold their reserve and never claim an immediate cash payment", () => {
  const html = render([row({ source: "bill", description: "Venture X", annualPayment: true, cardCreditActivity: true,
    amount: 395, grossAmount: 395, reserveHeld: 395, reserveUsed: 0, reserveShortfall: 0, currency: "USD", usd: 0 })]);
  assert.match(html, /Card charge \$395\.00 · \$395\.00 held in annual reserves/);
  assert.match(html, /no separate cash payment on the charge date/);
  assert.doesNotMatch(html, /additional cash/);
});
const plain = (html) => html.replace(/<[^>]*>/g, "");
const cells = (html) =>
  [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, value]) =>
    plain(value),
  );
const findRow = (html, className) =>
  html.match(
    new RegExp(`<tr(?=[^>]*class="[^"]*${className}[^"]*")[^>]*>([\\s\\S]*?)<\\/tr>`),
  )?.[1] || "";
const elements = (node) => {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object") return [];
  if (typeof node.type === "function") return elements(node.type(node.props));
  return [node, ...elements(node.props?.children)];
};
const isCompletionInput = (element) =>
  element.type === "input" && element.props.type === "checkbox" &&
  /^(?:Mark done: |Reopen |Done)/.test(element.props["aria-label"] || "");
const completionCheckbox = (record, props = {}) =>
  elements(
    Ledger({
      plan,
      rows: [record],
      onEdit() {},
      onDelete() {},
      ...props,
    }),
  ).find(isCompletionInput);

test("date groups separate full calendar dates while retaining row order, balances, and upcoming links", () => {
  const dates = ["2026-11-06", "2026-11-06", "2026-11-07", "2026-12-06", "2027-01-06"];
  const records = dates.map((date, index) => row({
    id: `grouped-${index}`,
    date,
    description: `Item ${index}`,
    usd: -(index + 1),
    balanceUsd: 749 - index,
    completed: index < 2,
  }));
  const props = {
    plan: { ...plan, id: "grouping", endDate: "2027-01-06" },
    rows: records,
    today: "2026-11-06",
    onToggleComplete() {},
  };
  const nodes = elements(Ledger(props));
  const bodies = nodes.filter((node) => node.type === "tbody");
  const groups = bodies.filter((node) => node.props.className === "fpl-date-group");
  assert.equal(bodies.length, 5, "starting balances have their own row group");
  assert.deepEqual(groups.map((group) => group.props["data-date"]), [
    "2026-11-06", "2026-11-07", "2026-12-06", "2027-01-06",
  ]);
  assert.deepEqual(groups.map((group) => group.props["aria-label"]), [
    "Nov 6, 2026", "Nov 7, 2026", "Dec 6, 2026", "Jan 6, 2027",
  ]);
  const groupedRows = groups.map((group) => elements(group).filter((node) => node.type === "tr"));
  assert.deepEqual(groupedRows.map((group) => group.length), [2, 1, 1, 1]);
  for (const group of groupedRows) {
    assert.match(group[0].props.className, /\bfpl-date-start\b/);
    assert.ok(group.slice(1).every((record) => /\bfpl-date-repeat\b/.test(record.props.className)));
  }
  const entries = groupedRows.flat();
  assert.deepEqual(entries.map((entry) => entry.props.id), records.map((_, index) => `budget-ledger-grouping-row-${index}`));
  assert.deepEqual(entries.map((entry) => elements(entry).find((node) => node.type === "strong").props.children), records.map((entry) => entry.description));
  assert.deepEqual(entries.map((entry) => elements(entry).find((node) => node.type === "td" && node.props["data-column"] === "flow-usd").props.children), ["-$1.00", "-$2.00", "-$3.00", "-$4.00", "-$5.00"]);
  assert.deepEqual(entries.map((entry) => elements(entry).find((node) => node.type === "td" && node.props["data-column"] === "available-usd").props.children), ["$749.00", "$748.00", "$747.00", "$746.00", "$745.00"]);
  assert.equal(nodes.filter(isCompletionInput).length, records.length);
  assert.equal(nodes.find((node) => node.type === "a" && node.props.children === "Upcoming").props.href, "#budget-ledger-grouping-row-2");
});

test("an empty ledger keeps starting balances without creating an empty date group", () => {
  const nodes = elements(Ledger({ plan, rows: [] }));
  assert.equal(nodes.filter((node) => node.type === "tbody").length, 1);
  assert.equal(nodes.filter((node) => node.type === "tbody" && node.props.className === "fpl-date-group").length, 0);
  assert.equal(nodes.filter((node) => node.type === "tr" && node.props.className?.includes("fpl-opening-row")).length, 1);
});

test("row colors and visible category names survive completion and transaction matching", () => {
  const cases = [
    ["savings", "Savings", { source: "allocation", allocationKind: "savings" }],
    ["bill", "Bills", { source: "bill", completed: true, completionSource: "transaction" }],
    ["transfer", "Transfers", { source: "manual", kind: "transfer" }],
    ["reserve", "Annual reserves", { source: "reserve" }],
    ["income", "Income", { source: "salary", kind: "income" }],
    ["expense", "Expenses", { source: "manual", kind: "expense" }],
    ["income", "Income", { source: "transaction", kind: "income", scheduledSource: "salary", completed: true }],
    ["bill", "Bills", { source: "transaction", scheduledSource: "bill", completed: true }],
    ["savings", "Savings", { source: "transaction", scheduledSource: "allocation", matchedForecast: { source: "allocation", allocationKind: "savings" }, completed: true }],
  ];
  const records = cases.map(([, , fields], index) => row({ ...fields, id: `category-${index}`, description: `Category ${index}` }));
  const nodes = elements(Ledger({ plan, rows: records }));
  const renderedRows = nodes.filter((node) => node.type === "tr" && node.props.id);
  assert.equal(renderedRows.length, records.length);
  for (let index = 0; index < cases.length; index += 1) {
    const [key, label] = cases[index];
    assert.match(renderedRows[index].props.className, new RegExp(`\\bfpl-category-${key}\\b`));
    const pill = elements(renderedRows[index]).find((node) => node.type === "span" && node.props.className === "fpl-category-label");
    assert.equal(pill?.props.children, label);
  }
  const legend = nodes.find((node) => node.type === "ul" && node.props.className === "fpl-category-legend");
  assert.equal(legend?.props["aria-label"], "Row colors");
  const legendHtml = renderToStaticMarkup(legend);
  for (const label of ["Savings", "Bills", "Transfers", "Annual reserves", "Income", "Expenses"]) {
    assert.ok(plain(legendHtml).includes(label), label);
  }
});

test("statement dues explain the full balance and payments without occurrence editing", () => {
  const html = render([row({
    id: "creditCardDue:7:2026-11-15",
    source: "creditCardDue",
    description: "Travel card statement",
    date: "2026-11-15",
    currency: "USD",
    statementBalance: 500,
    paidAmount: 125,
    amount: 375,
    usd: -375,
    balanceUsd: 375,
    editable: false,
  })], { onEditOccurrence() {} });
  assert.match(plain(html), /Credit card statement dueStatement balance \$500\.00 · Paid \$125\.00 · Remaining \$375\.00/);
  assert.ok(!html.includes("Edit this occurrence"));
});

test("next-cycle estimates identify unbilled balance without claiming a confirmed statement", () => {
  for (const estimateDateIsReported of [true, false]) {
    const html = render([row({
      id: "creditCardDue:32:2026-12-18", source: "creditCardDue", estimated: true,
      description: "Venture X · estimated next payment", date: "2026-12-18", currency: "USD",
      statementBalance: null, estimatedBalance: 1380.16, amount: 1380.16, usd: -1380.16,
      estimateDateIsReported, editable: false,
    })]);
    assert.match(plain(html), /Estimated next card payment/);
    assert.match(plain(html), /Unbilled balance \$1,380\.16/);
    assert.match(html, /class="fpl-estimate-tag">Estimated<\/span>/);
    assert.match(plain(html), estimateDateIsReported
      ? /Uses the bank’s next payment date/
      : /Payment date estimated from the monthly billing cycle/);
    assert.ok(!plain(html).includes("Statement balance $0.00"));
    assert.ok(!html.includes("Edit this occurrence"));
  }
});

test("automatic card payments disclose their payment date separately from the original due date", () => {
  for (const estimated of [false, true]) {
    const html = render([row({
      id: "creditCardDue:7:2026-11-20", source: "creditCardDue", description: "Travel card automatic payment",
      date: "2026-11-13", dueDate: "2026-11-20", autopayEnabled: true, autopayDaysBeforeDue: 7,
      estimated, estimateDateIsReported: !estimated, amount: 200, statementBalance: estimated ? null : 200,
      estimatedBalance: estimated ? 200 : undefined, currency: "USD", usd: -200,
    })]);
    assert.match(plain(html), /Automatic payment Nov 13, 2026 · (?:Estimated due|Due) Nov 20, 2026 · 7 days before due/);
    assert.match(html, /Nov 13/);
    if (estimated) {
      assert.match(plain(html), /Automatic payment is based on the estimated monthly billing cycle/);
      assert.doesNotMatch(plain(html), /Uses the bank’s next payment date/);
    }
  }
});

test("same-day autopay clearly identifies an unchanged due date", () => {
  const html = render([row({ source: "creditCardDue", date: "2026-11-20", dueDate: "2026-11-20",
    autopayEnabled: true, autopayDaysBeforeDue: 0, currency: "USD", amount: 200, statementBalance: 200 })]);
  assert.match(plain(html), /Automatic payment Nov 20, 2026 · Due Nov 20, 2026 · On the due date/);
});

test("estimated dues explain the share already covered by planned payments", () => {
  const html = render([row({ source: "creditCardDue", estimated: true, currency: "USD",
    estimatedBalance: 500, plannedPaymentAmount: 125, amount: 375, usd: -375 })]);
  assert.match(plain(html), /Unbilled balance \$500\.00 · Planned payments \$125\.00 · Remaining \$375\.00/);
});

test("card activity and posted statement payments identify their cash flow treatment", () => {
  const html = render([
    row({ source: "transaction", cardCreditActivity: true, description: "Card purchase" }),
    row({ id: "payment", source: "transaction", scheduledSource: "creditCardDue", description: "Card payment" }),
  ]);
  assert.match(plain(html), /Changes the card balance\. Cash payments are shown with statement dues\./);
  assert.match(plain(html), /Recorded against credit card statement payment/);
});

test("planned card payments explain remaining dues without marking the statement paid", () => {
  const html = render([
    row({ id: "transfer", source: "manual", kind: "transfer", creditCardPaymentFor: 7, usd: -125 }),
    row({ source: "creditCardDue", statementBalance: 500, plannedPaymentAmount: 125, amount: 375, currency: "USD", usd: -375 }),
  ]);
  assert.match(plain(html), /Planned credit card payment/);
  assert.match(plain(html), /Pays the card from available funds/);
  assert.match(plain(html), /Statement balance \$500\.00 · Planned payments \$125\.00 · Remaining \$375\.00/);
  assert.ok(!plain(html).includes("Done · bank payment reported"));
});

test("provider-reported payments use an honest completion label without loaded transaction matches", () => {
  const html = render([row({ source: "creditCardDue", currency: "USD", statementBalance: 200, paidAmount: 200,
    amount: 0, completed: true, completionSource: "transaction", matchedTransactionIds: [] })]);
  assert.match(plain(html), /Done · bank payment reported/);
});

test("opening balances keep annual reserve pockets distinct from available USD and PHP", () => {
  const html = render();
  const opening = cells(findRow(html, "fpl-opening-row"));
  assert.equal(opening.length, 12);
  assert.equal(opening[4], "$750.00");
  assert.equal(opening[5], "₱500.00");
  assert.equal(opening[6], "$200.00");
  assert.equal(opening[7], "₱12,600.00");
  assert.ok(html.includes("Available · USD"));
  assert.ok(html.includes("Annual reserve · PHP"));
  assert.match(html, /<th[^>]*scope="col"[^>]*>Status<\/th>/);
  assert.ok(html.includes('role="region"'));
  assert.ok(html.includes('tabindex="0"'));
});

test("compact phone rows retain every money value and one set of row controls", () => {
  const record = row({
    id: "allocation:saving:2026-11-06",
    description: "Savings · A long account purpose that can wrap on a phone",
    source: "allocation",
    editable: true,
    usd: -500,
    balanceUsd: 250,
    savingsUsd: 746.73,
    savingsPhp: 0,
  });
  let edited, completed;
  const tree = Ledger({
    plan,
    rows: [record],
    onEditOccurrence(value) { edited = value; },
    onToggleComplete(value) { completed = value; },
  });
  const nodes = elements(tree);
  assert.equal(nodes.filter((node) => node.type === "table").length, 1);
  assert.equal(nodes.filter(isCompletionInput).length, 1);
  const edit = nodes.filter((node) => node.type === "button" && node.props["aria-label"]?.startsWith("Edit this occurrence:"));
  assert.equal(edit.length, 1);
  edit[0].props.onClick();
  assert.equal(edited, record);
  nodes.find(isCompletionInput).props.onChange();
  assert.equal(completed, record);
  for (const label of ["Flow · USD", "Flow · PHP", "Available · USD", "Available · PHP", "Annual reserve · USD", "Annual reserve · PHP", "Savings · USD", "Savings · PHP"])
    assert.equal(nodes.filter((node) => node.type === "td" && node.props["data-label"] === label).length, 2, label);
  const html = renderToStaticMarkup(tree);
  assert.match(html, /<thead>/);
  assert.match(html, /<th[^>]*scope="col"[^>]*>Flow · USD<\/th>/);
  assert.equal(cells(findRow(html, "fpl-row-allocation"))[8], "$746.73");
});

test("compact row details retain annual payment explanations and account disclosures", () => {
  const html = render([row({
    annualPayment: true,
    currency: "USD",
    amount: 395,
    grossAmount: 395,
    reserveUsed: 100,
    reserveShortfall: 295,
    usd: -295,
    accountNames: ["Checking · •5483", "Annual savings · •5742"],
    accountMovements: [{ accountId: 1, accountName: "Checking · •5483", amount: -395, currency: "USD" }],
  })]);
  const card = findRow(html, "fpl-row-bill");
  assert.ok(card.indexOf('class="fpl-annual-payment-detail"') < card.indexOf('<details class="fpl-account-movements">'));
  assert.match(card, /<details class="fpl-account-movements"><summary>Account movements<\/summary>/);
  assert.match(card, /Accounts: Checking/);
  assert.doesNotMatch(card, /<details[^>]*open/);
  assert.match(html, /<details class="fpl-legend"><summary>How balances work<\/summary>/);
});

test("optional phone columns retain zero, future, and unknown money values in the table", () => {
  const initial = { openingReserve: { usd: 0, php: 0 }, openingSavings: { usd: 0, php: 0 } };
  const base = row({ reserveUsd: 100, reservePhp: 0, savingsUsd: 250, savingsPhp: 0 });
  const cases = [
    { rows: [base] },
    { rows: [base, row({ id: "later", date: "2026-11-20", reserveUsd: 100, reservePhp: 25, savingsUsd: 250, savingsPhp: 50 })] },
    { rows: [{ ...base, reservePhp: null, savingsPhp: null }] },
  ];
  for (const fixture of cases) {
    const nodes = elements(Ledger({ plan, rows: fixture.rows, ...initial }));
    for (const label of ["Annual reserve · PHP", "Savings · PHP"]) {
      const moneyCells = nodes.filter((node) => node.type === "td" && node.props["data-label"] === label);
      assert.equal(moneyCells.length, fixture.rows.length + 1);
      assert.ok(moneyCells.every((node) => node.props["data-column"]), label);
    }
    // Column selection changes presentation without dropping any financial cells.
    const html = render(fixture.rows, initial);
    assert.equal(cells(findRow(html, "fpl-opening-row")).length, 12);
    assert.equal(nodes.filter(isCompletionInput).length, fixture.rows.length);
  }
  const unknownOpening = elements(Ledger({ plan, rows: [base], ...initial, openingSavings: { usd: 0, php: null } }));
  assert.ok(unknownOpening.filter((node) => node.type === "td" && node.props["data-label"] === "Savings · PHP").every((node) => node.props["data-column"] === "savings-php"));
});

test("running savings show both native currencies separately from available funds and annual reserves", () => {
  const html = render(
    [
      row({
        id: "allocation:savings:2026-11-06",
        source: "allocation",
        description: "Savings · Travel",
        usd: -250,
        balanceUsd: 500,
        savingsUsd: 496.73,
        savingsPhp: 2750,
      }),
    ],
    { openingSavings: { usd: 246.73, php: 2500 } },
  );
  const opening = cells(findRow(html, "fpl-opening-row"));
  const saved = cells(findRow(html, "fpl-row-allocation"));
  assert.equal(opening[8], "$246.73");
  assert.equal(opening[9], "₱2,500.00");
  assert.equal(saved[8], "$496.73");
  assert.equal(saved[9], "₱2,750.00");
  assert.equal(saved[4], "$500.00");
  assert.equal(saved[6], "$200.00");
  assert.equal(saved[7], "₱12,600.00");
  assert.match(html, /Savings · USD/);
  assert.match(html, /Savings · PHP/);
  assert.match(plain(html), /excluding annual reserves/);
  assert.match(plain(html), /Unassigned savings accumulate separately/);
});

test("unknown savings balances stay unavailable rather than displaying a zero balance", () => {
  const html = render(
    [row({ savingsUsd: null, savingsPhp: -25 })],
    { openingSavings: { usd: null, php: 0 } },
  );
  const opening = cells(findRow(html, "fpl-opening-row"));
  const record = cells(findRow(html, "fpl-row-bill"));
  assert.equal(opening[8], "—");
  assert.equal(opening[9], "₱0.00");
  assert.equal(record[8], "—");
  assert.equal(record[9], "-₱25.00");
  assert.equal((html.match(/aria-label="Savings balance unavailable in USD"/g) || []).length, 2);
  assert.match(html, /class="fpl-savings-balance fp-negative">-₱25\.00/);
});

test("scheduled rows edit only their occurrence and overridden rows offer a reset", () => {
  for (const source of ["salary", "bill", "allocation", "reserve"]) {
    const record = row({
      id: `${source}:example:2026-11-06`,
      source,
      description: "Savings · Travel",
      editable: true,
      isOverride: true,
      originalAmount: 500,
      amount: 250,
    });
    const edits = [];
    const resets = [];
    const tree = elements(
      Ledger({
        plan,
        rows: [record],
        onEditOccurrence: (value) => edits.push(value),
        onResetOccurrence: (value) => resets.push(value),
      }),
    );
    const edit = tree.find((element) => element.props["aria-label"] === "Edit this occurrence: Savings · Travel");
    const reset = tree.find((element) => element.props["aria-label"] === "Reset this occurrence: Savings · Travel");
    assert.equal(edit.props.type, "button");
    assert.equal(edit.props.disabled, false);
    assert.equal(reset.props.type, "button");
    assert.equal(reset.props.disabled, false);
    edit.props.onClick();
    reset.props.onClick();
    assert.deepEqual(edits, [record]);
    assert.deepEqual(resets, [record]);
    const html = render([record]);
    assert.match(html, /Edited for this plan/);
    assert.doesNotMatch(html, /aria-label="Delete Savings/);
  }
  const untouched = render([row({ editable: true, source: "allocation" })]);
  assert.doesNotMatch(untouched, /Reset this occurrence/);
  assert.doesNotMatch(untouched, /Edited for this plan/);
});

test("occurrence controls stay disabled during saves and imported rows never expose forecast editing", () => {
  const record = row({ editable: true, isOverride: true });
  for (const props of [{}, { busy: true, onEditOccurrence() { throw Error("Must not edit while busy"); }, onResetOccurrence() { throw Error("Must not reset while busy"); } }]) {
    const controls = elements(Ledger({ plan, rows: [record], ...props })).filter(
      (element) => element.type === "button" && /^(?:Edit this occurrence:|Reset this occurrence:)/.test(element.props["aria-label"] || ""),
    );
    assert.equal(controls.length, 2);
    for (const control of controls) {
      assert.equal(control.props.disabled, true);
      control.props.onClick();
    }
  }
  const html = render([row({ source: "transaction", editable: true, isOverride: true })]);
  assert.doesNotMatch(html, /Edit this occurrence/);
  assert.doesNotMatch(html, /Reset this occurrence/);
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

test("manual controls require original entries and noneditable forecast rows remain read-only", () => {
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

test("account transfers show both native account movements while aggregate available funds stay unchanged", () => {
  const html = render([
    row({
      id: "savings-transfer",
      source: "manual",
      kind: "transfer",
      description: "Move payday savings",
      accountNames: ["Checking · •1234", "Savings · •3456"],
      accountMovements: [
        {
          accountId: 1,
          accountName: "Checking · •1234",
          amount: -500,
          currency: "USD",
          kind: "transfer",
          balanceDelta: -500,
        },
        {
          accountId: 2,
          accountName: "Savings · •3456",
          amount: 500,
          currency: "USD",
          kind: "transfer",
          balanceDelta: 500,
        },
      ],
    }),
  ]);
  const cellsInRow = cells(findRow(html, "fpl-row-manual"));
  assert.equal(cellsInRow.length, 12);
  assert.equal(cellsInRow[2], "—");
  assert.equal(cellsInRow[4], "$750.00");
  assert.match(html, /Planned account transfer/);
  assert.match(html, /<summary>Account movements<\/summary>/);
  assert.match(plain(html), /Checking · •1234: -\$500\.00/);
  assert.match(plain(html), /Savings · •3456: \+\$500\.00/);
});

test("credit account movements retain cash direction and explain the opposite balance-owed change", () => {
  const html = render([
    row({
      description: "Credit purchase",
      accountNames: ["Credit card · •5678"],
      accountMovements: [
        {
          accountId: 3,
          accountName: "Credit card · •5678",
          amount: -25,
          currency: "USD",
          kind: "payment",
          balanceDelta: 25,
        },
      ],
    }),
  ]);
  assert.match(
    plain(html),
    /Credit card · •5678: -\$25\.00 · balance owed \+\$25\.00/,
  );
});

test("earmarking an annual reserve inside one account records no bank movement", () => {
  const html = render([
    row({
      source: "reserve",
      kind: "reserve",
      description: "Set aside for annual bills",
      usd: -20,
      reserveDeltaUsd: 20,
      reserveUsd: 220,
      accountNames: ["Annual savings · •2345"],
      accountMovements: [],
      reserveAllocations: [
        { billId: "fee", amount: 20, sourceAccountId: 2, reserveAccountId: 2 },
      ],
    }),
  ]);
  assert.match(
    html,
    /Earmarked within the same account; bank balance stays unchanged/,
  );
  assert.doesNotMatch(html, /<summary>Account movements<\/summary>/);
  assert.match(plain(html), /-\$20\.00/);
  assert.match(plain(html), /\+\$20\.00 set aside/);
});

test("annual account movements keep the gross bill and reserve coverage visible", () => {
  const html = render([
    row({
      annualPayment: true,
      description: "Venture X",
      currency: "USD",
      amount: 395,
      grossAmount: 395,
      reserveUsed: 100,
      reserveShortfall: 295,
      usd: -295,
      accountNames: ["Annual savings · •2345", "Checking · •1234"],
      accountMovements: [
        {
          accountId: 2,
          accountName: "Annual savings · •2345",
          amount: -100,
          currency: "USD",
          kind: "transfer",
          label: "Use annual reserve · Venture X",
          balanceDelta: -100,
        },
        {
          accountId: 1,
          accountName: "Checking · •1234",
          amount: 100,
          currency: "USD",
          kind: "transfer",
          label: "Use annual reserve · Venture X",
          balanceDelta: 100,
        },
        {
          accountId: 1,
          accountName: "Checking · •1234",
          amount: -395,
          currency: "USD",
          kind: "payment",
          label: "Venture X",
          balanceDelta: -395,
        },
      ],
    }),
  ]);
  assert.match(
    html,
    /Total bill \$395\.00 · \$100\.00 from reserves · \$295\.00 additional cash/,
  );
  assert.match(plain(html), /Annual savings · •2345: -\$100\.00/);
  assert.match(plain(html), /Checking · •1234: \+\$100\.00/);
  assert.match(plain(html), /Checking · •1234: -\$395\.00/);
});

test("live account percentages and flat amounts resolve into the displayed starting balances", () => {
  const livePlan = {
    ...plan,
    openingUsd: 25,
    openingPhp: 50,
    startingAccounts: [
      { accountId: 1, percentage: 80 },
      { accountId: 2, percentage: 25 },
    ],
  };
  const accounts = [
    {
      id: 1,
      name: "Checking",
      mask: "5483",
      currency: "USD",
      type: "checking",
      nativeCurrentBalance: 100,
      nativeAvailableBalance: 900,
    },
    {
      id: 2,
      name: "Peso savings",
      mask: "7777",
      currency: "PHP",
      type: "savings",
      nativeCurrentBalance: 2000,
    },
  ];
  const display = (bankAccounts) =>
    render([], {
      plan: livePlan,
      openingBalances: planner.getPlanOpening(livePlan, bankAccounts),
    });
  const html = display(accounts);
  const opening = cells(findRow(html, "fpl-opening-row"));
  assert.equal(opening[4], "$105.00");
  assert.equal(opening[5], "₱550.00");
  assert.equal(opening[6], "$200.00");
  assert.match(plain(html), /Flat starting balance: \$25\.00 · ₱50\.00/);
  assert.match(
    plain(html),
    /80% of Checking · ••5483: \$80\.00Current balance \$100\.00/,
  );
  assert.match(
    plain(html),
    /25% of Peso savings · ••7777: ₱500\.00Current balance ₱2,000\.00/,
  );
  const refreshed = cells(
    findRow(
      display([{ ...accounts[0], nativeCurrentBalance: 150 }, accounts[1]]),
      "fpl-opening-row",
    ),
  );
  assert.equal(refreshed[4], "$145.00");
  assert.equal(refreshed[5], "₱550.00");
});

test("unavailable live account balances display the exclusion warning and preserve only usable funds", () => {
  const livePlan = {
    ...plan,
    startingAccounts: [{ accountId: 9, percentage: 80 }],
  };
  const openingBalances = planner.getPlanOpening(livePlan, [
    {
      id: 9,
      name: "Disconnected savings",
      currency: "USD",
      type: "savings",
      nativeCurrentBalance: null,
    },
  ]);
  const html = render([], { plan: livePlan, openingBalances });
  assert.match(html, /role="status"/);
  assert.match(
    plain(html),
    /Disconnected savings: a current bank balance is unavailable/,
  );
  assert.equal(cells(findRow(html, "fpl-opening-row"))[4], "$750.00");
  assert.doesNotMatch(html, /NaN|Infinity|undefined/);
});

test("a live account contribution explains annual reserves excluded from spendable starting funds", () => {
  const livePlan = {
    ...plan,
    openingUsd: 25,
    openingReserveUsd: 0,
    startingAccounts: [{ accountId: 1, percentage: 80 }],
  };
  const document = {
    bills: [
      {
        id: "fee",
        cadence: "annual",
        currency: "USD",
        amount: 100,
        savedAmount: 60,
        reserveAccountId: 1,
      },
    ],
  };
  const openingBalances = planner.getPlanOpening(
    livePlan,
    [
      {
        id: 1,
        name: "Annual savings",
        currency: "USD",
        type: "savings",
        nativeCurrentBalance: 100,
      },
    ],
    document,
  );
  const html = render([], {
    plan: livePlan,
    openingBalances,
    openingReserve: planner.getAnnualReserveOpening(livePlan, document),
  });
  const opening = cells(findRow(html, "fpl-opening-row"));
  assert.equal(opening[4], "$45.00");
  assert.equal(opening[6], "$60.00");
  assert.match(plain(html), /\$60\.00 already reserved · \$20\.00 available/);
});

test("manual completion controls preserve the stable forecast key and allow reopening", () => {
  let toggled;
  const pending = row({
    id: "bill:rent:2026-11-06",
    completionKey: "bill:rent:2026-11-06",
    description: "Rent",
    completed: false,
    completionSource: null,
  });
  const input = completionCheckbox(pending, {
    onToggleComplete: (value) => {
      toggled = value;
    },
  });
  assert.equal(input.props.checked, false);
  assert.equal(input.props.disabled, false);
  assert.equal(input.props["aria-label"], "Mark done: Rent");
  input.props.onChange();
  assert.equal(toggled, pending);
  assert.equal(toggled.completionKey, "bill:rent:2026-11-06");
  const done = {
    ...pending,
    completed: true,
    completionSource: "manual",
    completedAt: "2026-11-06T12:00:00.000Z",
  };
  const reopen = completionCheckbox(done, {
    onToggleComplete: (value) => {
      toggled = value;
    },
  });
  assert.equal(reopen.props.checked, true);
  assert.equal(reopen.props.disabled, false);
  assert.equal(reopen.props["aria-label"], "Reopen Rent");
  reopen.props.onChange();
  assert.equal(toggled, done);
  const html = render([done], { onToggleComplete() {} });
  assert.match(html, /fpl-row-completed/);
  assert.match(plain(html), /DoneMarked manually/);
});

test("completion saves disable manual toggles and readonly renders cannot mutate progress", () => {
  let toggles = 0;
  const onToggleComplete = () => {
    toggles++;
  };
  const record = row({ completionKey: "bill:fee:2026-11-06" });
  const saving = completionCheckbox(record, { busy: true, onToggleComplete });
  assert.equal(saving.props.disabled, true);
  saving.props.onChange();
  const readonly = completionCheckbox(record);
  assert.equal(readonly.props.disabled, true);
  readonly.props.onChange();
  assert.equal(toggles, 0);
});

test("posted matched transactions show automatic done status without a manual undo", () => {
  const actual = row({
    id: "transaction:99",
    source: "transaction",
    description: "Rent paid",
    completed: true,
    completionKey: "bill:rent:2026-11-06",
    completionSource: "transaction",
    matchedTransactionIds: [99],
    matchedForecast: { id: "bill:rent:2026-11-06", source: "bill" },
    scheduledSource: "bill",
  });
  let toggled = false;
  const input = completionCheckbox(actual, {
    onToggleComplete: () => {
      toggled = true;
    },
  });
  assert.equal(input.props.checked, true);
  assert.equal(input.props.disabled, true);
  input.props.onChange();
  assert.equal(toggled, false);
  const html = render([actual], { onToggleComplete() {} });
  assert.match(plain(html), /Done · matched transaction/);
  assert.match(html, /aria-label="Done · matched transaction: Rent paid"/);
  assert.doesNotMatch(html, /aria-label="Reopen /);
  assert.match(
    plain(
      render([{ ...actual, matchedForecast: null, scheduledSource: null }]),
    ),
    /Done · recorded transaction/,
  );
  const matchedAllocation = {
    ...actual,
    source: "allocation",
    matchedForecast: null,
    scheduledSource: null,
  };
  assert.match(
    plain(render([matchedAllocation])),
    /Done · matched transaction/,
  );
});

test("future or pending transaction rows remain open unless completion metadata says otherwise", () => {
  for (const metadata of [{ scheduled: true }, { pending: true }]) {
    const record = row({
      source: "transaction",
      ...metadata,
      completed: false,
      completionSource: null,
    });
    const input = completionCheckbox(record, { onToggleComplete() {} });
    assert.equal(input.props.checked, false);
    assert.equal(input.props.disabled, false);
    assert.match(plain(render([record], { onToggleComplete() {} })), /To do/);
    assert.doesNotMatch(
      plain(render([record])),
      /Done · (matched|recorded) transaction/,
    );
  }
});

test("marking an annual payment done leaves every cash and reserve value unchanged", () => {
  const payment = row({
    annualPayment: true,
    currency: "USD",
    grossAmount: 395,
    reserveUsed: 100,
    reserveShortfall: 295,
    usd: -295,
    balanceUsd: 455,
    reserveUsd: 0,
    reserveDeltaUsd: -100,
  });
  const open = cells(findRow(render([payment]), "fpl-row-bill"));
  const done = cells(
    findRow(
      render([{ ...payment, completed: true, completionSource: "manual" }]),
      "fpl-row-bill",
    ),
  );
  assert.deepEqual(done.slice(0, 8), open.slice(0, 8));
  assert.match(done[10], /DoneMarked manually/);
  assert.match(
    plain(render([payment])),
    /it does not create a transaction or change its planned amount/,
  );
});

test("a historical conversion keeps both flow amounts visible and identifies only its live-account side", () => {
  const document = { salary: {}, bills: [], allocations: [] };
  const accounts = [
    { id: 1, currency: "USD", type: "checking", nativeCurrentBalance: 90 },
    { id: 2, currency: "PHP", type: "checking", nativeCurrentBalance: 630 },
  ];
  for (const accountId of [1, 2]) {
    const livePlan = {
      ...plan,
      startDate: "2026-11-01",
      endDate: "2026-11-01",
      openingUsd: 0,
      openingPhp: 0,
      includeIncome: false,
      startingAccounts: [{ accountId, percentage: 100 }],
      entries: [
        {
          id: "conversion",
          date: "2026-11-01",
          kind: "conversion",
          description: "Convert funds",
          amount: 10,
          currency: "USD",
          fromAccountId: 1,
          toAccountId: 2,
        },
      ],
    };
    const records = planner.buildPlanRows(livePlan, document, 63, {
      accounts,
      today: "2026-11-02",
    });
    const html = render(records, { plan: livePlan, onToggleComplete() {} });
    const conversion = cells(findRow(html, "fpl-row-manual"));
    assert.equal(conversion[2], "-$10.00");
    assert.equal(conversion[3], "+₱630.00");
    assert.equal(conversion[4], accountId === 1 ? "$90.00" : "-$10.00");
    assert.equal(conversion[5], "₱630.00");
    assert.equal(conversion[10], "To do");
    assert.match(
      conversion[1],
      accountId === 1
        ? /Already included in the live starting balance · USD -\$10\.00/
        : /Already included in the live starting balance · PHP \+₱630\.00/,
    );
    assert.doesNotMatch(
      conversion[1],
      accountId === 1
        ? /live starting balance · PHP/
        : /live starting balance · USD/,
    );
  }
});

test("matched conversions explain recorded cash movements while preserving task flows and automatic completion", () => {
  const conversionPlan = {
    ...plan,
    startDate: "2026-11-02",
    endDate: "2026-11-02",
    openingUsd: 100,
    openingPhp: 0,
    includeIncome: false,
    entries: [
      {
        id: "conversion",
        date: "2026-11-02",
        kind: "conversion",
        description: "Convert funds",
        amount: 10,
        currency: "USD",
        fromAccountId: 1,
        toAccountId: 2,
      },
    ],
  };
  const records = planner.buildPlanRows(
    conversionPlan,
    { salary: {}, bills: [], allocations: [] },
    63,
    {
      today: "2026-11-02",
      transactions: [
        {
          id: 1,
          date: "2026-11-02",
          kind: "expense",
          amount: 10,
          currency: "USD",
          category: "Transfer",
          accountId: 1,
        },
        {
          id: 2,
          date: "2026-11-02",
          kind: "income",
          amount: 630,
          currency: "PHP",
          category: "Transfer",
          accountId: 2,
        },
      ],
    },
  );
  const html = render(records, { plan: conversionPlan, onToggleComplete() {} });
  const conversion = cells(findRow(html, "fpl-row-manual"));
  const task = records.find((record) => record.source === "manual");
  assert.equal(conversion[2], "-$10.00");
  assert.equal(conversion[3], "+₱630.00");
  assert.equal(conversion[4], planner.money(task.balanceUsd));
  assert.equal(conversion[5], planner.money(task.balancePhp, "PHP"));
  assert.match(
    conversion[1],
    /Cash movement shown in matched recorded transactions/,
  );
  assert.match(conversion[10], /Done · matched transaction/);
  assert.equal(records.at(-1).balanceUsd, 90);
  assert.equal(records.at(-1).balancePhp, 630);
});

test("historical reserve movements retain their planned flow without showing an unapplied set-aside or use", () => {
  for (const currency of ["USD", "PHP"]) {
    for (const delta of [40, -40]) {
      const record = row({
        source: "reserve",
        description: "Historical annual reserve",
        currency,
        usd: currency === "USD" ? -delta : 0,
        php: currency === "PHP" ? -delta : 0,
        balanceAppliedUsd: 0,
        balanceAppliedPhp: 0,
        reflectedInStartingBalance: true,
        reserveDeltaUsd: currency === "USD" ? delta : 0,
        reserveDeltaPhp: currency === "PHP" ? delta : 0,
        reserveAppliedUsd: 0,
        reserveAppliedPhp: 0,
      });
      const html = render([record]);
      const reserve = cells(findRow(html, "fpl-row-reserve"));
      assert.equal(
        reserve[currency === "USD" ? 2 : 3],
        `${delta < 0 ? "+" : ""}${planner.money(-delta, currency)}`,
      );
      assert.equal(reserve[4], "$750.00");
      assert.equal(reserve[5], "₱500.00");
      assert.equal(reserve[6], "$200.00");
      assert.equal(reserve[7], "₱12,600.00");
      assert.match(
        reserve[1],
        /Historical reserve movement is already included in current earmarks/,
      );
      assert.doesNotMatch(reserve[6] + reserve[7], /set aside|used/);
    }
  }
});

const hasClass = (node, name) =>
  (` ${node.props?.className || ""} `).includes(` ${name} `);

test("phone column controls default to flows and balances and support native reset", () => {
  const nodes = elements(Ledger({ plan, rows: [row()] }));
  const form = nodes.find((node) => node.type === "form" && hasClass(node, "fpl-display-controls"));
  assert.ok(form, "Column choices belong to a native resettable form");
  const controls = elements(form);
  const expected = {
    "fpl-show-flow": true,
    "fpl-show-available": true,
    "fpl-show-reserves": false,
    "fpl-show-savings": false,
    "fpl-show-status": false,
    "fpl-show-actions": true,
  };
  assert.equal(controls.filter((node) => node.type === "input" && node.props.type === "checkbox").length, 6);
  for (const [name, checked] of Object.entries(expected)) {
    const input = controls.find((node) => node.type === "input" && hasClass(node, name));
    assert.ok(input, name);
    assert.equal(Boolean(input.props.defaultChecked), checked, name);
    assert.equal(input.props.checked, undefined, "Native reset restores each initial choice");
    const label = controls.find((node) => node.type === "label" && elements(node).includes(input));
    assert.ok(label && plain(renderToStaticMarkup(label)).trim(), `${name} has a visible label`);
  }
  const currency = controls.filter((node) => node.type === "input" && node.props.type === "radio");
  assert.equal(currency.length, 3);
  assert.equal(new Set(currency.map((node) => node.props.name)).size, 1);
  assert.ok(currency.every((node) => node.props.name));
  assert.equal(currency.filter((node) => node.props.defaultChecked).length, 1);
  assert.ok(currency.find((node) => node.props.defaultChecked && hasClass(node, "fpl-currency-both")));
  assert.ok(currency.find((node) => hasClass(node, "fpl-currency-usd")));
  assert.ok(currency.find((node) => hasClass(node, "fpl-currency-php")));
  const reset = controls.find((node) => node.type === "button" && node.props.type === "reset");
  assert.ok(reset);
  assert.equal(plain(renderToStaticMarkup(reset)), "Reset columns");
});

test("recurring rows distinguish editing one occurrence from editing or deleting the series", () => {
  const entry = { id: "coffee", date: "2026-11-06", description: "Coffee", recurrence: "daily", amount: 5, currency: "USD", kind: "expense" };
  const occurrence = row({ id: "entry:coffee:2026-11-07", entryId: "coffee", source: "manual", recurring: true,
    recurrence: "daily", editable: true, description: "Coffee", date: "2026-11-07", amount: 5, currency: "USD" });
  let editedOccurrence, editedSeries, deletedSeries;
  const nodes = elements(Ledger({
    plan: { ...plan, entries: [entry] }, rows: [occurrence],
    onEditOccurrence(value) { editedOccurrence = value; },
    onEdit(value) { editedSeries = value; },
    onDelete(value) { deletedSeries = value; },
  }));
  nodes.find((node) => node.type === "button" && node.props["aria-label"] === "Edit this occurrence: Coffee").props.onClick();
  nodes.find((node) => node.type === "button" && node.props["aria-label"] === "Edit recurring entry: Coffee").props.onClick();
  nodes.find((node) => node.type === "button" && node.props["aria-label"] === "Delete recurring entry: Coffee").props.onClick();
  assert.equal(editedOccurrence, occurrence);
  assert.equal(editedSeries, entry);
  assert.equal(deletedSeries, entry);
  assert.match(plain(renderToStaticMarkup(Ledger({ plan: { ...plan, entries: [entry] }, rows: [occurrence] }))), /Daily plan entry/);
});

test("all hideable column headers match each opening and budget-row cell", () => {
  const records = [row({ id: "usd", usd: -20 }), row({ id: "php", php: -1500, savingsPhp: null })];
  const nodes = elements(Ledger({ plan, rows: records }));
  const columns = [
    "date", "description", "flow-usd", "flow-php", "available-usd", "available-php",
    "reserve-usd", "reserve-php", "savings-usd", "savings-php", "status", "actions",
  ];
  assert.equal(nodes.filter((node) => node.type === "table").length, 1);
  assert.equal(nodes.filter((node) => node.type === "tr").length, records.length + 2);
  for (const column of columns) {
    const header = nodes.filter((node) => node.type === "th" && node.props["data-column"] === column);
    assert.equal(header.length, 1, `${column} has one matching header`);
    assert.equal(header[0].props.scope, "col");
    assert.equal(nodes.filter((node) => node.type === "td" && node.props["data-column"] === column).length,
      records.length + 1, `${column} stays aligned when hidden or shown`);
  }
  assert.equal(nodes.filter(isCompletionInput).length, records.length);
  const html = render(records);
  assert.match(html, /-\$20\.00/);
  assert.match(html, /-₱1,500\.00/);
  assert.match(html, /Savings balance unavailable in PHP/);
});

test("compact rows expose full descriptions and financial explanations in closed details", () => {
  const description = "A long annual subscription name that remains readable when its item cell is compact";
  const nodes = elements(Ledger({ plan, rows: [row({
    description, annualPayment: true, amount: 395, grossAmount: 395, currency: "USD",
    reserveUsed: 100, reserveShortfall: 295, usd: -295,
  })] }));
  const detail = nodes.find((node) => node.type === "details" && hasClass(node, "fpl-row-details"));
  assert.ok(detail);
  assert.ok(!detail.props.open);
  const summary = elements(detail).find((node) => node.type === "summary");
  assert.equal(summary.props["aria-label"], `Details for ${description}`);
  const html = renderToStaticMarkup(detail);
  assert.ok(plain(html).includes(description));
  assert.match(plain(html), /Total bill \$395\.00 · \$100\.00 from reserves · \$295\.00 additional cash/);
  assert.equal(nodes.filter((node) => node.type === "time" && hasClass(node, "fpl-mobile-date") && node.props.dateTime === "2026-11-06").length, 2);
});

test("phone scroll buttons move only the ledger scrollport in either direction", () => {
  const nodes = elements(Ledger({ plan, rows: [row()] }));
  const buttons = nodes.filter((node) => node.type === "button" && /^Scroll budget columns (left|right)$/.test(node.props["aria-label"] || ""));
  assert.equal(buttons.length, 2);
  const calls = [];
  const scrollport = { clientWidth: 240, scrollBy: (options) => calls.push(options) };
  const event = { currentTarget: { closest(selector) {
    assert.equal(selector, ".fpl-ledger");
    return { querySelector(selector) { assert.equal(selector, ".fpl-scroll"); return scrollport; } };
  } } };
  for (const direction of ["left", "right"]) {
    const button = buttons.find((node) => node.props["aria-label"].endsWith(direction));
    assert.equal(button.props.type, "button");
    button.props.onClick(event);
  }
  assert.deepEqual(calls, [ { left: -180, behavior: "smooth" }, { left: 180, behavior: "smooth" } ]);
  scrollport.clientWidth = 100;
  buttons.find((node) => node.props["aria-label"].endsWith("right")).props.onClick(event);
  assert.equal(calls.at(-1).left, 160);
});

test("the upcoming shortcut targets the first unfinished row on or after today", () => {
  const records = [
    row({ id: "past", date: "2026-11-06", description: "Earlier bill" }),
    row({ id: "done", date: "2026-11-11", description: "Already paid", completed: true }),
    row({ id: "next", date: "2026-11-12", description: "Next bill" }),
    row({ id: "later", date: "2026-11-20", description: "Later bill" }),
  ];
  const nodes = elements(Ledger({ plan, rows: records, today: "2026-11-10" }));
  const shortcut = nodes.find((node) => node.type === "a" && hasClass(node, "fpl-upcoming-link"));
  assert.ok(shortcut);
  assert.ok(shortcut.props.href.startsWith("#"));
  const target = nodes.find((node) => node.type === "tr" && node.props.id === decodeURIComponent(shortcut.props.href.slice(1)));
  assert.ok(target);
  assert.ok(plain(renderToStaticMarkup(target)).includes("Next bill"));
  const pastOnly = elements(Ledger({ plan, rows: records.slice(0, 1), today: "2026-12-01" }));
  assert.ok(!pastOnly.some((node) => node.type === "a" && hasClass(node, "fpl-upcoming-link")));
});
