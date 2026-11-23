import assert from "node:assert/strict";
import test from "node:test";
import { financePlanPostingSpecs, financePlanTransactionMetadata, freezeFinancePlanRestartHistory, refreshFinancePlanPostings, synchronizeFinancePlanPostings } from "../app/lib/financePlanPostings.mjs";
import { mapFinanceActivityAccount } from "../app/lib/financeActivity.mjs";
import { buildPlanRows } from "../app/lib/financePlanner.mjs";

const today = "2026-11-18";
const completion = (id) => ({ rowId: `entry:${id}`, completedAt: `${today}T12:00:00.000Z` });
const entry = (extra = {}) => ({ id: "purchase", date: today, description: "Fill", kind: "expense", amount: 20,
  currency: "PHP", accountId: 37, ...extra });
const planner = (entries, completed = entries.map((row) => completion(row.id))) => ({ salary: {}, plans: [{ id: "main",
  startDate: "2026-11-01", endDate: "2027-01-31", entries, completedRows: completed,
  restart: { version: 1, date: "1900-01-01", transactionId: 0, balances: [], coveredEntryIds: [] } }] });
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
  let matchFailure = false;
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
      if (sql.startsWith("SELECT t.*") && sql.includes("t.id <= ?")) {
        const allPlans = sql.includes("t.source_plan_id IS NOT NULL");
        const [planId, transactionId, date] = allPlans ? [null, ...params] : params;
        return [structuredClone(rows.filter((row) => row.source_plan_id && (allPlans || row.source_plan_id === planId) && row.id <= transactionId &&
          !row.pending && row.duplicate_of_id == null && !row.is_provider_removed && row.transaction_date <= date))];
      }
      if (sql.startsWith("SELECT t.*") && sql.includes("t.source_plan_id IS NOT NULL"))
        return [structuredClone(rows.filter((row) => row.source_plan_id))];
      if (sql.startsWith("SELECT t.*") && sql.includes("WHERE t.pending = 1"))
        return [structuredClone(rows.filter((row) => row.pending && params[0].includes(row.account_id) && row.external_provider &&
          row.duplicate_of_id == null && !row.is_provider_removed && row.transaction_date <= params[1]))];
      if (sql.startsWith("SELECT t.*") && sql.includes("WHERE t.pending = 0"))
        return [structuredClone(rows.filter((row) => !row.pending && row.duplicate_of_id == null &&
          !row.is_provider_removed && row.transaction_date <= params[0]))];
      if (sql.startsWith("SELECT t.*")) return [structuredClone(rows.filter((row) => params[0].includes(row.account_id) &&
        row.duplicate_of_id == null && !row.is_provider_removed && row.external_provider &&
        ((row.transaction_date >= params[1] && row.transaction_date <= params[2]) ||
          params[3]?.includes(row.external_pending_transaction_id) || params[4]?.includes(row.external_transaction_id) || params[5]?.includes(row.id))))];
      if (sql.startsWith("DELETE")) {
        rows = rows.filter((row) => !(row.id === params[0] && row.plan_generated && !row.external_provider && !row.external_transaction_id));
      } else if (sql.startsWith("UPDATE") && sql.includes("source_plan_id = NULL")) {
        Object.assign(rows.find((row) => row.id === params[0]), { source_plan_id: null, source_plan_row_id: null,
          source_plan_leg: null, plan_generated: 0, plan_provisional: 0, plan_record_json: null });
      } else if (sql.startsWith("UPDATE") && sql.includes("SET plan_generated = 1, plan_record_json")) {
        Object.assign(rows.find((row) => row.id === params[1]), { plan_generated: 1, plan_record_json: params[0] });
      } else if (sql.startsWith("UPDATE") && sql.includes("SET plan_record_json = ?")) {
        Object.assign(rows.find((row) => row.id === params[1]), { plan_record_json: params[0] });
      } else if (sql.startsWith("UPDATE")) {
        if (matchFailure) throw new Error("Pending association failed");
        Object.assign(rows.find((row) => row.id === params[4]), { source_plan_id: params[0], source_plan_row_id: params[1],
          source_plan_leg: params[2], plan_record_json: params[3], plan_generated: sql.includes("plan_generated = 1") ? 1 : 0, plan_provisional: 0 });
      } else if (sql.startsWith("INSERT")) {
        if (failure && params[10] === "credit") throw new Error("Second transfer leg failed");
        const old = rows.find((row) => row.source_plan_id === params[8] && row.source_plan_row_id === params[9] && row.source_plan_leg === params[10]);
        const row = { id: old?.id || sequence++, transaction_date: params[0], kind: params[1], account_id: params[2], category: params[3],
          merchant: params[4], note: params[5], amount: params[6], currency: params[7], source_plan_id: params[8],
          source_plan_row_id: params[9], source_plan_leg: params[10], plan_generated: 1, plan_provisional: params[11], plan_record_json: params[12], pending: params[13] || 0 };
        if (old) Object.assign(old, row); else rows.push(row);
      } else throw new Error(`Unexpected query: ${sql}`);
      return [{ affectedRows: 1 }];
    },
  };
  return {
    async refresh(date = today) {
      currentDate = date;
      if (document.plans?.length) return refreshFinancePlanPostings({ getConnection: async () => connection }, date);
      // Exercise explicit plan-removal synchronization independently of the
      // automatic one-time migration guard on a normal account refresh.
      try {
        await connection.beginTransaction();
        await synchronizeFinancePlanPostings(connection, document, { today: date, rate });
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
    },
    rows: () => structuredClone(rows), accounts: () => summary().map(mapFinanceActivityAccount),
    async freeze(date = today, { allPlans = false } = {}) {
      const transactionId = Math.max(0, ...rows.map((row) => row.id));
      await connection.beginTransaction();
      await freezeFinancePlanRestartHistory(connection, { planId: document.plans[0].id, date, transactionId, allPlans });
      await connection.commit();
      return transactionId;
    },
    add: (row) => rows.push(structuredClone(row)), update: (id, changes) => Object.assign(rows.find((row) => row.id === id), changes),
    fail: () => { failure = true; }, failMatch: () => { matchFailure = true; }, setRate: (value) => { rate = value; }, events,
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

test("linked-account recorded activity keeps the bank balance until a unique bank import replaces it", async () => {
  const account = bank(1);
  const document = planner([entry({ accountId: 1 })]);
  const store = ledger([account], document);
  await store.refresh();
  assert.equal(store.accounts()[0].nativeCurrentBalance, 1000);
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

const pendingCharge = (extra = {}) => ({ id: 9, account_id: 1, transaction_date: today, kind: "expense", currency: "USD", amount: 20,
  merchant: "OPENAI *CHATGPT SUBSCR", external_provider: "plaid", external_transaction_id: "pending-auth", pending: 1, ...extra });
const linkedCard = (extra = {}) => ({ ...bank(1, 100), account_type: "credit", currency: "USD", ...extra });
const linkedPurchase = (extra = {}) => entry({ accountId: 1, description: "OpenAI", currency: "USD", ...extra });

function visibleLedgerPlan(store, document, currentDate = today) {
  const transactions = store.rows().filter((row) => !row.is_provider_removed && row.duplicate_of_id == null).map((row) => ({
    id: row.id, date: row.transaction_date, kind: row.kind, accountId: row.account_id, amount: row.amount, currency: row.currency,
    merchant: row.merchant, provider: row.external_provider || "", externalId: row.external_transaction_id || "",
    pendingExternalId: row.external_pending_transaction_id || "", pending: Boolean(row.pending), ...financePlanTransactionMetadata(row),
  }));
  return buildPlanRows(document.plans[0], document, 58, { accounts: store.accounts(), transactions, today: currentDate });
}

test("an unrecorded linked task owns its unique pending receipt and completes once through changed provider settlement", async () => {
  const card = linkedCard();
  const document = planner([linkedPurchase()], []);
  document.plans[0].continuous = true;
  const store = ledger([card], document, [pendingCharge()]);
  await store.refresh(); await store.refresh();
  assert.equal(store.rows().length, 1);
  assert.equal(store.rows()[0].source_plan_row_id, "entry:purchase");
  assert.equal(JSON.parse(store.rows()[0].plan_record_json).pendingOnly, true);
  let visible = visibleLedgerPlan(store, document);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].completionKey || visible[0].id, "entry:purchase");
  assert.equal(visible[0].bankPending, true);
  assert.equal(visible[0].completed, false);
  assert.equal(store.accounts()[0].nativeCurrentBalance, 100);
  store.update(9, { amount: 22, transaction_date: "2026-11-23", merchant: "Updated bank label" });
  await store.refresh("2026-11-23");
  visible = visibleLedgerPlan(store, document, "2026-11-23");
  assert.equal(visible.length, 1);
  assert.equal(visible[0].bankPending, true);
  assert.equal(visible[0].completed, false);
  store.update(9, { is_provider_removed: 1 });
  store.add(pendingCharge({ id: 10, pending: 0, transaction_date: "2026-11-27", merchant: "Completely different settled label", amount: 21.5,
    external_transaction_id: "posted-charge", external_pending_transaction_id: "pending-auth" }));
  card.current_balance = 121.5;
  await store.refresh("2026-11-27"); await store.refresh("2026-11-27");
  assert.equal(store.rows().find((row) => row.id === 10).source_plan_row_id, "entry:purchase");
  assert.equal(store.rows().filter((row) => row.plan_generated).length, 0);
  visible = visibleLedgerPlan(store, document, "2026-11-27");
  assert.equal(visible.length, 1);
  assert.equal(visible[0].completionKey || visible[0].id, "entry:purchase");
  assert.equal(visible[0].completed, true);
  assert.equal(visible[0].amount, 21.5);
  assert.equal(visible[0].bankPending, undefined);
  assert.equal(visible[0].bankPendingRemoved, undefined);
  assert.equal(store.accounts()[0].nativeCurrentBalance, 121.5);
});

test("pending-only tasks never create a local receipt when pending evidence is unrelated or ambiguous", async () => {
  for (const initial of [[pendingCharge({ merchant: "Different merchant" })],
    [pendingCharge(), pendingCharge({ id: 10, external_transaction_id: "another-auth" })], []]) {
    const document = planner([linkedPurchase()], []);
    document.plans[0].continuous = true;
    const store = ledger([linkedCard()], document, initial);
    await store.refresh(); await store.refresh();
    assert.equal(store.rows().length, initial.length);
    assert.ok(store.rows().every((row) => !row.source_plan_id && !row.plan_generated));
    assert.equal(store.accounts()[0].nativeCurrentBalance, 100);
  }
});

test("a lower final bank amount settles the pending task without adding a phantom remainder to a later full payment", async () => {
  const card = linkedCard();
  const document = planner([linkedPurchase()], []);
  document.plans[0].continuous = true;
  const store = ledger([card, { ...bank(2, 1000), currency: "USD" }], document, [pendingCharge()]);
  await store.refresh();
  store.update(9, { is_provider_removed: 1 });
  store.add(pendingCharge({ id: 10, pending: 0, transaction_date: "2026-11-27", merchant: "Final provider merchant", amount: 19.8,
    external_transaction_id: "settled-lower-amount", external_pending_transaction_id: "pending-auth" }));
  card.current_balance = 119.8;
  await store.refresh("2026-11-27"); await store.refresh("2026-11-27");
  const settled = store.rows().find((row) => row.id === 10);
  assert.equal(financePlanTransactionMetadata(settled).bankPendingSettled, true);
  assert.equal(financePlanTransactionMetadata(settled).pendingBankExternalId, "pending-auth");
  document.plans[0].entries.push(linkedPurchase({ id: "pay", kind: "transfer", accountId: null,
    fromAccountId: 2, toAccountId: 1, date: "2026-11-28", amountMode: "cardBalance", amount: 0, description: "Pay card" }));
  const rows = visibleLedgerPlan(store, document, "2026-11-27");
  assert.equal(rows.find((row) => row.completionKey === "entry:purchase").amount, 19.8);
  assert.equal(rows.find((row) => row.entryId === "pay").amount, 119.8,
    "the original planned twenty does not add an extra twenty cents after bank settlement");
  assert.equal(store.rows().filter((row) => row.plan_generated).length, 0);
});

test("a unique pending bank charge replaces the local posted surrogate without changing the bank balance", async () => {
  const document = planner([linkedPurchase()]);
  const store = ledger([linkedCard()], document);
  await store.refresh();
  assert.equal(store.rows().length, 1);
  assert.equal(store.rows()[0].pending, 0);
  const provisionalId = store.rows()[0].id;
  store.add(pendingCharge());
  await store.refresh(); await store.refresh();
  assert.equal(store.rows().length, 1);
  const [pending] = store.rows();
  assert.equal(pending.id, 9);
  assert.notEqual(pending.id, provisionalId);
  assert.equal(pending.pending, 1);
  assert.equal(pending.amount, 20);
  assert.equal(pending.source_plan_row_id, "entry:purchase");
  assert.equal(pending.plan_generated, 0);
  assert.equal(pending.plan_provisional, 0);
  const metadata = financePlanTransactionMetadata(pending);
  assert.equal(metadata.bankPending, true);
  assert.equal(metadata.awaitingBankSync, false);
  assert.equal(metadata.recordedFromPlan, false);
  assert.equal(store.accounts()[0].nativeCurrentBalance, 100);
  assert.equal(store.accounts()[0].planPendingMovement, undefined);
});

test("pending-to-posted provider identity retains one canonical task when date, name and amount change", async () => {
  const card = linkedCard();
  const document = planner([linkedPurchase()]);
  const store = ledger([card], document, [pendingCharge()]);
  await store.refresh();
  store.update(9, { amount: 22, transaction_date: "2026-11-23", merchant: "Changed pending description" });
  await store.refresh("2026-11-23");
  assert.equal(store.rows().length, 1);
  assert.equal(store.rows()[0].source_plan_row_id, "entry:purchase", "an already identified authorization may change before settlement");
  store.update(9, { is_provider_removed: 1 });
  store.add(pendingCharge({ id: 10, pending: 0, transaction_date: "2026-11-27", merchant: "Settled service charge", amount: 21.5,
    external_transaction_id: "posted-charge", external_pending_transaction_id: "pending-auth" }));
  card.current_balance = 121.5;
  await store.refresh("2026-11-27"); await store.refresh("2026-11-27");
  const rows = store.rows();
  assert.equal(rows.length, 2, "the removed authorization stays bank history; no generated expense survives");
  assert.equal(rows.find((row) => row.id === 9).source_plan_id, null);
  const settled = rows.find((row) => row.id === 10);
  assert.equal(settled.source_plan_row_id, "entry:purchase");
  assert.equal(settled.amount, 21.5);
  assert.equal(settled.transaction_date, "2026-11-27");
  assert.equal(settled.pending, 0);
  assert.equal(settled.plan_generated, 0);
  assert.equal(financePlanTransactionMetadata(settled).bankPending, undefined);
  assert.equal(financePlanTransactionMetadata(settled).awaitingBankSync, false);
  assert.equal(store.accounts()[0].nativeCurrentBalance, 121.5);
});

test("posted bank evidence wins over a matching pending authorization", async () => {
  const store = ledger([linkedCard({ current_balance: 120 })], planner([linkedPurchase()]), [
    pendingCharge(), pendingCharge({ id: 10, pending: 0, external_transaction_id: "settled-charge" }),
  ]);
  await store.refresh();
  assert.equal(store.rows().find((row) => row.id === 10).source_plan_row_id, "entry:purchase");
  assert.equal(store.rows().find((row) => row.id === 9).source_plan_id, undefined);
  assert.equal(store.rows().filter((row) => row.plan_generated).length, 0);
  assert.equal(store.accounts()[0].nativeCurrentBalance, 120);
});

test("a known pending owner survives similar new authorizations and unrelated settled charges", async () => {
  const store = ledger([linkedCard()], planner([linkedPurchase()]), [pendingCharge()]);
  await store.refresh();
  store.add(pendingCharge({ id: 10, external_transaction_id: "second-authorization" }));
  store.add(pendingCharge({ id: 11, pending: 0, merchant: "Different merchant", external_transaction_id: "unrelated-posted" }));
  await store.refresh(); await store.refresh();
  assert.equal(store.rows().find((row) => row.id === 9).source_plan_row_id, "entry:purchase");
  assert.equal(store.rows().find((row) => row.id === 10).source_plan_id, undefined);
  assert.equal(store.rows().find((row) => row.id === 11).source_plan_id, undefined);
  assert.equal(store.rows().filter((row) => row.plan_generated).length, 0);
});

test("pending matching requires distinctive merchant evidence and unique native account, currency and kind", async () => {
  for (const changes of [{ merchant: "Another service" }, { merchant: "Card purchase payment" }, { currency: "PHP" },
    { account_id: 2 }, { kind: "income" }, { amount: 21 }, { transaction_date: "2026-11-10" }]) {
    const store = ledger([linkedCard(), linkedCard({ id: 2, external_account_id: "other-card" })],
      planner([linkedPurchase()]), [pendingCharge(changes)]);
    await store.refresh();
    assert.equal(store.rows().find((row) => row.id === 9).source_plan_id, undefined, JSON.stringify(changes));
    assert.equal(store.rows().filter((row) => row.plan_generated).length, 1);
    assert.equal(store.accounts()[0].nativeCurrentBalance, 100);
  }
  const ambiguous = ledger([linkedCard()], planner([linkedPurchase()]), [pendingCharge(), pendingCharge({ id: 10, external_transaction_id: "other-authorization" })]);
  await ambiguous.refresh();
  assert.ok(ambiguous.rows().filter((row) => row.external_provider).every((row) => !row.source_plan_id));
  const competing = ledger([linkedCard()], planner([linkedPurchase(), linkedPurchase({ id: "second" })]), [pendingCharge()]);
  await competing.refresh();
  assert.equal(competing.rows().find((row) => row.id === 9).source_plan_id, undefined);
});

test("a removed pending authorization leaves a nonfinancial review marker instead of resurrecting a posted expense", async () => {
  const document = planner([linkedPurchase()]);
  const store = ledger([linkedCard()], document, [pendingCharge()]);
  await store.refresh();
  store.update(9, { is_provider_removed: 1 });
  await store.refresh(); await store.refresh();
  assert.equal(store.rows().length, 2);
  const removed = store.rows().find((row) => row.id === 9);
  assert.equal(removed.source_plan_id, null);
  assert.equal(removed.is_provider_removed, 1);
  const marker = store.rows().find((row) => row.plan_generated);
  assert.equal(marker.pending, 1);
  assert.equal(marker.source_plan_row_id, "entry:purchase");
  assert.equal(financePlanTransactionMetadata(marker).bankPendingRemoved, true);
  assert.equal(financePlanTransactionMetadata(marker).bankPending, undefined);
  assert.equal(financePlanTransactionMetadata(marker).pendingBankExternalId, "pending-auth");
  assert.equal(financePlanTransactionMetadata(marker).recordedFromPlan, false);
  assert.equal(financePlanTransactionMetadata(marker).awaitingBankSync, false);
  assert.equal(store.accounts()[0].nativeCurrentBalance, 100);
  document.plans[0].entries = [];
  document.plans[0].completedRows = [];
  await store.refresh();
  assert.deepEqual(store.rows().map((row) => row.id), [9], "deleting the task deletes only the review marker, preserving bank history");
});

test("a canceled authorization can settle later by provider identity or be superseded by an explicit financial edit", async () => {
  for (const settle of [true, false]) {
    const purchase = linkedPurchase();
    const document = planner([purchase]);
    const store = ledger([linkedCard()], document, [pendingCharge()]);
    await store.refresh();
    store.update(9, { is_provider_removed: 1 });
    await store.refresh();
    if (settle) store.add(pendingCharge({ id: 10, pending: 0, transaction_date: "2026-12-01", amount: 21.5,
      external_transaction_id: "later-settlement", external_pending_transaction_id: "pending-auth" }));
    else purchase.amount = 30;
    await store.refresh("2026-12-01"); await store.refresh("2026-12-01");
    const active = store.rows().filter((row) => !row.is_provider_removed);
    assert.equal(active.length, 1);
    assert.equal(active[0].pending, 0);
    assert.equal(financePlanTransactionMetadata(active[0]).bankPendingRemoved, undefined);
    assert.equal(active[0].amount, settle ? 21.5 : 30);
    assert.equal(active[0].plan_generated, settle ? 0 : 1);
  }
});

test("failure while claiming a pending receipt restores the previous local row and provider history together", async () => {
  const store = ledger([linkedCard()], planner([linkedPurchase()]));
  await store.refresh();
  store.add(pendingCharge());
  const before = store.rows();
  store.failMatch();
  await assert.rejects(store.refresh(), /Pending association failed/);
  assert.deepEqual(store.rows(), before);
  assert.equal(store.accounts()[0].nativeCurrentBalance, 100);
  assert.deepEqual(store.events.slice(-3), ["begin", "rollback", "release"]);
});

test("live full-balance payments use the connected card's reported debt without pending planner adjustments", async () => {
  const document = planner([entry({ accountId: 37, amount: 100 })]);
  const card = { ...bank(37, 500), account_type: "credit" };
  const store = ledger([manual(1, "checking", 1000), card], document);
  await store.refresh();
  document.plans = [];
  await store.refresh();
  document.plans = livePlanner([entry({ id: "payment", kind: "transfer", accountId: null,
    fromAccountId: 1, toAccountId: 37, amount: 0, amountMode: "cardBalance" })]).plans;
  for (let index = 0; index < 3; index++) await store.refresh();
  const payment = store.rows().find((row) => row.source_plan_row_id === "entry:payment");
  assert.equal(payment.amount, 500, "an unimported planner charge cannot increase the reported card debt");
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [500, 500]);
  assert.equal(store.rows().length, 2);
  card.current_balance = 600;
  store.add({ id: 9, account_id: 37, transaction_date: today, kind: "expense", currency: "PHP", amount: 100,
    external_provider: "plaid", external_transaction_id: "reported-card-charge" });
  await store.refresh(); await store.refresh();
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [500, 600]);
  assert.equal(store.rows().length, 2, "the bank import replaces the provisional charge without another manual withdrawal");
  assert.equal(store.rows().find((row) => row.source_plan_row_id === "entry:payment").amount, 500);
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

test("saved same-day order sets new manual live-payment amounts and later reordering preserves posted receipts", async () => {
  for (const generatedBill of [false, true]) for (const paymentFirst of [false, true]) {
    const payment = entry({ id: "pay", description: "Pay card", kind: "transfer", accountId: null,
      fromAccountId: 1, toAccountId: 37, amount: 0, amountMode: "cardBalance" });
    const charge = entry({ id: "charge", amount: 100 });
    const document = livePlanner(generatedBill ? [payment] : [charge, payment]);
    if (generatedBill) document.bills = [{ id: "charge", name: "Card bill", amount: 100, currency: "PHP", cadence: "monthly", dueDay: 18, accountId: 37 }];
    const chargeId = generatedBill ? `bill:charge:${today}` : "entry:charge";
    const rowIds = paymentFirst ? ["entry:pay", chargeId] : [chargeId, "entry:pay"];
    document.plans[0].rowOrder = [{ date: today, rowIds }];
    const rawAccounts = [manual(1, "checking", 1000), manual(37, "credit", 500)];
    const store = ledger(rawAccounts, document);
    await store.refresh(); await store.refresh();
    const paid = paymentFirst ? 500 : 600;
    assert.deepEqual(store.accounts().map((account) => account.nativeCurrentBalance), [1000 - paid, 600 - paid]);
    const receipts = () => store.rows().map(({ id, account_id, amount, transaction_date }) => ({ id, account_id, amount, transaction_date }))
      .sort((a, b) => a.id - b.id);
    const recorded = receipts();
    assert.equal(recorded.length, 3);
    assert.ok(store.rows().filter((row) => row.source_plan_row_id === "entry:pay").every((row) => row.amount === paid));
    document.plans[0].rowOrder = [{ date: today, rowIds: [...rowIds].reverse() }];
    await store.refresh(); await store.refresh();
    assert.deepEqual(receipts(), recorded, "changing display chronology cannot rewrite an already-posted payment amount or its identity");
    assert.deepEqual(store.accounts().map((account) => account.nativeCurrentBalance), [1000 - paid, 600 - paid]);
    assert.deepEqual(rawAccounts.map((account) => account.opening_balance), [1000, 500]);
  }
});

test("automatic account refresh waits for the one-time planner restart without materializing legacy forecasts", async () => {
  const document = livePlanner([entry()]);
  delete document.plans[0].restart;
  const calls = [];
  const connection = {
    async beginTransaction() { calls.push("begin"); },
    async query(sql) { assert.match(sql, /SELECT document, exchange_rate.*FOR UPDATE/); return [[{ document, exchange_rate: { rate: 58 } }]]; },
    async commit() { calls.push("commit"); }, async rollback() { calls.push("rollback"); }, release() { calls.push("release"); },
  };
  await refreshFinancePlanPostings({ getConnection: async () => connection }, today);
  assert.deepEqual(calls, ["begin", "commit", "release"]);
});

test("restart freezes the existing ledger and resumes schedules after the cutover without changing current balances", async () => {
  const old = entry();
  const payment = entry({ id: "payment", kind: "transfer", accountId: null, fromAccountId: 1, toAccountId: 37, amount: 50 });
  const bankExpense = entry({ id: "bank", accountId: 2, amount: 25 });
  const daily = entry({ id: "daily", date: "2026-11-17", recurrence: "daily", accountId: 1, amount: 3 });
  const document = livePlanner([old, payment, bankExpense, daily], [completion("bank")]);
  document.salary = { amount: 100, currency: "PHP", accountId: 1, firstPayDate: today, payFrequency: "biweekly" };
  document.bills = [{ id: "monthly", name: "Monthly", amount: 40, currency: "PHP", cadence: "monthly", dueDays: [18, 19], accountId: 1 }];
  document.allocations = [{ id: "savings", name: "Savings", kind: "savings", amount: 10, currency: "PHP", sourceAccountId: 1, accountId: 3 }];
  Object.assign(document.plans[0], { includeIncome: true, includeAllocations: true });
  const imported = { id: 8, account_id: 2, transaction_date: today, kind: "expense", amount: 25, currency: "PHP",
    merchant: "Original bank merchant", note: "Keep the bank fields", external_provider: "plaid", external_transaction_id: "bank-expense" };
  const independent = { id: 9, account_id: 1, transaction_date: "2026-11-17", kind: "expense", amount: 10, currency: "PHP", merchant: "Independent" };
  const rawAccounts = [manual(1, "checking", 1000), manual(37, "credit", 100), manual(3, "savings", 0), bank(2, 300)];
  const store = ledger(rawAccounts, document, [imported, independent]);
  await store.refresh();
  const baseline = store.accounts().map((account) => account.nativeCurrentBalance);
  const saved = store.rows();
  const financialRows = (rows) => rows.map(({ plan_record_json, ...row }) => row);
  const transactionId = await store.freeze();
  assert.deepEqual(financialRows(store.rows()), financialRows(saved), "freezing changes metadata only, including both transfer legs");
  assert.deepEqual(store.accounts().map((account) => account.nativeCurrentBalance), baseline);
  assert.equal(store.rows().find((row) => row.id === independent.id).plan_record_json, undefined);
  document.plans[0].restart = { version: 1, date: today, transactionId, balances: [], coveredEntryIds: [old.id, payment.id, bankExpense.id, daily.id] };
  old.amount = 999;
  payment.amount = 80;
  payment.date = "2026-11-19";
  document.salary.amount = 200;
  document.bills[0].amount = 80;
  document.plans[0].entries.push(entry({ id: "new", accountId: 1, amount: 7 }),
    entry({ id: "backdated", accountId: 1, amount: 99, date: "2026-11-17" }));
  for (let index = 0; index < 3; index++) await store.refresh();
  assert.deepEqual(store.accounts().map((account) => account.nativeCurrentBalance), [baseline[0] - 7, ...baseline.slice(1)]);
  for (const row of saved) assert.deepEqual(financialRows([store.rows().find((current) => current.id === row.id)]), financialRows([row]));
  assert.equal(store.rows().filter((row) => row.source_plan_row_id === "entry:new").length, 1);
  assert.equal(store.rows().some((row) => row.source_plan_row_id === "entry:backdated"), false);
  for (let index = 0; index < 3; index++) await store.refresh("2026-11-19");
  assert.deepEqual(store.accounts().map((account) => account.nativeCurrentBalance), [baseline[0] - 7 - 40 - 3, ...baseline.slice(1)]);
  assert.equal(store.rows().filter((row) => row.source_plan_row_id === "bill:monthly:2026-11-19").length, 1);
  assert.equal(store.rows().filter((row) => row.source_plan_row_id === "entry:daily:2026-11-19").length, 1);
  for (const [field, value] of Object.entries(imported)) assert.equal(store.rows().find((row) => row.id === imported.id)[field], value);
  document.plans = [];
  await store.refresh("2026-11-19");
  assert.deepEqual(financialRows(store.rows()), financialRows(saved), "baseline history remains after its old planner source is removed");
  assert.deepEqual(store.accounts().map((account) => account.nativeCurrentBalance), baseline);
  assert.equal(rawAccounts[0].opening_balance, 1000);
});

test("restart retains valid future overrides of earlier manual and automatic occurrences exactly once", async () => {
  for (const alreadyRecorded of [false, true]) {
    const daily = entry({ id: "daily", date: "2026-11-17", recurrence: "daily", accountId: 1, amount: 3 });
    const once = entry({ id: "once", date: "2026-11-17", accountId: 1, amount: 2 });
    const document = livePlanner([daily, once]);
    document.bills = [{ id: "monthly", name: "Monthly", amount: 11, currency: "PHP", cadence: "monthly", dueDay: 17, accountId: 1 }];
    document.plans[0].restart = { version: 1, date: today, transactionId: alreadyRecorded ? 9 : 0, balances: [], coveredEntryIds: [daily.id, once.id] };
    document.plans[0].rowOverrides = [
      { rowId: "entry:daily:2026-11-17", date: "2026-11-19", amount: 7, description: "Moved daily" },
      { rowId: "entry:once", date: "2026-11-19", amount: 6, description: "Moved once" },
      { rowId: "bill:monthly:2026-11-17", date: "2026-11-19", amount: 11, description: "Moved bill" },
    ];
    const original = { id: 9, source_plan_id: "main", source_plan_row_id: "entry:daily:2026-11-17", source_plan_leg: "single",
      transaction_date: "2026-11-17", account_id: 1, currency: "PHP", kind: "expense", amount: 3, plan_generated: 1,
      merchant: "Daily", plan_record_json: JSON.stringify({ planId: "main", rowId: "entry:daily:2026-11-17", leg: "single",
        accountId: 1, currency: "PHP", kind: "expense", amount: 3, sourceAmount: 3, date: "2026-11-17", description: "Daily",
        category: "Uncategorized", manualPlannerSource: true, detached: true, resetHistory: true }) };
    const store = ledger([manual(1, "checking", 1000)], document, alreadyRecorded ? [original] : []);
    await store.refresh();
    assert.equal(store.rows().length, alreadyRecorded ? 1 : 0);
    await store.refresh("2026-11-19"); await store.refresh("2026-11-19");
    assert.equal(store.accounts()[0].nativeCurrentBalance, alreadyRecorded ? 977 : 973);
    assert.equal(store.rows().filter((row) => row.source_plan_row_id === "bill:monthly:2026-11-17").length, 1);
    assert.equal(store.rows().filter((row) => row.source_plan_row_id === "entry:once").length, 1);
    const moved = store.rows().find((row) => row.source_plan_row_id === "entry:daily:2026-11-17");
    assert.equal(moved.amount, alreadyRecorded ? 3 : 7, "a captured receipt cannot be reposted by its future override");
    assert.equal(moved.transaction_date, alreadyRecorded ? "2026-11-17" : "2026-11-19");
  }
});

test("restart preserves a posted legacy receipt whose source row identity is incomplete", async () => {
  const document = livePlanner();
  const original = { id: 9, source_plan_id: "main", source_plan_row_id: null, source_plan_leg: null,
    transaction_date: today, account_id: 1, currency: "PHP", kind: "income", amount: 25, plan_generated: 1,
    merchant: "Legacy saved receipt", note: "Retain this money", plan_record_json: "{}" };
  const store = ledger([manual(1, "checking", 100)], document, [original]);
  const transactionId = await store.freeze();
  document.plans[0].restart = { version: 1, date: today, transactionId, balances: [], coveredEntryIds: [] };
  await store.refresh(); await store.refresh();
  assert.equal(store.rows().length, 1);
  assert.equal(store.rows()[0].id, original.id);
  assert.equal(store.rows()[0].amount, 25);
  assert.equal(store.rows()[0].note, original.note);
  assert.equal(store.accounts()[0].nativeCurrentBalance, 125);
});

test("restart covers secondary plans without backfilling their missing past receipts or revising captured money", async () => {
  const cutover = "2026-11-20";
  const document = livePlanner();
  const old = entry({ id: "old", date: "2026-11-10", amount: 20 });
  const missing = entry({ id: "missing", date: "2026-11-10", accountId: 1, amount: 30 });
  const future = entry({ id: "future", date: "2026-11-21", accountId: 1, amount: 7 });
  document.plans.push({ id: "legacy", startDate: "2026-11-01", endDate: "2026-11-30", entries: [old, missing, future],
    completedRows: [old, missing, future].map((row) => ({ rowId: `entry:${row.id}`, completedAt: `${row.date}T12:00:00.000Z` })) });
  const saved = { id: 9, source_plan_id: "legacy", source_plan_row_id: "entry:old", source_plan_leg: "single",
    transaction_date: old.date, account_id: 37, currency: "PHP", kind: "expense", amount: 20, plan_generated: 1,
    merchant: "Legacy recorded expense", note: "Keep original", plan_record_json: JSON.stringify({ planId: "legacy", rowId: "entry:old", leg: "single",
      accountId: 37, currency: "PHP", kind: "expense", amount: 20, sourceAmount: 20, date: old.date,
      description: "Legacy recorded expense", category: "Uncategorized" }) };
  const independent = { id: 8, account_id: 1, transaction_date: old.date, currency: "PHP", kind: "expense", amount: 5, merchant: "Independent" };
  const store = ledger([manual(1, "checking", 1000), manual(37, "credit", 100)], document, [saved, independent]);
  const transactionId = await store.freeze(cutover, { allPlans: true });
  assert.equal(JSON.parse(store.rows().find((row) => row.id === saved.id).plan_record_json).resetHistory, true);
  assert.equal(store.rows().find((row) => row.id === independent.id).plan_record_json, undefined);
  document.plans[0].restart = { version: 1, date: cutover, transactionId, balances: [], coveredEntryIds: [] };
  old.amount = 99;
  for (let index = 0; index < 3; index++) await store.refresh(cutover);
  assert.equal(store.rows().length, 2, "a completed secondary forecast cannot materialize old unrecorded money");
  assert.equal(store.rows().find((row) => row.id === saved.id).amount, 20);
  assert.equal(store.rows().find((row) => row.id === saved.id).note, "Keep original");
  assert.deepEqual(store.accounts().map((account) => account.nativeCurrentBalance), [995, 120]);
  document.plans[0].entries.push(entry({ id: "new", accountId: 1, amount: 5, date: cutover }),
    entry({ id: "income", accountId: 1, kind: "income", amount: 3, date: "2026-11-21" }));
  await store.refresh(cutover); await store.refresh(cutover);
  assert.deepEqual(store.accounts().map((account) => account.nativeCurrentBalance), [990, 120]);
  await store.refresh("2026-11-21"); await store.refresh("2026-11-21");
  assert.deepEqual(store.accounts().map((account) => account.nativeCurrentBalance), [986, 120]);
  assert.equal(store.rows().filter((row) => row.source_plan_id === "legacy" && row.source_plan_row_id === "entry:future").length, 1);
  assert.equal(store.rows().find((row) => row.id === saved.id).amount, 20);
});

test("removing a manual account preserves its posted history through refreshes and later planner edits", async () => {
  for (const flags of [{ is_archived: 1 }, { is_sync_excluded: 1 }, { merged_into_account_id: 99 }]) {
    const fill = entry();
    const document = livePlanner([fill]);
    const account = manual(37, "credit", 100);
    const store = ledger([account], document);
    await store.refresh();
    const recorded = store.rows()[0];
    Object.assign(account, flags);
    for (let index = 0; index < 3; index++) await store.refresh();
    assert.equal(store.rows().length, 1);
    assert.equal(store.rows()[0].id, recorded.id);
    assert.equal(store.rows()[0].amount, 20);
    assert.equal(financePlanTransactionMetadata(store.rows()[0]).planDetached, true);
    assert.equal(store.accounts()[0].nativeCurrentBalance, 120);
    fill.amount = 35;
    fill.date = "2026-12-01";
    await store.refresh();
    document.plans[0].entries = [];
    for (let index = 0; index < 3; index++) await store.refresh();
    assert.equal(store.rows()[0].id, recorded.id);
    assert.equal(store.rows()[0].amount, 20);
    assert.equal(store.accounts()[0].nativeCurrentBalance, 120);
    assert.equal(account.opening_balance, 100);
    for (const field of Object.keys(flags)) delete account[field];
    document.plans[0].entries = [entry({ amount: 35 })];
    await store.refresh();
    assert.equal(store.rows().length, 1, "reactivating an account cannot regenerate its archived event");
    assert.equal(store.rows()[0].amount, 20);
  }
});

test("an archived transfer account freezes both posted legs and keeps them in later balance-payment baselines", async () => {
  const payment = entry({ id: "old-pay", kind: "transfer", accountId: null, fromAccountId: 34, toAccountId: 37, amount: 50 });
  const document = livePlanner([payment]);
  const source = manual(34, "savings", 1000);
  const store = ledger([source, manual(37, "credit", 100), manual(1, "checking", 1000)], document);
  await store.refresh();
  const original = store.rows().map((row) => [row.id, row.account_id, row.amount]);
  source.is_archived = 1;
  const remaining = entry({ id: "new-pay", kind: "transfer", accountId: null, fromAccountId: 1, toAccountId: 37,
    amount: 0, amountMode: "cardBalance" });
  document.plans[0].entries.push(remaining);
  await store.refresh(); await store.refresh();
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [950, 0, 950]);
  assert.equal(store.rows().find((row) => row.source_plan_row_id === "entry:new-pay").amount, 50,
    "a retained card credit stays in the baseline instead of being subtracted as derived activity");
  assert.ok(store.rows().filter((row) => row.source_plan_row_id === "entry:old-pay")
    .every((row) => financePlanTransactionMetadata(row).planDetached));
  payment.amount = 80;
  await store.refresh();
  payment.date = "2026-12-01";
  await store.refresh();
  document.plans[0].entries = [];
  for (let index = 0; index < 3; index++) await store.refresh();
  assert.deepEqual(store.rows().map((row) => [row.id, row.account_id, row.amount]), original);
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [950, 50, 1000]);
});

test("freezing a removed manual account preserves its linked provider counterpart without rewriting bank history", async () => {
  for (const freezeBeforeImport of [false, true]) for (const removedLeg of ["manual", "linked"]) {
    const payment = entry({ id: "payment", kind: "transfer", accountId: null, fromAccountId: 34, toAccountId: 37, amount: 50 });
    const document = livePlanner([payment], [completion("payment")]);
    const manualSource = manual(34, "savings", 1000);
    const card = { ...bank(37, 100), account_type: "credit" };
    const removed = removedLeg === "manual" ? manualSource : card;
    const store = ledger([manualSource, card], document);
    await store.refresh();
    if (freezeBeforeImport) { removed.is_archived = 1; await store.refresh(); }
    const imported = { id: 9, transaction_date: today, account_id: 37, currency: "PHP", kind: "income", amount: 50,
      merchant: "Original bank payment", external_provider: "plaid", external_transaction_id: "bank-payment" };
    card.current_balance = 50;
    store.add(imported);
    await store.refresh();
    const recorded = store.rows().map((row) => [row.id, row.account_id, row.amount]);
    removed.is_archived = 1;
    payment.amount = 80;
    await store.refresh();
    document.plans[0].entries = [];
    document.plans[0].completedRows = [];
    for (let index = 0; index < 3; index++) await store.refresh();
    assert.deepEqual(store.rows().map((row) => [row.id, row.account_id, row.amount]), recorded);
    const bankReceipt = store.rows().find((row) => row.id === 9);
    for (const [field, value] of Object.entries(imported)) assert.equal(bankReceipt[field], value, field);
    assert.ok(store.rows().every((row) => financePlanTransactionMetadata(row).planDetached));
    assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [950, 50]);
  }
});

test("archiving a linked account retains its recorded provisional receipt and still reconciles the bank import", async () => {
  const purchase = entry({ accountId: 1 });
  const document = planner([purchase]);
  const account = bank(1);
  const store = ledger([account], document);
  await store.refresh();
  const recordedId = store.rows()[0].id;
  account.is_archived = 1;
  purchase.amount = 35;
  for (let index = 0; index < 3; index++) await store.refresh();
  assert.equal(store.rows().length, 1);
  assert.equal(store.rows()[0].id, recordedId);
  assert.equal(store.rows()[0].amount, 20);
  assert.equal(store.accounts()[0].nativeCurrentBalance, 1000);
  document.plans[0].entries = [];
  document.plans[0].completedRows = [];
  await store.refresh();
  account.current_balance = 980;
  const imported = { id: 9, transaction_date: today, account_id: 1, currency: "PHP", kind: "expense", amount: 20,
    merchant: "Original imported purchase", external_provider: "plaid", external_transaction_id: "bank-purchase" };
  store.add(imported);
  await store.refresh(); await store.refresh();
  assert.equal(store.rows().length, 1);
  for (const [field, value] of Object.entries(imported)) assert.equal(store.rows()[0][field], value, field);
  assert.equal(financePlanTransactionMetadata(store.rows()[0]).planDetached, true);
  assert.equal(store.accounts()[0].nativeCurrentBalance, 980);
});

test("inactive manual accounts cannot receive new explicit or automatic transfer legs", () => {
  const rows = [entry(), entry({ id: "from-inactive", kind: "transfer", accountId: null, fromAccountId: 37, toAccountId: 34 }),
    entry({ id: "to-inactive", kind: "transfer", accountId: null, fromAccountId: 34, toAccountId: 37 }),
    entry({ id: "recurring", kind: "transfer", accountId: null, fromAccountId: 34, toAccountId: 37,
      date: "1900-01-01", recurrence: "daily" })];
  const document = livePlanner(rows, rows.map((row) => completion(row.id)));
  const accounts = [manual(34, "checking", 1000), { ...manual(37, "savings", 100), is_archived: 1 }];
  assert.deepEqual(financePlanPostingSpecs(document, accounts, [], { today }), []);
});

test("archived payday savings preserve prior paired history without generating new active-source withdrawals", async () => {
  const document = livePlanner();
  document.salary = { amount: 0, currency: "PHP", accountId: 1, payFrequency: "semimonthly", firstPayDate: "2026-11-01" };
  document.allocations = [{ id: "saving", name: "Savings", kind: "savings", amount: 50, currency: "PHP", accountId: 34, sourceAccountId: 1 }];
  document.plans[0].includeAllocations = true;
  const savings = manual(34, "savings", 200);
  const store = ledger([manual(1, "checking", 1000), savings], document);
  await store.refresh();
  const recorded = store.rows().map((row) => [row.id, row.account_id, row.amount]);
  savings.is_archived = 1;
  document.allocations[0].amount = 75;
  await store.refresh("2026-12-01"); await store.refresh("2026-12-01");
  assert.deepEqual(store.rows().map((row) => [row.id, row.account_id, row.amount]), recorded);
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [900, 300]);
});

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
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [1000, 450]);
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

test("a recorded Google card charge does not generate a one-cent recurring bill remainder on refresh", async () => {
  const receipt = entry({ id: "google-receipt", description: "GOOGLE *Google One", accountId: 37,
    currency: "USD", amount: 1.99, scheduledRowId: `bill:google:${today}` });
  const document = livePlanner([receipt]);
  document.bills = [{ id: "google", name: "Google", amount: 2, currency: "USD", cadence: "monthly", dueDay: 18, accountId: 37 }];
  const store = ledger([manual(37, "credit", 0, "USD")], document);
  await store.refresh(); await store.refresh();
  assert.deepEqual(store.rows().map((row) => [row.source_plan_row_id, row.amount]), [["entry:google-receipt", 1.99]]);
  assert.equal(store.accounts()[0].nativeCurrentBalance, 1.99, "the card keeps the actual charge rather than the rounded forecast");
  const receiptId = store.rows()[0].id;
  assert.equal(financePlanTransactionMetadata(store.rows()[0]).planScheduledRowId, `bill:google:${today}`);

  receipt.amount = 1.50;
  await store.refresh(); await store.refresh();
  assert.equal(store.rows().find((row) => row.id === receiptId).amount, 1.50);
  assert.equal(store.rows().find((row) => row.source_plan_row_id === `bill:google:${today}`).amount, 0.50,
    "a real partial payment still records its remaining bill amount");
  assert.equal(store.accounts()[0].nativeCurrentBalance, 2);
});

test("a posted bill before the planner opening prevents a second manual account charge on refresh", async () => {
  const document = livePlanner();
  document.plans[0].startDate = today;
  document.bills = [{ id: "google", name: "Google", amount: 2, currency: "USD", cadence: "monthly", dueDay: 18, accountId: 37 }];
  const receipt = { id: 9, transaction_date: "2026-11-17", account_id: 37, currency: "USD", kind: "expense",
    amount: 1.99, merchant: "GOOGLE *Google One", category: "Subscriptions" };
  const store = ledger([manual(37, "credit", 0, "USD")], document, [receipt]);
  await store.refresh(); await store.refresh();
  assert.equal(store.accounts()[0].nativeCurrentBalance, 1.99);
  assert.equal(store.rows().length, 1);
  assert.equal(store.rows()[0].id, receipt.id);
  assert.equal(store.rows()[0].amount, 1.99);
  const partial = { ...receipt, amount: 1.50, source_plan_id: "main", source_plan_row_id: "entry:actual-google",
    source_plan_leg: "single", plan_generated: 0, plan_record_json: JSON.stringify({ planId: "main", rowId: "entry:actual-google",
      planScheduledRowId: "bill:google:2026-11-18" }) };
  const partialDocument = structuredClone(document);
  partialDocument.plans[0].entries = [{ id: "actual-google", date: receipt.transaction_date, description: receipt.merchant,
    kind: "expense", accountId: 37, amount: 1.50, currency: "USD", scheduledRowId: "bill:google:2026-11-18" }];
  const partialStore = ledger([manual(37, "credit", 0, "USD")], partialDocument, [partial]);
  await partialStore.refresh(); await partialStore.refresh();
  assert.equal(partialStore.accounts()[0].nativeCurrentBalance, 2);
  assert.equal(partialStore.rows().find((row) => row.source_plan_row_id === "bill:google:2026-11-18").amount, 0.50);
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

test("an unpaid earlier autopay stays a projection until an explicit statement payment is recorded", async () => {
  const document = livePlanner();
  document.plans[0].accountLinks = { availablePhpAccountId: 1 };
  const card = { ...manual(37, "credit", 500), credit_card_due_status: "manual",
    credit_card_autopay_enabled: 1, credit_card_autopay_days_before_due: 7,
    credit_card_due_json: JSON.stringify({ statementBalance: 200, dueDate: "2026-11-20", lastStatementDate: "2026-10-25" }) };
  const source = manual(1, "checking", 1000);
  const before = structuredClone({ source, card });
  const store = ledger([source, card], document);
  for (let index = 0; index < 3; index++) await store.refresh();
  assert.deepEqual(store.rows(), [], "a missed configured payment cannot become a new receipt on refresh");
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [1000, 500]);
  assert.deepEqual({ source, card }, before);
  const payment = entry({ id: "recorded-payment", description: "Recorded statement payment", kind: "transfer",
    accountId: null, fromAccountId: 1, toAccountId: 37, amount: 200,
    scheduledRowId: "creditCardDue:37:2026-11-20" });
  document.plans[0].entries.push(payment);
  document.plans[0].completedRows = [completion(payment.id)];
  for (let index = 0; index < 3; index++) await store.refresh();
  const receipts = store.rows();
  assert.equal(receipts.length, 2);
  assert.ok(receipts.every((row) => row.source_plan_row_id === "entry:recorded-payment"));
  assert.ok(receipts.every((row) => row.amount === 200 && row.transaction_date === today));
  assert.ok(receipts.every((row) => financePlanTransactionMetadata(row).creditCardPaymentDueDate === "2026-11-20"));
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [800, 300]);
  assert.deepEqual({ source, card }, before);
});

test("a carried statement keeps its already posted payment at the original date and amount", async () => {
  const document = livePlanner();
  document.plans[0].accountLinks = { availablePhpAccountId: 1 };
  const card = { ...manual(37, "credit", 500), credit_card_due_status: "manual",
    credit_card_due_json: JSON.stringify({ statementBalance: 200, dueDate: today, lastStatementDate: "2026-10-25" }) };
  const store = ledger([manual(1, "checking", 1000), card], document);
  await store.refresh();
  const receipts = store.rows().map((row) => [row.id, row.account_id, row.kind, row.currency, row.amount, row.transaction_date]);
  assert.equal(receipts.length, 2);
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [800, 300]);
  for (const date of ["2026-11-19", "2026-11-19", "2026-11-20"]) {
    await store.refresh(date);
    assert.deepEqual(store.rows().map((row) => [row.id, row.account_id, row.kind, row.currency, row.amount, row.transaction_date]), receipts);
    assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [800, 300]);
    assert.ok(store.rows().every((row) => !financePlanTransactionMetadata(row).planDetached));
  }
});

test("an inferred cycle payment dated today stays a forecast while its manual card charge posts", async () => {
  const document = livePlanner();
  document.plans[0].accountLinks = { availablePhpAccountId: 1 };
  document.bills = [{ id: "card-charge", name: "Card charge", amount: 100, currency: "PHP",
    cadence: "monthly", dueDay: 18, accountId: 37 }];
  const card = { ...manual(37, "credit", 0), credit_card_due_status: "manual",
    credit_card_autopay_enabled: 1, credit_card_autopay_days_before_due: 20,
    credit_card_due_json: JSON.stringify({ statementBalance: 0, lastStatementDate: "2026-10-18", dueDate: "2026-11-08" }) };
  const store = ledger([manual(1, "checking", 1000), card], document);
  for (let index = 0; index < 3; index++) await store.refresh();
  const [charge] = store.rows();
  assert.equal(store.rows().length, 1, "an unissued future cycle cannot fabricate an actual card payment today");
  assert.equal(charge.source_plan_row_id, `bill:card-charge:${today}`);
  assert.equal(charge.kind, "expense");
  assert.equal(charge.amount, 100);
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [1000, 100]);
  const payment = entry({ id: "recorded-cycle-payment", description: "Recorded card payment", kind: "transfer",
    accountId: null, fromAccountId: 1, toAccountId: 37, amount: 100,
    scheduledRowId: "creditCardDue:37:2026-12-08" });
  document.plans[0].entries.push(payment);
  document.plans[0].completedRows = [completion(payment.id)];
  for (let index = 0; index < 3; index++) await store.refresh();
  assert.equal(store.rows().length, 3);
  assert.equal(store.rows().filter((row) => row.source_plan_row_id === "entry:recorded-cycle-payment").length, 2);
  assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [900, 0]);
  assert.equal(store.rows().find((row) => row.id === charge.id).source_plan_row_id, charge.source_plan_row_id);
});

test("advancing a manual card statement preserves its settled cycle and records the next due only once", async () => {
  for (const withClosingDate of [false, true]) {
    const document = livePlanner();
    document.plans[0].accountLinks = { availablePhpAccountId: 1 };
    const card = { ...manual(37, "credit", 500), credit_card_due_status: "manual",
      credit_card_due_json: JSON.stringify({ statementBalance: 200, dueDate: today,
        ...(withClosingDate ? { lastStatementDate: "2026-10-25" } : {}) }) };
    const store = ledger([manual(1, "checking", 1000), card], document);
    await store.refresh();
    const oldReceipts = store.rows().map((row) => [row.id, row.account_id, row.amount, row.transaction_date]);
    card.credit_card_due_json = JSON.stringify({ statementBalance: 100, dueDate: "2026-12-18",
      ...(withClosingDate ? { lastStatementDate: "2026-11-25" } : {}) });
    for (let index = 0; index < 3; index++) await store.refresh("2026-11-26");
    assert.deepEqual(store.rows().map((row) => [row.id, row.account_id, row.amount, row.transaction_date]), oldReceipts);
    assert.ok(store.rows().every((row) => financePlanTransactionMetadata(row).planDetached));
    assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [800, 300]);
    await store.refresh("2026-12-17");
    assert.equal(store.rows().length, 2, "the next future statement is still a forecast");
    for (let index = 0; index < 3; index++) await store.refresh("2026-12-18");
    assert.equal(store.rows().length, 4);
    assert.deepEqual(store.rows().filter((row) => row.source_plan_row_id === `creditCardDue:37:${today}`)
      .map((row) => [row.id, row.account_id, row.amount, row.transaction_date]), oldReceipts);
    assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [700, 200]);
  }
});

test("same-cycle manual statement amount and due-date corrections remain authoritative", async () => {
  for (const withClosingDate of [false, true]) {
    const document = livePlanner();
    document.plans[0].accountLinks = { availablePhpAccountId: 1 };
    const card = { ...manual(37, "credit", 500), credit_card_due_status: "manual",
      credit_card_due_json: JSON.stringify({ statementBalance: 200, dueDate: today,
        ...(withClosingDate ? { lastStatementDate: "2026-10-25" } : {}) }) };
    const store = ledger([manual(1, "checking", 1000), card], document);
    await store.refresh();
    card.credit_card_due_json = JSON.stringify({ statementBalance: 150, dueDate: today,
      ...(withClosingDate ? { lastStatementDate: "2026-10-25" } : {}) });
    await store.refresh();
    assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [850, 350]);
    const correctedDate = withClosingDate ? "2026-12-18" : "2026-11-19";
    card.credit_card_due_json = JSON.stringify({ statementBalance: 150, dueDate: correctedDate,
      ...(withClosingDate ? { lastStatementDate: "2026-10-25" } : {}) });
    await store.refresh();
    assert.deepEqual(store.rows(), [], "a due-date correction within the same statement replaces its derived posting date");
    await store.refresh(correctedDate); await store.refresh(correctedDate);
    assert.deepEqual(store.accounts().map((row) => row.nativeCurrentBalance), [850, 350]);
    assert.equal(store.rows().length, 2);
    assert.ok(store.rows().every((row) => !financePlanTransactionMetadata(row).planDetached));
  }
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

test("detached linked receipts preserve reported bank balances and reconcile a later import", async () => {
  const account = bank(1);
  const document = planner([entry({ accountId: 1, amount: 100 })]);
  const store = ledger([account], document);
  await store.refresh(); document.plans = []; await store.refresh();
  assert.equal(store.accounts()[0].nativeCurrentBalance, 1000);
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
