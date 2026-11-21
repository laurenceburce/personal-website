import test from "node:test";
import assert from "node:assert/strict";
import { getPlanRowOrderId, orderPlanRows } from "../app/lib/financePlanRowOrder.mjs";

test("row identities survive matched and generated receipts without merging statement references", () => {
  for (const row of [
    { id: "entry:income" },
    { id: "transaction:10", completionKey: "entry:income", matchedForecast: { id: "entry:income", source: "manual" } },
    { id: "transaction:11", completionKey: "transaction:11", planRowId: "entry:income" },
  ]) assert.equal(getPlanRowOrderId(row), "entry:income");
  assert.equal(getPlanRowOrderId({ id: "entry:daily:2026-11-22", recurring: true }), "entry:daily:2026-11-22");
  assert.equal(getPlanRowOrderId({ id: "transaction:12", planRowId: "bill:rent:2026-11-22" }), "bill:rent:2026-11-22");
  assert.equal(getPlanRowOrderId({ id: "transaction:13", completionKey: "creditCardDue:2:2026-11-22",
    source: "transaction", matchedForecast: { id: "creditCardDue:2:2026-11-22", source: "creditCardDue" } }), "transaction:13");
  assert.equal(getPlanRowOrderId({ id: "transaction:14", source: "transaction", planRowId: "creditCardDue:2:2026-11-22",
    planScheduledRowId: "creditCardDue:2:2026-11-22" }), "transaction:14");
  assert.equal(getPlanRowOrderId({ id: "transaction:15", source: "transaction", planRowId: "entry:payment",
    scheduledRowId: "creditCardDue:2:2026-11-22" }), "entry:payment");
  assert.equal(getPlanRowOrderId({ id: "transaction-pair:13:14", completionKey: "transaction:13" }), "transaction:13");
});

test("saved same-day ranks preserve chronology, opening position, stable defaults and source objects", () => {
  const rows = [
    { id: "z-expense", date: "2026-11-22", kind: "expense" },
    { id: "a-expense", date: "2026-11-22", kind: "expense" },
    { id: "income", date: "2026-11-22", kind: "income" },
    { id: "later", date: "2026-11-23", kind: "income" },
    { id: "opening", date: "2026-11-22", isOpeningBalance: true },
  ];
  const plan = { rowOrder: [{ date: "2026-11-22", rowIds: ["a-expense", "income", "z-expense", "missing", "later", "opening"] }] };
  const before = structuredClone({ rows, plan });
  assert.deepEqual(orderPlanRows(rows).map((row) => row.id), ["opening", "income", "z-expense", "a-expense", "later"]);
  assert.deepEqual(orderPlanRows(rows, plan).map((row) => row.id), ["opening", "a-expense", "income", "z-expense", "later"]);
  assert.deepEqual(orderPlanRows(rows, { rowOrder: [{ date: "2026-11-21", rowIds: ["a-expense", "z-expense"] }] })
    .map((row) => row.id), ["opening", "income", "z-expense", "a-expense", "later"]);
  assert.deepEqual({ rows, plan }, before);
  assert.ok(orderPlanRows(rows, plan).every((row) => rows.includes(row)));
});
