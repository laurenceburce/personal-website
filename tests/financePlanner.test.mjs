import test from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  annualSavingsTarget,
  billDueDays,
  billOccurrences,
  buildPlanRows,
  convert,
  formatDate,
  getAnnualBillFunding,
  getAnnualReserveOpening,
  getPlanOpening,
  getSummary as summarize,
  localDate,
  salaryOccurrences,
} from "../app/lib/financePlanner.mjs";

const getSummary = (document, rate, asOf = "2026-11-02") =>
  summarize(document, rate, asOf);

test("editing one savings occurrence preserves recurring amounts and stable completion identity", () => {
  const doc = {
    salary: { amount: 2000, currency: "USD", payFrequency: "biweekly", firstPayDate: "2026-11-06", accountId: 1 },
    bills: [],
    allocations: [{ id: "save", name: "Savings", kind: "savings", amount: 500, currency: "USD", accountId: 2 }],
  };
  const plan = {
    startDate: "2026-11-01", endDate: "2026-11-30", openingUsd: 1000, openingPhp: 0,
    includeIncome: false, includeAnnualReserve: false, entries: [],
    completedRows: [{ rowId: "allocation:save:2026-11-06", completedAt: "2026-11-07T12:00:00.000Z" }],
    rowOverrides: [{ rowId: "allocation:save:2026-11-06", date: "2026-11-07", description: "Smaller savings this payday", amount: 125.5 }],
  };
  const before = JSON.stringify({ doc, plan });
  const rows = buildPlanRows(plan, doc, 63, { today: "2026-11-02" });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, "allocation:save:2026-11-06");
  assert.equal(rows[0].date, "2026-11-07");
  assert.equal(rows[0].description, "Smaller savings this payday");
  assert.equal(rows[0].amount, 125.5);
  assert.equal(rows[0].usd, -125.5);
  assert.equal(rows[0].completed, true);
  assert.equal(rows[0].completionKey, "allocation:save:2026-11-06");
  assert.equal(rows[0].originalAmount, 500);
  assert.equal(rows[0].originalDate, "2026-11-06");
  assert.equal(rows[0].editable, true);
  assert.equal(rows[0].isOverride, true);
  assert.equal(rows[1].amount, 500);
  assert.equal(rows[1].isOverride, false);
  assert.equal(rows[1].balanceUsd, 374.5);
  assert.equal(JSON.stringify({ doc, plan }), before);
  assert.equal(buildPlanRows({ ...plan, rowOverrides: [] }, doc, 63)[0].amount, 500);
  const paused = buildPlanRows(plan, { ...doc, allocations: [{ ...doc.allocations[0], amount: 0 }] }, 63);
  assert.equal(paused.length, 1);
  assert.equal(paused[0].amount, 125.5);
  assert.equal(paused[0].originalAmount, 0);
});

test("one-off salary and bill amounts and dates are used before posted matching", () => {
  const doc = {
    salary: { amount: 2000, currency: "USD", payFrequency: "biweekly", firstPayDate: "2026-11-06", accountId: 1 },
    bills: [{ id: "subscription", name: "Subscription", amount: 20, currency: "USD", cadence: "monthly", dueDay: 6, accountId: 1 }],
    allocations: [],
  };
  const plan = {
    startDate: "2026-11-01", endDate: "2026-11-30", openingUsd: 0, openingPhp: 0,
    includeIncome: true, includeAnnualReserve: false, entries: [],
    rowOverrides: [
      { rowId: "salary:2026-11-06", date: "2026-11-07", description: "Adjusted paycheck", amount: 900 },
      { rowId: "bill:subscription:2026-11-06", date: "2026-11-08", description: "Subscription special", amount: 15 },
    ],
  };
  const transactions = [
    { id: 1, accountId: 1, date: "2026-11-07", merchant: "Payroll", kind: "income", currency: "USD", amount: 900 },
    { id: 2, accountId: 1, date: "2026-11-08", merchant: "Subscription special", kind: "expense", currency: "USD", amount: 15 },
  ];
  const rows = buildPlanRows(plan, doc, 63, { transactions, today: "2026-11-10" });
  assert.equal(rows.filter((row) => row.date < "2026-11-20").length, 2);
  assert.equal(rows[0].completionKey, "salary:2026-11-06");
  assert.equal(rows[1].completionKey, "bill:subscription:2026-11-06");
  assert.ok(rows.slice(0, 2).every((row) => row.completed && row.source === "transaction" && !row.editable));
  assert.equal(rows[1].balanceUsd, 885);
  assert.equal(rows[2].amount, 923.08);
});

test("an edited expense allocation matches its edited merchant and amount", () => {
  const doc = { salary: { amount: 0, currency: "USD", payFrequency: "biweekly", firstPayDate: "2026-11-06" }, bills: [],
    allocations: [{ id: "expense", name: "Default expense", kind: "expense", amount: 100, currency: "USD", accountId: 1 }] };
  const plan = { startDate: "2026-11-06", endDate: "2026-11-06", openingUsd: 100, includeIncome: false, entries: [],
    rowOverrides: [{ rowId: "allocation:expense:2026-11-06", date: "2026-11-06", description: "Gym", amount: 40 }] };
  const transactions = [{ id: 1, date: "2026-11-06", accountId: 1, merchant: "Gym", kind: "expense", amount: 40, currency: "USD" }];
  const rows = buildPlanRows(plan, doc, 63, { transactions, today: "2026-11-06" });
  const allocation = rows.find((row) => row.source === "allocation");
  assert.equal(allocation.completed, true);
  assert.equal(allocation.completionSource, "transaction");
  assert.equal(allocation.reflectedInRecordedTransactions, true);
  assert.equal(rows.at(-1).balanceUsd, 60);
});

test("zero and moved occurrences stay addressable without moving neighboring recurrences", () => {
  const doc = {
    salary: { amount: 0, currency: "USD", payFrequency: "biweekly", firstPayDate: "2026-10-23" },
    bills: [], allocations: [{ id: "save", name: "Savings", kind: "savings", currency: "USD", amount: 500 }],
  };
  const plan = { startDate: "2026-11-01", endDate: "2026-11-20", includeIncome: false, includeAnnualReserve: false, entries: [],
    rowOverrides: [{ rowId: "allocation:save:2026-10-23", date: "2026-11-02", description: "Skipped old payday", amount: 0 }] };
  const rows = buildPlanRows(plan, doc, 63);
  assert.deepEqual(rows.map((row) => [row.date, row.amount]), [["2026-11-02", 0], ["2026-11-06", 500], ["2026-11-20", 500]]);
  assert.equal(rows[0].editable, true);
});

test("an overridden annual charge recomputes its shortfall from gross cost and existing reserve", () => {
  const doc = { salary: {}, allocations: [], bills: [{ id: "fee", name: "Annual fee", amount: 395, savedAmount: 100, currency: "USD", cadence: "annual", dueMonths: [11], dueDay: 28 }] };
  const plan = { startDate: "2026-11-01", endDate: "2026-11-30", openingUsd: 1000, includeIncome: false, includeAnnualReserve: false, entries: [],
    rowOverrides: [{ rowId: "bill:fee:2026-11-28", date: "2026-11-29", description: "Annual fee after discount", amount: 300 }] };
  const [row] = buildPlanRows(plan, doc, 63, { today: "2026-11-02" });
  assert.equal(row.originalAmount, 395);
  assert.equal(row.grossAmount, 300);
  assert.equal(row.reserveUsed, 100);
  assert.equal(row.reserveShortfall, 200);
  assert.equal(row.usd, -200);
  assert.equal(row.balanceUsd, 800);
  assert.equal(row.reserveUsd, 0);
});

test("moving an annual charge earlier consumes its original installment before funding the next cycle", () => {
  const doc = { salary: { amount: 0, currency: "USD", payFrequency: "biweekly", firstPayDate: "2026-11-13" }, allocations: [],
    bills: [{ id: "fee", name: "Annual fee", amount: 100, savedAmount: 100, currency: "USD", cadence: "annual", dueMonths: [11], dueDay: 28 }] };
  const plan = { startDate: "2026-11-13", endDate: "2026-11-30", openingUsd: 1000, includeIncome: false, entries: [],
    rowOverrides: [{ rowId: "bill:fee:2026-11-28", date: "2026-11-20", description: "Annual fee", amount: 100 }] };
  const rows = buildPlanRows(plan, doc, 63, { today: "2026-11-02" });
  assert.equal(rows.filter((row) => row.annualPayment).length, 1);
  assert.equal(rows.find((row) => row.annualPayment).reserveShortfall, 0);
  const next = rows.find((row) => row.id === "reserve:USD:2026-11-27");
  assert.ok(next.amount < 5, "later funding must target the next year, not fund the paid original date again");
  const posted = buildPlanRows(plan, doc, 63, { today: "2026-11-20", transactions: [
    { id: 1, date: "2026-11-20", kind: "expense", amount: 100, currency: "USD", merchant: "Annual fee" },
  ] });
  assert.equal(posted.find((row) => row.source === "transaction").originalDate, "2026-11-28");
  assert.ok(posted.find((row) => row.id === "reserve:USD:2026-11-27").amount < 5);
});

test("reserve occurrence overrides split cents, cap at funding left, and leave later funding adaptive", () => {
  const doc = { salary: { amount: 0, currency: "USD", payFrequency: "biweekly", firstPayDate: "2026-11-06" }, allocations: [],
    bills: [1, 2].map((amount, i) => ({ id: `fee${i}`, name: `Fee ${i}`, amount, savedAmount: 0, currency: "USD", cadence: "annual", dueMonths: [11], dueDay: 28 })) };
  const plan = { startDate: "2026-11-01", endDate: "2026-11-30", openingUsd: 10, includeIncome: false, entries: [],
    rowOverrides: [{ rowId: "reserve:USD:2026-11-06", date: "2026-11-06", description: "Extra annual funding", amount: 2.01 }] };
  const rows = buildPlanRows(plan, doc, 63, { today: "2026-11-02" });
  const reserves = rows.filter((row) => row.source === "reserve");
  assert.equal(reserves[0].amount, 2.01);
  assert.equal(reserves[0].originalAmount, 1.5);
  assert.deepEqual(reserves[0].reserveAllocations.map((allocation) => allocation.amount), [0.67, 1.34]);
  assert.equal(reserves[1].amount, 0.99);
  assert.equal(rows.at(-1).balanceUsd, 7);
  assert.equal(rows.at(-1).reserveUsd, 0);
  const capped = buildPlanRows({ ...plan, rowOverrides: [{ ...plan.rowOverrides[0], amount: 100 }] }, doc, 63);
  assert.equal(capped[0].amount, 3);
  assert.equal(capped[0].overrideRequestedAmount, 100);
  const zero = buildPlanRows({ ...plan, rowOverrides: [{ ...plan.rowOverrides[0], amount: 0 }] }, doc, 63);
  assert.equal(zero[0].amount, 0);
  assert.equal(zero[0].editable, true);
  assert.equal(zero.find((row) => row.id === "reserve:USD:2026-11-20").amount, 3);
});

test("live plan openings add flat amounts to current native account percentages", () => {
  const plan = { openingUsd: 25, openingPhp: 10, startingAccounts: [
    { accountId: 1, percentage: 80 }, { accountId: 2, percentage: 100 },
    { accountId: 3, percentage: 0 },
  ] };
  const accounts = [
    { id: 1, name: "Checking", currency: "USD", type: "checking", nativeCurrentBalance: 200, availableBalance: 999 },
    { id: 2, name: "Pesos", currency: "PHP", type: "savings", nativeCurrentBalance: 5000.55 },
    { id: 3, name: "Excluded", currency: "USD", type: "savings", nativeCurrentBalance: 999 },
  ];
  const before = JSON.stringify({ plan, accounts });
  const opening = getPlanOpening(plan, accounts);
  assert.equal(opening.usd, 185);
  assert.equal(opening.php, 5010.55);
  assert.equal(opening.contributions[0].balance, 200);
  assert.equal(opening.contributions[0].amount, 160);
  assert.equal(opening.contributions[2].amount, 0);
  assert.deepEqual(opening.warnings, []);
  assert.equal(JSON.stringify({ plan, accounts }), before);
  accounts[0].nativeCurrentBalance = 300;
  assert.equal(getPlanOpening(plan, accounts).usd, 265);
});

test("unavailable native starting balances are excluded with a reason, never NaN or an available-balance fallback", () => {
  const accounts = [
    { id: 1, currency: "USD", nativeCurrentBalance: null, currentBalance: 50, availableBalance: 60 },
    { id: 2, currency: "USD", nativeCurrentBalance: 50, isArchived: true },
    { id: 3, currency: "USD", nativeCurrentBalance: 50, mergedIntoAccountId: 4 },
    { id: 4, currency: "USD", nativeCurrentBalance: 50, type: "credit" },
    { id: 5, currency: "EUR", nativeCurrentBalance: 50 },
  ];
  const plan = { openingUsd: 17, startingAccounts: [1, 2, 3, 4, 5, 6].map((accountId) => ({ accountId, percentage: 100 })) };
  const opening = getPlanOpening(plan, accounts);
  assert.equal(opening.usd, 17);
  assert.equal(opening.php, 0);
  assert.equal(opening.contributions.length, 0);
  assert.equal(opening.warnings.length, 6);
});

test("a refreshed bank balance immediately changes plan running totals without recounting posted selected-account activity", () => {
  const plan = { startDate: "2026-11-01", endDate: "2026-11-03", openingUsd: 10, openingPhp: 0, includeIncome: false,
    startingAccounts: [{ accountId: 1, percentage: 80 }], entries: [] };
  const doc = { salary: {}, bills: [], allocations: [] };
  const accounts = [{ id: 1, currency: "USD", type: "checking", nativeCurrentBalance: 100 }];
  const transactions = [
    { id: 1, date: "2026-11-01", accountId: 1, amount: 20, currency: "USD", kind: "expense", merchant: "Already posted" },
    { id: 2, date: "2026-11-03", accountId: 1, amount: 5, currency: "USD", kind: "expense", merchant: "Future expense" },
    { id: 3, date: "2026-11-01", accountId: 2, amount: 3, currency: "USD", kind: "expense", merchant: "Flat balance expense" },
  ];
  const options = { accounts, transactions, today: "2026-11-02" };
  let rows = buildPlanRows(plan, doc, 63, options);
  assert.equal(rows.at(-1).balanceUsd, 82);
  assert.equal(rows.find((row) => row.transactionId === 1).reflectedInStartingBalance, true);
  accounts[0].nativeCurrentBalance = 200;
  rows = buildPlanRows(plan, doc, 63, options);
  assert.equal(rows.at(-1).balanceUsd, 162);
});

test("selected annual reserve balances are counted once and disappear when their funded bill is paid", () => {
  const bill = { id: "venture", name: "Venture X", amount: 395, currency: "USD", cadence: "annual", dueDay: 28, dueMonths: [11], savedAmount: 395, reserveAccountId: 2 };
  const doc = { salary: {}, bills: [bill], allocations: [] };
  const plan = { startDate: "2026-11-28", endDate: "2026-11-28", openingUsd: 0, openingPhp: 0,
    includeIncome: false, startingAccounts: [{ accountId: 2, percentage: 100 }], entries: [] };
  const accounts = [{ id: 2, currency: "USD", type: "savings", nativeCurrentBalance: 395 }];
  const opening = getPlanOpening(plan, accounts, doc);
  assert.equal(opening.totalUsd, 395);
  assert.equal(opening.reserveExcludedUsd, 395);
  assert.equal(opening.usd, 0);
  assert.equal(opening.contributions[0].availableAmount, 0);
  const rows = buildPlanRows(plan, doc, 63, { accounts, today: "2026-11-02" });
  assert.equal(rows.at(-1).balanceUsd, 0);
  assert.equal(rows.at(-1).reserveUsd, 0);
  assert.equal(rows.at(-1).grossAmount, 395);
});

test("manual row completion is stable metadata and does not change a single cash flow", () => {
  const plan = { startDate: "2026-11-02", endDate: "2026-11-02", openingUsd: 100, openingPhp: 0,
    includeIncome: false, entries: [{ id: "rent", date: "2026-11-02", description: "Rent", amount: 25, currency: "USD", kind: "expense" }] };
  const doc = { salary: {}, bills: [], allocations: [] };
  const before = buildPlanRows(plan, doc, 63, { today: "2026-11-02" });
  plan.completedRows = [{ rowId: "entry:rent", completedAt: "2026-11-02T12:34:56.000Z" }];
  const after = buildPlanRows(plan, doc, 63, { today: "2026-11-02" });
  assert.equal(after[0].completed, true);
  assert.equal(after[0].completionSource, "manual");
  assert.equal(after[0].completionKey, "entry:rent");
  for (const key of ["usd", "php", "balanceUsd", "balancePhp", "reserveUsd", "reservePhp"]) assert.equal(after[0][key], before[0][key]);
  assert.deepEqual(after[0].matchedTransactionIds, []);
});

test("a posted reconciliation retains the forecast completion key and supersedes manual status", () => {
  const plan = { startDate: "2026-11-01", endDate: "2026-11-30", openingUsd: 100, openingPhp: 0, includeIncome: false,
    completedRows: [{ rowId: "bill:google:2026-11-02", completedAt: "2026-11-01T12:00:00.000Z" }], entries: [] };
  const doc = { salary: {}, bills: [{ id: "google", name: "Google", amount: 2, currency: "USD", cadence: "monthly", dueDay: 2, accountId: 1 }], allocations: [] };
  const transactions = [{ id: 8, date: "2026-11-02", kind: "expense", currency: "USD", amount: 2, merchant: "Google", accountId: 1 }];
  const row = buildPlanRows(plan, doc, 63, { today: "2026-11-02", transactions })[0];
  assert.equal(row.id, "transaction:8");
  assert.equal(row.completionKey, "bill:google:2026-11-02");
  assert.equal(row.completionSource, "transaction");
  assert.deepEqual(row.matchedTransactionIds, [8]);
});

test("pending and future transactions cannot automatically complete a plan row", () => {
  const plan = { startDate: "2026-11-01", endDate: "2026-11-30", openingUsd: 0, openingPhp: 0, includeIncome: false, entries: [] };
  const doc = { salary: {}, bills: [], allocations: [] };
  const transactions = [
    { id: 1, date: "2026-11-01", amount: 5, currency: "USD", kind: "expense", pending: true },
    { id: 2, date: "2026-11-03", amount: 5, currency: "USD", kind: "expense" },
    { id: 3, date: "2026-11-02", amount: 5, currency: "USD", kind: "expense" },
  ];
  const rows = buildPlanRows(plan, doc, 63, { today: "2026-11-02", transactions });
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.transactionId === 2).completed, false);
  assert.equal(rows.find((row) => row.transactionId === 3).completed, true);
});

test("savings completion requires both assigned posted transfer legs once, rather than an equal amount", () => {
  const doc = { salary: { amount: 0, currency: "USD", payFrequency: "semimonthly", firstPayDate: "2026-11-02", accountId: 1 }, bills: [],
    allocations: [{ id: "saving", name: "Savings", kind: "savings", amount: 500, currency: "USD", sourceAccountId: 1, accountId: 2 }] };
  const plan = { startDate: "2026-11-02", endDate: "2026-11-02", openingUsd: 1000, openingPhp: 0, includeIncome: false, entries: [] };
  const debit = { id: 10, date: "2026-11-02", amount: 500, currency: "USD", kind: "expense", accountId: 1, category: "Transfer" };
  const credit = { id: 11, date: "2026-11-02", amount: 500, currency: "USD", kind: "income", accountId: 2, category: "Transfer" };
  const allocation = (transactions) => buildPlanRows(plan, doc, 63, { today: "2026-11-02", transactions }).find((row) => row.source === "allocation");
  assert.equal(allocation([debit]).completed, false);
  assert.equal(allocation([debit, { ...credit, accountId: 3 }]).completed, false);
  assert.equal(allocation([debit, { ...credit, pending: true }]).completed, false);
  assert.equal(allocation([debit, { ...credit, category: "Salary" }]).completed, false);
  assert.equal(allocation([debit, credit]).completed, true);
  assert.deepEqual(allocation([debit, credit]).matchedTransactionIds, [10, 11]);
  doc.allocations.push({ ...doc.allocations[0], id: "second" });
  const rows = buildPlanRows(plan, doc, 63, { today: "2026-11-02", transactions: [debit, credit] }).filter((row) => row.source === "allocation");
  assert.equal(rows.filter((row) => row.completed).length, 1);
});

test("historical conversion balances suppress each selected live account independently", () => {
  const plan = { startDate: "2026-11-01", endDate: "2026-11-01", openingUsd: 0, openingPhp: 0, includeIncome: false,
    startingAccounts: [{ accountId: 1, percentage: 100 }], entries: [
      { id: "convert", date: "2026-11-01", kind: "conversion", description: "Convert", amount: 10, currency: "USD", fromAccountId: 1, toAccountId: 2 },
    ] };
  const doc = { salary: {}, bills: [], allocations: [] };
  const accounts = [{ id: 1, currency: "USD", nativeCurrentBalance: 90 }, { id: 2, currency: "PHP", nativeCurrentBalance: 630 }];
  let row = buildPlanRows(plan, doc, 63, { accounts, today: "2026-11-02" })[0];
  assert.equal(row.balanceUsd, 90);
  assert.equal(row.balancePhp, 630);
  assert.equal(row.usd, -10);
  plan.startingAccounts = [{ accountId: 2, percentage: 100 }];
  row = buildPlanRows(plan, doc, 63, { accounts, today: "2026-11-02" })[0];
  assert.equal(row.balanceUsd, -10);
  assert.equal(row.balancePhp, 630);
});

test("historical live-account reserve tasks do not increase the current earmark a second time", () => {
  const doc = { salary: { amount: 0, currency: "USD", payFrequency: "semimonthly", firstPayDate: "2026-11-01", accountId: 1 },
    bills: [{ id: "annual", name: "Annual", amount: 100, savedAmount: 20, cadence: "annual", dueDay: 28, dueMonths: [11], currency: "USD", reserveAccountId: 2, sourceAccountId: 1 }], allocations: [] };
  const plan = { startDate: "2026-11-01", endDate: "2026-11-01", openingUsd: 0, openingPhp: 0, includeIncome: false,
    startingAccounts: [{ accountId: 1, percentage: 100 }], entries: [] };
  const accounts = [{ id: 1, currency: "USD", nativeCurrentBalance: 100 }];
  const row = buildPlanRows(plan, doc, 63, { accounts, today: "2026-11-02" })[0];
  assert.equal(row.source, "reserve");
  assert.equal(row.reflectedInStartingBalance, true);
  assert.equal(row.balanceUsd, 100);
  assert.equal(row.reserveUsd, 20);
  assert.equal(row.reserveAppliedUsd, 0);
});

test("a same-account savings earmark requires manual completion without a bank transfer", () => {
  const doc = { salary: { amount: 0, currency: "USD", payFrequency: "semimonthly", firstPayDate: "2026-11-02", accountId: 1 }, bills: [],
    allocations: [{ id: "saving", name: "Savings", kind: "savings", amount: 500, currency: "USD", sourceAccountId: 1, accountId: 1 }] };
  const plan = { startDate: "2026-11-02", endDate: "2026-11-02", openingUsd: 1000, openingPhp: 0, includeIncome: false, entries: [] };
  const transactions = [{ id: 1, date: "2026-11-02", amount: 500, kind: "income", currency: "USD", accountId: 1, category: "Transfer" }];
  const row = buildPlanRows(plan, doc, 63, { today: "2026-11-02", transactions }).find((row) => row.source === "allocation");
  assert.equal(row.completed, false);
});

test("posted conversion legs complete the task and change native running totals only once", () => {
  const doc = { salary: {}, bills: [], allocations: [] };
  const plan = { startDate: "2026-11-02", endDate: "2026-11-02", openingUsd: 100, openingPhp: 0, includeIncome: false, entries: [
    { id: "convert", date: "2026-11-02", description: "Convert", kind: "conversion", amount: 10, currency: "USD", fromAccountId: 1, toAccountId: 2 },
  ] };
  const transactions = [
    { id: 1, date: "2026-11-02", kind: "expense", amount: 10, currency: "USD", category: "Transfer", accountId: 1 },
    { id: 2, date: "2026-11-02", kind: "income", amount: 630, currency: "PHP", category: "Transfer", accountId: 2 },
  ];
  const rows = buildPlanRows(plan, doc, 63, { today: "2026-11-02", transactions });
  const task = rows.find((row) => row.source === "manual");
  assert.equal(task.completed, true);
  assert.equal(task.reflectedInRecordedTransactions, true);
  assert.equal(rows.at(-1).balanceUsd, 90);
  assert.equal(rows.at(-1).balancePhp, 630);
  assert.deepEqual(task.matchedTransactionIds, [1, 2]);
});

test("posted named expense allocation completion uses the real expense once", () => {
  const doc = { salary: { amount: 0, currency: "USD", payFrequency: "semimonthly", firstPayDate: "2026-11-02" }, bills: [],
    allocations: [{ id: "groceries", name: "Groceries", kind: "expense", amount: 50, currency: "USD", accountId: 1 }] };
  const plan = { startDate: "2026-11-02", endDate: "2026-11-02", openingUsd: 100, openingPhp: 0, includeIncome: false, entries: [] };
  const transactions = [{ id: 1, date: "2026-11-02", kind: "expense", amount: 50, currency: "USD", merchant: "Groceries", accountId: 1 }];
  const rows = buildPlanRows(plan, doc, 63, { today: "2026-11-02", transactions });
  const allocation = rows.find((row) => row.source === "allocation");
  assert.equal(allocation.completed, true);
  assert.equal(allocation.reflectedInRecordedTransactions, true);
  assert.equal(rows.at(-1).balanceUsd, 50);
  const unrelated = buildPlanRows(plan, doc, 63, { today: "2026-11-02", transactions: [{ ...transactions[0], merchant: "Other purchase" }] });
  assert.equal(unrelated.find((row) => row.source === "allocation").completed, false);
});

test("excluding recorded cash flows still checks posted bill completion without changing the forecast ledger", () => {
  const doc = { salary: {}, bills: [
    { id: "google", name: "Google", amount: 20, currency: "USD", cadence: "monthly", dueDay: 2, accountId: 1 },
  ], allocations: [] };
  const plan = { startDate: "2026-11-01", endDate: "2026-11-03", openingUsd: 100, openingPhp: 0,
    includeIncome: false, includeTransactions: false, entries: [] };
  const actual = { id: 8, date: "2026-11-02", amount: 20, currency: "USD", kind: "expense", merchant: "Google", accountId: 1 };
  const before = buildPlanRows(plan, doc, 63, { today: "2026-11-02" });
  const rows = buildPlanRows(plan, doc, 63, { today: "2026-11-02", transactions: [actual] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "bill:google:2026-11-02");
  assert.equal(rows[0].completed, true);
  assert.equal(rows[0].completionSource, "transaction");
  assert.deepEqual(rows[0].matchedTransactionIds, [8]);
  assert.equal(rows[0].balanceUsd, before[0].balanceUsd);
  assert.equal(rows[0].usd, -20);
  for (const changed of [{ ...actual, pending: true }, { ...actual, accountId: 2 }, { ...actual, date: "2026-11-03" }]) {
    const changedRows = buildPlanRows(plan, doc, 63, { today: "2026-11-02", transactions: [changed] });
    assert.equal(changedRows[0].completed, false);
    assert.equal(changedRows[0].balanceUsd, 80);
  }
});

test("completion-only conversion matches keep all hypothetical forecast amounts", () => {
  const doc = { salary: {}, bills: [], allocations: [] };
  const plan = { startDate: "2026-11-02", endDate: "2026-11-02", openingUsd: 100, openingPhp: 0, includeIncome: false, includeTransactions: false, entries: [
    { id: "convert", date: "2026-11-02", description: "Convert", kind: "conversion", amount: 10, currency: "USD", fromAccountId: 1, toAccountId: 2 },
  ] };
  const transactions = [
    { id: 1, date: "2026-11-02", kind: "expense", amount: 10, currency: "USD", category: "Transfer", accountId: 1 },
    { id: 2, date: "2026-11-02", kind: "income", amount: 630, currency: "PHP", category: "Transfer", accountId: 2 },
  ];
  const rows = buildPlanRows(plan, doc, 63, { today: "2026-11-02", transactions });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].completed, true);
  assert.equal(rows[0].balanceUsd, 90);
  assert.equal(rows[0].balancePhp, 630);
  assert.equal(rows[0].reflectedInRecordedTransactions, undefined);
});

const salary = {
  amount: 2000,
  currency: "USD",
  payFrequency: "semimonthly",
  firstPayDate: "2026-11-06",
};
const monthly = (id, amount, currency = "USD", dueDay = 18) => ({
  id,
  name: id,
  amount,
  currency,
  cadence: "monthly",
  dueDay,
  dueMonths: [],
});
const annual = (id, amount, currency = "USD", dueDay = 9, dueMonths = [9]) => ({
  id,
  name: id,
  amount,
  currency,
  cadence: "annual",
  dueDay,
  dueMonths,
});

const payday = (id, amount, currency = "USD") => ({
  id,
  name: id,
  amount,
  currency,
  cadence: "payday",
  dueDay: null,
  dueDays: [],
  dueMonths: [],
});

test("payday bills follow the salary anchor with their full native amount on every paycheck", () => {
  const anchored = {
    ...salary,
    firstPayDate: "2026-10-23",
    payFrequency: "biweekly",
  };
  const house = {
    ...payday("House", 19000, "PHP"),
    dueDay: 14,
    dueDays: [14, 28],
    dueMonths: [11],
  };
  assert.deepEqual(billDueDays(house), []);
  assert.deepEqual(
    billOccurrences(house, "2026-11-01", "2026-11-30", anchored),
    [
      { date: "2026-11-06", amount: 19000, currency: "PHP", billId: "House" },
      { date: "2026-11-20", amount: 19000, currency: "PHP", billId: "House" },
    ],
  );
  assert.deepEqual(
    billOccurrences(house, "2026-10-01", "2026-11-10", anchored).map(
      (row) => row.date,
    ),
    ["2026-10-23", "2026-11-06"],
  );
  assert.deepEqual(
    billOccurrences(house, "2026-10-01", "2026-10-22", anchored),
    [],
  );
});

test("biweekly payday bills include three-paycheck months and keep fourteen-day dates in February", () => {
  const anchored = {
    ...salary,
    firstPayDate: "2026-10-23",
    payFrequency: "biweekly",
  };
  const bill = payday("House", 19000, "PHP");
  const january = billOccurrences(bill, "2027-01-01", "2027-01-31", anchored);
  assert.deepEqual(
    january.map((row) => row.date),
    ["2027-01-01", "2027-01-15", "2027-01-29"],
  );
  assert.equal(
    january.reduce((total, row) => total + row.amount, 0),
    57000,
  );
  assert.deepEqual(
    billOccurrences(bill, "2027-02-01", "2027-02-28", anchored).map(
      (row) => row.date,
    ),
    ["2027-02-12", "2027-02-26"],
  );
});

test("payday bills regenerate when the salary frequency or first payday changes", () => {
  const bill = payday("Payday fee", 25.01);
  const anchored = {
    ...salary,
    firstPayDate: "2026-10-23",
    payFrequency: "biweekly",
  };
  const range = ["2026-11-01", "2026-11-30"];
  assert.deepEqual(
    billOccurrences(bill, ...range, anchored).map((row) => row.date),
    ["2026-11-06", "2026-11-20"],
  );
  assert.deepEqual(
    billOccurrences(bill, ...range, {
      ...anchored,
      payFrequency: "semimonthly",
    }).map((row) => row.date),
    ["2026-11-08", "2026-11-23"],
  );
  assert.deepEqual(
    billOccurrences(bill, ...range, {
      ...anchored,
      firstPayDate: "2026-10-30",
    }).map((row) => row.date),
    ["2026-11-13", "2026-11-27"],
  );
  assert.deepEqual(
    billOccurrences(bill, "2027-02-01", "2027-02-28", {
      ...salary,
      firstPayDate: "2027-01-31",
    }).map((row) => row.date),
    ["2027-02-16", "2027-02-28"],
  );
});

test("payday bills need a valid salary schedule and date range", () => {
  const bill = payday("House", 19000, "PHP");
  for (const schedule of [
    undefined,
    null,
    {},
    { ...salary, firstPayDate: "2026-02-30" },
    { ...salary, payFrequency: "weekly" },
  ]) {
    assert.deepEqual(
      billOccurrences(bill, "2026-11-01", "2026-11-30", schedule),
      [],
    );
  }
  for (const range of [
    ["bad", "2026-11-30"],
    ["2026-11-30", "2026-11-01"],
  ]) {
    assert.deepEqual(billOccurrences(bill, ...range, salary), []);
  }
});

test("payday summaries use native per-pay amounts and monthly averages without double counting", () => {
  const document = {
    salary: { ...salary, amount: 2600, payFrequency: "biweekly" },
    bills: [
      monthly("Monthly USD", 26),
      monthly("Monthly PHP", 1300, "PHP"),
      payday("Payday USD", 125.01),
      payday("House", 19000.03, "PHP"),
      annual("Annual", 260, "USD", null),
    ],
    allocations: [],
  };
  const summary = getSummary(document, 50);
  assert.equal(summary.monthlyBillsUsd, 26);
  assert.equal(summary.monthlyBillsPhp, 1300);
  assert.equal(summary.paydayBillsUsd, 125.01);
  assert.equal(summary.paydayBillsPhp, 19000.03);
  assert.equal(summary.paydayMonthlyUsd, 270.86);
  assert.equal(summary.paydayMonthlyPhp, 41166.73);
  assert.equal(summary.billsUsd, 296.86);
  assert.equal(summary.billsPhp, 42466.73);
  assert.equal(summary.billsUsdPerPeriod, 137.01);
  assert.equal(summary.billsPhpPerPeriod, 19600.03);
  assert.equal(summary.annualPerPeriodUsd, 10);
  assert.equal(summary.remainingPerPeriodUsd, 660.99);
  assert.equal(summary.monthlyCommitmentsUsd, 1167.86);
  const twiceMonthly = getSummary(
    {
      ...document,
      salary: { ...document.salary, payFrequency: "semimonthly" },
    },
    50,
  );
  assert.equal(twiceMonthly.paydayBillsPhp, 19000.03);
  assert.equal(twiceMonthly.paydayMonthlyPhp, 38000.06);
  assert.equal(twiceMonthly.billsUsdPerPeriod, 138.01);
  assert.equal(twiceMonthly.billsPhpPerPeriod, 19650.03);
});

test("per-pay bill cents are added directly rather than recovered from rounded monthly equivalents", () => {
  const summary = getSummary(
    {
      salary: { ...salary, payFrequency: "biweekly" },
      bills: [
        monthly("Monthly USD", 0.01),
        monthly("Monthly PHP", 0.01, "PHP"),
        payday("Payday USD", 0.04),
        payday("Payday PHP", 0.04, "PHP"),
      ],
      allocations: [],
    },
    63,
  );
  assert.equal(summary.billsUsd, 0.1);
  assert.equal(summary.billsPhp, 0.1);
  assert.equal(summary.billsUsdPerPeriod, 0.04);
  assert.equal(summary.billsPhpPerPeriod, 0.04);
  assert.notEqual(
    summary.billsUsdPerPeriod,
    Math.round(((summary.billsUsd * 12) / 26) * 100) / 100,
  );
});

test("budget plans include payday bills even when forecast salary is switched off", () => {
  const document = {
    salary: {
      ...salary,
      amount: 2600,
      firstPayDate: "2026-10-23",
      payFrequency: "biweekly",
    },
    bills: [
      monthly("Internet", 100, "USD", 10),
      payday("House", 19000, "PHP"),
      payday("Payday fee", 5.25),
    ],
    allocations: [],
  };
  const plan = {
    startDate: "2026-11-01",
    endDate: "2026-11-30",
    openingUsd: 1000,
    openingPhp: 50000,
    includeIncome: false,
    includeAnnualReserve: false,
    includeAllocations: false,
    entries: [],
  };
  const before = JSON.stringify({ document, plan });
  const rows = buildPlanRows(plan, document, 63);
  assert.equal(rows.length, 5);
  assert.equal(rows.filter((row) => row.source === "salary").length, 0);
  assert.deepEqual(
    rows
      .filter((row) => row.billId === "House")
      .map((row) => [row.date, row.php]),
    [
      ["2026-11-06", -19000],
      ["2026-11-20", -19000],
    ],
  );
  assert.deepEqual(
    rows.filter((row) => row.billId === "Payday fee").map((row) => row.usd),
    [-5.25, -5.25],
  );
  assert.equal(rows.at(-1).balanceUsd, 889.5);
  assert.equal(rows.at(-1).balancePhp, 12000);
  assert.equal(JSON.stringify({ document, plan }), before);
  const withIncome = buildPlanRows(
    { ...plan, includeIncome: true },
    document,
    63,
  );
  assert.equal(withIncome.filter((row) => row.source === "salary").length, 2);
  assert.equal(withIncome.filter((row) => row.source === "bill").length, 5);
  assert.equal(withIncome[0].source, "salary");
});

test("posted payday bill payments replace one forecast without moving other bills to a bank posting date", () => {
  const document = {
    salary: {
      ...salary,
      amount: 2600,
      firstPayDate: "2026-10-23",
      payFrequency: "biweekly",
    },
    bills: [payday("House", 19000, "PHP"), payday("Payday fee", 5.25)],
    allocations: [],
  };
  const plan = {
    startDate: "2026-11-01",
    endDate: "2026-11-30",
    openingUsd: 0,
    openingPhp: 50000,
    includeIncome: true,
    includeAnnualReserve: false,
    includeAllocations: false,
    entries: [],
  };
  const transactions = [
    {
      id: 1,
      date: "2026-11-05",
      kind: "income",
      merchant: "Salary payroll",
      amount: 1200,
      currency: "USD",
    },
    {
      id: 2,
      date: "2026-11-07",
      kind: "expense",
      merchant: "House",
      amount: 19000,
      currency: "PHP",
    },
  ];
  const rows = buildPlanRows(plan, document, 63, { transactions });
  const house = rows.filter((row) => row.billId === "House");
  assert.equal(house.length, 2);
  assert.equal(house[0].source, "transaction");
  assert.equal(house[0].date, "2026-11-07");
  assert.equal(house[0].scheduledDate, "2026-11-06");
  assert.equal(house[0].php, -19000);
  assert.equal(house[1].date, "2026-11-20");
  assert.deepEqual(
    rows.filter((row) => row.billId === "Payday fee").map((row) => row.date),
    ["2026-11-06", "2026-11-20"],
  );
  assert.equal(
    rows.filter((row) => row.source === "transaction" && row.kind === "income")
      .length,
    1,
  );
  assert.equal(rows.filter((row) => row.source === "salary").length, 1);
});

test("monthly and pay-period summaries reserve annual bills exactly once", () => {
  const document = {
    salary,
    bills: [
      monthly("US bills", 62),
      monthly("PH bills", 4200, "PHP"),
      annual("Microsoft", 100),
      annual("Domain", 20),
      annual("Car", 500, "USD", 9, [3, 9]),
      annual("Venture X", 395),
    ],
    allocations: [{ amount: 500, currency: "USD", kind: "savings" }],
  };
  const summary = getSummary(document, 63);
  assert.equal(summary.monthlyUsd, 2000);
  assert.equal(summary.monthlyPhp, 126000);
  assert.equal(summary.annualUsd, 1015);
  assert.equal(summary.annualMonthlyUsd, 104.64);
  assert.equal(summary.billsUsdPerPeriod, 31);
  assert.equal(summary.billsPhpPerPeriod, 2100);
  assert.equal(summary.billsPhpPerPeriodUsd, 33.33);
  assert.equal(summary.annualPerPeriodUsd, 52.32);
  assert.equal(summary.remainingPerPeriodUsd, 883.35);
  assert.equal(summary.unallocatedPerPeriodUsd, 383.35);
  assert.equal(summary.monthlyCommitmentsUsd, 233.31);
});

test("true biweekly pay annualizes income and expenses over 26 periods", () => {
  const document = {
    salary: { ...salary, payFrequency: "biweekly" },
    bills: [monthly("Bills", 260), annual("Annual", 260, "USD", null)],
    allocations: [],
  };
  const summary = getSummary(document, 63);
  assert.equal(summary.payPeriods, 26);
  assert.equal(summary.incomePerPeriodUsd, 923.08);
  assert.equal(summary.billsUsdPerPeriod, 120);
  assert.equal(summary.annualPerPeriodUsd, 10);
  assert.equal(summary.remainingPerPeriodUsd, 793.08);
});

test("PHP salary and allocations keep native currency and convert once", () => {
  const summary = getSummary(
    {
      salary: { ...salary, amount: 126000, currency: "PHP" },
      bills: [annual("PHP annual", 6300, "PHP")],
      allocations: [{ amount: 6300, currency: "PHP" }],
    },
    63,
  );
  assert.equal(summary.monthlyUsd, 2000);
  assert.equal(summary.monthlyPhp, 126000);
  assert.equal(summary.annualUsd, 100);
  assert.equal(summary.allocationsPerPeriodUsd, 100);
});

test("PHP summary totals preserve native cents instead of round-tripping rounded USD", () => {
  const summary = getSummary(
    {
      salary: { ...salary, amount: 1000.01, currency: "PHP" },
      bills: [
        monthly("PHP monthly", 169.01, "PHP"),
        monthly("USD monthly", 2),
        annual("PHP annual", 1015.01, "PHP"),
        annual("USD annual", 20),
      ],
      allocations: [],
    },
    63,
  );
  assert.equal(summary.annualPhp, 2275.01);
  assert.equal(summary.annualMonthlyPhp, 217.64);
  assert.equal(summary.monthlyCommitmentsPhp, 512.65);
  assert.equal(summary.monthlyRemainingPhp, 487.36);
  assert.notEqual(
    summary.annualPhp,
    convert(summary.annualUsd, "USD", "PHP", 63),
  );
});

test("annual funding follows saved balances without changing the bill or calendar target", () => {
  const bill = {
    ...annual("Venture X", 395, "USD", 28, [11]),
    savedAmount: 100,
  };
  const before = JSON.stringify(bill);
  const {
    amount,
    savedAmount,
    remainingAmount,
    monthlyAmount,
    perPeriodAmount,
    fullyFunded,
  } = getAnnualBillFunding(bill);
  assert.deepEqual(
    {
      amount,
      savedAmount,
      remainingAmount,
      monthlyAmount,
      perPeriodAmount,
      fullyFunded,
    },
    {
      amount: 395,
      savedAmount: 100,
      remainingAmount: 295,
      monthlyAmount: 24.58,
      perPeriodAmount: 11.35,
      fullyFunded: false,
    },
  );
  assert.equal(getAnnualBillFunding(bill, 24).perPeriodAmount, 12.29);
  for (const savedAmount of [395, 500]) {
    const funded = getAnnualBillFunding({ ...bill, savedAmount });
    assert.equal(funded.savedAmount, savedAmount);
    assert.equal(funded.remainingAmount, 0);
    assert.equal(funded.monthlyAmount, 0);
    assert.equal(funded.perPeriodAmount, 0);
    assert.equal(funded.fullyFunded, true);
    assert.deepEqual(
      annualSavingsTarget({ ...bill, savedAmount }, "2026-11-02"),
      annualSavingsTarget(bill, "2026-11-02"),
    );
  }
  assert.equal(JSON.stringify(bill), before);
});

test("annual funding sanitizes legacy values and excludes monthly savings", () => {
  for (const savedAmount of [
    undefined,
    -10,
    "invalid",
    Number.POSITIVE_INFINITY,
  ]) {
    assert.equal(
      getAnnualBillFunding({ ...annual("Legacy", 395), savedAmount })
        .remainingAmount,
      395,
    );
  }
  assert.equal(
    getAnnualBillFunding({
      ...annual("PHP", "6300.01", "PHP"),
      savedAmount: "1260.01",
    }).remainingAmount,
    5040,
  );
  assert.deepEqual(
    getAnnualBillFunding({ ...monthly("Monthly", 20), savedAmount: 10 }),
    getAnnualBillFunding(),
  );
  assert.equal(getAnnualBillFunding(annual("Invalid", -10)).amount, 0);
  assert.equal(
    getAnnualBillFunding(annual("Invalid", "invalid")).remainingAmount,
    0,
  );
  assert.equal(
    getAnnualBillFunding(annual("Fallback", 260), 0).perPeriodAmount,
    10,
  );
});

test("summary funding clamps each item before aggregating native USD and PHP balances", () => {
  const document = {
    salary: { ...salary, payFrequency: "biweekly" },
    bills: [
      { ...annual("Funded", 100), savedAmount: 250 },
      { ...annual("Venture X", 395), savedAmount: 100 },
      { ...annual("PHP", 6300.01, "PHP"), savedAmount: 1260.01 },
      { ...monthly("Monthly", 50), savedAmount: 999 },
    ],
    allocations: [{ amount: 100, currency: "USD" }],
  };
  const summary = getSummary(document, 63);
  assert.equal(summary.annualUsd, 595);
  assert.equal(summary.annualPhp, 37485.01);
  assert.equal(summary.annualSavedUsd, 370);
  assert.equal(summary.annualSavedPhp, 23310.01);
  assert.equal(summary.annualRemainingUsd, 375);
  assert.equal(summary.annualRemainingPhp, 23625);
  assert.equal(summary.annualMonthlyUsd, 36.94);
  assert.equal(summary.annualMonthlyPhp, 2327.16);
  assert.equal(summary.annualPerPeriodUsd, 17.05);
  assert.equal(summary.monthlyCommitmentsUsd, 86.94);
  assert.equal(summary.monthlyRemainingUsd, 1913.06);
  assert.equal(summary.remainingPerPeriodUsd, 882.95);
  assert.equal(summary.unallocatedPerPeriodUsd, 782.95);
});

test("changing saved annual money recomputes all funding-based summary metrics", () => {
  const document = {
    salary: { ...salary, payFrequency: "biweekly" },
    bills: [{ ...annual("Venture X", 395), savedAmount: 395 }],
    allocations: [{ amount: 500, currency: "USD" }],
  };
  const funded = getSummary(document, 63);
  assert.equal(funded.annualMonthlyUsd, 0);
  assert.equal(funded.annualMonthlyPhp, 0);
  assert.equal(funded.annualPerPeriodUsd, 0);
  assert.equal(funded.monthlyRemainingUsd, 2000);
  assert.equal(funded.unallocatedPerPeriodUsd, 423.08);
  document.bills[0].savedAmount = 100;
  const partial = getSummary(document, 63);
  assert.equal(partial.annualUsd, funded.annualUsd);
  assert.equal(partial.annualPhp, funded.annualPhp);
  assert.equal(partial.annualRemainingUsd, 295);
  assert.equal(partial.annualRemainingPhp, 18585);
  assert.equal(partial.annualMonthlyUsd, 29.06);
  assert.equal(partial.annualMonthlyPhp, 1830.78);
  assert.equal(partial.annualPerPeriodUsd, 13.41);
  assert.equal(partial.monthlyCommitmentsUsd, 29.06);
  assert.equal(partial.monthlyRemainingUsd, 1970.94);
  assert.equal(partial.remainingPerPeriodUsd, 909.67);
  assert.equal(partial.unallocatedPerPeriodUsd, 409.67);
});

test("monthly dates clamp to month end across leap years and year boundaries", () => {
  const bill = monthly("Month end", 10, "USD", 31);
  assert.deepEqual(
    billOccurrences(bill, "2024-01-31", "2024-03-31").map((row) => row.date),
    ["2024-01-31", "2024-02-29", "2024-03-31"],
  );
  assert.deepEqual(
    billOccurrences(bill, "2026-12-01", "2027-02-28").map((row) => row.date),
    ["2026-12-31", "2027-01-31", "2027-02-28"],
  );
  assert.deepEqual(
    billOccurrences({ ...bill, dueDay: null }, "2026-11-01", "2026-11-30"),
    [],
  );
});

test("annual installment rounding preserves total and deduplicates months", () => {
  const bill = annual("Installments", 100, "USD", 31, [9, 3, 6, 3]);
  const rows = billOccurrences(bill, "2026-01-01", "2026-12-31");
  assert.deepEqual(
    rows.map(({ date, amount }) => ({ date, amount })),
    [
      { date: "2026-03-31", amount: 33.33 },
      { date: "2026-06-30", amount: 33.33 },
      { date: "2026-09-30", amount: 33.34 },
    ],
  );
  assert.equal(
    rows.reduce((sum, row) => sum + Math.round(row.amount * 100), 0),
    10000,
  );
});

test("salary schedules respect first payday, range edges and leap dates", () => {
  assert.deepEqual(
    salaryOccurrences(salary, "2026-11-01", "2026-12-21").map(
      (row) => row.date,
    ),
    ["2026-11-06", "2026-11-21", "2026-12-06", "2026-12-21"],
  );
  assert.deepEqual(
    salaryOccurrences(
      { ...salary, firstPayDate: "2026-11-20" },
      "2026-11-01",
      "2026-12-31",
    ).map((row) => row.date),
    ["2026-11-20", "2026-12-05", "2026-12-20"],
  );
  assert.deepEqual(
    salaryOccurrences(
      { ...salary, firstPayDate: "2024-01-31" },
      "2024-02-01",
      "2024-02-29",
    ).map((row) => row.date),
    ["2024-02-16", "2024-02-29"],
  );
  const fortnightly = salaryOccurrences(
    { ...salary, payFrequency: "biweekly" },
    "2026-11-07",
    "2026-12-18",
  );
  assert.deepEqual(
    fortnightly.map((row) => row.date),
    ["2026-11-20", "2026-12-04", "2026-12-18"],
  );
  assert.equal(fortnightly[0].amount, 923.08);
});

test("budget ledger generates native bills and income with independent running balances", () => {
  const document = {
    salary,
    bills: [
      monthly("USD bill", 100, "USD", 6),
      monthly("PHP bill", 6300, "PHP", 6),
      annual("Annual", 200, "USD", 6, [3, 11]),
    ],
    allocations: [],
  };
  const plan = {
    startDate: "2026-11-01",
    endDate: "2026-11-06",
    openingUsd: 750,
    openingPhp: 0,
    includeIncome: true,
    entries: [
      {
        id: "fx",
        date: "2026-11-06",
        description: "Convert",
        kind: "conversion",
        amount: 100,
        currency: "USD",
      },
    ],
  };
  const rows = buildPlanRows(plan, document, 63);
  assert.equal(rows.length, 6);
  assert.equal(rows[0].source, "salary");
  assert.equal(rows[1].kind, "conversion");
  assert.equal(rows.at(-1).balanceUsd, 1450);
  assert.equal(rows.at(-1).balancePhp, 0);
  assert.equal(rows.filter((row) => row.source === "bill").length, 3);
  assert.equal(rows.filter((row) => row.source === "reserve").length, 1);
  assert.equal(rows.filter((row) => row.source === "reserveRelease").length, 0);
  assert.equal(rows.at(-1).reserveUsd, 0);
  assert.deepEqual(buildPlanRows(plan, document, 63), rows);
});

test("manual PHP conversions conserve value and negative balances stay visible", () => {
  const plan = {
    startDate: "2026-11-01",
    endDate: "2026-11-30",
    openingUsd: 0,
    openingPhp: 0,
    includeIncome: false,
    entries: [
      {
        id: "convert",
        date: "2026-11-06",
        description: "Convert PHP to USD",
        kind: "conversion",
        amount: 630,
        currency: "PHP",
      },
      {
        id: "expense",
        date: "2026-11-06",
        description: "Expense",
        kind: "expense",
        amount: 20,
        currency: "USD",
      },
      {
        id: "outside",
        date: "2026-12-01",
        description: "Outside range",
        kind: "income",
        amount: 1000,
        currency: "USD",
      },
    ],
  };
  const rows = buildPlanRows(plan, { salary, bills: [] }, 63);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].usd + rows[0].php / 63, 0);
  assert.equal(rows.at(-1).balanceUsd, -10);
  assert.equal(rows.at(-1).balancePhp, -630);
});

test("date helpers use New York calendar dates without DST drift", () => {
  assert.equal(localDate(new Date("2026-11-02T02:00:00Z")), "2026-11-01");
  assert.equal(addDays("2026-03-07", 2), "2026-03-09");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-02-30", 1), "");
  assert.equal(formatDate("2026-11-06"), "Nov 6");
  assert.equal(convert(100, "USD", "PHP", 63), 6300);
  assert.equal(convert(6300, "PHP", "USD", 63), 100);
});

test("monthly bills split the total across two dates and retain legacy single due dates", () => {
  const bill = { ...monthly("Rent", 100.01), dueDays: [20, 5, 20] };
  assert.deepEqual(billDueDays(bill), [5, 20]);
  assert.deepEqual(
    billOccurrences(bill, "2026-11-01", "2026-12-31").map(
      ({ date, amount }) => ({ date, amount }),
    ),
    [
      { date: "2026-11-05", amount: 50 },
      { date: "2026-11-20", amount: 50.01 },
      { date: "2026-12-05", amount: 50 },
      { date: "2026-12-20", amount: 50.01 },
    ],
  );
  assert.equal(
    billOccurrences(bill, "2026-11-10", "2026-11-25")[0].amount,
    50.01,
  );
  assert.deepEqual(billDueDays(monthly("Legacy", 10, "USD", 18)), [18]);
  assert.deepEqual(
    billOccurrences({ ...bill, dueDays: [] }, "2026-11-01", "2026-11-30"),
    [],
  );
  assert.equal(
    getSummary({ salary, bills: [bill], allocations: [] }, 63).billsUsd,
    100.01,
  );
});

test("two monthly dates clamped to the same short-month day preserve the monthly total", () => {
  const bill = { ...monthly("Month end split", 101.01), dueDays: [30, 31] };
  assert.deepEqual(billOccurrences(bill, "2028-02-01", "2028-02-29"), [
    { date: "2028-02-29", amount: 101.01, currency: "USD", billId: bill.id },
  ]);
  assert.equal(
    billOccurrences(bill, "2026-04-01", "2026-04-30")[0].amount,
    101.01,
  );
});

test("annual savings targets progress between renewal dates and are fully funded on the due date", () => {
  const bill = annual("Renewal", 120, "USD", 1, [1]);
  assert.deepEqual(annualSavingsTarget(bill, "2026-01-01"), {
    target: 120,
    currency: "USD",
    cycleStart: "2025-01-01",
    nextDueDate: "2026-01-01",
    installmentAmount: 120,
    progress: 1,
    needsDate: false,
  });
  assert.equal(annualSavingsTarget(bill, "2026-01-02").target, 0.33);
  const afterSeptember = annualSavingsTarget(
    annual("Microsoft", 100),
    "2026-11-02",
  );
  assert.equal(afterSeptember.target, 14.79);
  assert.equal(afterSeptember.cycleStart, "2026-09-09");
  assert.equal(afterSeptember.nextDueDate, "2027-09-09");
});

test("annual target cycles handle leap dates, installment pennies and missing due dates", () => {
  const leap = annual("Leap renewal", 366, "PHP", 29, [2]);
  assert.equal(annualSavingsTarget(leap, "2024-02-28").target, 365);
  assert.equal(annualSavingsTarget(leap, "2024-02-29").target, 366);
  assert.equal(annualSavingsTarget(leap, "2024-03-01").target, 1);
  const installments = annual("Three installments", 100, "USD", 31, [3, 6, 9]);
  assert.equal(annualSavingsTarget(installments, "2026-09-30").target, 33.34);
  assert.equal(annualSavingsTarget(installments, "2026-12-30").target, 16.67);
  const unknown = annualSavingsTarget({ ...leap, dueDay: null }, "2026-11-02");
  assert.equal(unknown.needsDate, true);
  assert.equal(unknown.target, null);
  assert.equal(unknown.nextDueDate, null);
});

test("October 23 anchored biweekly pay stays on Fridays across November DST", () => {
  const anchored = {
    ...salary,
    firstPayDate: "2026-10-23",
    payFrequency: "biweekly",
  };
  assert.deepEqual(
    salaryOccurrences(anchored, "2026-11-01", "2026-12-31").map(
      (row) => row.date,
    ),
    ["2026-11-06", "2026-11-20", "2026-12-04", "2026-12-18"],
  );
  assert.deepEqual(
    salaryOccurrences(
      { ...anchored, payFrequency: "semimonthly" },
      "2026-11-01",
      "2026-11-30",
    ).map((row) => row.date),
    ["2026-11-08", "2026-11-23"],
  );
});

test("full plan flows include allocations, native reserves, one-time transactions and conversions", () => {
  const document = {
    salary: {
      amount: 2600,
      currency: "USD",
      payFrequency: "biweekly",
      firstPayDate: "2026-10-23",
    },
    bills: [
      monthly("Internet", 100, "USD", 10),
      annual("USD reserve", 260, "USD", 9, [12]),
      annual("PHP reserve", 2600, "PHP", 9, [12]),
    ],
    allocations: [
      {
        id: "save",
        name: "Savings",
        amount: 500,
        currency: "USD",
        kind: "savings",
      },
      {
        id: "food",
        name: "Groceries",
        amount: 630,
        currency: "PHP",
        kind: "expense",
      },
    ],
  };
  const plan = {
    startDate: "2026-11-01",
    endDate: "2026-11-30",
    openingUsd: 100,
    openingPhp: 1000,
    includeIncome: true,
    entries: [
      {
        id: "convert",
        date: "2026-11-19",
        description: "Convert",
        kind: "conversion",
        amount: 100,
        currency: "USD",
      },
    ],
  };
  const rows = buildPlanRows(plan, document, 63, {
    transactions: [
      {
        id: 1,
        date: "2026-11-15",
        merchant: "One-time purchase",
        kind: "expense",
        amount: 150,
        currency: "USD",
      },
    ],
  });
  assert.equal(rows.length, 13);
  assert.equal(rows.filter((row) => row.source === "salary").length, 2);
  assert.equal(rows.filter((row) => row.source === "allocation").length, 4);
  assert.equal(rows.filter((row) => row.source === "reserve").length, 4);
  assert.deepEqual(
    {
      usd: rows.at(-1).balanceUsd,
      php: rows.at(-1).balancePhp,
      reserveUsd: rows.at(-1).reserveUsd,
      reservePhp: rows.at(-1).reservePhp,
    },
    { usd: 976.66, php: 4306.66, reserveUsd: 173.34, reservePhp: 1733.34 },
  );
  const reserve = rows.find((row) => row.source === "reserve");
  assert.equal(
    reserve.usd +
      reserve.php / 63 +
      reserve.reserveDeltaUsd +
      reserve.reserveDeltaPhp / 63,
    0,
  );
});

test("annual payments consume existing reserves before charging available funds", () => {
  const document = {
    salary: { ...salary, firstPayDate: "2026-12-01" },
    bills: [annual("Insurance", 120, "USD", 9, [11])],
    allocations: [],
  };
  const plan = {
    startDate: "2026-11-01",
    endDate: "2026-11-10",
    openingUsd: 100,
    openingPhp: 0,
    openingReserveUsd: 120,
    includeIncome: false,
    includeAnnualReserve: false,
    entries: [],
  };
  const rows = buildPlanRows(plan, document, 63);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "bill");
  assert.equal(rows[0].usd, 0);
  assert.equal(rows[0].amount, 120);
  assert.equal(rows[0].grossAmount, 120);
  assert.equal(rows[0].reserveUsed, 120);
  assert.equal(rows[0].reserveDeltaUsd, -120);
  assert.equal(rows[0].balanceUsd, 100);
  assert.equal(rows[0].reserveUsd, 0);
  assert.equal(rows[0].reserveShortfall, 0);
  const shortfall = buildPlanRows(
    { ...plan, openingReserveUsd: 50 },
    document,
    63,
  ).at(-1);
  assert.equal(shortfall.balanceUsd, 30);
  assert.equal(shortfall.reserveShortfall, 70);
});

test("posted records replace matching salary, bills and exact dated manual forecasts once", () => {
  const document = {
    salary: {
      amount: 2600,
      currency: "USD",
      payFrequency: "biweekly",
      firstPayDate: "2026-10-23",
    },
    bills: [
      monthly("Google", 2, "USD", 6),
      annual("Domain", 260, "USD", 6, [11]),
    ],
    allocations: [],
  };
  const plan = {
    startDate: "2026-11-01",
    endDate: "2026-11-10",
    openingUsd: 500,
    openingPhp: 1000,
    includeIncome: true,
    entries: [
      {
        id: "groceries",
        description: "Groceries",
        date: "2026-11-08",
        kind: "expense",
        amount: 630,
        currency: "PHP",
      },
    ],
  };
  const transactions = [
    {
      id: 1,
      merchant: "Company payroll",
      date: "2026-11-05",
      kind: "income",
      amount: 1200,
      currency: "USD",
    },
    {
      id: 2,
      merchant: "Google Workspace",
      date: "2026-11-07",
      kind: "expense",
      amount: 2,
      currency: "USD",
    },
    {
      id: 3,
      merchant: "Domain",
      date: "2026-11-06",
      kind: "expense",
      amount: 260,
      currency: "USD",
    },
    {
      id: 4,
      merchant: "Groceries",
      date: "2026-11-08",
      kind: "expense",
      amount: 630,
      currency: "PHP",
    },
  ];
  const before = JSON.stringify({ plan, document, transactions });
  const rows = buildPlanRows(plan, document, 63, { transactions });
  assert.equal(rows.length, 5);
  assert.equal(rows.filter((row) => row.source === "transaction").length, 4);
  assert.equal(
    rows.filter((row) => ["salary", "bill", "manual"].includes(row.source))
      .length,
    0,
  );
  assert.equal(rows.find((row) => row.source === "reserve").date, "2026-11-05");
  const domain = rows.find((row) => row.transactionId === 3);
  assert.equal(domain.billId, "Domain");
  assert.equal(domain.scheduledSource, "bill");
  assert.equal(domain.reserveShortfall, 0);
  assert.equal(rows.at(-1).balanceUsd, 1438);
  assert.equal(rows.at(-1).balancePhp, 370);
  assert.equal(before, JSON.stringify({ plan, document, transactions }));
});

test("matching does not discard unrelated income or nonmatching user forecasts", () => {
  const document = {
    salary: {
      amount: 2600,
      currency: "USD",
      payFrequency: "biweekly",
      firstPayDate: "2026-10-23",
    },
    bills: [monthly("Google", 2, "USD", 6)],
    allocations: [],
  };
  const plan = {
    startDate: "2026-11-01",
    endDate: "2026-11-10",
    openingUsd: 0,
    includeIncome: true,
    entries: [
      {
        id: "lunch",
        date: "2026-11-06",
        description: "Lunch",
        kind: "expense",
        amount: 10,
        currency: "USD",
      },
    ],
  };
  const transactions = [
    {
      id: 1,
      merchant: "Birthday gift",
      date: "2026-11-06",
      kind: "income",
      amount: 1200,
      currency: "USD",
    },
    {
      id: 2,
      merchant: "Coffee",
      date: "2026-11-06",
      kind: "expense",
      amount: 2,
      currency: "USD",
    },
    {
      id: 3,
      merchant: "Lunch",
      date: "2026-11-07",
      kind: "expense",
      amount: 10,
      currency: "USD",
    },
  ];
  const rows = buildPlanRows(plan, document, 63, { transactions });
  assert.equal(rows.length, 6);
  assert.equal(rows.filter((row) => row.matchedForecast).length, 0);
  assert.equal(rows.at(-1).balanceUsd, 2376);
});

test("plan switches control new funding and records without erasing opening reserve funds", () => {
  const document = {
    salary,
    bills: [annual("Undated", 100, "USD", null, [12])],
    allocations: [
      {
        id: "save",
        name: "Savings",
        amount: 10,
        currency: "USD",
        kind: "savings",
      },
    ],
  };
  const plan = {
    startDate: "2026-11-01",
    endDate: "2026-11-30",
    openingUsd: 100,
    openingReserveUsd: 25,
    includeIncome: false,
    includeTransactions: false,
    includeAnnualReserve: false,
    includeAllocations: false,
    entries: [],
  };
  const transactions = [
    {
      id: 1,
      date: "2026-11-06",
      kind: "expense",
      amount: 1,
      currency: "USD",
      merchant: "Expense",
    },
  ];
  assert.deepEqual(buildPlanRows(plan, document, 63, { transactions }), []);
  const funded = buildPlanRows(
    { ...plan, includeAnnualReserve: true },
    document,
    63,
    { transactions },
  );
  assert.equal(funded.length, 2);
  assert.ok(funded.every((row) => row.source === "reserve"));
  assert.equal(funded.at(-1).reserveUsd, 33.34);
  assert.equal(funded.at(-1).balanceUsd, 91.66);
});

test("reserve funding spreads cents across a complete cycle without rounding drift", () => {
  const document = {
    salary: { ...salary, firstPayDate: "2026-01-06" },
    bills: [annual("Undated", 100, "USD", null, [12])],
    allocations: [],
  };
  const plan = {
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    openingUsd: 100,
    includeIncome: false,
    entries: [],
  };
  const rows = buildPlanRows(plan, document, 63);
  assert.equal(rows.length, 24);
  assert.equal(
    rows.reduce((sum, row) => sum + Math.round(row.amount * 100), 0),
    10000,
  );
  assert.equal(rows.at(-1).reserveUsd, 100);
  assert.equal(rows.at(-1).balanceUsd, 0);
});

test("recorded pending flows stay excluded while dated transfers and future entries stay visible", () => {
  const document = { salary, bills: [], allocations: [] };
  const plan = {
    startDate: "2026-11-01",
    endDate: "2026-11-30",
    openingUsd: 100,
    openingPhp: 0,
    includeIncome: false,
    entries: [],
  };
  const transactions = [
    {
      id: 1,
      date: "2026-11-02",
      kind: "expense",
      amount: 1000,
      currency: "USD",
      pending: true,
      merchant: "Pending",
    },
    {
      id: 2,
      date: "2026-11-02",
      kind: "expense",
      amount: 10,
      currency: "USD",
      category: "Transfer Out",
      merchant: "Transfer",
    },
    {
      id: 3,
      date: "2026-11-02",
      kind: "income",
      amount: 630,
      currency: "PHP",
      category: "Transfer In",
      merchant: "Transfer",
    },
    {
      id: 4,
      date: "2026-11-20",
      kind: "expense",
      amount: 5,
      currency: "USD",
      merchant: "Scheduled expense",
    },
  ];
  const rows = buildPlanRows(plan, document, 63, {
    transactions: [...transactions, transactions[3]],
    today: "2026-11-02",
  });
  assert.equal(rows.length, 3);
  assert.equal(rows.at(-1).scheduled, true);
  assert.equal(rows.at(-1).balanceUsd, 85);
  assert.equal(rows.at(-1).balancePhp, 630);
});

test("recorded annual payments inside the window can use reserves for a due date just outside it", () => {
  const document = {
    salary: { ...salary, firstPayDate: "2026-12-06" },
    bills: [annual("Insurance", 100, "USD", 1, [11])],
    allocations: [],
  };
  const plan = {
    startDate: "2026-11-02",
    endDate: "2026-11-05",
    openingUsd: 50,
    openingReserveUsd: 100,
    includeIncome: false,
    entries: [],
  };
  const rows = buildPlanRows(plan, document, 63, {
    transactions: [
      {
        id: 1,
        date: "2026-11-02",
        merchant: "Insurance",
        kind: "expense",
        amount: 100,
        currency: "USD",
      },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "transaction");
  assert.equal(rows[0].scheduledDate, "2026-11-01");
  assert.equal(rows[0].billId, "Insurance");
  assert.equal(rows[0].usd, 0);
  assert.equal(rows[0].reserveUsed, 100);
  assert.equal(rows[0].balanceUsd, 50);
  assert.equal(rows[0].reserveUsd, 0);
  assert.ok(
    rows.every((row) => row.date >= plan.startDate && row.date <= plan.endDate),
  );
});

test("paychecks shifted across a plan boundary keep their associated set-asides in the window", () => {
  const document = {
    salary: {
      amount: 2600,
      currency: "USD",
      payFrequency: "biweekly",
      firstPayDate: "2026-10-23",
    },
    bills: [annual("Annual", 260, "USD", null, [12])],
    allocations: [
      {
        id: "save",
        name: "Savings",
        amount: 100,
        currency: "USD",
        kind: "savings",
      },
    ],
  };
  const plan = {
    startDate: "2026-11-05",
    endDate: "2026-11-05",
    openingUsd: 0,
    includeIncome: false,
    entries: [],
  };
  const rows = buildPlanRows(plan, document, 63, {
    transactions: [
      {
        id: 1,
        date: "2026-11-05",
        merchant: "Payroll",
        kind: "income",
        amount: 1200,
        currency: "USD",
      },
    ],
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].source, "transaction");
  assert.equal(rows[0].scheduledDate, "2026-11-06");
  assert.equal(rows.at(-1).balanceUsd, 1090);
  assert.equal(rows.at(-1).reserveUsd, 10);
  assert.ok(rows.every((row) => row.date === "2026-11-05"));
});

const annualSavingsPlan = {
  startDate: "2026-11-01",
  endDate: "2026-11-30",
  openingUsd: 500,
  openingPhp: 1000,
  includeIncome: false,
  includeAnnualReserve: false,
  entries: [],
};

test("opening reserves include item savings once and retain only the unassigned legacy remainder", () => {
  assert.deepEqual(getAnnualReserveOpening(), {
    usd: 0,
    php: 0,
    billSavingsUsd: 0,
    billSavingsPhp: 0,
    unassignedUsd: 0,
    unassignedPhp: 0,
  });
  const document = {
    bills: [
      { ...annual("Venture X", 395), savedAmount: 100 },
      { ...annual("Car", 6300, "PHP"), savedAmount: 300 },
      { ...annual("Missing", 100), savedAmount: undefined },
      { ...annual("Invalid", 100), savedAmount: -50 },
      { ...monthly("Monthly", 50), savedAmount: 999 },
    ],
  };
  for (const openingReserveUsd of [0, 50, 100, 150]) {
    assert.deepEqual(
      getAnnualReserveOpening(
        { openingReserveUsd, openingReservePhp: 200 },
        document,
      ),
      {
        usd: Math.max(100, openingReserveUsd),
        php: 300,
        billSavingsUsd: 100,
        billSavingsPhp: 300,
        unassignedUsd: Math.max(0, openingReserveUsd - 100),
        unassignedPhp: 0,
      },
    );
  }
  assert.equal(
    getAnnualReserveOpening({ openingReservePhp: 500 }, document).unassignedPhp,
    200,
  );
});

test("a $395 annual bill with $100 saved shows one $295 cash outflow", () => {
  const document = {
    salary,
    bills: [{ ...annual("Venture X", 395, "USD", 28, [11]), savedAmount: 100 }],
  };
  const before = JSON.stringify({ plan: annualSavingsPlan, document });
  const rows = buildPlanRows(annualSavingsPlan, document, 63);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 395);
  assert.equal(rows[0].grossAmount, 395);
  assert.equal(rows[0].usd, -295);
  assert.equal(rows[0].php, 0);
  assert.equal(rows[0].reserveUsed, 100);
  assert.equal(rows[0].reserveShortfall, 295);
  assert.equal(rows[0].reserveDeltaUsd, -100);
  assert.equal(rows[0].reserveUsd, 0);
  assert.equal(rows[0].balanceUsd, 205);
  assert.equal(before, JSON.stringify({ plan: annualSavingsPlan, document }));
});

test("payday contributions add to each item's saved money before its annual payment", () => {
  const document = {
    salary,
    bills: [{ ...annual("Venture X", 395, "USD", 28, [11]), savedAmount: 100 }],
  };
  const rows = buildPlanRows(
    { ...annualSavingsPlan, includeAnnualReserve: true },
    document,
    63,
  );
  const funding = rows.filter((row) => row.source === "reserve");
  assert.equal(funding.length, 2);
  assert.ok(funding.every((row) => row.amount === 147.5));
  assert.deepEqual(funding[0].reserveAllocations, [
    {
      billId: "Venture X",
      amount: 147.5,
      reserveAccountId: null,
      sourceAccountId: null,
    },
  ]);
  const payment = rows.find((row) => row.annualPayment);
  assert.equal(payment.reserveUsed, 395);
  assert.equal(payment.usd, 0);
  assert.equal(payment.reserveUsd, 0);
  assert.equal(payment.balanceUsd, 205);
});

test("fully funded annual bills skip set-asides until payment then resume funding for renewal", () => {
  const document = {
    salary,
    bills: [{ ...annual("Venture X", 395, "USD", 6, [11]), savedAmount: 395 }],
  };
  const before = JSON.stringify(document);
  const rows = buildPlanRows(
    { ...annualSavingsPlan, includeAnnualReserve: true },
    document,
    63,
  );
  assert.deepEqual(
    rows.map((row) => [row.date, row.source]),
    [
      ["2026-11-06", "bill"],
      ["2026-11-21", "reserve"],
    ],
  );
  assert.equal(rows[0].amount, 395);
  assert.equal(rows[0].reserveUsed, 395);
  assert.equal(rows[0].usd, 0);
  assert.equal(rows[0].reserveUsd, 0);
  assert.equal(rows[1].amount, 16.46);
  assert.deepEqual(rows[1].reserveAllocations, [
    {
      billId: "Venture X",
      amount: 16.46,
      reserveAccountId: null,
      sourceAccountId: null,
    },
  ]);
  assert.equal(rows[1].reserveUsd, 16.46);
  assert.equal(rows[1].balanceUsd, 483.54);
  assert.equal(JSON.stringify(document), before);
});

test("changing saved money rebuilds existing plan funding without stale or zero rows", () => {
  const document = {
    salary,
    bills: [{ ...annual("Venture X", 395, "USD", 28, [11]), savedAmount: 395 }],
  };
  const plan = {
    ...annualSavingsPlan,
    endDate: "2026-11-27",
    includeAnnualReserve: true,
  };
  assert.deepEqual(buildPlanRows(plan, document, 63), []);
  document.bills[0].savedAmount = 100;
  const partial = buildPlanRows(plan, document, 63);
  assert.deepEqual(
    partial.map((row) => row.amount),
    [147.5, 147.5],
  );
  assert.equal(partial.at(-1).reserveUsd, 395);
  assert.equal(partial.at(-1).balanceUsd, 205);
  document.bills[0].savedAmount = 500;
  assert.deepEqual(buildPlanRows(plan, document, 63), []);
  document.bills[0].savedAmount = 0;
  assert.deepEqual(
    buildPlanRows(plan, document, 63).map((row) => row.amount),
    [197.5, 197.5],
  );
});

test("recorded annual payment dates reopen reserve funding after the actual payment", () => {
  const document = {
    salary,
    bills: [{ ...annual("Venture X", 395, "USD", 6, [11]), savedAmount: 395 }],
  };
  const rows = buildPlanRows(
    { ...annualSavingsPlan, includeAnnualReserve: true },
    document,
    63,
    {
      transactions: [
        {
          id: 1,
          date: "2026-11-05",
          merchant: "Venture X",
          kind: "expense",
          amount: 395,
          currency: "USD",
        },
      ],
    },
  );
  assert.equal(rows[0].source, "transaction");
  assert.equal(rows[0].date, "2026-11-05");
  assert.equal(rows[0].grossAmount, 395);
  assert.equal(rows[0].usd, 0);
  assert.deepEqual(
    rows.filter((row) => row.source === "reserve").map((row) => row.date),
    ["2026-11-06", "2026-11-21"],
  );
  assert.equal(rows.at(-1).reserveUsd, 31.6);
});

test("annual bills cannot consume another item's savings, but may use unassigned opening reserves", () => {
  const document = {
    salary,
    bills: [
      { ...annual("Venture X", 395, "USD", 28, [11]), savedAmount: 100 },
      { ...annual("Microsoft", 200, "USD", 9, [12]), savedAmount: 200 },
    ],
  };
  const isolated = buildPlanRows(annualSavingsPlan, document, 63).at(-1);
  assert.equal(isolated.reserveUsed, 100);
  assert.equal(isolated.usd, -295);
  assert.equal(isolated.reserveUsd, 200);
  const withLegacyFunds = buildPlanRows(
    { ...annualSavingsPlan, openingReserveUsd: 350 },
    document,
    63,
  ).at(-1);
  assert.equal(withLegacyFunds.reserveUsed, 150);
  assert.equal(withLegacyFunds.usd, -245);
  assert.equal(withLegacyFunds.reserveUsd, 200);
  const sameOpeningTotal = buildPlanRows(
    { ...annualSavingsPlan, openingReserveUsd: 300 },
    document,
    63,
  ).at(-1);
  assert.equal(sameOpeningTotal.reserveUsed, 100);
  assert.equal(sameOpeningTotal.reserveUsd, 200);
});

test("payday reserves are earmarked for their bill even when another annual bill is due first", () => {
  const document = {
    salary,
    bills: [
      annual("Venture X", 240, "USD", 9, [11]),
      { ...annual("Microsoft", 240, "USD", 9, [12]), savedAmount: 100 },
    ],
  };
  const rows = buildPlanRows(
    { ...annualSavingsPlan, includeAnnualReserve: true },
    document,
    63,
  );
  const payment = rows.find((row) => row.annualPayment);
  assert.equal(payment.reserveUsed, 240);
  assert.equal(payment.usd, 0);
  assert.equal(payment.reserveUsd, 146.67);
  assert.equal(rows.at(-1).reserveUsd, 203.34);
  assert.deepEqual(rows[0].reserveAllocations, [
    {
      billId: "Venture X",
      amount: 240,
      reserveAccountId: null,
      sourceAccountId: null,
    },
    {
      billId: "Microsoft",
      amount: 46.67,
      reserveAccountId: null,
      sourceAccountId: null,
    },
  ]);
});

test("saved annual funds are consumed once across installments and later renewal cycles", () => {
  const document = {
    salary,
    bills: [{ ...annual("Car", 400, "USD", 9, [3, 9]), savedAmount: 300 }],
  };
  const rows = buildPlanRows(
    {
      ...annualSavingsPlan,
      startDate: "2026-01-01",
      endDate: "2027-09-30",
    },
    document,
    63,
  );
  assert.deepEqual(
    rows.map((row) => row.amount),
    [200, 200, 200, 200],
  );
  assert.deepEqual(
    rows.map((row) => row.reserveUsed),
    [200, 100, 0, 0],
  );
  assert.deepEqual(
    rows.map((row) => row.usd),
    [0, -100, -200, -200],
  );
  assert.deepEqual(
    rows.map((row) => row.reserveUsd),
    [100, 0, 0, 0],
  );
  assert.equal(rows.at(-1).balanceUsd, 0);
});

test("funded annual installments wait until their saved pot is consumed before funding the next deadline", () => {
  const document = {
    salary: { ...salary, firstPayDate: "2026-01-06" },
    bills: [
      { ...annual("Car", 480, "USD", 9, [3, 10]), savedAmount: 480 },
      { ...annual("Other reserve", 50, "USD", null, [12]), savedAmount: 50 },
    ],
  };
  const before = JSON.stringify(document);
  const rows = buildPlanRows(
    {
      ...annualSavingsPlan,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      includeAnnualReserve: true,
    },
    document,
    63,
  );
  const payments = rows.filter((row) => row.annualPayment);
  const funding = rows.filter((row) => row.source === "reserve");
  assert.equal(rows[0].date, "2026-03-09");
  assert.equal(rows[0].source, "bill");
  assert.deepEqual(
    payments.map((row) => [row.date, row.amount, row.reserveUsed, row.usd]),
    [
      ["2026-03-09", 240, 240, 0],
      ["2026-10-09", 240, 240, 0],
    ],
  );
  assert.equal(payments[0].reserveUsd, 290);
  assert.equal(payments[0].balanceUsd, 500);
  assert.equal(funding[0].date, "2026-10-21");
  assert.equal(funding[0].reserveUsd, 74);
  assert.equal(funding.length, 5);
  assert.ok(funding.every((row) => row.amount === 24));
  assert.ok(
    funding.every(
      (row) =>
        row.reserveAllocations.length === 1 &&
        row.reserveAllocations[0].billId === "Car",
    ),
  );
  assert.ok(rows.every((row) => row.reserveUsd >= 50 && row.reserveUsd <= 530));
  assert.ok(!funding.some((row) => row.date <= "2026-10-09"));
  assert.equal(payments[1].reserveUsd, 50);
  assert.equal(payments[1].balanceUsd, 500);
  assert.equal(rows.at(-1).reserveUsd, 170);
  assert.equal(rows.at(-1).balanceUsd, 380);
  assert.equal(
    rows.at(-1).balanceUsd + rows.at(-1).reserveUsd,
    500 + 530 - 480,
  );
  assert.equal(JSON.stringify(document), before);
});

test("PHP annual savings offset PHP payments without converting or spending USD reserves", () => {
  const document = {
    salary,
    bills: [
      { ...annual("Insurance", 395, "PHP", 28, [11]), savedAmount: 100 },
      { ...annual("USD reserve", 100, "USD", 9, [12]), savedAmount: 100 },
    ],
  };
  const rows = buildPlanRows(annualSavingsPlan, document, 123);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usd, 0);
  assert.equal(rows[0].php, -295);
  assert.equal(rows[0].reserveDeltaPhp, -100);
  assert.equal(rows[0].reserveUsd, 100);
  assert.equal(rows[0].reservePhp, 0);
  assert.equal(rows[0].balanceUsd, 500);
  assert.equal(rows[0].balancePhp, 705);
});

test("overfunded annual savings carry forward and never create a positive cash payment", () => {
  const document = {
    salary,
    bills: [{ ...annual("Venture X", 395, "USD", 28, [11]), savedAmount: 500 }],
  };
  const rows = buildPlanRows(
    { ...annualSavingsPlan, endDate: "2027-11-30" },
    document,
    63,
  );
  assert.deepEqual(
    rows.map((row) => row.usd),
    [0, -290],
  );
  assert.deepEqual(
    rows.map((row) => row.reserveUsed),
    [395, 105],
  );
  assert.deepEqual(
    rows.map((row) => row.reserveUsd),
    [105, 0],
  );
  assert.equal(rows.at(-1).balanceUsd, 210);
});

test("legacy annual bills with no actual savings retain their full native cash outflow", () => {
  for (const savedAmount of [undefined, 0, -10, "invalid"]) {
    const document = {
      salary,
      bills: [{ ...annual("Venture X", 395, "USD", 28, [11]), savedAmount }],
    };
    const payment = buildPlanRows(annualSavingsPlan, document, 63)[0];
    assert.equal(payment.usd, -395);
    assert.equal(payment.reserveUsed, 0);
    assert.equal(payment.reserveShortfall, 395);
    assert.equal(payment.reserveUsd, 0);
    assert.equal(payment.balanceUsd, 105);
  }
});

test("recorded annual payments match their gross amount then show only unfunded cash without mutating activity", () => {
  const document = {
    salary,
    bills: [{ ...annual("Venture X", 395, "USD", 28, [11]), savedAmount: 100 }],
  };
  const transaction = {
    id: 1,
    date: "2026-11-29",
    merchant: "Venture X",
    kind: "expense",
    amount: 395,
    currency: "USD",
  };
  const before = JSON.stringify({ document, transaction });
  const rows = buildPlanRows(annualSavingsPlan, document, 63, {
    transactions: [transaction, transaction],
    today: "2026-11-30",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "transaction");
  assert.equal(rows[0].billId, "Venture X");
  assert.equal(rows[0].scheduledDate, "2026-11-28");
  assert.equal(rows[0].amount, 395);
  assert.equal(rows[0].grossAmount, 395);
  assert.equal(rows[0].usd, -295);
  assert.equal(rows[0].reserveUsed, 100);
  assert.equal(rows[0].balanceUsd, 205);
  assert.equal(before, JSON.stringify({ document, transaction }));
});

test("per-item contributions preserve each annual total over a complete pay cycle", () => {
  const document = {
    salary: { ...salary, firstPayDate: "2026-01-06" },
    bills: [
      annual("First", 100.01, "USD", null, [12]),
      annual("Second", 395.02, "USD", null, [12]),
      annual("PHP", 633.05, "PHP", null, [12]),
    ],
  };
  const rows = buildPlanRows(
    {
      ...annualSavingsPlan,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      includeAnnualReserve: true,
    },
    document,
    63,
  );
  for (const bill of document.bills) {
    const totalCents = rows
      .flatMap((row) => row.reserveAllocations)
      .filter((allocation) => allocation.billId === bill.id)
      .reduce(
        (sum, allocation) => sum + Math.round(allocation.amount * 100),
        0,
      );
    assert.equal(totalCents, Math.round(bill.amount * 100));
  }
  assert.equal(rows.at(-1).reserveUsd, 495.03);
  assert.equal(rows.at(-1).reservePhp, 633.05);
});

test("26 contributions fund each item's initial remaining cents exactly and stop at capacity", () => {
  const document = {
    salary: { ...salary, payFrequency: "biweekly", firstPayDate: "2026-01-02" },
    bills: [
      {
        ...annual("Partial USD", 395.02, "USD", null, [12]),
        savedAmount: 80.01,
      },
      {
        ...annual("Partial PHP", 633.05, "PHP", null, [12]),
        savedAmount: 200.02,
      },
      { ...annual("Full USD", 100, "USD", null, [12]), savedAmount: 100 },
      { ...annual("Excess PHP", 300, "PHP", null, [12]), savedAmount: 500 },
    ],
  };
  const before = JSON.stringify(document);
  const rows = buildPlanRows(
    {
      ...annualSavingsPlan,
      startDate: "2026-01-01",
      endDate: "2028-12-31",
      includeAnnualReserve: true,
    },
    document,
    63,
  );
  const allocations = rows.flatMap((row) => row.reserveAllocations);
  assert.equal(rows.length, 52);
  assert.ok(rows.every((row) => row.date <= "2026-12-18" && row.amount > 0));
  assert.ok(allocations.every((allocation) => allocation.amount > 0));
  assert.deepEqual(
    [...new Set(allocations.map((allocation) => allocation.billId))].sort(),
    ["Partial PHP", "Partial USD"],
  );
  assert.equal(
    allocations
      .filter((allocation) => allocation.billId === "Partial USD")
      .reduce(
        (sum, allocation) => sum + Math.round(allocation.amount * 100),
        0,
      ),
    31501,
  );
  assert.equal(
    allocations
      .filter((allocation) => allocation.billId === "Partial PHP")
      .reduce(
        (sum, allocation) => sum + Math.round(allocation.amount * 100),
        0,
      ),
    43303,
  );
  assert.equal(rows.at(-1).reserveUsd, 495.02);
  assert.equal(rows.at(-1).reservePhp, 1133.05);
  assert.equal(rows.at(-1).balanceUsd, 184.99);
  assert.equal(rows.at(-1).balancePhp, 566.97);
  assert.equal(JSON.stringify(document), before);
});

const deadlineSalary = {
  amount: 2100,
  currency: "USD",
  payFrequency: "biweekly",
  firstPayDate: "2026-10-23",
};
const deadlineContext = { salary: deadlineSalary, asOf: "2026-11-02" };

test("the saved-target screenshot funds each next deadline using its actual remaining paydays", () => {
  const bills = [
    { ...annual("Microsoft", 100, "USD", 9, [9]), savedAmount: 14.79 },
    { ...annual("Domain", 20, "USD", 4, [6]), savedAmount: 8.27 },
    { ...annual("Venture X", 395, "USD", 28, [11]), savedAmount: 395 },
    { ...annual("Car", 500, "USD", 1, [3, 9]), savedAmount: 85.64 },
  ];
  const document = { salary: deadlineSalary, bills, allocations: [] };
  const before = JSON.stringify(document);
  const summary = getSummary(document, 63, "2026-11-02");
  assert.deepEqual(
    summary.annualFunding.map((bill) => [
      bill.billId,
      bill.nextDueDate,
      bill.installmentAmount,
      bill.remainingForNextPayment,
      bill.paydaysRemaining,
      bill.perPeriodAmount,
    ]),
    [
      ["Microsoft", "2027-09-09", 100, 85.21, 22, 3.88],
      ["Domain", "2027-06-04", 20, 11.73, 16, 0.74],
      ["Venture X", "2026-11-28", 395, 0, 2, 0],
      ["Car", "2027-03-01", 250, 164.36, 9, 18.27],
    ],
  );
  assert.equal(summary.annualUsd, 1015);
  assert.equal(summary.annualSavedUsd, 503.7);
  assert.equal(summary.annualRemainingUsd, 511.3);
  assert.equal(summary.annualPerPeriodUsd, 22.89);
  assert.equal(summary.annualMonthlyUsd, 49.6);
  assert.equal(summary.annualImmediateUsd, 0);
  assert.equal(summary.annualEstimatedCount, 0);
  assert.equal(JSON.stringify(document), before);
});

test("saved edits and due-date edits recalculate contributions rather than restarting a full savings year", () => {
  const bill = {
    ...annual("Venture X", 395, "USD", 28, [11]),
    savedAmount: 100,
  };
  const partial = getAnnualBillFunding(bill, 26, deadlineContext);
  assert.equal(partial.paydaysRemaining, 2);
  assert.equal(partial.perPeriodAmount, 147.5);
  assert.equal(partial.monthlyAmount, 319.58);
  for (const savedAmount of [395, 500]) {
    const funded = getAnnualBillFunding(
      { ...bill, savedAmount },
      26,
      deadlineContext,
    );
    assert.equal(funded.remainingForNextPayment, 0);
    assert.equal(funded.perPeriodAmount, 0);
    assert.equal(funded.monthlyAmount, 0);
  }
  assert.equal(
    getAnnualBillFunding(bill, 26, deadlineContext).perPeriodAmount,
    147.5,
  );
  const later = getAnnualBillFunding(
    { ...bill, dueMonths: [12] },
    26,
    deadlineContext,
  );
  assert.equal(later.paydaysRemaining, 4);
  assert.equal(later.perPeriodAmount, 73.75);
});

test("the next installment can be funded without funding the whole annual amount", () => {
  const bill = { ...annual("Car", 500, "USD", 1, [3, 9]), savedAmount: 250 };
  const funding = getAnnualBillFunding(bill, 26, deadlineContext);
  assert.equal(funding.fullyFunded, false);
  assert.equal(funding.remainingAmount, 250);
  assert.equal(funding.installmentAmount, 250);
  assert.equal(funding.remainingForNextPayment, 0);
  assert.equal(funding.perPeriodAmount, 0);
  const odd = getAnnualBillFunding(
    { ...bill, amount: 100.01, savedAmount: 25 },
    26,
    {
      salary: deadlineSalary,
      asOf: "2027-06-01",
    },
  );
  assert.equal(odd.installmentAmount, 50.01);
  assert.equal(odd.remainingForNextPayment, 25.01);
});

test("annual funding identifies cash needed before any eligible payday", () => {
  const bill = {
    ...annual("Before payday", 395, "USD", 4, [11]),
    savedAmount: 100,
  };
  const funding = getAnnualBillFunding(bill, 26, deadlineContext);
  assert.equal(funding.paydaysRemaining, 0);
  assert.equal(funding.immediateAmount, 295);
  assert.equal(funding.perPeriodAmount, 0);
  assert.equal(funding.monthlyAmount, 0);
  assert.equal(funding.estimated, false);
  assert.equal(funding.fullyFunded, false);
  const summary = getSummary(
    { salary: deadlineSalary, bills: [bill] },
    63,
    "2026-11-02",
  );
  assert.equal(summary.annualImmediateUsd, 295);
  assert.equal(summary.annualImmediatePhp, 18585);
  const rows = buildPlanRows(
    { ...annualSavingsPlan, includeAnnualReserve: true },
    { salary: deadlineSalary, bills: [bill] },
    63,
  );
  assert.equal(rows[0].date, "2026-11-04");
  assert.equal(rows[0].reserveShortfall, 295);
  assert.equal(rows[0].usd, -295);
});

test("missing annual dates or salary schedules retain clearly marked estimates", () => {
  const undated = getAnnualBillFunding(
    annual("Undated", 260, "USD", null),
    26,
    deadlineContext,
  );
  assert.equal(undated.needsDate, true);
  assert.equal(undated.estimated, true);
  assert.equal(undated.perPeriodAmount, 10);
  const noSalary = getAnnualBillFunding(annual("No salary", 260), 26, {
    asOf: "2026-11-02",
  });
  assert.equal(noSalary.needsSchedule, true);
  assert.equal(noSalary.estimated, true);
  assert.equal(noSalary.perPeriodAmount, 10);
  const summary = getSummary(
    { salary: deadlineSalary, bills: [annual("Undated", 260, "USD", null)] },
    63,
    "2026-11-02",
  );
  assert.equal(summary.annualEstimatedCount, 1);
});

test("payday on the due date contributes before the bill is paid", () => {
  const bill = annual("Same day", 12.34, "PHP", 6, [11]);
  const funding = getAnnualBillFunding(bill, 26, {
    ...deadlineContext,
    asOf: "2026-11-06",
  });
  assert.equal(funding.paydaysRemaining, 1);
  assert.equal(funding.perPeriodAmount, 12.34);
  const rows = buildPlanRows(
    { ...annualSavingsPlan, endDate: "2026-11-06", includeAnnualReserve: true },
    { salary: deadlineSalary, bills: [bill] },
    63,
  );
  assert.deepEqual(
    rows.map((row) => row.source),
    ["reserve", "bill"],
  );
  assert.equal(rows[0].php, -12.34);
  assert.equal(rows[1].php, 0);
  assert.equal(rows[1].reserveUsed, 12.34);
  assert.equal(rows[1].reservePhp, 0);
});

test("rolling remaining-payday funding finishes exact cents without overfunding", () => {
  const salary = { ...deadlineSalary, firstPayDate: "2026-11-01" };
  const bill = annual("One dollar", 1, "USD", 30, [11]);
  const rows = buildPlanRows(
    { ...annualSavingsPlan, includeAnnualReserve: true },
    { salary, bills: [bill] },
    63,
  );
  assert.deepEqual(
    rows.filter((row) => row.source === "reserve").map((row) => row.amount),
    [0.34, 0.33, 0.33],
  );
  assert.equal(rows.at(-1).reserveUsed, 1);
  assert.equal(rows.at(-1).usd, 0);
  assert.equal(rows.at(-1).reserveUsd, 0);
  assert.equal(rows.at(-1).balanceUsd, 499);
});

test("deadline funding follows leap dates and salary changes", () => {
  const bill = annual("Leap renewal", 10, "USD", 29, [2]);
  const twiceMonthly = {
    ...deadlineSalary,
    payFrequency: "semimonthly",
    firstPayDate: "2027-01-31",
  };
  const february = getAnnualBillFunding(bill, 24, {
    salary: twiceMonthly,
    asOf: "2027-02-01",
  });
  assert.equal(february.nextDueDate, "2027-02-28");
  assert.equal(february.paydaysRemaining, 2);
  assert.equal(february.perPeriodAmount, 5);
  const leap = getAnnualBillFunding(bill, 24, {
    salary: twiceMonthly,
    asOf: "2028-02-01",
  });
  assert.equal(leap.nextDueDate, "2028-02-29");
  const shifted = getAnnualBillFunding(
    annual("Soon", 100, "USD", 13, [11]),
    26,
    {
      salary: { ...deadlineSalary, firstPayDate: "2026-11-13" },
      asOf: "2026-11-02",
    },
  );
  assert.equal(shifted.paydaysRemaining, 1);
  assert.equal(shifted.perPeriodAmount, 100);
});

test("reconciled early and late annual payments consume the scheduled installment only once", () => {
  const bill = {
    ...annual("Matched renewal", 100, "USD", 6, [11]),
    savedAmount: 100,
  };
  for (const date of ["2026-11-03", "2026-11-09"]) {
    const rows = buildPlanRows(
      { ...annualSavingsPlan, includeAnnualReserve: true },
      { salary: deadlineSalary, bills: [bill] },
      63,
      {
        transactions: [
          {
            id: 1,
            date,
            merchant: bill.name,
            kind: "expense",
            amount: 100,
            currency: "USD",
          },
        ],
      },
    );
    const payment = rows.find((row) => row.annualPayment);
    assert.equal(payment.date, date);
    assert.equal(payment.scheduledDate, "2026-11-06");
    assert.equal(payment.reserveUsed, 100);
    assert.equal(payment.usd, 0);
    assert.equal(rows.filter((row) => row.annualPayment).length, 1);
    const contributions = rows.filter((row) => row.source === "reserve");
    assert.ok(contributions.every((row) => row.date > date));
    assert.ok(contributions.every((row) => row.amount < 5));
  }
});

test("multiple installment cycles are fully funded by each deadline and conserve available plus reserve cash", () => {
  const document = {
    salary: { ...deadlineSalary, firstPayDate: "2026-01-02" },
    bills: [
      { ...annual("Installments", 101.01, "USD", 1, [3, 9]), savedAmount: 10 },
    ],
  };
  const rows = buildPlanRows(
    {
      ...annualSavingsPlan,
      startDate: "2026-01-01",
      endDate: "2027-09-02",
      includeAnnualReserve: true,
    },
    document,
    63,
  );
  const payments = rows.filter((row) => row.annualPayment);
  assert.deepEqual(
    payments.map((row) => row.amount),
    [50.5, 50.51, 50.5, 50.51],
  );
  assert.ok(
    payments.every(
      (row) =>
        row.reserveShortfall === 0 && row.usd === 0 && row.reserveUsd === 0,
    ),
  );
  assert.ok(
    rows.every((row) => row.reserveUsd >= 0 && row.reserveUsd <= 50.51),
  );
  assert.equal(
    roundCents(rows.at(-1).balanceUsd + rows.at(-1).reserveUsd),
    roundCents(500 + 10 - 202.02),
  );
});

function roundCents(value) {
  return Math.round(value * 100) / 100;
}
