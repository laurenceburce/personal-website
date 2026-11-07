import test from "node:test";
import assert from "node:assert/strict";
import { PLAN_ROW_CATEGORIES, getPlanRowCategory } from "../app/lib/financePlanPresentation.mjs";

const category = (row) => getPlanRowCategory(row).key;

test("logical savings and reserve rows keep their category when bank transfers are matched", () => {
  const evidence = { completed: true, completionSource: "transaction",
    recordedTransactions: [{ kind: "expense", category: "Transfer Out" }, { kind: "income", category: "Transfer In" }] };
  assert.equal(category({ source: "allocation", allocationKind: "savings", kind: "expense", ...evidence }), "savings");
  assert.equal(category({ source: "reserve", kind: "reserve", ...evidence }), "reserve");
  assert.equal(category({ source: "reserveRelease", billId: "annual-fee" }), "reserve");
  assert.equal(category({ source: "transaction", kind: "expense", scheduledSource: "allocation", allocationKind: "savings", category: "Transfer Out" }), "savings");
  assert.equal(category({ source: "transaction", matchedForecast: { source: "allocation", allocationKind: "savings" }, category: "Transfer Out" }), "savings");
});

test("scheduled bills, matched bills, and card payments share the bill category", () => {
  for (const row of [
    { source: "bill", kind: "expense" },
    { source: "creditCardDue", kind: "expense", amount: 0, completed: true },
    { source: "transaction", kind: "expense", scheduledSource: "bill", category: "Transfer Out" },
    { source: "transaction", kind: "income", matchedForecast: { source: "creditCardDue" } },
    { source: "transaction", kind: "expense", billId: "insurance" },
    { source: "manual", kind: "transfer", creditCardPaymentFor: 12 },
    { source: "transaction", kind: "expense", category: "Transfer Out", matchedForecast: { source: "manual", creditCardPaymentFor: 12 } },
  ]) assert.equal(category(row), "bill");
});

test("transfers and conversions stay distinct from ordinary income and expenses", () => {
  for (const row of [
    { source: "manual", kind: "transfer" },
    { source: "manual", kind: "conversion" },
    { source: "transaction", kind: "transfer" },
    { source: "transaction", kind: "income", category: " transfer  IN " },
    { source: "transaction", kind: "expense", category: "Account Transfer" },
    { source: "transaction", kind: "expense", category: "Loan Payments" },
    { source: "transaction", kind: "expense", matchedForecast: { source: "manual", kind: "conversion" } },
  ]) assert.equal(category(row), "transfer");
  assert.equal(category({ source: "transaction", kind: "income", category: "Interest" }), "income");
  assert.equal(category({ source: "allocation", allocationKind: "expense", kind: "expense" }), "expense");
});

test("matched salary uses income metadata and category labels never depend on description", () => {
  assert.equal(category({ source: "salary", kind: "income" }), "income");
  assert.equal(category({ source: "transaction", scheduledSource: "salary", kind: "income" }), "income");
  assert.equal(category({ source: "transaction", matchedForecast: { source: "salary" }, kind: "income" }), "income");
  assert.equal(category({ source: "transaction", scheduledSource: "salary", kind: "income", category: "Transfer In" }), "income");
  assert.equal(category({ source: "transaction", matchedForecast: { source: "salary" }, kind: "income", category: "Transfer In" }), "income");
  assert.equal(category({ source: "manual", kind: "expense", description: "Savings transfer for bill" }), "expense");
  assert.equal(category({ source: "new-source" }), "expense");
  assert.equal(new Set(PLAN_ROW_CATEGORIES.map(({ key }) => key)).size, PLAN_ROW_CATEGORIES.length);
  assert.ok(PLAN_ROW_CATEGORIES.every(({ key, label }) => key && label));
});
