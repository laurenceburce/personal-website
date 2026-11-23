import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { financePlanActivityRange } from "../app/lib/financePlanActivity.mjs";
import * as activity from "../app/lib/financeActivity.mjs";
import * as planActivity from "../app/lib/financePlanActivity.mjs";
import * as identity from "../app/lib/financeAccountIdentity.mjs";
import * as postings from "../app/lib/financePlanPostings.mjs";
import { addDays } from "../app/lib/financePlanner.mjs";

const require = createRequire(import.meta.url);
const { transformSync } = require("next/dist/build/swc");
const { code } = transformSync(await readFile(new URL("../app/lib/financeStore.js", import.meta.url), "utf8"), {
  jsc: { parser: { syntax: "ecmascript" }, target: "es2022" }, module: { type: "commonjs" },
});
function historyBackend(t, handler) {
  const previous = process.env.FINANCE_DATABASE_URL;
  process.env.FINANCE_DATABASE_URL = "mysql://balance-history-test";
  t.after(() => previous === undefined ? delete process.env.FINANCE_DATABASE_URL : process.env.FINANCE_DATABASE_URL = previous);
  const queries = [];
  const database = { async query(raw, params = []) {
    const sql = raw.replace(/\s+/g, " ").trim();
    queries.push({ sql, params });
    return [(await handler(sql, params)) || [], []];
  } };
  const module = { exports: {} };
  new Function("require", "module", "exports", code)((specifier) => {
    if (specifier === "mysql2/promise") return { createPool: () => database };
    if (specifier === "./financeActivity.mjs") return activity;
    if (specifier === "./financePlanActivity.mjs") return planActivity;
    if (specifier === "./financeAccountIdentity.mjs") return identity;
    if (specifier === "./financePlanPostings.mjs") return { ...postings, refreshFinancePlanPostings: async () => {} };
    return require(specifier);
  }, module, module.exports);
  return { api: module.exports, queries };
}
const historyRow = (id, date, extra = {}) => ({ id, transaction_date: date, kind: "expense", account_id: 1,
  amount: "25.50", currency: "USD", ...extra });

test("planner activity exposes pending bank state and the provider's replacement identity without settling it", async (t) => {
  const start = addDays(activity.financeActivityWindow().today, -2);
  const pending = historyRow(90, start, { pending: 1, external_provider: "plaid", external_transaction_id: "authorization",
    source_plan_id: "live", source_plan_row_id: "entry:service", source_plan_leg: "single",
    plan_generated: 0, plan_provisional: 0, merchant: "Service subscription" });
  const settled = historyRow(91, start, { pending: 0, external_provider: "plaid", external_transaction_id: "settled-charge",
    external_pending_transaction_id: "authorization" });
  const { api } = historyBackend(t, (sql) => sql.startsWith("SELECT t.*") && sql.includes("a.name AS account_name") ? [pending, settled] : []);
  const result = await api.getFinancePlanActivity({ startDate: start, endDate: start });
  assert.equal(result.transactions.length, 2);
  assert.equal(result.transactions[0].pending, true);
  assert.equal(result.transactions[0].bankPending, true);
  assert.equal(result.transactions[0].planRowId, "entry:service");
  assert.equal(result.transactions[0].recordedFromPlan, false);
  assert.equal(result.transactions[0].awaitingBankSync, false);
  assert.equal(result.transactions[0].externalId, "authorization");
  assert.equal(result.transactions[1].pendingExternalId, "authorization");
  assert.equal(result.transactions[1].pending, false);
});

test("future-only API views retain outstanding pending ownership outside the posted halo without adding visible or historical flows", async (t) => {
  const today = activity.financeActivityWindow().today;
  const start = addDays(today, 40);
  const pendingDate = addDays(today, -20);
  const pending = historyRow(90, pendingDate, { pending: 1, external_provider: "plaid", external_transaction_id: "authorization",
    source_plan_id: "live", source_plan_row_id: "entry:service", source_plan_leg: "single", plan_generated: 0, plan_provisional: 0 });
  const marker = historyRow(91, pendingDate, { pending: 1, source_plan_id: "live", source_plan_row_id: "entry:removed", source_plan_leg: "single",
    plan_generated: 1, plan_provisional: 1, plan_record_json: JSON.stringify({ bankPendingRemoved: true, pendingBankExternalId: "removed-auth" }) });
  const { api, queries } = historyBackend(t, (sql) => sql.includes("WHERE t.pending = 1") ? [pending, { ...pending }, marker,
    historyRow(92, pendingDate, { pending: 0, external_provider: "plaid" }),
    historyRow(93, addDays(today, 1), { pending: 1, external_provider: "plaid" })] : []);
  const result = await api.getFinancePlanActivity({ startDate: start, endDate: addDays(start, 10) });
  assert.deepEqual(result.transactions, []);
  assert.deepEqual(result.matchingTransactions.map((row) => row.id), [90, 91], "each outstanding task is supplied as matching-only evidence once");
  assert.equal(result.matchingTransactions[0].bankPending, true);
  assert.equal(result.matchingTransactions[0].planRowId, "entry:service");
  assert.equal(result.matchingTransactions[1].bankPendingRemoved, true);
  assert.deepEqual(result.balanceTransactions, []);
  assert.equal(result.balanceHistoryFrom, start, "a pending hold cannot widen the posted-history reconstruction floor");
  assert.equal(result.balanceHistoryComplete, true);
  assert.equal(result.matchingWarning, "");
  assert.ok(!queries.some(({ sql }) => sql.includes("AND t.currency IN ('USD', 'PHP') AND t.pending = 0")), "the expired posted halo stays empty");
  const query = queries.find(({ sql }) => sql.includes("WHERE t.pending = 1"));
  assert.deepEqual(query.params, [today, start, addDays(start, 10)]);
  assert.match(query.sql, /t.duplicate_of_id IS NULL AND t.is_provider_removed = 0/);
  assert.match(query.sql, /a.is_archived = 0 AND a.is_sync_excluded = 0 AND a.merged_into_account_id IS NULL/);
});

test("outstanding pending evidence has its own bounded warning and failures preserve posted boundary evidence", async (t) => {
  const today = activity.financeActivityWindow().today;
  const old = addDays(today, -20);
  for (const failed of [false, true]) {
    const { api } = historyBackend(t, (sql) => {
      if (sql.includes("WHERE t.pending = 1")) {
        if (failed) throw new Error("Pending history unavailable");
        return Array.from({ length: 10001 }, (_, index) => historyRow(index + 1, old,
          { pending: 1, external_provider: "plaid", external_transaction_id: `hold-${index}` }));
      }
      return [];
    });
    const result = await api.getFinancePlanActivity({ startDate: addDays(today, 40), endDate: addDays(today, 50) });
    assert.equal(result.configured, true);
    assert.equal(result.matchingTransactions.length, failed ? 0 : 10000);
    assert.equal(result.matchingLimitHit, !failed);
    assert.match(result.matchingWarning, failed ? /bank holds could not be loaded/ : /10,000 outstanding bank holds/);
    assert.deepEqual(result.transactions, []);
    assert.deepEqual(result.balanceTransactions, []);
  }
});

test("account activity hides bookkeeping review markers while planner activity retains their nonfinancial evidence", async (t) => {
  const today = activity.financeActivityWindow().today;
  const real = historyRow(90, today, { pending: 1, external_provider: "plaid", merchant: "Real pending merchant" });
  const marker = historyRow(91, today, { pending: 1, source_plan_id: "live", source_plan_row_id: "entry:removed", source_plan_leg: "single",
    plan_generated: 1, plan_provisional: 1, plan_record_json: JSON.stringify({ bankPendingRemoved: true, pendingBankExternalId: "removed-auth" }) });
  const { api } = historyBackend(t, (sql) => sql.startsWith("SELECT t.*") ? [real, marker] : []);
  const accountActivity = await api.getFinanceActivity({ month: today.slice(0, 7) });
  assert.deepEqual(accountActivity.transactions.map((row) => row.id), [90]);
  assert.equal(accountActivity.warning, undefined, "hiding bookkeeping is not a currency or data-loss warning");
  const plannerActivity = await api.getFinancePlanActivity({ startDate: today, endDate: today });
  assert.deepEqual(plannerActivity.transactions.map((row) => row.id), [90, 91]);
  assert.equal(plannerActivity.transactions[1].bankPendingRemoved, true);
  assert.equal(plannerActivity.transactions[1].recordedFromPlan, false);
});

test("plan activity accepts the complete chosen range rather than an overview month window", () => {
  assert.deepEqual(
    financePlanActivityRange({
      startDate: "2025-01-01",
      endDate: "2026-11-30",
    }),
    { from: "2025-01-01", to: "2026-11-30" },
  );
  assert.deepEqual(
    financePlanActivityRange({
      startDate: "2026-11-02",
      endDate: "2026-11-02",
    }),
    { from: "2026-11-02", to: "2026-11-02" },
  );
});

test("plan activity rejects missing, impossible and out-of-bounds calendar dates", () => {
  for (const value of [
    undefined,
    null,
    "",
    "2026-02-29",
    "2026-11-31",
    "2026-13-01",
    "2026-1-1",
    "1899-12-31",
    "2201-01-01",
    20261102,
  ]) {
    assert.throws(
      () =>
        financePlanActivityRange({ startDate: value, endDate: "2026-11-30" }),
      (error) => error.status === 400,
    );
    assert.throws(
      () =>
        financePlanActivityRange({ startDate: "2026-11-01", endDate: value }),
      (error) => error.status === 400,
    );
  }
});

test("plan activity allows leap dates and enforces the same two-year range cap as plans", () => {
  assert.deepEqual(
    financePlanActivityRange({
      startDate: "2028-02-29",
      endDate: "2030-03-01",
    }),
    { from: "2028-02-29", to: "2030-03-01" },
  );
  assert.throws(
    () =>
      financePlanActivityRange({
        startDate: "2026-11-02",
        endDate: "2026-11-01",
      }),
    /in order/,
  );
  assert.throws(
    () =>
      financePlanActivityRange({
        startDate: "2026-11-02",
        endDate: "2028-11-03",
      }),
    /two years/,
  );
});

test("historical account balances receive later posted movements through today without adding them to visible flows", async (t) => {
  const today = activity.financeActivityWindow().today;
  const start = addDays(today, -60);
  const end = addDays(today, -30);
  const rows = [historyRow(11, addDays(start, 1)), historyRow(12, addDays(end, 2)), historyRow(13, today, {
    kind: "income", account_id: 37, currency: "PHP", amount: "1500.00",
    source_plan_id: "live", source_plan_row_id: "entry:payment", source_plan_leg: "credit", plan_generated: 1,
    plan_record_json: JSON.stringify({ transferAccountId: 34, creditCardPaymentFor: 37 }),
    merchant: "Private text is not needed for balance reconstruction", external_transaction_id: "private-bank-id",
  })];
  const { api, queries } = historyBackend(t, (sql) => {
    if (sql.startsWith("SELECT t.id,")) return rows;
    if (sql.startsWith("SELECT t.*")) return [rows[0]];
    return [];
  });
  const result = await api.getFinancePlanActivity({ startDate: start, endDate: end });
  assert.equal(result.configured, true);
  assert.deepEqual(result.transactions.map((row) => row.id), [11], "later evidence is not extra visible cash flow");
  assert.deepEqual(result.balanceTransactions.map((row) => [row.id, row.date, row.accountId, row.kind, row.amount, row.currency]),
    [[11, rows[0].transaction_date, 1, "expense", 25.5, "USD"], [12, rows[1].transaction_date, 1, "expense", 25.5, "USD"],
      [13, today, 37, "income", 1500, "PHP"]]);
  assert.equal(result.balanceTransactions[2].planId, "live");
  assert.equal(result.balanceTransactions[2].planRowId, "entry:payment");
  assert.equal(result.balanceTransactions[2].creditCardPaymentFor, 37);
  assert.equal(result.balanceTransactions[2].transferAccountId, 34);
  assert.ok(result.balanceTransactions.every((row) => row.pending === false && !Object.hasOwn(row, "merchant") && !Object.hasOwn(row, "externalId")));
  assert.equal(result.balanceHistoryFrom, start);
  assert.equal(result.balanceHistoryThrough, today);
  assert.equal(result.balanceHistoryComplete, true);
  assert.equal(result.balanceHistoryWarning, "");
  const query = queries.find(({ sql }) => sql.startsWith("SELECT t.id,"));
  assert.deepEqual(query.params, [start, today], "history cannot stop at the selected historical end date");
  assert.match(query.sql, /t\.account_id IS NOT NULL AND t\.currency IN \('USD', 'PHP'\)/);
  assert.match(query.sql, /t\.kind IN \('income', 'expense'\) AND t\.pending = 0/);
  assert.match(query.sql, /t\.duplicate_of_id IS NULL AND t\.is_provider_removed = 0/);
  assert.match(query.sql, /ORDER BY t\.transaction_date ASC, t\.id ASC LIMIT 10001/);
});

test("account balance history excludes future rows even when the visible range includes forecasts", async (t) => {
  const today = activity.financeActivityWindow().today;
  const { api, queries } = historyBackend(t, (sql) => sql.startsWith("SELECT t.id,") ? [historyRow(1, today)] : []);
  const result = await api.getFinancePlanActivity({ startDate: addDays(today, -3), endDate: addDays(today, 45) });
  assert.equal(result.balanceHistoryComplete, true);
  assert.equal(result.balanceHistoryThrough, today);
  assert.deepEqual(queries.find(({ sql }) => sql.startsWith("SELECT t.id,")).params, [addDays(today, -3), today]);
  assert.equal(result.balanceTransactions.length, 1);
});

test("a future-only view needs no historical reversal query", async (t) => {
  const today = activity.financeActivityWindow().today;
  const { api, queries } = historyBackend(t, () => []);
  const result = await api.getFinancePlanActivity({ startDate: addDays(today, 1), endDate: addDays(today, 30) });
  assert.equal(result.configured, true);
  assert.equal(result.balanceHistoryComplete, true);
  assert.deepEqual(result.balanceTransactions, []);
  assert.ok(!queries.some(({ sql }) => sql.startsWith("SELECT t.id,")));
});

test("known earlier statement receipts extend history coverage without changing the visible date window", async (t) => {
  const today = activity.financeActivityWindow().today;
  const start = addDays(today, -14);
  const earlierReceipt = historyRow(91, addDays(today, -60), { kind: "income", account_id: 37 });
  const { api, queries } = historyBackend(t, (sql) => {
    if (sql.startsWith("SELECT a.id, a.credit_card_due_json")) return [{ id: 37,
      credit_card_due_json: JSON.stringify({ statementBalance: 300, dueDate: addDays(today, 7), lastStatementDate: addDays(today, -70) }) }];
    if (sql.startsWith("SELECT t.id,")) return [earlierReceipt, historyRow(92, today)];
    if (sql.startsWith("SELECT t.*") && sql.includes("t.pending = 0")) return [earlierReceipt];
    return [];
  });
  const result = await api.getFinancePlanActivity({ startDate: start, endDate: addDays(today, 30) });
  assert.equal(result.from, start);
  assert.deepEqual(result.transactions, [], "settlement evidence stays outside visible cash flow");
  assert.deepEqual(result.creditCardPaymentTransactions.map((row) => row.id), [91]);
  assert.equal(result.balanceHistoryFrom, earlierReceipt.transaction_date);
  assert.equal(result.balanceHistoryComplete, true);
  assert.deepEqual(result.balanceTransactions.map((row) => row.id), [91, 92]);
  assert.deepEqual(queries.find(({ sql }) => sql.startsWith("SELECT t.id,")).params, [earlierReceipt.transaction_date, today]);
});

test("truncated history marks snapshots incomplete while preserving visible activity", async (t) => {
  const today = activity.financeActivityWindow().today;
  const { api } = historyBackend(t, (sql) => {
    if (sql.startsWith("SELECT t.id,")) return Array.from({ length: 10001 }, (_, index) => historyRow(index + 1, today));
    if (sql.startsWith("SELECT t.*")) return [historyRow(7, today)];
    return [];
  });
  const result = await api.getFinancePlanActivity({ startDate: today, endDate: today });
  assert.equal(result.configured, true);
  assert.deepEqual(result.transactions.map((row) => row.id), [7]);
  assert.equal(result.balanceTransactions.length, 10000);
  assert.equal(result.balanceHistoryComplete, false);
  assert.match(result.balanceHistoryWarning, /exceeds 10,000/);
  assert.equal(result.limitHit, false, "history and visible range caps are independent");
});

test("history read failures do not discard otherwise valid transactions or claim complete snapshots", async (t) => {
  const today = activity.financeActivityWindow().today;
  const { api } = historyBackend(t, (sql) => {
    if (sql.startsWith("SELECT t.id,")) throw new Error("History connection unavailable");
    if (sql.startsWith("SELECT t.*")) return [historyRow(7, today)];
    return [];
  });
  const result = await api.getFinancePlanActivity({ startDate: today, endDate: today });
  assert.equal(result.configured, true);
  assert.deepEqual(result.transactions.map((row) => row.id), [7]);
  assert.deepEqual(result.balanceTransactions, []);
  assert.equal(result.balanceHistoryComplete, false);
  assert.match(result.balanceHistoryWarning, /could not be loaded/);
  assert.equal(result.warning, undefined, "history notices cannot replace other API warnings");
});
