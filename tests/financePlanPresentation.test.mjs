import test from "node:test";
import assert from "node:assert/strict";
import { PLAN_ROW_CATEGORIES, getPlanRowCategory, getPlannerAccountLabel, getPlannerTransactionLabel } from "../app/lib/financePlanPresentation.mjs";

const category = (row) => getPlanRowCategory(row).key;

test("planner account labels use US and PH without changing real account names or showing unnecessary masks", () => {
  const accounts = [
    { id: 1, name: "Checking", type: "checking", currency: "USD", mask: "5483" },
    { id: 2, name: "Annual Savings", type: "savings", currency: "USD", mask: "5742" },
    { id: 3, name: "RCBC Gold JCB", type: "credit", currency: "PHP", mask: "4321" },
  ];
  const before = structuredClone(accounts);
  assert.deepEqual(accounts.map((account) => getPlannerAccountLabel(account, accounts)),
    ["Checking (US)", "Annual Savings (US)", "RCBC Gold JCB (PH)"]);
  assert.equal(getPlannerAccountLabel({ name: "US Bank Smartly Savings", currency: "USD" }), "US Bank Smartly Savings (US)");
  assert.equal(getPlannerAccountLabel({ name: "Euro savings", currency: "EUR" }), "Euro savings");
  assert.equal(getPlannerAccountLabel(null), "Account");
  assert.deepEqual(accounts, before);
});

test("planner account labels remove existing display decorations instead of repeating currency and masked text", () => {
  for (const name of ["Checking (US)", "Checking · ••5483", "Checking·••5483", "Checking••5483", "Checking (US) · ••5483",
    "Checking · ••5483 (US) (USD)", "Checking (••5483) · USD"])
    assert.equal(getPlannerAccountLabel({ id: 1, name, currency: "USD", mask: "5483" }), "Checking (US)");
  assert.equal(getPlannerAccountLabel({ name: "RCBC Gold JCB (PHP)", currency: "PHP" }), "RCBC Gold JCB (PH)");
  assert.equal(getPlannerAccountLabel({ name: "Savings (Premium)", currency: "USD" }), "Savings (Premium) (US)");
  const venture = { id: 7, name: "Venture X 1234", officialName: "Venture X", type: "credit", currency: "USD", mask: "1234" };
  assert.equal(getPlannerAccountLabel(venture), "Venture X 1234 (US)", "a product's single X is not masked account text");
  assert.equal(getPlannerTransactionLabel({ source: "creditCardDue", creditAccountId: 7, autopayEnabled: true }, [venture]),
    "Venture X 1234 (Automatic Payment)");
  assert.equal(getPlannerAccountLabel({ name: "Checking xxxx5483", currency: "USD" }), "Checking (US)");
});

test("only active duplicate names in the same currency need masked account digits", () => {
  const checking = { id: 1, name: "Checking", type: "checking", currency: "USD", mask: "5483" };
  const other = { id: 2, name: "Checking (US) · ••9876", type: "checking", currency: "USD" };
  const pesos = { id: 3, name: "Checking", type: "checking", currency: "PHP", mask: "4321" };
  const accounts = [checking, other, pesos];
  assert.equal(getPlannerAccountLabel(checking, accounts), "Checking (US) · ••5483");
  assert.equal(getPlannerAccountLabel(other, accounts), "Checking (US) · ••9876");
  assert.equal(getPlannerAccountLabel(pesos, accounts), "Checking (PH)");
  for (const change of [{ isArchived: true }, { is_sync_excluded: 1 }, { mergedIntoAccountId: 1 }])
    assert.equal(getPlannerAccountLabel(checking, [checking, { ...other, ...change }, pesos]), "Checking (US)");
  assert.equal(getPlannerAccountLabel(checking, [checking, { ...checking, id: "1" }, pesos]), "Checking (US)");
});

test("automatic card payments use the specific card product or custom name", () => {
  const accounts = [
    { id: 1, name: "Checking", type: "checking", currency: "USD" },
    { id: 2, name: "CreditCard", officialName: "US Bank Altitude Connect Visa", type: "credit", currency: "USD" },
    { id: 3, name: "Travel card", officialName: "Bank Visa Signature", type: "credit", currency: "USD" },
    { id: 4, name: "Credit Card", officialName: "Credit Card", institutionName: "RCBC", type: "credit", currency: "PHP" },
  ];
  assert.equal(getPlannerAccountLabel(accounts[1], accounts), "US Bank Altitude Connect Visa (US)");
  assert.equal(getPlannerAccountLabel(accounts[2], accounts), "Travel card (US)");
  assert.equal(getPlannerAccountLabel(accounts[3], accounts), "RCBC Credit Card (PH)");
  for (const field of ["creditAccountId", "creditCardPaymentFor", "toAccountId"]) {
    const row = { id: "due", source: "creditCardDue", description: "CreditCard · automatic payment", [field]: 2, autopayEnabled: true };
    const before = structuredClone({ row, accounts });
    assert.equal(getPlannerTransactionLabel(row, accounts), "US Bank Altitude Connect Visa (Automatic Payment)");
    assert.deepEqual({ row, accounts }, before);
  }
  assert.equal(getPlannerTransactionLabel({ source: "creditCardDue", creditAccountId: 3, autopayEnabled: true }, accounts),
    "Travel card (Automatic Payment)");
  assert.equal(getPlannerTransactionLabel({ source: "creditCardDue", creditAccountId: 4, autopayEnabled: true }, accounts),
    "RCBC Credit Card (Automatic Payment)");
  assert.equal(getPlannerTransactionLabel({ source: "transaction", creditCardPaymentFor: 2, description: "Bank payment",
    matchedForecast: { source: "creditCardDue", description: "CreditCard · automatic payment" } }, accounts),
  "US Bank Altitude Connect Visa (Automatic Payment)");
});

test("automatic payment names add currency or mask context only when card names collide", () => {
  const first = { id: 1, name: "Rewards Visa (US)", type: "credit", currency: "USD", mask: "1234" };
  const second = { id: 2, name: "Rewards Visa", type: "credit", currency: "PHP", mask: "5678" };
  const row = { source: "creditCardDue", creditAccountId: 1, autopayEnabled: true };
  assert.equal(getPlannerTransactionLabel(row, [first]), "Rewards Visa (Automatic Payment)");
  assert.equal(getPlannerTransactionLabel(row, [first, second]), "Rewards Visa (US) (Automatic Payment)");
  assert.equal(getPlannerTransactionLabel(row, [first, { ...second, currency: "USD" }]),
    "Rewards Visa (US) · ••1234 (Automatic Payment)");
});

test("ordinary descriptions and unresolved card identities are never relabeled as automatic payments", () => {
  const accounts = [{ id: 1, name: "Checking", type: "checking", currency: "USD" },
    { id: 2, name: "Travel card", type: "credit", currency: "USD", creditCardAutopayEnabled: true }];
  for (const row of [
    { source: "manual", kind: "transfer", description: "Pay my card", toAccountId: 2, creditCardPaymentFor: 2 },
    { source: "bill", description: "Insurance autopay", accountId: 2 },
    { source: "creditCardDue", description: "Travel card · statement due", creditAccountId: 2 },
    { source: "creditCardDue", description: "Unknown card · automatic payment", creditAccountId: 99 },
    { source: "manual", description: "Checking automatic payment", toAccountId: 1 },
  ]) assert.equal(getPlannerTransactionLabel(row, accounts), row.description);
  assert.equal(getPlannerTransactionLabel(null, accounts), "");
});

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
