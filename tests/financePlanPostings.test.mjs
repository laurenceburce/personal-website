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
  const events = [];
  const summary = () => accounts.map((account) => {
    const relevant = rows.filter((row) => Number(row.account_id) === Number(account.id) && row.currency === account.currency &&
      !row.pending && !row.is_provider_removed && row.duplicate_of_id == null && row.transaction_date <= today);
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
      if (sql.startsWith("SELECT t.*")) return [structuredClone(rows.filter((row) => params[0].includes(row.account_id) &&
        !row.pending && row.duplicate_of_id == null && !row.is_provider_removed && row.external_provider &&
        row.transaction_date >= params[1] && row.transaction_date <= params[2]))];
      if (sql.startsWith("DELETE")) {
        rows = rows.filter((row) => !(row.id === params[0] && row.plan_generated && !row.external_provider && !row.external_transaction_id));
      } else if (sql.startsWith("UPDATE") && sql.includes("source_plan_id = NULL")) {
        Object.assign(rows.find((row) => row.id === params[0]), { source_plan_id: null, source_plan_row_id: null,
          source_plan_leg: null, plan_generated: 0, plan_provisional: 0, plan_record_json: null });
      } else if (sql.startsWith("UPDATE")) {
        Object.assign(rows.find((row) => row.id === params[4]), { source_plan_id: params[0], source_plan_row_id: params[1],
          source_plan_leg: params[2], plan_record_json: params[3], plan_generated: 0, plan_provisional: 0 });
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
    refresh: () => refreshFinancePlanPostings({ getConnection: async () => connection }, today),
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

test("an ongoing planner records only addressed completed occurrences across decades of recurrence", () => {
  const daily = entry({ id: "daily", date: "2000-01-01", recurrence: "daily", repeatUntil: null });
  const monthly = entry({ id: "monthly", date: "2000-01-31", recurrence: "monthly", repeatUntil: null });
  const doc = planner([daily, monthly], [
    { rowId: `entry:daily:${today}`, completedAt: `${today}T12:00:00.000Z` },
    { rowId: "entry:monthly:2026-02-28", completedAt: `${today}T12:00:00.000Z` },
    { rowId: "entry:monthly:2026-02-27", completedAt: `${today}T12:00:00.000Z` },
  ]);
  Object.assign(doc.plans[0], { continuous: true, startDate: "2000-01-01", endDate: "2040-12-31",
    rowOverrides: [{ rowId: "entry:daily:2026-11-18", date: "2026-11-17", description: "Paid early", amount: 15 }] });
  const specs = financePlanPostingSpecs(doc, [manual(37, "credit", 0)], [], { today });
  assert.deepEqual(specs.map((row) => [row.rowId, row.date, row.amount]), [
    ["entry:daily:2026-11-18", "2026-11-17", 15], ["entry:monthly:2026-02-28", "2026-02-28", 20],
  ]);
  doc.plans[0].startDate = "2026-11-18";
  doc.plans[0].endDate = "2026-12-18";
  assert.deepEqual(financePlanPostingSpecs(doc, [manual(37, "credit", 0)], [], { today }), specs,
    "changing a view-sized horizon cannot delete historical receipts");
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
