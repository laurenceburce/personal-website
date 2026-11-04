import assert from "node:assert/strict";
import test from "node:test";
import {
  financeActivityWindow,
  financeProviderStatus,
  mapFinanceActivityAccount,
  validateFinanceTransactionInput,
} from "../app/lib/financeActivity.mjs";

const transaction = (overrides = {}) => ({
  date: "2026-11-02",
  kind: "expense",
  amount: 169,
  currency: "PHP",
  accountId: null,
  merchant: "Groceries",
  category: "Food",
  note: "",
  ...overrides,
});

test("one-time transactions preserve native amounts and optional unassigned accounts", () => {
  const clean = validateFinanceTransactionInput(
    transaction({ merchant: "  Weekly   groceries ", amount: 169.126 }),
  );
  assert.equal(clean.amount, 169.13);
  assert.equal(clean.currency, "PHP");
  assert.equal(clean.accountId, null);
  assert.equal(clean.merchant, "Weekly groceries");
  assert.equal(
    validateFinanceTransactionInput(
      transaction({ accountId: "12", kind: "income" }),
    ).accountId,
    12,
  );
});

test("transactions reject impossible dates, unsupported currencies and unsafe amounts", () => {
  for (const date of [
    "2026-02-29",
    "2026-11-31",
    "2026-13-01",
    "1899-12-31",
    "2026-1-1",
  ]) {
    assert.throws(
      () => validateFinanceTransactionInput(transaction({ date })),
      /valid transaction date/,
    );
  }
  assert.equal(
    validateFinanceTransactionInput(transaction({ date: "2028-02-29" })).date,
    "2028-02-29",
  );
  for (const amount of [
    0,
    -1,
    Infinity,
    NaN,
    "12",
    null,
    1_000_000_000,
    0.001,
  ]) {
    assert.throws(
      () => validateFinanceTransactionInput(transaction({ amount })),
      /Amount/,
    );
  }
  assert.throws(
    () => validateFinanceTransactionInput(transaction({ currency: "EUR" })),
    /USD or PHP/,
  );
  assert.throws(
    () => validateFinanceTransactionInput(transaction({ merchant: " " })),
    /description/,
  );
  assert.throws(
    () => validateFinanceTransactionInput(transaction({ kind: "transfer" })),
    /income or expense/,
  );
  assert.throws(
    () => validateFinanceTransactionInput(transaction({ accountId: -2 })),
    /valid account/,
  );
});

test("six-month activity windows cross year boundaries without date rollover", () => {
  const window = financeActivityWindow("2026-02");
  assert.equal(window.historyStart, "2025-09-01");
  assert.equal(window.historyEnd, "2026-02-28");
  assert.equal(window.nextMonthStart, "2026-03-01");
  assert.equal(financeActivityWindow("2028-02").historyEnd, "2028-02-29");
  for (const value of ["2026-13", "2026-00", "2026-2", "bad", 202611])
    assert.throws(() => financeActivityWindow(value), /valid month/);
});

test("PHP cash balances use native movement and credit accounts increase debt on expenses", () => {
  const row = {
    id: 1,
    name: "Cash",
    account_type: "cash",
    currency: "PHP",
    opening_balance: "10000",
    native_movement: "-1500",
  };
  assert.equal(mapFinanceActivityAccount(row).nativeCurrentBalance, 8500);
  assert.equal(
    mapFinanceActivityAccount({
      ...row,
      account_type: "credit",
      opening_balance: 500,
    }).nativeCurrentBalance,
    2000,
  );
  assert.equal(mapFinanceActivityAccount({ ...row, currency: "EUR" }), null);
});

test("linked balances remain provider balances and unknown balances remain unknown", () => {
  const row = {
    id: 2,
    name: "Bank",
    account_type: "checking",
    currency: "USD",
    external_provider: "plaid",
    external_account_id: "external-id",
    connection_id: 9,
    current_balance: "125.75",
    available_balance: "120.10",
    native_movement: 10000,
    opening_balance: 200,
  };
  assert.equal(mapFinanceActivityAccount(row).nativeCurrentBalance, 125.75);
  assert.equal(mapFinanceActivityAccount(row).nativeAvailableBalance, 120.1);
  assert.equal(mapFinanceActivityAccount(row).isLinked, true);
  assert.equal(
    mapFinanceActivityAccount({ ...row, current_balance: null })
      .nativeCurrentBalance,
    null,
  );
});

test("credit statement dues preserve unknown fields and never use the revolving balance", () => {
  const row = {
    id: 2, name: "Credit card", account_type: "credit", currency: "USD",
    external_provider: "plaid", external_account_id: "card", current_balance: 999,
    credit_card_due_status: "current",
    credit_card_due_json: JSON.stringify({
      statementBalance: "350.126", minimumPayment: null, dueDate: "2026-11-25",
      lastStatementDate: "2026-10-31", lastPaymentDate: "2026-10-25",
      lastPaymentAmount: "40", syncedAt: "2026-11-04T13:00:00Z",
      secret: "not exposed",
    }),
  };
  assert.deepEqual(mapFinanceActivityAccount(row).creditCardDue, {
    statementBalance: 350.13, minimumPayment: null, dueDate: "2026-11-25",
    lastStatementDate: "2026-10-31", lastPaymentDate: "2026-10-25",
    lastPaymentAmount: 40, syncedAt: "2026-11-04T13:00:00.000Z",
  });
  assert.equal(mapFinanceActivityAccount(row).creditCardDueStatus, "current");
  assert.equal(mapFinanceActivityAccount({...row, credit_card_due_status: "stale"}).creditCardDueStatus, "stale");
  assert.equal(mapFinanceActivityAccount({...row, credit_card_due_json: "bad"}).creditCardDue, null);
  const missing = mapFinanceActivityAccount({...row, credit_card_due_json: JSON.stringify({
    statementBalance: null, minimumPayment: 0, dueDate: "2026-02-30",
  })}).creditCardDue;
  assert.equal(missing.statementBalance, null);
  assert.equal(missing.minimumPayment, 0);
  assert.equal(missing.dueDate, null);
  assert.equal(mapFinanceActivityAccount({...row, account_type: "checking"}).creditCardDue, null);
});

test("bank setup distinguishes sandbox and real setup, encryption and HTTPS requirements", () => {
  assert.equal(financeProviderStatus({}).plaid.configured, false);
  const env = {
    PLAID_CLIENT_ID: "test-client",
    PLAID_SECRET: "test-secret",
    AUTH_SECRET: "test-encryption-key",
  };
  assert.deepEqual(financeProviderStatus(env).plaid, {
    configured: true,
    environment: "sandbox",
  });
  assert.equal(
    financeProviderStatus({ ...env, PLAID_ENV: "production" }).plaid
      .environment,
    "production",
  );
  assert.equal(
    financeProviderStatus({ ...env, PLAID_ENV: "typo" }).plaid.configured,
    false,
  );
  assert.equal(
    financeProviderStatus({ PLAID_CLIENT_ID: "id", PLAID_SECRET: "secret" })
      .plaid.configured,
    false,
  );
  assert.equal(
    financeProviderStatus({ ...env, BRANKAS_LINK_URL: "javascript:alert(1)" })
      .brankas.configured,
    false,
  );
  assert.equal(
    financeProviderStatus({ ...env, BRANKAS_LINK_URL: "http://bank.test" })
      .brankas.configured,
    false,
  );
  assert.deepEqual(
    financeProviderStatus({
      ...env,
      BRANKAS_LINK_URL: "https://bank.test/link",
    }).brankas,
    { configured: true, syncSupported: false },
  );
});
