import test from "node:test";
import assert from "node:assert/strict";
import {
  financeAccountDuplicateGroups,
  findFinanceAccountIdentityMatch,
  financeTransactionDuplicatePairs,
  remapFinancePlannerAccountIds,
  confirmedFinanceAccountGroups,
} from "../app/lib/financeAccountIdentity.mjs";

test("merged bank identities retain one live percentage selection without doubling it", () => {
  const document = {
    plans: [
      {
        startingAccounts: [
          { accountId: 29, percentage: 50 },
          { accountId: 1, percentage: 80 },
        ],
      },
    ],
  };
  const remapped = remapFinancePlannerAccountIds(document, new Map([[29, 1]]));
  assert.deepEqual(remapped.plans[0].startingAccounts, [
    { accountId: 1, percentage: 80 },
  ]);
  assert.equal(document.plans[0].startingAccounts.length, 2);
});

const account = (id, connection = 1, overrides = {}) => ({
  id,
  connection_id: connection,
  external_provider: "plaid",
  external_account_id: `account-${id}`,
  institution_id: "bank",
  account_type: "savings",
  currency: "USD",
  name: "Savings",
  official_name: "Savings",
  account_mask: "1234",
  persistent_account_id: "persistent-savings",
  current_balance: 503.7,
  ...overrides,
});
const transaction = (id, connection = 1, overrides = {}) => ({
  id,
  account_id: 1,
  external_provider: "plaid",
  external_transaction_id: `transaction-${id}`,
  transaction_date: "2026-11-02",
  kind: "expense",
  amount: 25,
  currency: "USD",
  merchant: "Coffee",
  pending: 0,
  import_connection_id: connection,
  import_account_key: `account-${connection}`,
  ...overrides,
});

test("persistent identities merge relinked accounts while preserving genuinely new savings", () => {
  const rows = [
    account(1),
    account(29, 3),
    account(28, 3, {
      account_mask: "5678",
      persistent_account_id: "other-savings",
    }),
  ];
  const groups = financeAccountDuplicateGroups(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].reason, "persistent_account_id");
  assert.equal(groups[0].canonicalId, 1);
  assert.deepEqual(groups[0].duplicateIds, [29]);
  assert.equal(
    findFinanceAccountIdentityMatch(account(99, 5), [rows[0], rows[2]]).id,
    1,
  );
});

test("matching balances and names without bank identifiers never merge", () => {
  const missingIdentity = { account_mask: null, persistent_account_id: null };
  assert.deepEqual(
    financeAccountDuplicateGroups([
      account(1, 1, missingIdentity),
      account(2, 3, missingIdentity),
    ]),
    [],
  );
  assert.equal(
    findFinanceAccountIdentityMatch(account(9, 5, missingIdentity), [
      account(1, 1, missingIdentity),
    ]),
    null,
  );
});

test("credit fallback requires institution, mask, name, type and currency and is unique per connection", () => {
  const credit = {
    persistent_account_id: null,
    account_type: "credit",
    name: "Credit Card",
    official_name: "Credit Card",
  };
  const old = account(3, 1, credit);
  const fresh = account(31, 3, credit);
  assert.equal(financeAccountDuplicateGroups([old, fresh])[0].canonicalId, 3);
  for (const change of [
    { institution_id: "another-bank" },
    { currency: "PHP" },
    { account_mask: "9999" },
    { account_type: "checking" },
    { official_name: "Other Card" },
  ])
    assert.deepEqual(
      financeAccountDuplicateGroups([old, { ...fresh, ...change }]),
      [],
    );
  assert.deepEqual(
    financeAccountDuplicateGroups([old, { ...fresh, connection_id: 1 }]),
    [],
  );
  assert.equal(findFinanceAccountIdentityMatch(fresh, [old]).id, 3);
});

test("different persistent identities override an accidental fallback collision", () => {
  assert.deepEqual(
    financeAccountDuplicateGroups([
      account(1),
      account(2, 3, { persistent_account_id: "different" }),
    ]),
    [],
  );
  assert.equal(
    findFinanceAccountIdentityMatch(
      account(2, 3, { persistent_account_id: "different" }),
      [account(1)],
    ),
    null,
  );
});

test("ambiguous mask collisions remain separate and previously merged aliases stay excluded", () => {
  const noPersistent = { persistent_account_id: null };
  assert.deepEqual(
    financeAccountDuplicateGroups([
      account(1, 1, noPersistent),
      account(2, 1, noPersistent),
      account(3, 3, noPersistent),
    ]),
    [],
  );
  assert.deepEqual(
    financeAccountDuplicateGroups([
      account(1),
      account(2, 3, { merged_into_account_id: 1 }),
    ]),
    [],
  );
});

test("cross-item duplicate imports preserve the maximum legitimate same-day multiplicity", () => {
  const rows = [
    transaction(1),
    transaction(2),
    transaction(3, 3),
    transaction(4, 3),
    transaction(5, 3),
  ];
  const pairs = financeTransactionDuplicatePairs(rows);
  assert.equal(pairs.length, 2);
  const suppressed = new Set(pairs.map((pair) => pair.id));
  assert.equal(rows.filter((row) => !suppressed.has(row.id)).length, 3);
  assert.ok(pairs.every((pair) => !suppressed.has(pair.canonicalId)));
});

test("same-item purchases, manual entries, unknown provenance, pending and different native amounts are retained", () => {
  const sameItem = [
    transaction(1),
    transaction(2),
    transaction(3, 1, { import_account_key: "account-churn" }),
  ];
  assert.deepEqual(financeTransactionDuplicatePairs(sameItem), []);
  for (const change of [
    { external_provider: null },
    { import_connection_id: null },
    { currency: "PHP" },
    { pending: 1 },
    { amount: 25.01 },
    { transaction_date: "2026-11-03" },
    { merchant: "Other" },
  ])
    assert.deepEqual(
      financeTransactionDuplicatePairs([
        transaction(1),
        transaction(2, 3, change),
      ]),
      [],
    );
});

test("provider removal promotes surviving copies without leaving references to deleted records", () => {
  const pairs = financeTransactionDuplicatePairs([
    transaction(2, 3, { duplicate_of_id: 1 }),
    transaction(3, 5, { duplicate_of_id: 1 }),
  ]);
  assert.deepEqual(pairs, [{ id: 3, canonicalId: 2 }]);
});

test("account references remap across salary, bills, savings, transfers and plan opening balances", () => {
  const document = {
    salary: { accountId: 29, amount: 2000 },
    bills: [
      { accountId: 31, reserveAccountId: 30, amount: 395, savedAmount: 100 },
    ],
    allocations: [{ accountId: 28, sourceAccountId: 29, amount: 500 }],
    plans: [
      {
        accountOpeningBalances: [
          { accountId: 29, balance: 20 },
          { accountId: 1, balance: 25 },
        ],
        entries: [{ accountId: 29, fromAccountId: 29, toAccountId: 28 }],
      },
    ],
  };
  const before = JSON.stringify(document);
  const fixed = remapFinancePlannerAccountIds(
    document,
    new Map([
      [29, 1],
      [30, 2],
      [31, 3],
    ]),
  );
  assert.equal(fixed.salary.accountId, 1);
  assert.equal(fixed.bills[0].accountId, 3);
  assert.equal(fixed.bills[0].reserveAccountId, 2);
  assert.equal(fixed.allocations[0].accountId, 28);
  assert.equal(fixed.allocations[0].sourceAccountId, 1);
  assert.deepEqual(fixed.plans[0].accountOpeningBalances, [
    { accountId: 1, balance: 25 },
  ]);
  assert.deepEqual(fixed.plans[0].entries, [
    { accountId: 1, fromAccountId: 1, toAccountId: 28 },
  ]);
  assert.equal(fixed.bills[0].savedAmount, 100);
  assert.equal(JSON.stringify(document), before);
});

test("all six budget column links follow a confirmed account identity without altering legacy plans", () => {
  const links = {
    availableUsdAccountId: 29, availablePhpAccountId: 34,
    annualReserveUsdAccountId: 30, annualReservePhpAccountId: 38,
    savingsUsdAccountId: 28, savingsPhpAccountId: 39,
  };
  const document = { plans: [{ accountLinks: links }, { name: "Legacy" }] };
  const before = structuredClone(document);
  const remapped = remapFinancePlannerAccountIds(document, { 29: 1, 34: 4, 30: 2, 38: 5, 28: 3, 39: 6 });
  assert.deepEqual(remapped.plans[0].accountLinks, {
    availableUsdAccountId: 1, availablePhpAccountId: 4,
    annualReserveUsdAccountId: 2, annualReservePhpAccountId: 5,
    savingsUsdAccountId: 3, savingsPhpAccountId: 6,
  });
  assert.deepEqual(remapped.plans[1], { name: "Legacy" });
  assert.deepEqual(document, before);
});

test("an account merge cannot silently assign the same balance to two budget columns", () => {
  const document = { plans: [{ accountLinks: { availableUsdAccountId: 1, annualReserveUsdAccountId: 29, savingsUsdAccountId: null } }] };
  const before = structuredClone(document);
  assert.throws(() => remapFinancePlannerAccountIds(document, { 29: 1 }),
    (error) => error.status === 400 && /separate budget column accounts/.test(error.message));
  assert.deepEqual(document, before);
});

test("owner-confirmed missing metadata pairs are audited while conflicting bank identities still reject", () => {
  const credit = { account_type: "credit", persistent_account_id: null };
  const rows = [
    account(3, 1, { ...credit, account_mask: null, official_name: null }),
    account(31, 3, { ...credit, account_mask: "7782" }),
  ];
  assert.deepEqual(financeAccountDuplicateGroups(rows), []);
  const [group] = confirmedFinanceAccountGroups(rows, [
    { canonicalId: 3, duplicateIds: [31] },
  ]);
  assert.equal(group.reason, "user_confirmed_identity");
  assert.equal(group.canonicalId, 3);
  for (const change of [
    { currency: "PHP" },
    { institution_id: "other" },
    { account_type: "checking" },
  ]) {
    assert.throws(
      () =>
        confirmedFinanceAccountGroups(
          [rows[0], { ...rows[1], ...change }],
          [{ canonicalId: 3, duplicateIds: [31] }],
        ),
      (error) => error.status === 400,
    );
  }
  assert.throws(
    () =>
      confirmedFinanceAccountGroups(rows, [
        { canonicalId: 3, duplicateIds: [3] },
      ]),
    (error) => error.status === 400,
  );
  assert.throws(
    () =>
      confirmedFinanceAccountGroups(rows, [
        { canonicalId: 3, duplicateIds: [999] },
      ]),
    (error) => error.status === 400,
  );
});

test("provider-removal tombstones cannot participate in duplicate promotion", () => {
  assert.deepEqual(
    financeTransactionDuplicatePairs([
      transaction(1, 1, { is_provider_removed: 1 }),
      transaction(2, 3, { is_provider_removed: 1 }),
    ]),
    [],
  );
  assert.deepEqual(
    financeTransactionDuplicatePairs([
      transaction(1, 1, { is_provider_removed: 1 }),
      transaction(2, 3),
    ]),
    [],
  );
});
