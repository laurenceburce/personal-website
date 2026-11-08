import test from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  annualSavingsTarget,
  billDueDays,
  billOccurrences,
  buildPlanRows,
  convert,
  entryOccurrences,
  formatDate,
  getAnnualBillFunding,
  getAnnualReserveOpening,
  getCreditCardObligations,
  getCreditCardPaymentDate,
  getPlanOpening,
  getSummary as summarize,
  localDate,
  salaryOccurrences,
} from "../app/lib/financePlanner.mjs";

const getSummary = (document, rate, asOf = "2026-11-02") =>
  summarize(document, rate, asOf);

function transferFixture() {
  return {
    document: {
      salary: { amount: 0, currency: "USD", payFrequency: "biweekly", firstPayDate: "2026-11-06", accountId: 1 },
      bills: [],
      allocations: [{ id: "saving", name: "Savings", kind: "savings", amount: 500, currency: "USD", sourceAccountId: 1, accountId: 2 }],
    },
    plan: {
      startDate: "2026-11-06", endDate: "2026-11-30", openingUsd: 921.4, openingPhp: 0,
      includeIncome: false, includeAllocations: false, includeAnnualReserve: false, includeTransactions: false,
      entries: [{ id: "move", date: "2026-11-27", description: "Transfer", kind: "transfer", amount: 96.73, currency: "USD", fromAccountId: 2, toAccountId: 1 }],
    },
    accounts: [
      { id: 1, name: "Checking", currency: "USD", type: "checking", nativeCurrentBalance: 921.4 },
      { id: 2, name: "Savings", currency: "USD", type: "savings", nativeCurrentBalance: 246.73 },
    ],
  };
}

function linkedPocketFixture() {
  return {
    document: {
      salary: { amount: 2300, currency: "USD", payFrequency: "biweekly", firstPayDate: "2026-10-23", accountId: 1 },
      bills: [{ id: "annual", name: "Annual renewal", cadence: "annual", amount: 595.26, savedAmount: 503.70,
        currency: "USD", dueDay: 31, dueMonths: [12], sourceAccountId: 2, reserveAccountId: 2, accountId: 1 }],
      allocations: [{ id: "smartly", name: "Smartly Savings", kind: "savings", amount: 500, currency: "USD", sourceAccountId: 1, accountId: 28 }],
    },
    plan: {
      startDate: "2026-11-05", endDate: "2026-11-07", openingUsd: 160.72, openingPhp: 0,
      includeIncome: true, includeTransactions: true, entries: [],
      accountLinks: { availableUsdAccountId: 1, availablePhpAccountId: null, annualReserveUsdAccountId: 2,
        annualReservePhpAccountId: null, savingsUsdAccountId: 28, savingsPhpAccountId: null },
      rowOverrides: [
        { rowId: "salary:2026-11-06", date: "2026-11-06", description: "Salary", amount: 969.67 },
        { rowId: "allocation:smartly:2026-11-06", date: "2026-11-06", description: "Savings", amount: 253.27 },
      ],
    },
    accounts: [
      { id: 1, name: "Checking", currency: "USD", type: "checking", nativeCurrentBalance: 854.23 },
      { id: 2, name: "Savings", currency: "USD", type: "savings", nativeCurrentBalance: 526.59 },
      { id: 28, name: "Smartly Savings", currency: "USD", type: "savings", nativeCurrentBalance: 500 },
    ],
    transactions: [
      { id: 2534, date: "2026-11-06", kind: "income", accountId: 1, currency: "USD", amount: 969.67,
        merchant: "Electronic Deposit 11/06 Maxx Potential", category: "Income" },
      { id: 2533, date: "2026-11-06", kind: "expense", accountId: 1, currency: "USD", amount: 22.89, category: "Transfer Out" },
      { id: 2535, date: "2026-11-06", kind: "income", accountId: 2, currency: "USD", amount: 22.89, category: "Transfer In" },
      { id: 2532, date: "2026-11-06", kind: "expense", accountId: 1, currency: "USD", amount: 253.27, category: "Transfer Out" },
      { id: 2536, date: "2026-11-06", kind: "income", accountId: 28, currency: "USD", amount: 253.27, category: "Transfer In" },
    ],
  };
}

test("linked reserve and Smartly transfers replace their bank legs with one logical row per pocket", () => {
  const { document, plan, accounts, transactions } = linkedPocketFixture();
  const before = JSON.stringify({ document, plan, accounts, transactions });
  const rows = buildPlanRows(plan, document, 63, { accounts, transactions, today: "2026-11-06" });
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((row) => row.source === "transaction").length, 1, "the posted salary remains visible");
  const reserve = rows.find((row) => row.source === "reserve");
  assert.equal(reserve.amount, 22.89);
  assert.deepEqual(reserve.reserveAllocations.map((allocation) => [allocation.sourceAccountId, allocation.reserveAccountId]), [[1, 2]]);
  assert.deepEqual(reserve.recordedTransactions.map((row) => row.transactionId), [2533, 2535]);
  assert.equal(reserve.completionSource, "transaction");
  const savings = rows.find((row) => row.source === "allocation");
  assert.equal(savings.accountId, 28);
  assert.equal(savings.sourceAccountId, 1);
  assert.deepEqual(savings.recordedTransactions.map((row) => row.transactionId), [2532, 2536]);
  assert.equal(savings.completed, true);
  assert.equal(before, JSON.stringify({ document, plan, accounts, transactions }));
});

test("one posted reserve leg remains attached to its task without completing it or becoming available income", () => {
  const { document, plan, accounts, transactions } = linkedPocketFixture();
  const receipt = transactions.find((row) => row.id === 2535);
  const rows = buildPlanRows(plan, document, 63, { accounts, transactions: [receipt], today: "2026-11-06" });
  const reserve = rows.find((row) => row.source === "reserve");
  assert.equal(reserve.completed, false);
  assert.deepEqual(reserve.recordedTransactions.map((row) => row.transactionId), [2535]);
  assert.equal(rows.some((row) => row.transactionId === 2535), false);
});

test("linked transfer matching preserves amount, native account, date, category and posting checks", () => {
  const { document, plan, accounts, transactions } = linkedPocketFixture();
  const debit = transactions.find((row) => row.id === 2533);
  const credit = transactions.find((row) => row.id === 2535);
  for (const patch of [{ amount: 23 }, { accountId: 99 }, { currency: "PHP" }, { date: "2026-11-02" }, { category: "Income" }, { pending: true }]) {
    const rows = buildPlanRows(plan, document, 63, { accounts, transactions: [debit, { ...credit, ...patch }], today: "2026-11-06" });
    const reserve = rows.find((row) => row.source === "reserve");
    assert.equal(reserve.completed, false, JSON.stringify(patch));
    assert.deepEqual(reserve.recordedTransactions.map((row) => row.transactionId), [2533], JSON.stringify(patch));
  }
});

test("bank transfer evidence can explain only one linked recurring savings task", () => {
  const { document, plan, accounts, transactions } = linkedPocketFixture();
  document.allocations.push({ ...document.allocations[0], id: "second", amount: 253.27 });
  const rows = buildPlanRows(plan, document, 63, { accounts, transactions, today: "2026-11-06" });
  const savings = rows.filter((row) => row.source === "allocation");
  assert.equal(savings.length, 2);
  assert.equal(savings.filter((row) => row.recordedTransactions?.length).length, 1);
  assert.equal(savings.filter((row) => row.completionSource === "transaction").length, 1);
});

test("unplanned transfers between linked accounts combine only mutually unambiguous posted pairs", () => {
  const { document, plan, accounts, transactions } = linkedPocketFixture();
  const onlyTransfer = transactions.filter((row) => [2533, 2535].includes(row.id));
  const options = { accounts, transactions: onlyTransfer, today: "2026-11-06" };
  const noForecast = { ...plan, includeIncome: false, includeAnnualReserve: false, includeAllocations: false };
  const rows = buildPlanRows(noForecast, document, 63, options);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "transfer");
  assert.equal(rows[0].source, "transaction");
  assert.deepEqual([rows[0].fromAccountId, rows[0].toAccountId], [1, 2]);
  assert.deepEqual(rows[0].recordedTransactions.map((row) => row.transactionId), [2533, 2535]);
  const ambiguous = buildPlanRows(noForecast, document, 63, { ...options,
    transactions: [...onlyTransfer, { ...onlyTransfer.find((row) => row.kind === "income"), id: 999 }] });
  assert.equal(ambiguous.length, 3);
  assert.ok(ambiguous.every((row) => !row.recordedTransactions));
});

test("bank receipts outside a linked available account never become available income", () => {
  const { document, plan, accounts, transactions } = linkedPocketFixture();
  const rows = buildPlanRows({ ...plan, includeIncome: false, includeAnnualReserve: false, includeAllocations: false }, document, 63, {
    accounts, transactions: transactions.filter((row) => row.kind === "income" && row.accountId !== 1), today: "2026-11-06",
  });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.usd === 0 && row.balanceAppliedUsd === 0));
});

test("hidden recorded flows retain posted salary evidence for linked live account projections", () => {
  const { document, plan, accounts, transactions } = linkedPocketFixture();
  const rows = buildPlanRows({ ...plan, includeTransactions: false }, document, 63, { accounts, transactions, today: "2026-11-06" });
  assert.equal(rows.length, 3);
  assert.equal(rows.find((row) => row.source === "salary").recordedTransactions[0].transactionId, 2534);
  assert.ok(rows.every((row) => row.recordedTransactionsIncluded === false));
  assert.ok(rows.every((row) => row.completionSource === "transaction"));
});

test("explicitly unassigned pocket links cannot silently reuse legacy salary or savings accounts", () => {
  const { document, plan, accounts } = linkedPocketFixture();
  const rows = buildPlanRows({ ...plan, accountLinks: Object.fromEntries(Object.keys(plan.accountLinks).map((key) => [key, null])) },
    document, 63, { accounts, today: "2026-11-06" });
  assert.equal(rows.find((row) => row.source === "salary").accountId, null);
  const savings = rows.find((row) => row.source === "allocation");
  assert.equal(savings.accountId, null);
  assert.equal(savings.sourceAccountId, null);
  assert.deepEqual(rows.find((row) => row.source === "reserve").reserveAllocations.map((allocation) =>
    [allocation.sourceAccountId, allocation.reserveAccountId]), [[null, null]]);
});

test("linked posted reserve receipts keep future bill funding stable after the posting day", () => {
  const { document, plan, accounts, transactions } = linkedPocketFixture();
  const current = { ...plan, endDate: "2026-12-19", openingUsd: 0, startingAccounts: [{ accountId: 1, percentage: 100 }] };
  for (const today of ["2026-11-06", "2026-11-07"]) {
    const rows = buildPlanRows(current, document, 63, { accounts, transactions, today });
    assert.deepEqual(rows.filter((row) => row.source === "reserve" && row.date > "2026-11-06")
      .map((row) => [row.date, row.amount]), [["2026-11-20", 22.89], ["2026-12-04", 22.89], ["2026-12-18", 22.89]], today);
  }
});

test("unique same-day bank funding replaces changed reserve and savings amounts without changing definitions", () => {
  const { document, plan, accounts, transactions } = linkedPocketFixture();
  document.bills[0].savedAmount = 526.59;
  const current = { ...plan, endDate: "2026-12-19", openingUsd: 0, startingAccounts: [{ accountId: 1, percentage: 100 }],
    rowOverrides: plan.rowOverrides.filter((row) => !row.rowId.startsWith("allocation:")) };
  const before = JSON.stringify({ document, current, accounts, transactions });
  for (const today of ["2026-11-06", "2026-11-07"]) {
    const rows = buildPlanRows(current, document, 63, { accounts, transactions, today });
    const firstReserve = rows.find((row) => row.source === "reserve");
    assert.equal(firstReserve.amount, 22.89, today);
    assert.equal(firstReserve.plannedAmount, 17.17, today);
    assert.equal(firstReserve.actualTransferAmount, true, today);
    assert.deepEqual(firstReserve.matchedTransactionIds, [2533, 2535], today);
    assert.deepEqual(rows.filter((row) => row.source === "reserve" && row.date > "2026-11-06").map((row) => row.amount), [22.89, 22.89, 22.89], today);
    const firstSavings = rows.find((row) => row.source === "allocation");
    assert.equal(firstSavings.amount, 253.27, today);
    assert.equal(firstSavings.plannedAmount, 500, today);
    assert.equal(firstSavings.originalAmount, 500, today);
    assert.deepEqual(firstSavings.matchedTransactionIds, [2532, 2536], today);
    assert.equal(rows.filter((row) => row.source === "transaction").length, 1, today);
  }
  assert.equal(before, JSON.stringify({ document, current, accounts, transactions }));
});

test("changed linked funding amounts require unique complete same-day pairs without competing tasks", () => {
  for (const change of ["extra credit", "pending credit", "wrong source", "shifted date", "competing task"]) {
    const { document, plan, accounts, transactions } = linkedPocketFixture();
    document.bills[0].savedAmount = 526.59;
    let records = transactions.filter((row) => [2533, 2535].includes(row.id));
    if (change === "extra credit") records.push({ ...records.find((row) => row.kind === "income"), id: 999, accountId: 99 });
    if (change === "pending credit") records = records.map((row) => row.kind === "income" ? { ...row, pending: true } : row);
    if (change === "wrong source") records = records.map((row) => row.kind === "expense" ? { ...row, accountId: 99 } : row);
    if (change === "shifted date") records = records.map((row) => ({ ...row, date: "2026-11-05" }));
    if (change === "competing task") plan.entries.push({ id: "other", date: "2026-11-06", kind: "transfer", description: "Other reserve transfer",
      amount: 25, currency: "USD", fromAccountId: 1, toAccountId: 2 });
    const rows = buildPlanRows(plan, document, 63, { accounts, transactions: records, today: "2026-11-06" });
    const reserve = rows.find((row) => row.source === "reserve");
    assert.equal(reserve.amount, 17.17, change);
    assert.equal(reserve.actualTransferAmount, undefined, change);
    assert.equal(reserve.recordedTransactions, undefined, change);
  }
});

test("bank reserve funding beyond a bill's remaining capacity stays one recorded transfer with unassigned excess", () => {
  const { document, plan, accounts, transactions } = linkedPocketFixture();
  document.bills[0].savedAmount = 590;
  accounts.find((account) => account.id === 2).nativeCurrentBalance = 612.89;
  const rows = buildPlanRows(plan, document, 63, { accounts,
    transactions: transactions.filter((row) => [2533, 2535].includes(row.id)), today: "2026-11-06" });
  const reserve = rows.find((row) => row.source === "reserve");
  assert.equal(reserve.amount, 22.89);
  assert.deepEqual(reserve.reserveAllocations.map((allocation) => [allocation.billId, allocation.amount]), [["annual", 5.26], [null, 17.63]]);
  assert.deepEqual(reserve.matchedTransactionIds, [2533, 2535]);
  assert.equal(rows.some((row) => row.source === "transaction"), false);
});

test("adaptive savings cannot reuse a bank debit already assigned to a card statement", () => {
  const { document, plan, accounts, transactions } = linkedPocketFixture();
  accounts.push({ id: 3, name: "Travel card", type: "credit", currency: "USD", isLinked: true, nativeCurrentBalance: 253.27,
    creditCardDue: { statementBalance: 253.27, dueDate: "2026-11-06", lastStatementDate: "2026-10-23" } });
  plan.rowOverrides = plan.rowOverrides.filter((row) => !row.rowId.startsWith("allocation:"));
  const records = transactions.filter((transaction) => [2532, 2536].includes(transaction.id))
    .map((transaction) => transaction.kind === "expense" ? { ...transaction, merchant: "Travel card payment" } : transaction);
  const rows = buildPlanRows(plan, document, 63, { accounts, transactions: records, today: "2026-11-06" });
  const payment = rows.find((row) => row.transactionId === 2532);
  assert.equal(payment.matchedForecast.source, "creditCardDue");
  const savings = rows.find((row) => row.source === "allocation");
  assert.equal(savings.amount, 500);
  assert.equal(savings.actualTransferAmount, undefined);
});

test("adaptive savings funding cannot reuse either bank leg already claimed by a scalar forecast", () => {
  for (const claimedKind of ["expense", "income"]) {
    const { document, plan, accounts, transactions } = linkedPocketFixture();
    const records = transactions.filter((row) => [2532, 2536].includes(row.id))
      .map((row) => ({ ...row, merchant: row.kind === "expense" ? "Mobile Banking Transfer Withdrawal" : "Mobile Banking Transfer Deposit" }));
    const claimed = records.find((row) => row.kind === claimedKind);
    const current = { ...plan, includeIncome: false, includeAnnualReserve: false,
      rowOverrides: [], entries: [{ id: "intentional", date: claimed.date, kind: claimed.kind, amount: claimed.amount,
        currency: claimed.currency, accountId: claimed.accountId, description: claimed.merchant }] };
    const rows = buildPlanRows(current, document, 63, { accounts, transactions: records, today: "2026-11-06" });
    const savings = rows.find((row) => row.source === "allocation");
    assert.equal(savings.amount, 500, claimedKind);
    assert.equal(savings.actualTransferAmount, undefined, claimedKind);
    assert.equal(savings.recordedTransactions, undefined, claimedKind);
    const scalar = rows.find((row) => row.matchedForecast?.id === "entry:intentional");
    assert.equal(scalar.transactionId, claimed.id, claimedKind);
    assert.equal(rows.filter((row) => row.recordedTransactions?.some((transaction) => transaction.transactionId === claimed.id)).length, 0, claimedKind);
  }
});

test("adaptive funding cannot claim a debit scheduled for a named expense allocation", () => {
  const { document, plan, accounts, transactions } = linkedPocketFixture();
  document.allocations.push({ id: "other-expense", name: "Mobile Banking Transfer Withdrawal", kind: "expense",
    amount: 253.27, currency: "USD", accountId: 1 });
  const records = transactions.filter((row) => [2532, 2536].includes(row.id))
    .map((row) => ({ ...row, merchant: row.kind === "expense" ? "Mobile Banking Transfer Withdrawal" : "Mobile Banking Transfer Deposit" }));
  const rows = buildPlanRows({ ...plan, includeIncome: false, includeAnnualReserve: false, rowOverrides: [] },
    document, 63, { accounts, transactions: records, today: "2026-11-06" });
  const savings = rows.find((row) => row.source === "allocation" && row.allocationKind === "savings");
  assert.equal(savings.amount, 500);
  assert.equal(savings.actualTransferAmount, undefined);
  assert.equal(savings.recordedTransactions, undefined);
  const expense = rows.find((row) => row.source === "allocation" && row.allocationKind === "expense");
  assert.equal(expense.completed, true);
  assert.deepEqual(expense.recordedTransactions.map((row) => row.transactionId), [2532]);
});

test("a manual transfer releases general savings into available cash and the reverse earmarks cash", () => {
  const { document, plan, accounts } = transferFixture();
  for (const [fromAccountId, toAccountId, delta, ending] of [[2, 1, 96.73, 1018.13], [1, 2, -96.73, 824.67]]) {
    const row = buildPlanRows({ ...plan, entries: [{ ...plan.entries[0], fromAccountId, toAccountId }] }, document, 63,
      { accounts, today: "2026-11-02" })[0];
    assert.equal(row.amount, 96.73);
    assert.equal(row.usd, delta);
    assert.equal(row.balanceAppliedUsd, delta);
    assert.equal(row.balanceUsd, ending);
    assert.equal(row.reserveUsd, 0);
  }
});

test("selected savings opening funds cannot become available twice but later earmarks can be released", () => {
  const { document, plan, accounts } = transferFixture();
  const selected = { ...plan, startingAccounts: [{ accountId: 2, percentage: 100 }] };
  let row = buildPlanRows(selected, document, 63, { accounts, today: "2026-11-02" })[0];
  assert.equal(row.usd, 0);
  assert.equal(row.balanceUsd, 1168.13);
  const rows = buildPlanRows({ ...selected, includeAllocations: true }, document, 63, { accounts, today: "2026-11-02" });
  row = rows.find((item) => item.entryId === "move");
  assert.equal(row.usd, 96.73);
  assert.equal(row.balanceUsd, 264.86);
  const partial = buildPlanRows({ ...plan, openingUsd: 0, startingAccounts: [{ accountId: 2, percentage: 80 }],
    entries: [{ ...plan.entries[0], amount: 300 }] }, document, 63,
  { accounts: [accounts[0], { ...accounts[1], nativeCurrentBalance: 1000 }], today: "2026-11-02" })[0];
  assert.equal(partial.usd, 200);
  assert.equal(partial.balanceUsd, 1000);
});

test("moving available-owned funds through another savings account cannot release them a second time", () => {
  const { document, plan, accounts } = transferFixture();
  const rows = buildPlanRows({ ...plan, openingUsd: 0, startingAccounts: [{ accountId: 2, percentage: 100 }],
    entries: [
      { ...plan.entries[0], id: "between", date: "2026-11-26", amount: 100, fromAccountId: 2, toAccountId: 3 },
      { ...plan.entries[0], amount: 100, fromAccountId: 3 },
    ] }, { ...document, allocations: [...document.allocations,
    { ...document.allocations[0], id: "other", accountId: 3 }] }, 63,
  { accounts: [accounts[0], { ...accounts[1], nativeCurrentBalance: 100 },
    { ...accounts[1], id: 3, nativeCurrentBalance: 0 }], today: "2026-11-02" });
  assert.deepEqual(rows.map((row) => row.usd), [0, 0]);
  assert.equal(rows.at(-1).balanceUsd, 100);
});

test("shared annual savings excludes each earmark once when releasing only uncounted savings", () => {
  const { document, plan, accounts } = transferFixture();
  const annual = { id: "annual", name: "Annual", cadence: "annual", amount: 100, savedAmount: 100,
    currency: "USD", dueDay: 28, dueMonths: [12], reserveAccountId: 2 };
  const row = buildPlanRows({ ...plan, openingUsd: 0, startingAccounts: [{ accountId: 2, percentage: 80 }],
    entries: [{ ...plan.entries[0], amount: 40 }] }, { ...document, bills: [annual] }, 63,
  { accounts: [accounts[0], { ...accounts[1], nativeCurrentBalance: 150 }], today: "2026-11-02" })[0];
  assert.equal(row.usd, 30);
  assert.equal(row.balanceUsd, 50);
  assert.equal(row.reserveUsd, 100);
});

test("manual transfers do not release annual earmarks or turn card payments and invalid accounts into income", () => {
  const { document, plan, accounts } = transferFixture();
  const annual = { id: "annual", name: "Annual", cadence: "annual", amount: 246.73, savedAmount: 246.73,
    currency: "USD", dueDay: 28, dueMonths: [12], reserveAccountId: 2 };
  const annualOnly = buildPlanRows(plan, { ...document, allocations: [], bills: [annual] }, 63,
    { accounts, today: "2026-11-02" })[0];
  assert.equal(annualOnly.usd, 0);
  assert.equal(annualOnly.reserveUsd, 246.73);
  for (const target of [
    { ...accounts[0], type: "credit" },
    { ...accounts[0], type: "loan" },
    { ...accounts[0], isArchived: true },
    { ...accounts[0], currency: "PHP" },
    null,
  ]) {
    const row = buildPlanRows(plan, document, 63, { accounts: [accounts[1], ...(target ? [target] : [])], today: "2026-11-02" })[0];
    assert.equal(row.usd, 0);
    assert.equal(row.balanceUsd, 921.4);
  }
});

test("posted manual transfer legs reflect their pocket shift once for dated and live openings", () => {
  const { document, plan, accounts } = transferFixture();
  const transactions = [
    { id: 101, date: "2026-11-27", amount: 96.73, currency: "USD", kind: "expense", accountId: 2, category: "Transfer" },
    { id: 102, date: "2026-11-27", amount: 96.73, currency: "USD", kind: "income", accountId: 1, category: "Transfer" },
  ];
  const bank = [{ ...accounts[0], nativeCurrentBalance: 1018.13 }, { ...accounts[1], nativeCurrentBalance: 150 }];
  for (const live of [false, true]) {
    const rows = buildPlanRows({ ...plan, includeTransactions: true,
      ...(live ? { openingUsd: 0, startingAccounts: [{ accountId: 1, percentage: 100 }] } : {}) }, document, 63,
    { accounts: bank, transactions, today: "2026-11-27" });
    const task = rows.find((row) => row.kind === "transfer");
    assert.equal(task.completed, true);
    assert.equal(task.usd, 96.73);
    assert.equal(task.reflectedInRecordedTransactions, true);
    assert.equal(task.balanceAppliedUsd, 0);
    assert.equal(rows.find((row) => row.transactionId === 101).usd, 0);
    assert.equal(rows.at(-1).balanceUsd, 1018.13);
  }
  const hidden = buildPlanRows(plan, document, 63, { accounts: bank, transactions, today: "2026-11-27" });
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0].completed, true);
  assert.equal(hidden[0].balanceUsd, 1018.13);
});

test("a single posted transfer leg affects available cash once without completing the two-leg task", () => {
  const { document, plan, accounts } = transferFixture();
  const credit = { id: 102, date: "2026-11-27", amount: 96.73, currency: "USD", kind: "income", accountId: 1, category: "Transfer" };
  for (const live of [false, true]) {
    const rows = buildPlanRows({ ...plan, includeTransactions: true,
      ...(live ? { openingUsd: 0, startingAccounts: [{ accountId: 1, percentage: 100 }] } : {}) }, document, 63,
    { accounts: [{ ...accounts[0], nativeCurrentBalance: 1018.13 }, accounts[1]], transactions: [credit], today: "2026-11-27" });
    const task = rows.find((row) => row.kind === "transfer");
    assert.equal(task.completed, false);
    assert.equal(task.balanceAppliedUsd, 0);
    assert.equal(rows.at(-1).balanceUsd, 1018.13);
  }
  const sourceOnly = buildPlanRows({ ...plan, includeTransactions: true }, document, 63,
    { accounts, transactions: [{ ...credit, id: 101, kind: "expense", accountId: 2 }], today: "2026-11-27" });
  assert.equal(sourceOnly.find((row) => row.source === "transaction").usd, 0);
  assert.equal(sourceOnly.find((row) => row.kind === "transfer").completed, false);
  assert.equal(sourceOnly.at(-1).balanceUsd, 1018.13);
});

test("one partial posted leg cannot satisfy or financially suppress two manual transfers", () => {
  const { document, plan, accounts } = transferFixture();
  const rows = buildPlanRows({ ...plan, includeTransactions: true, entries: [plan.entries[0], { ...plan.entries[0], id: "second" }] }, document, 63,
    { accounts, transactions: [{ id: 102, date: "2026-11-27", amount: 96.73, currency: "USD", kind: "income", accountId: 1, category: "Transfer" }], today: "2026-11-27" });
  assert.equal(rows.filter((row) => row.kind === "transfer" && row.reflectedInRecordedTransactions).length, 1);
  assert.ok(rows.filter((row) => row.kind === "transfer").every((row) => !row.completed));
  assert.equal(rows.at(-1).balanceUsd, 1114.86);
});

test("a posted savings withdrawal remains money in transit even when the current savings balance is zero", () => {
  const { document, plan, accounts } = transferFixture();
  const debit = { id: 101, date: "2026-11-27", amount: 96.73, currency: "USD", kind: "expense", accountId: 2, category: "Transfer" };
  const credit = { ...debit, id: 102, kind: "income", accountId: 1 };
  const bank = [accounts[0], { ...accounts[1], nativeCurrentBalance: 0 }];
  for (const includeTransactions of [false, true]) {
    for (const transactions of [[debit], [debit, credit]]) {
      const rows = buildPlanRows({ ...plan, includeTransactions }, document, 63,
        { accounts: bank, transactions, today: "2026-11-27" });
      assert.equal(rows.find((row) => row.kind === "transfer").usd, 96.73);
      assert.equal(rows.at(-1).balanceUsd, 1018.13);
    }
  }
});

test("dated savings opening ownership uses its historical balance rather than its now-empty bank balance", () => {
  const { document, plan, accounts } = transferFixture();
  const rows = buildPlanRows({ ...plan, accountOpeningBalances: [{ accountId: 2, balance: 96.73 }] }, document, 63,
    { accounts: [accounts[0], { ...accounts[1], nativeCurrentBalance: 0 }], today: "2026-11-28" });
  assert.equal(rows[0].usd, 96.73);
  assert.equal(rows[0].balanceUsd, 1018.13);
});

test("posted-source reconstruction preserves annual reserve deficits instead of releasing earmarked funds", () => {
  const { document, plan, accounts } = transferFixture();
  const annual = { id: "annual", name: "Annual", cadence: "annual", amount: 100, savedAmount: 100,
    currency: "USD", dueDay: 28, dueMonths: [12], reserveAccountId: 2 };
  const rows = buildPlanRows({ ...plan, entries: [{ ...plan.entries[0], amount: 50 }] }, { ...document, bills: [annual] }, 63,
    { accounts: [accounts[0], { ...accounts[1], nativeCurrentBalance: 50 }],
      transactions: [{ id: 101, date: "2026-11-27", amount: 50, currency: "USD", kind: "expense", accountId: 2, category: "Transfer" }], today: "2026-11-27" });
  assert.equal(rows[0].usd, 0);
  assert.equal(rows[0].balanceUsd, 921.4);
  assert.equal(rows[0].reserveUsd, 100);
});

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

test("saved account openings stay fixed through refreshes and replay posted expenses once", () => {
  for (const currency of ["USD", "PHP"]) {
    const plan = {
      startDate: "2026-11-01", endDate: "2026-11-30", openingUsd: 0, openingPhp: 0,
      startingAccounts: [{ accountId: 1, percentage: 100 }],
      accountOpeningBalances: [{ accountId: 1, balance: 200 }],
      includeIncome: false, includeAllocations: false, includeAnnualReserve: false, entries: [],
    };
    const document = { salary: {}, bills: [], allocations: [] };
    const transactions = [{ id: 1, accountId: 1, currency, kind: "expense", amount: 50,
      description: "Groceries", date: "2026-11-02" }];
    for (const nativeCurrentBalance of [200, 150, 90, null]) {
      const accounts = [{ id: 1, name: "Checking", type: "checking", currency, nativeCurrentBalance }];
      const opening = getPlanOpening(plan, accounts, document);
      assert.equal(opening[currency.toLowerCase()], 200);
      assert.equal(opening.contributions[0].isSnapshot, true);
      const rows = buildPlanRows(plan, document, 63, { accounts, transactions, today: "2026-11-08" });
      assert.equal(rows.length, 1);
      assert.equal(rows[0][currency === "USD" ? "balanceUsd" : "balancePhp"], 150);
      assert.equal(rows[0][currency === "USD" ? "balanceAppliedUsd" : "balanceAppliedPhp"], -50);
    }
  }
});

test("saved opening percentages and zero amounts remain stable even when an account is archived", () => {
  const plan = { openingUsd: 25, startingAccounts: [{ accountId: 1, percentage: 80 }, { accountId: 2, percentage: 100 }],
    accountOpeningBalances: [{ accountId: 1, balance: 200 }, { accountId: 2, balance: 0 }] };
  const accounts = [1, 2].map((id) => ({ id, currency: "USD", type: "checking", nativeCurrentBalance: 9000, isArchived: true }));
  assert.equal(getPlanOpening(plan, accounts).usd, 185);
  assert.equal(getPlanOpening(plan, accounts).warnings.length, 0);
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

function electronicSalaryFixture() {
  return {
    document: {
      salary: { amount: 2300, currency: "USD", payFrequency: "biweekly", firstPayDate: "2026-10-23", accountId: 1 },
      bills: [],
      allocations: [],
    },
    plan: {
      startDate: "2026-11-01", endDate: "2026-11-10", openingUsd: 160.72,
      includeIncome: true, includeTransactions: true, includeAnnualReserve: false, includeAllocations: false,
      entries: [],
      rowOverrides: [{ rowId: "salary:2026-11-06", date: "2026-11-06", description: "Salary", amount: 969.67 }],
    },
    transaction: {
      id: 2534, date: "2026-11-06", kind: "income", accountId: 1, currency: "USD",
      amount: 969.67, merchant: "Electronic Deposit 11/06 Maxx Potential", category: "Income",
    },
  };
}

test("an electronic payroll deposit replaces the adjusted salary once and keeps its completion identity", () => {
  const { document, plan, transaction } = electronicSalaryFixture();
  const before = JSON.stringify({ document, plan, transaction });
  const rows = buildPlanRows(plan, document, 63, { transactions: [transaction], today: "2026-11-06" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "transaction");
  assert.equal(rows[0].usd, 969.67);
  assert.equal(rows[0].balanceUsd, 1130.39);
  assert.equal(rows[0].matchedForecast.id, "salary:2026-11-06");
  assert.equal(rows[0].completionKey, "salary:2026-11-06");
  assert.equal(rows[0].completed, true);
  assert.equal(rows[0].completionSource, "transaction");
  assert.equal(before, JSON.stringify({ document, plan, transaction }));
});

test("electronic salary matching preserves its account, currency, amount, date and posting guards", () => {
  const { document, plan, transaction } = electronicSalaryFixture();
  for (const patch of [
    { accountId: 2 }, { accountId: null }, { currency: "PHP" }, { amount: 970 },
    { date: "2026-11-02" }, { date: "2026-11-10" }, { pending: true }, { kind: "expense" },
  ]) {
    const rows = buildPlanRows(plan, document, 63, { transactions: [{ ...transaction, ...patch }], today: "2026-11-10" });
    assert.equal(rows.filter((row) => row.source === "salary").length, 1, JSON.stringify(patch));
    assert.equal(rows.some((row) => row.matchedForecast), false, JSON.stringify(patch));
    assert.equal(rows.find((row) => row.source === "salary").completed, false, JSON.stringify(patch));
  }
});

test("generic deposits, transfers and gifts cannot consume a same-size salary forecast", () => {
  const { document, plan, transaction } = electronicSalaryFixture();
  for (const merchant of ["Mobile Banking Transfer Deposit 11/06 5483", "Deposit", "Birthday gift", "ATM deposit"]) {
    const rows = buildPlanRows(plan, document, 63, {
      transactions: [{ ...transaction, merchant, category: merchant.startsWith("Mobile") ? "Transfer In" : "Income" }],
      today: "2026-11-06",
    });
    assert.equal(rows.filter((row) => row.source === "salary").length, 1, merchant);
    assert.equal(rows.some((row) => row.matchedForecast), false, merchant);
    assert.equal(rows.at(-1).balanceUsd, 2100.06, merchant);
  }
});

test("only one electronic deposit replaces each payday and other recorded income is retained", () => {
  const { document, plan, transaction } = electronicSalaryFixture();
  const rows = buildPlanRows(plan, document, 63, {
    transactions: [transaction, { ...transaction, id: 2538 }], today: "2026-11-06",
  });
  assert.equal(rows.filter((row) => row.source === "salary").length, 0);
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((row) => row.matchedForecast).length, 1);
  assert.equal(rows.at(-1).balanceUsd, 2100.06);
});

test("early or late electronic salary deposits move payday funding to the actual posting date once", () => {
  const { document, plan, transaction } = electronicSalaryFixture();
  document.bills = [annual("Renewal", 260, "USD", 30, [11])];
  document.allocations = [{ id: "save", name: "Savings", kind: "savings", amount: 100, currency: "USD" }];
  for (const date of ["2026-11-03", "2026-11-09"]) {
    const rows = buildPlanRows({ ...plan, includeAnnualReserve: true, includeAllocations: true }, document, 63, {
      transactions: [{ ...transaction, date }], today: "2026-11-10",
    });
    assert.equal(rows.filter((row) => row.source === "salary").length, 0, date);
    assert.equal(rows.filter((row) => row.source === "reserve").length, 1, date);
    assert.equal(rows.filter((row) => row.source === "allocation").length, 1, date);
    assert.ok(rows.every((row) => row.date === date), date);
    assert.equal(rows[0].balanceUsd, 1130.39, date);
  }
});

test("a hidden electronic salary deposit completes the forecast without adding its cash flow twice", () => {
  const { document, plan, transaction } = electronicSalaryFixture();
  const rows = buildPlanRows({ ...plan, includeTransactions: false }, document, 63, {
    transactions: [transaction], today: "2026-11-06",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "salary");
  assert.equal(rows[0].completionSource, "transaction");
  assert.deepEqual(rows[0].matchedTransactionIds, [2534]);
  assert.equal(rows[0].balanceUsd, 1130.39);
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

function cardStatementFixture() {
  return {
    plan: { startDate: "2026-11-01", endDate: "2026-12-31", openingUsd: 1000, openingPhp: 10000,
      includeIncome: false, includeAllocations: false, includeAnnualReserve: false, entries: [] },
    document: { salary: {}, bills: [], allocations: [] },
    accounts: [
      { id: 1, name: "Checking", type: "checking", currency: "USD", nativeCurrentBalance: 1000 },
      { id: 2, name: "Travel Card", institutionName: "Example Bank", mask: "1234", type: "credit", currency: "USD", nativeCurrentBalance: 500,
        creditCardDue: { statementBalance: 200, minimumPayment: 25, dueDate: "2026-11-20", lastStatementDate: "2026-10-25" } },
    ],
  };
}

test("entered manual card statements use the full native balance and saved autopay date", () => {
  for (const currency of ["USD", "PHP"]) {
    const { plan, document, accounts } = cardStatementFixture();
    const card = { ...accounts[1], currency, isLinked: false, creditCardDueStatus: "manual", nativeCurrentBalance: 14930.79,
      creditCardAutopayEnabled: true, creditCardAutopayDaysBeforeDue: 7,
      creditCardDue: { statementBalance: 14930.79, minimumPayment: 500, dueDate: "2026-11-20", lastStatementDate: "2026-10-25" } };
    const before = JSON.stringify(card);
    const rows = buildPlanRows({ ...plan, openingUsd: 20000, openingPhp: 20000 }, document, 63, { accounts: [card], today: "2026-11-08" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].manualStatement, true);
    assert.equal(rows[0].date, "2026-11-13");
    assert.equal(rows[0].dueDate, "2026-11-20");
    assert.equal(rows[0].amount, 14930.79);
    assert.equal(rows[0][currency === "USD" ? "balanceUsd" : "balancePhp"], 5069.21);
    assert.equal(rows[0].completed, false);
    assert.equal(JSON.stringify(card), before);
  }
});

test("manual cards only estimate unbilled funds when entered statement details identify a cycle", () => {
  const { accounts } = cardStatementFixture();
  const card = { ...accounts[1], isLinked: false, creditCardDueStatus: "manual", nativeCurrentBalance: 350,
    creditCardDue: { statementBalance: 200, dueDate: "2026-11-20", lastStatementDate: "2026-10-25" } };
  const rows = getCreditCardObligations([card], { today: "2026-11-08" });
  assert.deepEqual(rows.map((row) => [row.date, row.amount, Boolean(row.estimated), row.manualStatement]), [
    ["2026-11-20", 200, false, true], ["2026-12-20", 150, true, true],
  ]);
  assert.deepEqual(getCreditCardObligations([{ ...card, creditCardDue: null }], { today: "2026-11-08" }), []);
  const zero = getCreditCardObligations([{ ...card, nativeCurrentBalance: 0,
    creditCardDue: { ...card.creditCardDue, statementBalance: 0 } }], { today: "2026-11-08" });
  assert.deepEqual(zero, []);
  const zeroStatementWithNewPurchases = getCreditCardObligations([{ ...card, nativeCurrentBalance: 150,
    creditCardAutopayEnabled: true, creditCardAutopayDaysBeforeDue: 7,
    creditCardDue: { statementBalance: 0, dueDate: "2026-11-20", lastStatementDate: null } }], { today: "2026-11-08" });
  assert.deepEqual(zeroStatementWithNewPurchases.map((row) => [row.date, row.dueDate, row.amount, row.estimated]), [
    ["2026-12-13", "2026-12-20", 150, true],
  ]);
});

test("posted manual card payments reduce the entered statement once even before the visible plan", () => {
  const { plan, document, accounts } = cardStatementFixture();
  accounts[1] = { ...accounts[1], isLinked: false, creditCardDueStatus: "manual", nativeCurrentBalance: 150,
    creditCardAutopayEnabled: true, creditCardAutopayDaysBeforeDue: 7 };
  const transactions = [
    { id: 1, date: "2026-11-03", kind: "expense", accountId: 1, amount: 50, currency: "USD", merchant: "Travel Card payment 1234", category: "Transfer Out" },
    { id: 2, date: "2026-11-03", kind: "income", accountId: 2, amount: 50, currency: "USD", merchant: "Card payment", category: "Transfer In" },
  ];
  const rows = buildPlanRows({ ...plan, startDate: "2026-11-08" }, document, 63,
    { accounts, transactions: [], creditCardPaymentTransactions: transactions, today: "2026-11-08" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 150);
  assert.equal(rows[0].paidAmount, 50);
  assert.equal(rows[0].balanceUsd, 850);
  assert.equal(rows[0].manualStatement, true);
  assert.equal(rows[0].date, "2026-11-13");
});

test("credit card autopay uses calendar days with a seven-day default and keeps the bank due date", () => {
  const card = { creditCardAutopayEnabled: true, creditCardDue: { dueDate: "2026-11-20" } };
  assert.equal(getCreditCardPaymentDate(card), "2026-11-13");
  assert.equal(getCreditCardPaymentDate({ ...card, creditCardAutopayEnabled: false }), "2026-11-20");
  assert.equal(getCreditCardPaymentDate({ ...card, creditCardAutopayDaysBeforeDue: 0 }), "2026-11-20");
  assert.equal(getCreditCardPaymentDate(card, "2026-01-03"), "2025-12-27");
  assert.equal(getCreditCardPaymentDate(card, "2028-03-03"), "2028-02-25");
  assert.equal(getCreditCardPaymentDate({ ...card, creditCardAutopayDaysBeforeDue: 31 }, "2026-03-03"), "2026-01-31");
  for (const value of [-1, 32, 1.5, "7", null])
    assert.equal(getCreditCardPaymentDate({ ...card, creditCardAutopayDaysBeforeDue: value }), "2026-11-13");
  assert.equal(getCreditCardPaymentDate(card, "2026-11-31"), "");
  assert.equal(card.creditCardDue.dueDate, "2026-11-20");
});

test("autopay shifts statement and estimated cash flow while preserving statement identity and amounts", () => {
  const { plan, document, accounts } = cardStatementFixture();
  const before = JSON.stringify(accounts);
  const baseline = getCreditCardObligations(accounts, { today: "2026-11-05" });
  const linked = [accounts[0], { ...accounts[1], isLinked: true, creditCardAutopayEnabled: true,
    creditCardAutopayDaysBeforeDue: 7 }];
  const rows = buildPlanRows(plan, document, 63, { accounts: linked, today: "2026-11-05" });
  assert.deepEqual(rows.map((row) => [row.id, row.date, row.dueDate, row.amount, Boolean(row.estimated)]), [
    ["creditCardDue:2:2026-11-20", "2026-11-13", "2026-11-20", 200, false],
    ["creditCardDue:2:2026-12-20", "2026-12-13", "2026-12-20", 300, true],
  ]);
  assert.equal(rows[0].id, baseline[0].id);
  assert.equal(rows[0].autopayEnabled, true);
  assert.equal(rows[0].autopayDaysBeforeDue, 7);
  assert.equal(rows[0].balanceUsd, 800);
  assert.equal(rows[1].balanceUsd, 500);
  const early = buildPlanRows({ ...plan, endDate: "2026-11-13" }, document, 63, { accounts: linked, today: "2026-11-05" });
  assert.equal(early.length, 1);
  assert.equal(early[0].date, "2026-11-13");
  assert.deepEqual(buildPlanRows({ ...plan, endDate: "2026-11-12" }, document, 63,
    { accounts: linked, today: "2026-11-05" }), []);
  assert.equal(JSON.stringify(accounts), before);
});

test("early posted autopay is recognized without a statement close and leaves only the unpaid remainder", () => {
  const { plan, document, accounts } = cardStatementFixture();
  accounts[1] = { ...accounts[1], nativeCurrentBalance: 0, creditCardAutopayEnabled: true, creditCardAutopayDaysBeforeDue: 7,
    creditCardDue: { statementBalance: 200, dueDate: "2026-11-20" } };
  const transactions = [
    { id: 1, date: "2026-11-13", kind: "expense", accountId: 1, currency: "USD", amount: 200, merchant: "Travel Card autopay 1234", category: "Transfer Out" },
    { id: 2, date: "2026-11-13", kind: "income", accountId: 2, currency: "USD", amount: 200, merchant: "Automatic payment", category: "Transfer In" },
  ];
  const rows = buildPlanRows(plan, document, 63, { accounts, transactions, today: "2026-11-14" });
  const due = rows.find((row) => row.source === "creditCardDue");
  assert.equal(due.amount, 0);
  assert.equal(due.paidAmount, 200);
  assert.equal(due.completed, true);
  assert.equal(rows.at(-1).balanceUsd, 800);
  const pending = getCreditCardObligations(accounts, { transactions: transactions.map((row) => ({ ...row, pending: true })), today: "2026-11-14" });
  assert.equal(pending[0].amount, 200);
});

test("autopay defaults do not apply a second early payment to an unissued estimate", () => {
  const { plan, document, accounts } = cardStatementFixture();
  accounts[1] = { ...accounts[1], isLinked: true, nativeCurrentBalance: 300,
    creditCardAutopayEnabled: true, creditCardAutopayDaysBeforeDue: 7,
    creditCardDue: { statementBalance: 0, dueDate: "2026-12-20" } };
  const rows = buildPlanRows(plan, document, 63, { accounts, today: "2026-11-05" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].estimated, true);
  assert.equal(rows[0].date, "2026-12-13");
  assert.equal(rows[0].dueDate, "2026-12-20");
  assert.equal(rows[0].amount, 300);
});

test("known next-cycle estimates roll forward after their autopay date passes", () => {
  const { accounts } = cardStatementFixture();
  const card = { ...accounts[1], isLinked: true, creditCardAutopayEnabled: true, creditCardAutopayDaysBeforeDue: 7,
    creditCardDue: { statementBalance: 200, dueDate: "2026-10-20", lastStatementDate: "2026-09-25" } };
  const estimate = getCreditCardObligations([card], { today: "2026-11-15" }).find((row) => row.estimated);
  assert.equal(estimate.date, "2026-12-13");
  assert.equal(estimate.dueDate, "2026-12-20");
  const shortMonth = { ...card, creditCardAutopayDaysBeforeDue: 31,
    creditCardDue: { statementBalance: 200, dueDate: "2026-01-01", lastStatementDate: "2025-12-05" } };
  const next = getCreditCardObligations([shortMonth], { today: "2026-01-31" }).find((row) => row.estimated);
  assert.equal(next.date, "2026-03-01");
  assert.equal(next.dueDate, "2026-04-01");
});

test("a linked Venture X balance with no issued statement appears once on its reported future due date", () => {
  const { plan, document, accounts } = cardStatementFixture();
  accounts[1] = { ...accounts[1], name: "Venture X", isLinked: true, nativeCurrentBalance: 1380.16,
    creditCardDue: { statementBalance: 0, minimumPayment: 0, dueDate: "2026-12-18", lastStatementDate: null } };
  const before = JSON.stringify(accounts);
  const obligations = getCreditCardObligations(accounts, { today: "2026-11-05" });
  assert.equal(obligations.length, 1);
  assert.equal(obligations[0].estimated, true);
  assert.equal(obligations[0].estimatedBalance, 1380.16);
  assert.equal(obligations[0].statementBalance, null);
  assert.equal(obligations[0].estimateDateIsReported, true);
  assert.deepEqual(obligations[0].paymentTransactionIds, []);
  assert.deepEqual(buildPlanRows({ ...plan, startDate: "2026-11-06", endDate: "2026-12-04" }, document, 63,
    { accounts, today: "2026-11-05" }), []);
  const rows = buildPlanRows({ ...plan, startDate: "2026-11-06", endDate: "2027-11-05" }, document, 63,
    { accounts, today: "2026-11-05" });
  assert.deepEqual(rows.map((row) => [row.id, row.date, row.amount, row.usd, row.completed]), [
    ["creditCardDue:2:2026-12-18", "2026-12-18", 1380.16, -1380.16, false],
  ]);
  assert.equal(JSON.stringify(accounts), before);
});

test("unbilled debt subtracts the remaining paid statement before a separate next-cycle estimate", () => {
  const { plan, document, accounts } = cardStatementFixture();
  accounts[1] = { ...accounts[1], isLinked: true,
    creditCardDue: { ...accounts[1].creditCardDue, lastPaymentDate: "2026-11-03", lastPaymentAmount: 50 } };
  const rows = buildPlanRows(plan, document, 63, { accounts, today: "2026-11-05" });
  assert.deepEqual(rows.map((row) => [row.date, row.amount, row.paidAmount, Boolean(row.estimated)]), [
    ["2026-11-20", 150, 50, false], ["2026-12-20", 350, 0, true],
  ]);
  assert.equal(rows.at(-1).balanceUsd, 500);
  const laterPlan = buildPlanRows({ ...plan, startDate: "2026-12-01" }, document, 63, { accounts, today: "2026-11-05" });
  assert.equal(laterPlan[0].amount, 350);
  assert.equal(laterPlan[0].estimateDateIsReported, false);
  assert.equal(laterPlan[0].statementBalance, null);
});

test("an issued zero statement uses the next cycle while an unknown statement uses a future reported due", () => {
  const { accounts } = cardStatementFixture();
  const card = { ...accounts[1], isLinked: true, nativeCurrentBalance: 100 };
  const zero = getCreditCardObligations([{ ...card,
    creditCardDue: { statementBalance: 0, dueDate: "2026-11-20", lastStatementDate: "2026-10-25" } }], { today: "2026-11-05" });
  assert.deepEqual(zero.map((row) => [row.date, row.amount, row.estimateDateIsReported]), [["2026-12-20", 100, false]]);
  const unknown = getCreditCardObligations([{ ...card,
    creditCardDue: { statementBalance: null, dueDate: "2026-12-18", lastStatementDate: "2026-10-25" } }], { today: "2026-11-05" });
  assert.deepEqual(unknown.map((row) => [row.date, row.amount, row.estimateDateIsReported]), [["2026-12-18", 100, true]]);
});

test("estimated monthly due dates clamp short months and roll past anchors without repeating debt", () => {
  const { accounts } = cardStatementFixture();
  const card = { ...accounts[1], isLinked: true,
    creditCardDue: { statementBalance: 200, dueDate: "2026-01-31", lastStatementDate: "2026-01-05" } };
  let estimates = getCreditCardObligations([card], { today: "2026-01-20" }).filter((row) => row.estimated);
  assert.deepEqual(estimates.map((row) => [row.date, row.amount]), [["2026-02-28", 300]]);
  estimates = getCreditCardObligations([card], { today: "2026-03-01" }).filter((row) => row.estimated);
  assert.deepEqual(estimates.map((row) => [row.date, row.amount]), [["2026-03-31", 300]]);
  card.creditCardDue.dueDate = "2028-01-31";
  card.creditCardDue.lastStatementDate = "2028-01-05";
  assert.equal(getCreditCardObligations([card], { today: "2028-01-20" }).find((row) => row.estimated).date, "2028-02-29");
});

test("unavailable, zero, negative and unlinked current balances cannot create a speculative card payment", () => {
  const { accounts } = cardStatementFixture();
  const card = { ...accounts[1], isLinked: true,
    creditCardDue: { statementBalance: 0, dueDate: "2026-12-18" } };
  for (const nativeCurrentBalance of [null, undefined, "", 0, -10, Number.NaN])
    assert.deepEqual(getCreditCardObligations([{ ...card, nativeCurrentBalance }], { today: "2026-11-05" }), []);
  for (const change of [
    { isLinked: false }, { isLinked: undefined }, { isArchived: true }, { mergedIntoAccountId: 4 },
    { creditCardDue: { statementBalance: 0, dueDate: null } },
    { creditCardDue: { statementBalance: 0, dueDate: "2026-11-31" } },
    { creditCardDue: { statementBalance: 0, dueDate: "2026-10-18" } },
    { creditCardDue: { statementBalance: -10, dueDate: "2026-12-18" } },
  ]) assert.deepEqual(getCreditCardObligations([{ ...card, ...change }], { today: "2026-11-05" }), []);
});

test("planned card transfers split once between the current statement and next-cycle balance", () => {
  const { plan, document, accounts } = cardStatementFixture();
  accounts[1] = { ...accounts[1], isLinked: true };
  const entry = { id: "pay", date: "2026-11-18", description: "Pay card", kind: "transfer",
    fromAccountId: 1, toAccountId: 2, amount: 250, currency: "USD" };
  const rows = buildPlanRows({ ...plan, entries: [entry] }, document, 63, { accounts, today: "2026-11-05" });
  assert.deepEqual(rows.filter((row) => row.source === "creditCardDue").map((row) => [row.amount, row.plannedPaymentAmount]), [[0, 200], [250, 50]]);
  assert.equal(rows.at(-1).balanceUsd, 500);
  assert.equal(rows.find((row) => row.estimated).completed, false);
  const late = buildPlanRows({ ...plan, entries: [{ ...entry, date: "2026-11-25" }] }, document, 63, { accounts, today: "2026-11-05" });
  assert.deepEqual(late.filter((row) => row.source === "creditCardDue").map((row) => [row.amount, row.plannedPaymentAmount]), [[200, 0], [50, 250]]);
  assert.equal(late.at(-1).balanceUsd, 500);
});

test("bank-reflected transfers and purchases do not reduce or charge an estimate twice", () => {
  const { plan, document, accounts } = cardStatementFixture();
  accounts[1] = { ...accounts[1], isLinked: true, nativeCurrentBalance: 450 };
  const entry = { id: "paid", date: "2026-11-03", description: "Pay card", kind: "transfer",
    fromAccountId: 1, toAccountId: 2, amount: 50, currency: "USD" };
  const rows = buildPlanRows({ ...plan, entries: [entry] }, document, 63, { accounts, today: "2026-11-05", transactions: [
    { id: 1, date: "2026-11-03", amount: 50, currency: "USD", kind: "income", accountId: 2, category: "Transfer In" },
    { id: 2, date: "2026-11-03", amount: 50, currency: "USD", kind: "expense", accountId: 1, category: "Transfer Out" },
    { id: 3, date: "2026-11-04", amount: 30, currency: "USD", kind: "expense", accountId: 2, merchant: "Market" },
  ] });
  assert.deepEqual(rows.filter((row) => row.source === "creditCardDue").map((row) => [row.amount, row.plannedPaymentAmount]), [[150, 0], [300, 0]]);
  assert.equal(rows.find((row) => row.transactionId === 3).usd, 0);
  assert.equal(rows.at(-1).balanceUsd, 500);
});

test("an issued statement replaces the prior estimate with the same dated payment identity", () => {
  const { plan, document, accounts } = cardStatementFixture();
  const card = { ...accounts[1], isLinked: true, nativeCurrentBalance: 1380.16,
    creditCardDue: { statementBalance: 0, dueDate: "2026-12-18" } };
  const estimated = buildPlanRows(plan, document, 63, { accounts: [card], today: "2026-11-05" });
  card.creditCardDue = { statementBalance: 1380.16, dueDate: "2026-12-18", lastStatementDate: "2026-11-23" };
  const issued = buildPlanRows(plan, document, 63, { accounts: [card], today: "2026-11-24" });
  assert.equal(estimated.length, 1);
  assert.equal(issued.length, 1);
  assert.equal(issued[0].id, estimated[0].id);
  assert.equal(issued[0].amount, 1380.16);
  assert.equal(Boolean(issued[0].estimated), false);
});

test("same-day posted transfers cannot pay an unissued estimate a second time", () => {
  const { plan, document, accounts } = cardStatementFixture();
  for (const statementBalance of [0, null]) {
    const linked = [accounts[0], { ...accounts[1], isLinked: true, nativeCurrentBalance: 1000,
      creditCardDue: { statementBalance, dueDate: "2026-12-18" } }];
    const rows = buildPlanRows({ ...plan, entries: [
      { id: "paid-today", date: "2026-11-05", description: "Pay card", kind: "transfer",
        fromAccountId: 1, toAccountId: 2, amount: 300, currency: "USD" },
    ] }, document, 63, { accounts: linked, today: "2026-11-05", transactions: [
      { id: 1, date: "2026-11-05", amount: 300, currency: "USD", kind: "income", accountId: 2, category: "Debt", merchant: "Automatic payment" },
      { id: 2, date: "2026-11-05", amount: 300, currency: "USD", kind: "expense", accountId: 1, category: "Debt", merchant: "Travel Card payment" },
    ] });
    const estimate = rows.find((row) => row.estimated);
    assert.equal(estimate.amount, 1000);
    assert.equal(estimate.plannedPaymentAmount, 0);
    assert.equal(estimate.paidAmount, 0);
    assert.deepEqual(estimate.paymentTransactionIds, []);
    assert.equal(rows.find((row) => row.entryId === "paid-today").completed, true);
    assert.equal(rows.at(-1).balanceUsd, -300);
  }
});

test("linked full statement dues appear once on their actual dates in each native currency", () => {
  const { plan, document, accounts } = cardStatementFixture();
  const input = [...accounts, { ...accounts[1], id: 3, name: "PHP Card", currency: "PHP",
    creditCardDue: { statementBalance: 3250.25, minimumPayment: 100, dueDate: "2026-11-30" } }];
  const before = JSON.stringify(input);
  const rows = buildPlanRows(plan, document, 63, { accounts: input, today: "2026-11-04" });
  assert.deepEqual(rows.map((row) => [row.id, row.date, row.amount, row.usd, row.php]), [
    ["creditCardDue:2:2026-11-20", "2026-11-20", 200, -200, 0],
    ["creditCardDue:3:2026-11-30", "2026-11-30", 3250.25, 0, -3250.25],
  ]);
  assert.equal(rows[0].editable, false);
  assert.equal(rows[0].accountId, null);
  assert.equal(rows[0].creditAccountId, 2);
  assert.equal(rows.at(-1).balanceUsd, 800);
  assert.equal(rows.at(-1).balancePhp, 6749.75);
  assert.equal(JSON.stringify(input), before);
});

test("missing, invalid, zero, removed and out-of-range statements never use the current balance or minimum", () => {
  const { plan, document, accounts } = cardStatementFixture();
  for (const change of [
    { creditCardDue: null },
    { creditCardDue: { statementBalance: null, minimumPayment: 20, dueDate: "2026-11-20" } },
    { creditCardDue: { statementBalance: "", dueDate: "2026-11-20" } },
    { creditCardDue: { statementBalance: 200, dueDate: "2026-11-31" } },
    { creditCardDue: { statementBalance: 200, dueDate: "2027-01-20" } },
    { creditCardDue: { statementBalance: 0, dueDate: "2026-11-20" } },
    { creditCardDue: { statementBalance: -20, dueDate: "2026-11-20" } },
    { isArchived: true }, { mergedIntoAccountId: 5 }, { currency: "CAD" }, { type: "loan" },
  ]) assert.deepEqual(buildPlanRows(plan, document, 63, { accounts: [{ ...accounts[1], ...change }] }), []);
});

test("credit purchases and card-billed plans change debt while statement dues alone consume available cash", () => {
  const { plan, document, accounts } = cardStatementFixture();
  const rows = buildPlanRows(plan, { ...document, bills: [
    { id: "streaming", name: "Streaming", cadence: "monthly", amount: 10, currency: "USD", dueDay: 10, accountId: 2 },
  ] }, 63, { accounts, today: "2026-11-04", transactions: [
    { id: 10, date: "2026-11-02", amount: 40, currency: "USD", kind: "expense", accountId: 2, category: "Groceries", merchant: "Market" },
    { id: 11, date: "2026-11-03", amount: 5, currency: "USD", kind: "income", accountId: 2, category: "Shopping", merchant: "Refund" },
  ] });
  assert.ok(rows.filter((row) => row.source !== "creditCardDue").every((row) => row.cardCreditActivity && row.usd === 0));
  assert.equal(rows.at(-1).balanceUsd, 800);
  // Existing behavior is preserved when a card has no usable statement data.
  const withoutDues = buildPlanRows(plan, document, 63, { accounts: [accounts[0], { ...accounts[1], creditCardDue: null }],
    transactions: [{ id: 10, date: "2026-11-02", amount: 40, currency: "USD", kind: "expense", accountId: 2 }] });
  assert.equal(withoutDues.at(-1).balanceUsd, 960);
});

test("posted partial card payments reduce the remaining statement once despite both transfer legs and shifted provider dates", () => {
  const { plan, document, accounts } = cardStatementFixture();
  accounts[1].creditCardDue = { ...accounts[1].creditCardDue, lastPaymentAmount: 50, lastPaymentDate: "2026-11-05" };
  const transactions = [
    { id: 10, date: "2026-11-02", amount: 30, currency: "USD", kind: "income", accountId: 2, category: "Transfer In" },
    { id: 11, date: "2026-11-02", amount: 30, currency: "USD", kind: "expense", accountId: 1, category: "Loan Payments" },
    { id: 12, date: "2026-11-04", amount: 50, currency: "USD", kind: "income", accountId: 2, merchant: "Automatic payment" },
    { id: 13, date: "2026-11-04", amount: 50, currency: "USD", kind: "expense", accountId: 1, category: "Transfer Out" },
  ];
  const rows = buildPlanRows(plan, document, 63, { accounts, transactions, today: "2026-11-06" });
  const due = rows.find((row) => row.source === "creditCardDue");
  assert.equal(due.statementBalance, 200);
  assert.equal(due.paidAmount, 80);
  assert.equal(due.amount, 120);
  assert.equal(due.completed, false);
  assert.deepEqual(due.paymentTransactionIds, [10, 12, 11, 13]);
  assert.equal(rows.at(-1).balanceUsd, 800);
  assert.equal(rows.find((row) => row.transactionId === 13).scheduledSource, "creditCardDue");
});

test("provider payment evidence completes a fully paid statement without inventing another cash payment", () => {
  const { plan, document, accounts } = cardStatementFixture();
  accounts[1].creditCardDue = { ...accounts[1].creditCardDue, lastPaymentDate: "2026-11-03", lastPaymentAmount: 200 };
  const [due] = buildPlanRows(plan, document, 63, { accounts, today: "2026-11-04" });
  assert.equal(due.amount, 0);
  assert.equal(due.usd, 0);
  assert.equal(due.paidAmount, 200);
  assert.equal(due.completed, true);
  assert.equal(due.completionSource, "transaction");
  assert.equal(due.balanceUsd, 1000);
});

test("duplicate payment records reduce a statement once and another card purchase cannot act as its bank debit", () => {
  const { plan, document, accounts } = cardStatementFixture();
  const payment = { id: 1, date: "2026-11-02", amount: 40, currency: "USD", kind: "income", accountId: 2, category: "Transfer In" };
  accounts.push({ id: 3, type: "credit", name: "Other Card", currency: "USD", nativeCurrentBalance: 0 });
  const rows = buildPlanRows(plan, document, 63, { accounts, today: "2026-11-04", transactions: [
    payment, { ...payment },
    { id: 2, date: "2026-11-02", amount: 40, currency: "USD", kind: "expense", accountId: 3, category: "Transfer Out", merchant: "Travel Card payment" },
  ] });
  const due = rows.find((row) => row.source === "creditCardDue");
  assert.equal(due.paidAmount, 40);
  assert.deepEqual(due.paymentTransactionIds, [1]);
  assert.equal(due.amount, 160);
});

test("pending payments, refunds and payments before statement close do not satisfy a statement", () => {
  const { plan, document, accounts } = cardStatementFixture();
  accounts[1].creditCardDue = { ...accounts[1].creditCardDue, lastPaymentDate: "2026-10-23", lastPaymentAmount: 200 };
  const rows = buildPlanRows(plan, document, 63, { accounts, today: "2026-11-04", transactions: [
    { id: 1, date: "2026-11-02", amount: 200, currency: "USD", kind: "income", accountId: 2, category: "Transfer", pending: true },
    { id: 2, date: "2026-11-03", amount: 200, currency: "USD", kind: "income", accountId: 2, category: "Shopping", merchant: "Refund" },
    { id: 3, date: "2026-10-23", amount: 200, currency: "USD", kind: "income", accountId: 2, category: "Transfer" },
  ] });
  assert.equal(rows.at(-1).amount, 200);
  assert.equal(rows.at(-1).paidAmount, 0);
  assert.equal(rows.at(-1).balanceUsd, 800);
});

test("payments posted well after the due date satisfy overdue statements using either bank records or provider metadata", () => {
  const { plan, document, accounts } = cardStatementFixture();
  for (const viaMetadata of [false, true]) {
    accounts[1].creditCardDue = { ...accounts[1].creditCardDue,
      lastPaymentDate: viaMetadata ? "2026-11-30" : null, lastPaymentAmount: viaMetadata ? 200 : null };
    const rows = buildPlanRows(plan, document, 63, { accounts, today: "2026-12-01", transactions: viaMetadata ? [] : [
      { id: 1, date: "2026-11-30", amount: 200, currency: "USD", kind: "income", accountId: 2, category: "Transfer In" },
      { id: 2, date: "2026-11-30", amount: 200, currency: "USD", kind: "expense", accountId: 1, category: "Transfer Out" },
    ] });
    const due = rows.find((row) => row.source === "creditCardDue");
    assert.equal(due.amount, 0);
    assert.equal(due.paidAmount, 200);
    assert.equal(due.completed, true);
    assert.equal(rows.at(-1).balanceUsd, viaMetadata ? 1000 : 800);
  }
});

test("a bank debit cannot pay two cards at the same issuer and a mask identifies a single card", () => {
  const { plan, document, accounts } = cardStatementFixture();
  accounts.push({ ...accounts[1], id: 3, name: "Rewards Card", mask: "5678" });
  const debit = { id: 10, date: "2026-11-02", amount: 200, currency: "USD", kind: "expense", accountId: 1,
    category: "Loan Payments", merchant: "Example Bank payment" };
  let rows = buildPlanRows(plan, document, 63, { accounts, transactions: [debit], today: "2026-11-04" });
  assert.deepEqual(rows.filter((row) => row.source === "creditCardDue").map((row) => row.paidAmount), [0, 0]);
  rows = buildPlanRows(plan, document, 63, { accounts, transactions: [{ ...debit, merchant: "Example Bank 5678 payment" }], today: "2026-11-04" });
  assert.deepEqual(rows.filter((row) => row.source === "creditCardDue").map((row) => row.paidAmount), [0, 200]);
  assert.equal(rows.at(-1).balanceUsd, 600);
});

function annualCardFeeFixture() {
  return {
    document: {
      salary: { amount: 0, currency: "USD", payFrequency: "biweekly", firstPayDate: "2026-10-23", accountId: 1 },
      bills: [{ id: "venture-fee", name: "Venture X", cadence: "annual", amount: 395, currency: "USD",
        dueDay: 1, dueMonths: [11], savedAmount: 395, accountId: 32, reserveAccountId: 2, sourceAccountId: 1 }],
      allocations: [],
    },
    plan: { startDate: "2026-11-05", endDate: "2027-01-01", openingUsd: 2000, openingPhp: 0,
      includeIncome: false, includeTransactions: true, includeAnnualReserve: false, includeAllocations: false, entries: [],
      accountLinks: { availableUsdAccountId: 1, availablePhpAccountId: null, annualReserveUsdAccountId: 2,
        annualReservePhpAccountId: null, savingsUsdAccountId: 28, savingsPhpAccountId: null } },
    accounts: [
      { id: 1, name: "Checking", type: "checking", currency: "USD", nativeCurrentBalance: 2000 },
      { id: 2, name: "Annual savings", type: "savings", currency: "USD", nativeCurrentBalance: 395 },
      { id: 28, name: "Smartly Savings", type: "savings", currency: "USD", nativeCurrentBalance: 500 },
      { id: 32, name: "Venture X", type: "credit", currency: "USD", nativeCurrentBalance: 1658.16, isLinked: true,
        creditCardDue: { statementBalance: 0, dueDate: "2026-12-18", lastStatementDate: null } },
    ],
    charge: { id: 2506, date: "2026-11-01", kind: "expense", accountId: 32, currency: "USD", amount: 395,
      merchant: "CAPITAL ONE MEMBER FEE", category: "Bank Fees" },
  };
}

test("a historical annual card fee funds one full statement payment without another charge or cash credit", () => {
  const { document, plan, accounts, charge } = annualCardFeeFixture();
  const before = JSON.stringify({ document, plan, accounts, charge });
  const rows = buildPlanRows(plan, document, 63, { accounts, creditCardPaymentTransactions: [charge], today: "2026-11-06" });
  assert.equal(rows.length, 1);
  const due = rows[0];
  assert.equal(due.source, "creditCardDue");
  assert.equal(due.amount, 1658.16);
  assert.equal(due.usd, -1263.16);
  assert.equal(due.reserveUsd, 0);
  assert.equal(due.balanceUsd, 736.84);
  assert.deepEqual(due.annualBillCoverage, [{ billId: "venture-fee", billName: "Venture X", chargeDate: "2026-11-01",
    chargeTransactionId: 2506, occurrenceDate: "2026-11-01", amount: 395, reserveUsed: 395, reserveAccountId: 2 }]);
  assert.equal(before, JSON.stringify({ document, plan, accounts, charge }));
});

test("annual charge attribution follows its statement cycle when an estimate becomes an issued statement", () => {
  for (const issued of [false, true]) {
    const { document, plan, accounts, charge } = annualCardFeeFixture();
    accounts[3].creditCardDue = issued
      ? { statementBalance: 1658.16, dueDate: "2026-12-18", lastStatementDate: "2026-11-17" }
      : { statementBalance: 200, dueDate: "2026-11-18", lastStatementDate: "2026-10-17" };
    const rows = buildPlanRows(plan, document, 63, { accounts, creditCardPaymentTransactions: [charge], today: issued ? "2026-11-20" : "2026-11-06" });
    const covered = rows.filter((row) => row.annualBillCoverage?.length);
    assert.equal(covered.length, 1);
    assert.equal(covered[0].date, "2026-12-18");
    assert.equal(Boolean(covered[0].estimated), !issued);
    assert.equal(covered[0].annualBillCoverage[0].reserveUsed, 395);
    assert.equal(rows.filter((row) => row.annualPayment).length, 0);
  }
});

test("card-fee matching requires a unique posted native charge near its annual anniversary", () => {
  for (const change of ["pending", "wrong account", "wrong currency", "wrong amount", "wrong date", "unrelated description", "duplicate charge", "ambiguous bill", "old cycle"]) {
    const { document, plan, accounts, charge } = annualCardFeeFixture();
    let evidence = [charge];
    if (change === "pending") charge.pending = true;
    if (change === "wrong account") charge.accountId = 1;
    if (change === "wrong currency") charge.currency = "PHP";
    if (change === "wrong amount") charge.amount = 396;
    if (change === "wrong date") charge.date = "2026-11-05";
    if (change === "unrelated description") { charge.merchant = "Groceries"; charge.category = "Food"; }
    if (change === "duplicate charge") evidence.push({ ...charge, id: 2507 });
    if (change === "ambiguous bill") document.bills.push({ ...document.bills[0], id: "another-fee", name: "Another fee" });
    if (change === "old cycle") charge.date = "2025-11-01";
    const rows = buildPlanRows(plan, document, 63, { accounts, creditCardPaymentTransactions: evidence, today: "2026-11-06" });
    assert.ok(rows.every((row) => !row.annualBillCoverage?.length), change);
  }
});

test("an annual installment matches its native charge amount instead of the full yearly total", () => {
  const { document, plan, accounts, charge } = annualCardFeeFixture();
  document.bills[0].amount = 790;
  document.bills[0].dueMonths = [5, 11];
  const rows = buildPlanRows(plan, document, 63, { accounts, creditCardPaymentTransactions: [charge], today: "2026-11-06" });
  assert.equal(rows[0].annualBillCoverage[0].amount, 395);
  assert.equal(rows[0].annualBillCoverage[0].reserveUsed, 395);
});

test("recorded annual card charges stay cash-neutral even without statement details", () => {
  const { document, plan, accounts, charge } = annualCardFeeFixture();
  accounts[3].creditCardDue = null;
  plan.startDate = "2026-11-01";
  plan.endDate = "2026-11-10";
  const rows = buildPlanRows(plan, document, 63, { accounts, transactions: [charge], today: "2026-11-06" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "transaction");
  assert.equal(rows[0].transactionId, 2506);
  assert.equal(rows[0].annualPayment, true);
  assert.equal(rows[0].cardCreditActivity, true);
  assert.equal(rows[0].usd, 0);
  assert.equal(rows[0].reserveHeld, 395);
  assert.equal(rows[0].reserveUsd, 395);
});

test("a historical fee cannot claim the following year's genuine annual charge", () => {
  const { document, plan, accounts, charge } = annualCardFeeFixture();
  plan.endDate = "2027-11-02";
  const rows = buildPlanRows(plan, document, 63, { accounts, creditCardPaymentTransactions: [charge], today: "2026-11-06" });
  assert.equal(rows.filter((row) => row.annualBillCoverage?.length).length, 1);
  const future = rows.find((row) => row.annualPayment);
  assert.equal(future.date, "2027-11-01");
  assert.equal(future.annualChargeTransactionId, undefined);
  assert.equal(future.cardCreditActivity, true);
  assert.equal(future.usd, 0);
});

test("posted reserve-funded card payments fund annual coverage once and leave no second reserve debit", () => {
  const { document, plan, accounts, charge } = annualCardFeeFixture();
  accounts[1].nativeCurrentBalance = 0;
  accounts[3].nativeCurrentBalance = 1263.16;
  const payment = [
    { id: 3001, date: "2026-11-03", kind: "expense", accountId: 2, amount: 395, currency: "USD", merchant: "Venture X payment", category: "Transfer Out" },
    { id: 3002, date: "2026-11-03", kind: "income", accountId: 32, amount: 395, currency: "USD", merchant: "Payment", category: "Transfer In" },
  ];
  const rows = buildPlanRows(plan, document, 63, { accounts, creditCardPaymentTransactions: [charge, ...payment], today: "2026-11-06" });
  assert.equal(rows[0].amount, 1263.16);
  assert.equal(rows[0].annualBillCoverage[0].reserveUsed, 395);
  assert.equal(rows[0].annualBillCoverage[0].reserveAlreadyPaidAmount, 395);
  assert.equal(rows[0].usd, -1263.16);
  assert.equal(rows[0].directReservePayment, 0);
  assert.equal(rows[0].reserveDeltaUsd, -395);
});

test("a flat plan consumes transferred annual earmarks without charging available funds for them twice", () => {
  const { document, plan, accounts, charge } = annualCardFeeFixture();
  delete plan.accountLinks;
  plan.entries = [{ id: "prepare", description: "Move annual savings", date: "2026-11-10", kind: "transfer",
    fromAccountId: 2, toAccountId: 1, amount: 395, currency: "USD" }];
  const rows = buildPlanRows(plan, document, 63, { accounts, creditCardPaymentTransactions: [charge], today: "2026-11-06" });
  const due = rows.find((row) => row.source === "creditCardDue");
  assert.equal(due.annualBillCoverage[0].reserveTransferredAmount, 395);
  assert.equal(due.amount, 1658.16);
  assert.equal(due.usd, -1263.16);
  assert.equal(due.reserveUsd, 0);
  assert.equal(due.balanceUsd, 736.84);
});

test("fully paid statements retain proven annual reserve attribution without creating another payment", () => {
  const { document, plan, accounts, charge } = annualCardFeeFixture();
  accounts[1].nativeCurrentBalance = 0;
  accounts[3].nativeCurrentBalance = 0;
  accounts[3].creditCardDue = { statementBalance: 395, dueDate: "2026-12-18", lastStatementDate: "2026-11-17" };
  const payment = [
    { id: 3001, date: "2026-12-01", kind: "expense", accountId: 2, amount: 395, currency: "USD", merchant: "Venture X payment", category: "Transfer Out" },
    { id: 3002, date: "2026-12-01", kind: "income", accountId: 32, amount: 395, currency: "USD", merchant: "Payment", category: "Transfer In" },
  ];
  const rows = buildPlanRows(plan, document, 63, { accounts, creditCardPaymentTransactions: [charge, ...payment], today: "2026-12-02" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 0);
  assert.equal(rows[0].usd, 0);
  assert.equal(rows[0].annualBillCoverage[0].reserveUsed, 395);
  assert.equal(rows[0].annualBillCoverage[0].reserveAlreadyPaidAmount, 395);
  assert.equal(rows[0].completed, true);
});

test("a future annual card charge holds its reserve without creating available cash", () => {
  const { plan, document, accounts } = cardStatementFixture();
  const rows = buildPlanRows({ ...plan, endDate: "2026-11-30" }, { ...document, bills: [
    { id: "annual", name: "Annual fee", cadence: "annual", amount: 200, currency: "USD", dueDay: 10, dueMonths: [11], savedAmount: 200, accountId: 2 },
  ] }, 63, { accounts, today: "2026-11-04" });
  const charge = rows.find((row) => row.annualPayment);
  assert.equal(charge.cardCreditActivity, true);
  assert.equal(charge.usd, 0);
  assert.equal(charge.reserveUsd, 200);
  assert.equal(charge.reserveHeld, 200);
  assert.equal(rows.at(-1).balanceUsd, 800);
});

test("explicit planned card transfers fund the statement once and stay pending until posted", () => {
  const { plan, document, accounts } = cardStatementFixture();
  const entry = { id: "card-payment", date: "2026-11-18", description: "Pay travel card", kind: "transfer",
    fromAccountId: 1, toAccountId: 2, amount: 80, currency: "USD" };
  let rows = buildPlanRows({ ...plan, entries: [entry] }, document, 63, { accounts, today: "2026-11-04" });
  let due = rows.find((row) => row.source === "creditCardDue");
  assert.equal(due.plannedPaymentAmount, 80);
  assert.equal(due.paidAmount, 0);
  assert.equal(due.amount, 120);
  assert.equal(due.completed, false);
  assert.equal(rows.find((row) => row.entryId === entry.id).usd, -80);
  assert.equal(rows.find((row) => row.entryId === entry.id).creditCardPaymentFor, 2);
  assert.equal(rows.at(-1).balanceUsd, 800);
  rows = buildPlanRows({ ...plan, entries: [{ ...entry, amount: 200 }] }, document, 63, { accounts, today: "2026-11-04" });
  due = rows.find((row) => row.source === "creditCardDue");
  assert.equal(due.plannedPaymentAmount, 200);
  assert.equal(due.amount, 0);
  assert.equal(due.completed, false);
  assert.equal(rows.at(-1).balanceUsd, 800);
});

test("posted explicit card transfers replace their planned cash movement and current live opening counts it once", () => {
  const { plan, document, accounts } = cardStatementFixture();
  const entry = { id: "card-payment", date: "2026-11-18", description: "Pay travel card", kind: "transfer",
    fromAccountId: 1, toAccountId: 2, amount: 200, currency: "USD" };
  const transactions = [
    { id: 1, date: "2026-11-18", amount: 200, currency: "USD", kind: "income", accountId: 2, category: "Transfer In" },
    { id: 2, date: "2026-11-18", amount: 200, currency: "USD", kind: "expense", accountId: 1, category: "Transfer Out" },
  ];
  for (const live of [false, true]) {
    const rows = buildPlanRows({ ...plan, entries: [entry],
      ...(live ? { openingUsd: 0, startingAccounts: [{ accountId: 1, percentage: 100 }] } : {}) }, document, 63,
    { accounts: [{ ...accounts[0], nativeCurrentBalance: 800 }, accounts[1]], transactions, today: "2026-11-19" });
    const due = rows.find((row) => row.source === "creditCardDue");
    assert.equal(due.amount, 0);
    assert.equal(due.plannedPaymentAmount, 0);
    assert.equal(due.paidAmount, 200);
    assert.equal(rows.find((row) => row.entryId === entry.id).balanceAppliedUsd, 0);
    assert.equal(rows.at(-1).balanceUsd, 800);
  }
});

test("recognized Debt and Other card payments complete explicit transfers and count once with dated and live cash", () => {
  const { plan, document, accounts } = cardStatementFixture();
  const entry = { id: "card-payment", date: "2026-11-18", description: "Pay travel card", kind: "transfer",
    fromAccountId: 1, toAccountId: 2, amount: 200, currency: "USD" };
  for (const category of ["Debt", "Other"]) for (const live of [false, true]) {
    const rows = buildPlanRows({ ...plan, entries: [entry],
      ...(live ? { openingUsd: 0, startingAccounts: [{ accountId: 1, percentage: 100 }] } : {}) }, document, 63,
    { accounts: [{ ...accounts[0], nativeCurrentBalance: 800 }, accounts[1]], today: "2026-11-18", transactions: [
      { id: 1, date: "2026-11-18", amount: 200, currency: "USD", kind: "income", accountId: 2, category, merchant: "Automatic payment" },
      { id: 2, date: "2026-11-18", amount: 200, currency: "USD", kind: "expense", accountId: 1, category, merchant: "Travel Card payment" },
    ] });
    const transfer = rows.find((row) => row.entryId === entry.id);
    assert.equal(transfer.completed, true);
    assert.equal(transfer.balanceAppliedUsd, 0);
    assert.deepEqual(transfer.matchedTransactionIds, [2, 1]);
    assert.equal(rows.find((row) => row.source === "creditCardDue").amount, 0);
    assert.equal(rows.at(-1).balanceUsd, 800);
  }
});

test("a named bank-only partial payment remains evidence alongside another paired card payment", () => {
  const { plan, document, accounts } = cardStatementFixture();
  const rows = buildPlanRows(plan, document, 63, { accounts, today: "2026-11-11", transactions: [
    { id: 1, date: "2026-11-02", amount: 50, currency: "USD", kind: "income", accountId: 2, category: "Transfer In" },
    { id: 2, date: "2026-11-02", amount: 50, currency: "USD", kind: "expense", accountId: 1, category: "Transfer Out" },
    { id: 3, date: "2026-11-10", amount: 70, currency: "USD", kind: "expense", accountId: 1, category: "Loan Payments", merchant: "Card 1234 payment" },
  ] });
  const due = rows.find((row) => row.source === "creditCardDue");
  assert.equal(due.paidAmount, 120);
  assert.equal(due.amount, 80);
  assert.equal(rows.at(-1).balanceUsd, 800);
});

test("statement-cycle evidence before the plan reduces dues without replaying earlier cash transactions", () => {
  const { plan, document, accounts } = cardStatementFixture();
  const earlierPayment = { id: 1, date: "2026-11-02", amount: 50, currency: "USD", kind: "income", accountId: 2, category: "Transfer In" };
  const laterPayment = { id: 2, date: "2026-11-16", amount: 30, currency: "USD", kind: "income", accountId: 2, category: "Transfer In" };
  const rows = buildPlanRows({ ...plan, startDate: "2026-11-15", endDate: "2026-11-30" }, document, 63,
    { accounts, today: "2026-11-17", transactions: [laterPayment],
      creditCardPaymentTransactions: [earlierPayment, laterPayment] });
  const due = rows.find((row) => row.source === "creditCardDue");
  assert.equal(due.paidAmount, 80);
  assert.equal(due.amount, 120);
  assert.equal(rows.some((row) => row.transactionId === earlierPayment.id), false);
  assert.equal(rows.at(-1).balanceUsd, 880);
});

test("an explicit savings-funded card payment consumes outside savings before available-owned cash", () => {
  const { plan, document, accounts } = cardStatementFixture();
  accounts.push({ id: 3, name: "Savings", type: "savings", currency: "USD", nativeCurrentBalance: 200 });
  const entry = { id: "card-payment", date: "2026-11-18", description: "Pay from savings", kind: "transfer",
    fromAccountId: 3, toAccountId: 2, amount: 200, currency: "USD" };
  const cardDocument = { ...document, allocations: [{ id: "savings", name: "Savings", kind: "savings", amount: 0, accountId: 3, currency: "USD" }] };
  for (const selected of [0, 50, 100]) {
    const rows = buildPlanRows({ ...plan, entries: [entry], startingAccounts: selected ? [{ accountId: 3, percentage: selected }] : [] },
      cardDocument, 63, { accounts, today: "2026-11-04" });
    assert.equal(rows.find((row) => row.entryId === entry.id).usd, -2 * selected || 0);
    assert.equal(rows.find((row) => row.source === "creditCardDue").amount, 0);
    assert.equal(rows.at(-1).balanceUsd, 1000);
  }
});

function recurringEntryFixture() {
  return {
    plan: {
      startDate: "2026-11-01", endDate: "2026-11-30", openingUsd: 1000, openingPhp: 0,
      includeIncome: false, includeAllocations: false, includeAnnualReserve: false,
      entries: [{ id: "daily", date: "2026-11-01", description: "Coffee", kind: "expense", amount: 10,
        currency: "USD", recurrence: "daily", repeatUntil: "2026-11-03" }],
    },
    document: { salary: { payFrequency: "biweekly", firstPayDate: "2026-10-23", amount: 2000, currency: "USD" }, bills: [], allocations: [] },
  };
}

test("daily plan entries follow inclusive calendar days through leap dates and New York DST", () => {
  const entry = { id: "daily", date: "2028-02-28", recurrence: "daily", repeatUntil: "2028-03-01", amount: 1.25, currency: "PHP" };
  const before = JSON.stringify(entry);
  assert.deepEqual(entryOccurrences(entry, "2028-02-01", "2028-03-31").map((row) => row.date),
    ["2028-02-28", "2028-02-29", "2028-03-01"]);
  assert.deepEqual(entryOccurrences({ ...entry, date: "2026-10-31", repeatUntil: "2026-11-03" }, "2026-10-01", "2026-11-30").map((row) => row.date),
    ["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]);
  assert.equal(JSON.stringify(entry), before);
});

test("monthly plan entries retain their original day after short and leap-year months", () => {
  const entry = { id: "monthly", date: "2027-01-31", recurrence: "monthly", amount: 30, currency: "USD" };
  assert.deepEqual(entryOccurrences(entry, "2027-01-01", "2027-04-30").map((row) => row.date),
    ["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
  assert.deepEqual(entryOccurrences({ ...entry, date: "2028-01-31" }, "2028-02-01", "2028-03-31").map((row) => row.date),
    ["2028-02-29", "2028-03-31"]);
  assert.deepEqual(entryOccurrences({ ...entry, repeatUntil: "2027-03-30" }, "2027-02-01", "2027-04-30").map((row) => row.date), ["2027-02-28"]);
});

test("entry schedules reject impossible or reversed dates and retain legacy single-entry behavior", () => {
  const entry = { id: "once", date: "2026-11-10", amount: 12, currency: "USD" };
  assert.deepEqual(entryOccurrences(entry, "2026-11-01", "2026-11-30"), [{ date: entry.date, amount: 12, currency: "USD", entryId: "once" }]);
  for (const change of [{ date: "2026-11-31" }, { recurrence: "weekly" }, { recurrence: "daily", repeatUntil: "2026-02-30" }, { recurrence: "daily", repeatUntil: "2026-11-01" }])
    assert.deepEqual(entryOccurrences({ ...entry, ...change }, "2026-11-01", "2026-11-30"), []);
  assert.deepEqual(entryOccurrences(entry, "2026-11-30", "2026-11-01"), []);
});

test("every-payday entries follow the salary schedule even when salary forecasts are switched off", () => {
  const { plan, document } = recurringEntryFixture();
  const entry = { ...plan.entries[0], date: "2026-11-01", recurrence: "payday", repeatUntil: null };
  const build = (salary) => buildPlanRows({ ...plan, entries: [entry] }, { ...document, salary }, 63, { today: "2026-11-01" });
  let rows = build(document.salary);
  assert.deepEqual(rows.map((row) => row.date), ["2026-11-06", "2026-11-20"]);
  assert.ok(rows.every((row) => row.source === "manual" && row.amount === 10 && row.recurring));
  rows = build({ ...document.salary, payFrequency: "semimonthly", firstPayDate: "2026-11-06" });
  assert.deepEqual(rows.map((row) => row.date), ["2026-11-06", "2026-11-21"]);
  assert.deepEqual(build({}), []);
});

test("recurring entries have independent stable occurrence IDs and native running balances", () => {
  const { plan, document } = recurringEntryFixture();
  const before = JSON.stringify(plan);
  const rows = buildPlanRows({ ...plan, entries: [...plan.entries,
    { id: "income", date: "2026-11-02", description: "Small income", kind: "income", amount: 100, currency: "PHP", recurrence: "daily", repeatUntil: "2026-11-03" },
  ] }, document, 63, { today: "2026-11-01" });
  assert.deepEqual(rows.filter((row) => row.entryId === "daily").map((row) => row.id),
    ["entry:daily:2026-11-01", "entry:daily:2026-11-02", "entry:daily:2026-11-03"]);
  assert.ok(rows.every((row) => row.recurring && row.editable));
  assert.equal(rows.at(-1).balanceUsd, 970);
  assert.equal(rows.at(-1).balancePhp, 200);
  assert.equal(JSON.stringify(plan), before);
});

test("editing or completing one recurring occurrence leaves the series and its other dates unchanged", () => {
  const { plan, document } = recurringEntryFixture();
  const overridden = { ...plan,
    rowOverrides: [{ rowId: "entry:daily:2026-11-02", date: "2026-11-03", description: "Skipped coffee", amount: 0 }],
    completedRows: [{ rowId: "entry:daily:2026-11-01", completedAt: "2026-11-01T12:00:00.000Z" }],
  };
  const rows = buildPlanRows(overridden, document, 63, { today: "2026-11-01" });
  assert.equal(rows.find((row) => row.id === "entry:daily:2026-11-01").completed, true);
  assert.equal(rows.find((row) => row.id === "entry:daily:2026-11-03").completed, false);
  const exception = rows.find((row) => row.id === "entry:daily:2026-11-02");
  assert.equal(exception.date, "2026-11-03");
  assert.equal(exception.originalDate, "2026-11-02");
  assert.equal(exception.originalAmount, 10);
  assert.equal(exception.amount, 0);
  assert.equal(exception.isOverride, true);
  assert.equal(rows.at(-1).balanceUsd, 980);
  assert.equal(plan.entries[0].amount, 10);
});

test("moved monthly occurrence overrides are reconstructed only for real dates in the source series", () => {
  const { plan, document } = recurringEntryFixture();
  const entry = { ...plan.entries[0], date: "2026-11-10", recurrence: "monthly", repeatUntil: null };
  const rows = buildPlanRows({ ...plan, entries: [entry], rowOverrides: [
    { rowId: "entry:daily:2026-12-10", date: "2026-11-15", description: "Moved monthly", amount: 20 },
    { rowId: "entry:daily:2026-12-11", date: "2026-11-16", description: "Not a source occurrence", amount: 99 },
  ] }, document, 63, { today: "2026-11-01" });
  assert.deepEqual(rows.map((row) => [row.id, row.date, row.amount]), [
    ["entry:daily:2026-11-10", "2026-11-10", 10],
    ["entry:daily:2026-12-10", "2026-11-15", 20],
  ]);
});

test("posted recurring expenses replace only their matching occurrence and preserve completion identity", () => {
  const { plan, document } = recurringEntryFixture();
  const rows = buildPlanRows(plan, document, 63, { today: "2026-11-03", transactions: [
    { id: 80, date: "2026-11-02", merchant: "Coffee", kind: "expense", amount: 10, currency: "USD" },
  ] });
  assert.equal(rows.length, 3);
  const actual = rows.find((row) => row.transactionId === 80);
  assert.equal(actual.completionKey, "entry:daily:2026-11-02");
  assert.equal(actual.matchedForecast.entryId, "daily");
  assert.equal(actual.matchedForecast.recurring, true);
  assert.equal(actual.completed, true);
  assert.equal(rows.filter((row) => row.source === "manual").length, 2);
  assert.equal(rows.at(-1).balanceUsd, 970);
});

test("recurring conversion overrides recompute both native sides instead of keeping the previous conversion amount", () => {
  const { plan, document } = recurringEntryFixture();
  const rows = buildPlanRows({ ...plan, entries: [{ ...plan.entries[0], kind: "conversion" }], rowOverrides: [
    { rowId: "entry:daily:2026-11-02", date: "2026-11-02", description: "Larger conversion", amount: 20 },
  ] }, document, 63, { today: "2026-11-01" });
  assert.deepEqual(rows.map((row) => [row.amount, row.usd, row.php]), [[10, -10, 630], [20, -20, 1260], [10, -10, 630]]);
  assert.equal(rows.at(-1).balanceUsd, 960);
  assert.equal(rows.at(-1).balancePhp, 2520);
});

test("each recurring card-payment transfer covers its statement share without counting paid occurrences again", () => {
  const { plan, document, accounts } = cardStatementFixture();
  const entry = { id: "card-series", date: "2026-11-17", description: "Card payment", kind: "transfer",
    amount: 50, currency: "USD", fromAccountId: 1, toAccountId: 2, recurrence: "daily", repeatUntil: "2026-11-19" };
  const rows = buildPlanRows({ ...plan, entries: [entry] }, document, 63, { accounts, today: "2026-11-18", transactions: [
    { id: 1, date: "2026-11-17", amount: 50, currency: "USD", kind: "expense", accountId: 1, category: "Transfer Out" },
    { id: 2, date: "2026-11-17", amount: 50, currency: "USD", kind: "income", accountId: 2, category: "Transfer In" },
  ] });
  const due = rows.find((row) => row.source === "creditCardDue");
  assert.equal(due.paidAmount, 50);
  assert.equal(due.plannedPaymentAmount, 100);
  assert.equal(due.amount, 50);
  assert.equal(rows.filter((row) => row.recurring && row.source === "manual").length, 3);
  assert.equal(rows.find((row) => row.id === "entry:card-series:2026-11-17").completed, true);
  assert.equal(rows.filter((row) => row.source === "manual" && row.completed).length, 1);
  assert.equal(rows.at(-1).balanceUsd, 800);
});
