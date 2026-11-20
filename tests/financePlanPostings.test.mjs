import assert from "node:assert/strict";
import test from "node:test";
import { financePlanPostingSpecs, financePlanTransactionMetadata, refreshFinancePlanPostings } from "../app/lib/financePlanPostings.mjs";
import { mapFinanceActivityAccount } from "../app/lib/financeActivity.mjs";

const today = "2026-11-18";
const completion = (id) => ({ rowId: `entry:${id}`, completedAt: `${today}T12:00:00.000Z` });
const entry = (extra = {}) => ({ id: "purchase", date: today, description: "Fill", kind: "expense", amount: 20,
  currency: "PHP", accountId: 37, ...extra });
const planner = (entries, completed = entries.map((row) => completion(row.id))) => ({ salary: {}, plans: [{ id: "main",
  startDate: "2026-11-01", endDate: "2027-01-31", entries, completedRows: completed }] });
const manual = (id, type, balance, currency = "PHP") => ({ id, account_type: type, currency, opening_balance: balance });
const bank = (id, balance = 1000) => ({ id, account_type: "checking", currency: "PHP", current_balance: balance,
  external_provider: "plaid", external_account_id: `bank-${id}` });

// This ledger models stored rows and transactional rollback, rather than returning
// canned successes: assertions inspect resulting account balances and bank records.
function ledger(accounts, document, initial = []) {
  let rows = structuredClone(initial);
  let sequence = 100;
  let snapshot;
  let failure = false;
  let rate = 58;
  let currentDate = today;
  const events = [];
  const summary = () => accounts.map((account) => {
    const relevant = rows.filter((row) => Number(row.account_id) === Number(account.id) && row.currency === account.currency &&
      !row.pending && !row.is_provider_removed && row.duplicate_of_id == null && row.transaction_date <= currentDate);
    const movement = (items) => items.reduce((sum, row) => sum + (row.kind === "income" ? 1 : -1) * Number(row.amount), 0);
    return { ...account, native_movement: movement(relevant), plan_pending_movement: movement(relevant.filter((row) => row.plan_provisional)) };
  });
  const connection = {
    async beginTransaction() { events.push("begin"); snapshot = structuredClone(rows); },
    async commit() { events.push("commit"); snapshot = null; },
    async rollback() { events.push("rollback"); rows = snapshot; snapshot = null; },
    release() { events.push("release"); },
    async query(raw, params = []) {
      const sql = raw.replace(/\s+/g, " ").trim();
      if (sql.startsWith("SELECT document")) return [[{ document, exchange_rate: JSON.stringify({ rate }) }]];
      if (sql.startsWith("SELECT a.*")) return [summary()];
      if (sql.startsWith("SELECT t.*") && sql.includes("t.source_plan_id IS NOT NULL"))
        return [structuredClone(rows.filter((row) => row.source_plan_id))];
      if (sql.startsWith("SELECT t.*") && sql.includes("WHERE t.pending = 0"))
        return [structuredClone(rows.filter((row) => !row.pending && row.duplicate_of_id == null &&
          !row.is_provider_removed && row.transaction_date <= params[0]))];
      if (sql.startsWith("SELECT t.*")) return [structuredClone(rows.filter((row) => params[0].includes(row.account_id) &&
        !row.pending && row.duplicate_of_id == null && !row.is_provider_removed && row.external_provider &&
        row.transaction_date >= params[1] && row.transaction_date <= params[2]))];
      if (sql.startsWith("DELETE")) {
        rows = rows.filter((row) => !(row.id === params[0] && row.plan_generated && !row.external_provider && !row.external_transaction_id));
      } else if (sql.startsWith("UPDATE") && sql.includes("source_plan_id = NULL")) {
        Object.assign(rows.find((row) => row.id === params[0]), { source_plan_id: null, source_plan_row_id: null,
          source_plan_leg: null, plan_generated: 0, plan_provisional: 0, plan_record_json: null });
      } else if (sql.startsWith("UPDATE") && sql.includes("SET plan_generated = 1, plan_record_json")) {
        Object.assign(rows.find((row) => row.id === params[1]), { plan_generated: 1, plan_record_json: params[0] });
      } else if (sql.startsWith("UPDATE")) {
        Object.assign(rows.find((row) => row.id === params[4]), { source_plan_id: params[0], source_plan_row_id: params[1],
          source_plan_leg: params[2], plan_record_json: params[3], plan_generated: sql.includes("plan_generated = 1") ? 1 : 0, plan_provisional: 0 });
      } else if (sql.startsWith("INSERT")) {
        if (failure && params[10] === "credit") throw new Error("Second transfer leg failed");
        const old = rows.find((row) => row.source_plan_id === params[8] && row.source_plan_row_id === params[9] && row.source_plan_leg === params[10]);
        const row = { id: old?.id || sequence++, transaction_date: params[0], kind: params[1], account_id: params[2], category: params[3],
          merchant: params[4], note: params[5], amount: params[6], currency: params[7], source_plan_id: params[8],
          source_plan_row_id: params[9], source_plan_leg: params[10], plan_generated: 1, plan_provisional: params[11], plan_record_json: params[12] };
        if (old) Object.assign(old, row); else rows.push(row);
      } else throw new Error(`Unexpected query: ${sql}`);
      return [{ affectedRows: 1 }];
    },
  };
  return {
    refresh: (date = today) => { currentDate = date; return refreshFinancePlanPostings({ getConnection: async () => connection }, date); },
    rows: () => structuredClone(rows), accounts: () => summary().map(mapFinanceActivityAccount),
    add: (row) => rows.push(structuredClone(row)), fail: () => { failure = true; }, setRate: (value) => { rate = value; }, events,
  };
}

test("completed Fill and Card Payment post to their native manual accounts exactly once; edits and reopen stay connected", async () => {
  const fill = entry({ amount: 10457.95 });
  const payment = entry({ id: "payment", description: "Card Payment", kind: "transfer", accountId: null,
    fromAccountId: 34, toAccountId: 37, amount: 2000 });
  const document = planner([fill, payment]);
  const store = ledger([manual(34, "savings", 100000), manual(37, "credit", 25000)], document);
  await store.refresh(); await store.refresh();
  assert.equal(store.rows().length, 3);
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [98000, 33457.95]);
  const credit = store.rows().find((row) => row.source_plan_leg === "credit");
  assert.deepEqual(financePlanTransactionMetadata(credit), { planId: "main", planRowId: "entry:payment", planScheduledRowId: null,
    transferAccountId: 34, creditCardPaymentFor: 37, creditCardPaymentDueDate: null,
    awaitingBankSync: false, recordedFromPlan: true, planGenerated: true, planDetached: false });
  payment.amount = 4000;
  await store.refresh();
  assert.equal(store.rows().length, 3);
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [96000, 31457.95]);
  document.plans[0].completedRows = [completion("purchase")];
  await store.refresh();
  assert.equal(store.rows().length, 1);
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [100000, 35457.95]);
  document.plans[0].entries = [];
  await store.refresh();
  assert.equal(store.rows().length, 0);
});

test("linked-account provisional activity changes effective balances until a unique bank import replaces it", async () => {
  const account = bank(1);
  const document = planner([entry({ accountId: 1 })]);
  const store = ledger([account], document);
  await store.refresh();
  assert.equal(store.accounts()[0].nativeCurrentBalance, 980);
  assert.equal(store.accounts()[0].bankReportedBalance, 1000);
  assert.equal(store.accounts()[0].awaitingBankSync, true);
  const generatedId = store.rows()[0].id;
  account.current_balance = 980;
  store.add({ id: 9, account_id: 1, transaction_date: "2026-11-19", kind: "expense", currency: "PHP", amount: 20,
    merchant: "Actual bank merchant", external_provider: "plaid", external_transaction_id: "bank-purchase" });
  await store.refresh(); await store.refresh();
  assert.equal(store.rows().length, 1);
  assert.equal(store.rows()[0].id, 9);
  assert.notEqual(store.rows()[0].id, generatedId);
  assert.equal(store.rows()[0].merchant, "Actual bank merchant");
  assert.equal(store.accounts()[0].nativeCurrentBalance, 980);
  assert.equal(financePlanTransactionMetadata(store.rows()[0]).awaitingBankSync, false);
  document.plans[0].completedRows = [];
  await store.refresh();
  assert.equal(store.rows().length, 1, "reopening retains imported bank history");
  assert.equal(store.rows()[0].source_plan_id, null);
});

test("ambiguous bank imports and competing same-amount plan rows cannot be merged automatically", async () => {
  const imported = (id) => ({ id, account_id: 1, transaction_date: today, kind: "expense", currency: "PHP", amount: 20,
    external_provider: "plaid", external_transaction_id: `bank-${id}` });
  const ambiguous = ledger([bank(1)], planner([entry({ accountId: 1 })]), [imported(9), imported(10)]);
  await ambiguous.refresh();
  assert.equal(ambiguous.rows().filter((row) => row.plan_generated).length, 1);
  assert.ok(ambiguous.rows().filter((row) => row.external_provider).every((row) => !row.source_plan_id));
  const competing = ledger([bank(1)], planner([entry({ accountId: 1 }), entry({ id: "second", accountId: 1 })]), [imported(9)]);
  await competing.refresh();
  assert.equal(competing.rows().filter((row) => row.plan_generated).length, 2);
  assert.equal(competing.rows().find((row) => row.id === 9).source_plan_id, undefined);
});

test("mixed linked/manual card transfers reconcile each leg and rollback both legs on failure", async () => {
  const payment = entry({ id: "payment", kind: "transfer", fromAccountId: 1, toAccountId: 37, accountId: null, amount: 100,
    scheduledRowId: "creditCardDue:37:2027-01-01" });
  const initial = [{ id: 9, account_id: 1, transaction_date: today, kind: "expense", currency: "PHP", amount: 100,
    external_provider: "plaid", external_transaction_id: "bank-payment" }];
  const store = ledger([bank(1, 900), manual(37, "credit", 500)], planner([payment]), initial);
  store.fail();
  await assert.rejects(store.refresh(), /Second transfer leg failed/);
  assert.deepEqual(store.rows(), initial, "neither a match nor one-sided money movement survives rollback");
  assert.deepEqual(store.events, ["begin", "rollback", "release"]);
  const success = ledger([bank(1, 900), manual(37, "credit", 500)], planner([payment]), initial);
  await success.refresh();
  assert.equal(success.rows().length, 2);
  assert.deepEqual(success.accounts().map((row) => row.nativeCurrentBalance), [900, 400]);
  for (const row of success.rows()) {
    const metadata = financePlanTransactionMetadata(row);
    assert.equal(metadata.planScheduledRowId, payment.scheduledRowId);
    assert.equal(metadata.creditCardPaymentDueDate, "2027-01-01");
  }
});

test("recorded conversion rates and live-card payment amounts freeze when first completed", async () => {
  const conversion = entry({ id: "convert", kind: "conversion", accountId: null, fromAccountId: 1, toAccountId: 2,
    currency: "USD", amount: 10 });
  const conversionStore = ledger([manual(1, "checking", 100, "USD"), manual(2, "cash", 0)], planner([conversion]));
  await conversionStore.refresh(); conversionStore.setRate(60); await conversionStore.refresh();
  assert.deepEqual(conversionStore.accounts().map((row) => row.nativeCurrentBalance), [90, 580]);
  const payment = entry({ id: "pay", kind: "transfer", accountId: null, fromAccountId: 34, toAccountId: 37,
    amount: 0, amountMode: "cardBalance" });
  const store = ledger([manual(34, "savings", 1000), manual(37, "credit", 500)], planner([payment]));
  await store.refresh(); await store.refresh();
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [500, 0]);
  assert.equal(store.rows().find((row) => row.source_plan_leg === "credit").amount, 500);
});

test("future and uncompleted rows stay forecasts; only a completed recurring occurrence becomes recorded", () => {
  const rows = [entry({ id: "future", date: "2027-01-01" }), entry({ id: "unpaid" }),
    entry({ id: "daily", recurrence: "daily", repeatUntil: "2026-11-20" })];
  const doc = planner(rows, [completion("future"), { ...completion("daily"), rowId: `entry:daily:${today}` }]);
  const specs = financePlanPostingSpecs(doc, [manual(37, "credit", 0)], [], { today });
  assert.equal(specs.length, 1);
  assert.equal(specs[0].rowId, `entry:daily:${today}`);
});

test("an ongoing planner records only addressed linked-account completions across decades of recurrence", () => {
  const daily = entry({ id: "daily", date: "2000-01-01", recurrence: "daily", repeatUntil: null });
  const monthly = entry({ id: "monthly", date: "2000-01-31", recurrence: "monthly", repeatUntil: null });
  const doc = planner([daily, monthly], [
    { rowId: `entry:daily:${today}`, completedAt: `${today}T12:00:00.000Z` },
    { rowId: "entry:monthly:2026-02-28", completedAt: `${today}T12:00:00.000Z` },
    { rowId: "entry:monthly:2026-02-27", completedAt: `${today}T12:00:00.000Z` },
  ]);
  Object.assign(doc.plans[0], { continuous: true, startDate: "2000-01-01", endDate: "2040-12-31",
    rowOverrides: [{ rowId: "entry:daily:2026-11-18", date: "2026-11-17", description: "Paid early", amount: 15 }] });
  const accounts = [{ ...bank(37), account_type: "credit" }];
  const specs = financePlanPostingSpecs(doc, accounts, [], { today });
  assert.deepEqual(specs.map((row) => [row.rowId, row.date, row.amount]), [
    ["entry:monthly:2026-02-28", "2026-02-28", 20], ["entry:daily:2026-11-18", "2026-11-17", 15],
  ]);
  doc.plans[0].startDate = "2026-11-18";
  doc.plans[0].endDate = "2026-12-18";
  assert.deepEqual(financePlanPostingSpecs(doc, accounts, [], { today }), specs,
    "changing a view-sized horizon cannot delete historical receipts");
});

const livePlanner = (entries = [], completed = []) => {
  const document = { bills: [], allocations: [], ...planner(entries, completed) };
  Object.assign(document.plans[0], { continuous: true, balanceMode: "live", includeIncome: false,
    includeAllocations: false, includeAnnualReserve: false });
  return document;
};

test("live manual balances include existing planned Fill and payments, preserve independent history and reverse corrections", async () => {
  const fill = entry({ amount: 10457.95 });
  const payment = entry({ id: "payment", description: "Card Payment", kind: "transfer", accountId: null,
    fromAccountId: 34, toAccountId: 37, amount: 2000 });
  const document = livePlanner([fill, payment]);
  const accounts = [manual(34, "savings", 100000), manual(37, "credit", 25000)];
  const independent = { id: 9, transaction_date: "2026-11-01", account_id: 34, currency: "PHP",
    kind: "expense", amount: 10, merchant: "Independent receipt" };
  const store = ledger(accounts, document, [independent]);
  await store.refresh();
  const ids = store.rows().map((row) => row.id);
  await store.refresh();
  assert.deepEqual(store.rows().map((row) => row.id), ids);
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [97990, 33457.95]);
  assert.deepEqual(accounts.map((row) => row.opening_balance), [100000, 25000]);
  assert.ok(store.rows().filter((row) => row.plan_generated).every((row) => financePlanTransactionMetadata(row).manualPlannerSource));
  payment.amount = 4000;
  await store.refresh();
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [95990, 31457.95]);
  fill.date = "2026-11-19";
  await store.refresh();
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [95990, 21000]);
  document.plans[0].entries = [];
  await store.refresh();
  assert.deepEqual(store.rows(), [independent]);
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [99990, 25000]);
});

test("the live planner adopts a unique manual receipt and owns later corrections without duplicating its previous amount", async () => {
  const fill = entry();
  const document = livePlanner([fill]);
  const receipt = { id: 9, transaction_date: today, account_id: 37, currency: "PHP", kind: "expense",
    amount: 20, merchant: "Fill", category: "Fuel", note: "Original note" };
  const unmatched = { id: 10, transaction_date: today, account_id: 34, currency: "PHP", kind: "expense",
    amount: 7, merchant: "Unmatched receipt", category: "Other", note: "Independent history" };
  const imported = { id: 11, transaction_date: today, account_id: 1, currency: "PHP", kind: "expense",
    amount: 10, merchant: "Bank purchase", category: "Other", external_provider: "plaid", external_transaction_id: "bank-11" };
  const store = ledger([manual(37, "credit", 100), manual(34, "savings", 500), bank(1, 990)], document, [receipt, unmatched, imported]);
  await store.refresh(); await store.refresh();
  assert.equal(store.rows().length, 3);
  assert.equal(store.rows().find((row) => row.id === 9).plan_generated, 1);
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [120, 493, 990]);
  fill.amount = 30;
  fill.description = "Corrected Fill";
  await store.refresh(); await store.refresh();
  const corrected = store.rows().find((row) => row.id === 9);
  assert.equal(store.rows().length, 3);
  assert.equal(corrected.amount, 30);
  assert.equal(corrected.merchant, "Corrected Fill");
  assert.equal(corrected.note, "Original note");
  assert.equal(corrected.category, "Fuel");
  assert.deepEqual(JSON.parse(corrected.plan_record_json).manualReceiptOriginal, {
    id: 9, date: today, accountId: 37, kind: "expense", amount: 20, currency: "PHP",
    description: "Fill", category: "Fuel", note: "Original note",
  });
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [130, 493, 990]);
  fill.date = "2026-11-19";
  await store.refresh();
  assert.equal(store.rows().length, 2);
  assert.equal(store.accounts()[0].nativeCurrentBalance, 100);
  fill.date = today;
  await store.refresh();
  const restoredId = store.rows().find((row) => row.source_plan_row_id === "entry:purchase").id;
  await store.refresh();
  assert.equal(store.rows().find((row) => row.source_plan_row_id === "entry:purchase").id, restoredId);
  assert.equal(store.accounts()[0].nativeCurrentBalance, 130);
  document.plans[0].entries = [];
  await store.refresh();
  assert.deepEqual(store.rows(), [unmatched, imported]);
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [100, 493, 990]);
});

test("legacy manual receipt associations become planner-owned before their first corrected or removed balance is calculated", async () => {
  for (const change of ["edit", "future", "delete"]) {
    const fill = entry();
    const document = livePlanner([fill]);
    const prior = financePlanPostingSpecs(document, [manual(37, "credit", 100)], [], { today })[0];
    const legacy = { id: 9, transaction_date: today, account_id: 37, currency: "PHP", kind: "expense",
      amount: 20, merchant: "Fill", category: "Fuel", note: "Legacy note", source_plan_id: prior.planId,
      source_plan_row_id: prior.rowId, source_plan_leg: prior.leg, plan_generated: 0, plan_record_json: JSON.stringify(prior) };
    if (change === "edit") fill.amount = 30;
    if (change === "future") fill.date = "2026-11-19";
    if (change === "delete") document.plans[0].entries = [];
    const store = ledger([manual(37, "credit", 100)], document, [legacy]);
    await store.refresh(); await store.refresh();
    assert.equal(store.accounts()[0].nativeCurrentBalance, change === "edit" ? 130 : 100, change);
    assert.equal(store.rows().length, change === "edit" ? 1 : 0);
    if (change === "edit") {
      assert.equal(store.rows()[0].id, 9);
      assert.equal(store.rows()[0].plan_generated, 1);
      assert.equal(store.rows()[0].note, "Legacy note");
      assert.equal(store.rows()[0].category, "Fuel");
      assert.equal(JSON.parse(store.rows()[0].plan_record_json).manualReceiptOriginal.amount, 20);
    }
  }
});

test("independent manual matching rejects ambiguity and shares a receipt with its explicit scheduled source once", async () => {
  const receipt = { id: 9, transaction_date: today, account_id: 37, currency: "PHP", kind: "expense",
    amount: 20, merchant: "Fill", category: "Uncategorized" };
  const ambiguous = ledger([manual(37, "credit", 100)], livePlanner([entry()]), [receipt, { ...receipt, id: 10 }]);
  await ambiguous.refresh();
  assert.equal(ambiguous.rows().filter((row) => row.plan_generated).length, 1);
  assert.ok(ambiguous.rows().filter((row) => row.id < 100).every((row) => !row.source_plan_id));
  const competing = ledger([manual(37, "credit", 100)], livePlanner([entry(), entry({ id: "second" })]), [receipt]);
  await competing.refresh();
  assert.equal(competing.rows().filter((row) => row.plan_generated).length, 2);
  assert.equal(competing.rows().find((row) => row.id === 9).source_plan_id, undefined);

  const actual = entry({ id: "actual", date: "2026-11-10", description: "Internet", accountId: 1, amount: 100,
    scheduledRowId: "bill:internet:2026-11-10" });
  const document = livePlanner([actual]);
  document.bills = [{ id: "internet", name: "Internet", amount: 100, currency: "PHP", cadence: "monthly", dueDay: 10, accountId: 1 }];
  const store = ledger([manual(1, "checking", 1000)], document, [{ ...receipt, account_id: 1, transaction_date: "2026-11-10", merchant: "Internet", amount: 100 }]);
  await store.refresh(); await store.refresh();
  assert.equal(store.rows().length, 1);
  assert.equal(store.rows()[0].id, 9);
  assert.equal(store.accounts()[0].nativeCurrentBalance, 900);
});

test("live manual recurring occurrences stop at today, follow overrides and remain independent of the view horizon", async () => {
  const daily = entry({ id: "daily", date: "2026-11-16", recurrence: "daily", repeatUntil: "2026-11-20", amount: 5 });
  const document = livePlanner([daily]);
  document.plans[0].rowOverrides = [{ rowId: "entry:daily:2026-11-17", date: "2026-11-17", amount: 8, description: "Edited day" }];
  const store = ledger([manual(37, "credit", 100)], document);
  await store.refresh();
  assert.deepEqual(store.rows().map((row) => row.amount), [5, 8, 5]);
  assert.equal(store.accounts()[0].nativeCurrentBalance, 118);
  document.plans[0].startDate = "2026-11-18";
  document.plans[0].endDate = "2026-11-18";
  await store.refresh("2026-11-19"); await store.refresh("2026-11-19");
  assert.equal(store.rows().length, 4);
  assert.equal(store.accounts()[0].nativeCurrentBalance, 123);
  document.plans[0].entries = [];
  await store.refresh();
  assert.equal(store.rows().length, 0);
  assert.equal(store.accounts()[0].nativeCurrentBalance, 100);
});

test("automatic mixed transfers change manual legs only while explicit recording retains linked reconciliation", async () => {
  const payment = entry({ id: "pay", kind: "transfer", accountId: null, fromAccountId: 1, toAccountId: 37, amount: 50 });
  const document = livePlanner([payment]);
  const store = ledger([bank(1, 1000), manual(37, "credit", 500)], document);
  await store.refresh(); await store.refresh();
  assert.equal(store.rows().length, 1);
  assert.equal(store.rows()[0].account_id, 37);
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [1000, 450]);
  document.plans[0].completedRows = [completion("pay")];
  await store.refresh();
  assert.equal(store.rows().length, 2);
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [950, 450]);
  assert.equal(store.rows().find((row) => row.account_id === 1).plan_provisional, 1);
});

test("generated salary, bills and savings post their native manual movements exactly once", async () => {
  const document = livePlanner();
  document.salary = { amount: 2400, currency: "PHP", accountId: 1, payFrequency: "semimonthly", firstPayDate: "2026-11-01" };
  document.bills = [{ id: "internet", name: "Internet", amount: 100, currency: "PHP", cadence: "monthly", dueDay: 10, accountId: 1 }];
  document.allocations = [{ id: "saving", name: "Savings", kind: "savings", amount: 50, currency: "PHP", accountId: 34, sourceAccountId: 1 }];
  Object.assign(document.plans[0], { includeIncome: true, includeAllocations: true });
  const store = ledger([manual(1, "checking", 1000), manual(34, "savings", 200)], document);
  await store.refresh(); await store.refresh();
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [3200, 300]);
  assert.equal(store.rows().length, 7);
  assert.deepEqual([...new Set(store.rows().map((row) => JSON.parse(row.plan_record_json).plannerSource))].sort(), ["allocation", "bill", "salary"]);
  document.bills[0].amount = 150;
  await store.refresh();
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [3150, 300]);
});

test("same-save actual payments replace a scheduled bill and partial payments post only the remainder", async () => {
  for (const amount of [40, 100]) {
    const actual = entry({ id: "receipt", description: "Actual Internet", accountId: 1, amount,
      date: "2026-11-10", scheduledRowId: "bill:internet:2026-11-10" });
    const document = livePlanner([actual], [completion("receipt")]);
    document.bills = [{ id: "internet", name: "Internet", amount: 100, currency: "PHP", cadence: "monthly", dueDay: 10, accountId: 1 }];
    const store = ledger([manual(1, "checking", 1000)], document);
    await store.refresh(); await store.refresh();
    assert.equal(store.accounts()[0].nativeCurrentBalance, 900);
    assert.equal(store.rows().reduce((total, row) => total + row.amount, 0), 100);
    assert.equal(store.rows().length, amount === 100 ? 1 : 2);
  }
});

test("annual funding and its reserve-covered payment use native transfer legs without spending twice", async () => {
  const document = livePlanner();
  document.salary = { amount: 0, currency: "PHP", accountId: 1, payFrequency: "biweekly", firstPayDate: today };
  document.bills = [{ id: "annual", name: "Annual renewal", amount: 100, savedAmount: 0, currency: "PHP", cadence: "annual",
    dueMonths: [11], dueDay: 20, accountId: 1, sourceAccountId: 1, reserveAccountId: 2 }];
  document.plans[0].includeAnnualReserve = true;
  const store = ledger([manual(1, "checking", 1000), manual(2, "savings", 0)], document);
  await store.refresh(); await store.refresh();
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [900, 100]);
  assert.equal(store.rows().length, 2);
  await store.refresh("2026-11-20"); await store.refresh("2026-11-20");
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [900, 0]);
  assert.ok(store.rows().some((row) => row.source_plan_row_id === "bill:annual:2026-11-20"));
});

test("generated card charges are included before a live-balance payment is recorded and frozen", async () => {
  const payment = entry({ id: "full-pay", kind: "transfer", accountId: null, fromAccountId: 1, toAccountId: 37,
    amount: 0, amountMode: "cardBalance", date: "2026-11-18" });
  const document = livePlanner([payment]);
  document.bills = [{ id: "card-bill", name: "Card purchase", amount: 100, currency: "PHP", cadence: "monthly", dueDay: 17, accountId: 37 }];
  const store = ledger([manual(1, "checking", 1000), manual(37, "credit", 500)], document);
  await store.refresh(); await store.refresh();
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [400, 0]);
  assert.equal(store.rows().find((row) => row.source_plan_row_id === "entry:full-pay").amount, 600);
  document.bills[0].amount = 125;
  await store.refresh();
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [400, 25], "a past payment stays the actual amount after a bill correction");
});

test("manual card statements require funding and post debt and funding movements once", async () => {
  const document = livePlanner();
  document.plans[0].accountLinks = { availablePhpAccountId: 1 };
  const card = { ...manual(37, "credit", 500), credit_card_due_status: "manual",
    credit_card_due_json: JSON.stringify({ statementBalance: 200, dueDate: today, lastStatementDate: "2026-10-25" }) };
  const store = ledger([manual(1, "checking", 1000), card], document);
  await store.refresh(); await store.refresh();
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [800, 300]);
  document.plans[0].accountLinks = {};
  await store.refresh();
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [1000, 500]);
});

test("automatic conversion amounts keep their original exchange rate and reject inactive manual legs", async () => {
  const conversion = entry({ id: "convert", kind: "conversion", accountId: null, fromAccountId: 1, toAccountId: 2,
    currency: "USD", amount: 10 });
  const document = livePlanner([conversion]);
  const store = ledger([manual(1, "checking", 100, "USD"), manual(2, "cash", 0)], document);
  await store.refresh(); store.setRate(60); await store.refresh();
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [90, 580]);
  const ignored = financePlanPostingSpecs(livePlanner([entry()]), [{ ...manual(37, "credit", 0), is_sync_excluded: 1 }], [], { today });
  assert.deepEqual(ignored, []);
});

test("unassigned live entries use the same manual available-funds accounts as their visible projections", async () => {
  const document = livePlanner([
    entry({ id: "income", kind: "income", accountId: null, currency: "USD", amount: 40 }),
    entry({ id: "expense", accountId: null, currency: "USD", amount: 10 }),
    entry({ id: "convert", kind: "conversion", accountId: null, fromAccountId: null, toAccountId: null, currency: "USD", amount: 10 }),
  ]);
  document.plans[0].accountLinks = { availableUsdAccountId: 1, availablePhpAccountId: 2 };
  const store = ledger([manual(1, "checking", 100, "USD"), manual(2, "cash", 0)], document);
  await store.refresh(); await store.refresh();
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [120, 580]);
  assert.equal(store.rows().length, 4);
  document.plans[0].accountLinks.availableUsdAccountId = null;
  await store.refresh();
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [100, 580], "only the known manual conversion destination remains assigned");
});

test("excessive automatic recurrence fails clearly instead of silently truncating manual money", () => {
  const document = livePlanner([entry({ date: "1900-01-01", recurrence: "daily", repeatUntil: null })]);
  assert.throws(() => financePlanPostingSpecs(document, [manual(37, "credit", 0)], [], { today }), /more than 10,000 manual transactions/);
});

test("removing the authoritative planner removes its derived history without orphaned receipts", async () => {
  const document = livePlanner([entry({ amount: 100 })]);
  const store = ledger([manual(37, "credit", 500)], document);
  await store.refresh();
  document.plans = [];
  await store.refresh(); await store.refresh();
  assert.equal(store.rows().length, 0);
  assert.equal(store.accounts()[0].nativeCurrentBalance, 500);
});

test("deleting a whole plan retains recorded manual history and its corrected detached amount", async () => {
  const document = planner([entry({ amount: 100 })]);
  const store = ledger([manual(37, "credit", 500)], document);
  await store.refresh();
  document.plans = [];
  await store.refresh(); await store.refresh();
  assert.equal(store.rows().length, 1);
  assert.equal(store.accounts()[0].nativeCurrentBalance, 600);
  assert.equal(financePlanTransactionMetadata(store.rows()[0]).planDetached, true);
  assert.equal(financePlanTransactionMetadata(store.rows()[0]).planGenerated, false, "detached receipts cannot reopen a row in another plan");
  document.plans = [{ id: "main", entries: [], completedRows: [] }];
  await store.refresh();
  assert.equal(store.rows().length, 1, "recreating an automatic workspace with the same ID cannot erase detached history");
  const edited = store.rows()[0];
  // Simulate a user correcting its now standalone manual transaction.
  document.plans = [];
  const corrected = ledger([manual(37, "credit", 500)], document, [{ ...edited, amount: 125, merchant: "Corrected receipt" }]);
  await corrected.refresh();
  assert.equal(corrected.accounts()[0].nativeCurrentBalance, 625);
  assert.equal(corrected.rows()[0].merchant, "Corrected receipt");
});

test("detached linked receipts keep effective movement and reconcile a later bank import", async () => {
  const account = bank(1);
  const document = planner([entry({ accountId: 1, amount: 100 })]);
  const store = ledger([account], document);
  await store.refresh(); document.plans = []; await store.refresh();
  assert.equal(store.accounts()[0].nativeCurrentBalance, 900);
  assert.equal(financePlanTransactionMetadata(store.rows()[0]).planDetached, true);
  account.current_balance = 900;
  store.add({ id: 9, account_id: 1, transaction_date: today, kind: "expense", currency: "PHP", amount: 100,
    external_provider: "plaid", external_transaction_id: "later-bank" });
  await store.refresh(); await store.refresh();
  assert.equal(store.rows().length, 1);
  assert.equal(store.rows()[0].id, 9);
  assert.equal(store.accounts()[0].nativeCurrentBalance, 900);
  assert.equal(financePlanTransactionMetadata(store.rows()[0]).planDetached, true);
});
