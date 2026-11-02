import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import * as activity from "../app/lib/financeActivity.mjs";
import * as planActivity from "../app/lib/financePlanActivity.mjs";
import * as identity from "../app/lib/financeAccountIdentity.mjs";

const require = createRequire(import.meta.url);
const { transformSync } = require("next/dist/build/swc");
const { code } = transformSync(
  await readFile(
    new URL("../app/lib/financeStore.js", import.meta.url),
    "utf8",
  ),
  {
    jsc: { parser: { syntax: "ecmascript" }, target: "es2022" },
    module: { type: "commonjs" },
  },
);
const secret = "test-only-finance-token-key";
function encryptedToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    crypto.createHash("sha256").update(secret).digest(),
    iv,
  );
  const encrypted = Buffer.concat([cipher.update(token), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted]
    .map((part) => part.toString("base64url"))
    .join(".");
}
function bankEnvironment(t, fetcher) {
  const keys = [
    "FINANCE_DATABASE_URL",
    "FINANCE_TOKEN_SECRET",
    "PLAID_CLIENT_ID",
    "PLAID_SECRET",
    "PLAID_ENV",
  ];
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    FINANCE_DATABASE_URL: "mysql://mock",
    FINANCE_TOKEN_SECRET: secret,
    PLAID_CLIENT_ID: "mock-client",
    PLAID_SECRET: "mock-secret",
    PLAID_ENV: "sandbox",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch =
    fetcher ||
    (() => {
      throw new Error("Unexpected provider request");
    });
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const key of keys)
      previous[key] === undefined
        ? delete process.env[key]
        : (process.env[key] = previous[key]);
  });
}
function backend(handler) {
  const queries = [];
  const lifecycle = [];
  const events = [];
  let inTransaction = false;
  const database = {
    async query(sql, params = []) {
      const query = {
        sql: sql.replace(/\s+/g, " ").trim(),
        params,
        inTransaction,
      };
      queries.push(query);
      events.push({ type: "query", ...query });
      return [
        (await handler(sql.replace(/\s+/g, " ").trim(), params)) ?? [],
        [],
      ];
    },
    async getConnection() {
      return database;
    },
    async beginTransaction() {
      lifecycle.push("begin");
      inTransaction = true;
      events.push({ type: "begin" });
    },
    async commit() {
      lifecycle.push("commit");
      inTransaction = false;
      events.push({ type: "commit" });
    },
    async rollback() {
      lifecycle.push("rollback");
      inTransaction = false;
      events.push({ type: "rollback" });
    },
    release() {
      lifecycle.push("release");
    },
  };
  const module = { exports: {} };
  const localRequire = (specifier) => {
    if (specifier === "mysql2/promise") return { createPool: () => database };
    if (specifier === "./financeActivity.mjs") return activity;
    if (specifier === "./financePlanActivity.mjs") return planActivity;
    if (specifier === "./financeAccountIdentity.mjs") return identity;
    return require(specifier);
  };
  new Function("require", "module", "exports", code)(
    localRequire,
    module,
    module.exports,
  );
  return { api: module.exports, queries, lifecycle, events };
}
const response = (body, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});

test("removing an account persists the sync exclusion and retains financial history", async (t) => {
  bankEnvironment(t);
  const { api, queries } = backend((sql) =>
    sql.startsWith("SELECT id FROM personal_finance_accounts")
      ? [{ id: 7 }]
      : { affectedRows: 1 },
  );
  assert.deepEqual(await api.archiveFinanceAccount(7), { id: 7 });
  assert.ok(
    queries.some((query) => query.sql.includes("is_sync_excluded = 1")),
  );
  assert.ok(!queries.some((query) => /^DELETE/.test(query.sql)));
});

test("superseded and disconnected connections cannot sync or request update-mode tokens", async (t) => {
  bankEnvironment(t);
  for (const status of ["superseded", "disconnected"]) {
    const { api } = backend((sql) =>
      sql.includes("FROM personal_finance_connections")
        ? [
            {
              id: 1,
              provider: "plaid",
              status,
              encrypted_access_token: encryptedToken("test-token"),
            },
          ]
        : [],
    );
    await assert.rejects(
      api.syncFinanceConnection(1),
      (error) => error.status === 409,
    );
    await assert.rejects(
      api.createPlaidLinkToken("owner@example.com", { connectionId: 1 }),
      (error) => error.status === 400,
    );
  }
});

test("update mode reuses the existing Item and enables account selection without exchanging a token", async (t) => {
  const requests = [];
  bankEnvironment(t, async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return response({ link_token: "mock-link", expiration: "2026-11-03" });
  });
  const { api } = backend((sql) =>
    sql.includes("FROM personal_finance_connections")
      ? [
          {
            provider: "plaid",
            status: "active",
            encrypted_access_token: encryptedToken("existing-item-token"),
          },
        ]
      : [],
  );
  const result = await api.createPlaidLinkToken("owner@example.com", {
    connectionId: 3,
  });
  assert.equal(result.connectionId, 3);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith("/link/token/create"));
  assert.equal(requests[0].body.access_token, "existing-item-token");
  assert.deepEqual(requests[0].body.update, {
    account_selection_enabled: true,
  });
  assert.equal(requests[0].body.products, undefined);
  assert.equal(requests[0].body.transactions, undefined);
});

test("unlink revokes the provider Item then atomically disables syncing while retaining transaction rows", async (t) => {
  const requests = [];
  bankEnvironment(t, async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return response({ request_id: "mock" });
  });
  const { api, queries, lifecycle } = backend((sql) =>
    sql.startsWith("SELECT provider, status")
      ? [
          {
            provider: "plaid",
            status: "active",
            encrypted_access_token: encryptedToken("unlink-token"),
          },
        ]
      : [],
  );
  assert.deepEqual(await api.unlinkFinanceConnection(3), {
    id: 3,
    status: "disconnected",
  });
  assert.ok(requests[0].url.endsWith("/item/remove"));
  assert.equal(requests[0].body.access_token, "unlink-token");
  assert.deepEqual(lifecycle, ["begin", "commit", "release"]);
  assert.ok(
    queries.some((query) =>
      query.sql.includes("encrypted_access_token = NULL"),
    ),
  );
  assert.ok(
    queries.some((query) =>
      query.sql.startsWith(
        "UPDATE personal_finance_accounts SET is_archived = 1",
      ),
    ),
  );
  assert.ok(!queries.some((query) => /^DELETE/.test(query.sql)));
});

test("provider unlink failure retains local credentials for a safe retry", async (t) => {
  bankEnvironment(t, async () =>
    response(
      { error_code: "INTERNAL_ERROR", error_message: "Provider unavailable" },
      500,
    ),
  );
  const { api, queries, lifecycle } = backend((sql) =>
    sql.startsWith("SELECT provider, status")
      ? [
          {
            provider: "plaid",
            status: "active",
            encrypted_access_token: encryptedToken("unlink-token"),
          },
        ]
      : [],
  );
  await assert.rejects(
    api.unlinkFinanceConnection(3),
    (error) => error.status === 502,
  );
  assert.deepEqual(lifecycle, []);
  assert.ok(
    !queries.some((query) =>
      query.sql.includes("encrypted_access_token = NULL"),
    ),
  );
});

const identityAccount = (id, connectionId, overrides = {}) => ({
  id,
  name: "Savings",
  official_name: "Savings",
  account_type: "savings",
  currency: "USD",
  external_provider: "plaid",
  external_account_id: `external-${id}`,
  connection_id: connectionId,
  institution_id: "bank",
  connection_status: "active",
  account_mask: "1234",
  persistent_account_id: "same-savings",
  is_archived: 0,
  is_sync_excluded: 0,
  current_balance: 503.7,
  available_balance: 503.7,
  ...overrides,
});

test("repair preview reads cached provider identity and leaves financial records untouched", async (t) => {
  const endpoints = [];
  bankEnvironment(t, async (url, options) => {
    endpoints.push(url);
    const token = JSON.parse(options.body).access_token;
    return response({
      accounts: [
        {
          account_id: token === "old" ? "external-2" : "external-30",
          name: "Savings",
          mask: "1234",
          persistent_account_id: "same-savings",
        },
      ],
    });
  });
  const rows = [
    identityAccount(2, 1),
    identityAccount(30, 3),
    identityAccount(28, 3, {
      account_mask: "5678",
      persistent_account_id: "new-savings",
    }),
  ];
  const { api, queries, lifecycle } = backend((sql) => {
    if (sql.startsWith("SELECT a.*, c.institution_id")) return rows;
    if (sql.startsWith("SELECT id, institution_id"))
      return [
        {
          id: 1,
          institution_id: "bank",
          encrypted_access_token: encryptedToken("old"),
        },
        {
          id: 3,
          institution_id: "bank",
          encrypted_access_token: encryptedToken("new"),
        },
      ];
    return [];
  });
  const result = await api.repairDuplicateFinanceAccounts({ preview: true });
  assert.equal(result.duplicateAccounts, 1);
  assert.deepEqual(result.groups[0].duplicateIds, [30]);
  assert.ok(result.unmatchedAccounts.some((account) => account.id === 28));
  assert.ok(endpoints.every((url) => url.endsWith("/accounts/get")));
  assert.ok(
    !queries.some((query) => /^(UPDATE|DELETE|INSERT)/.test(query.sql)),
  );
  assert.deepEqual(lifecycle, []);
  assert.ok(!JSON.stringify(result).includes("encrypted_access_token"));
  assert.ok(!JSON.stringify(result).includes("same-savings"));
});

test("repair uses locked removal flags, preserves imported copies and remaps planner references in one transaction", async (t) => {
  bankEnvironment(t, async () => response({ accounts: [] }));
  const rows = [identityAccount(2, 1), identityAccount(30, 3)];
  const planner = {
    salary: { accountId: null },
    bills: [{ reserveAccountId: 30, savedAmount: 503.7 }],
    plans: [],
  };
  const tx = [
    {
      id: 1,
      external_provider: "plaid",
      import_connection_id: 1,
      import_account_key: "old",
      transaction_date: "2026-11-01",
      kind: "income",
      amount: 100,
      currency: "USD",
      merchant: "Transfer",
      pending: 0,
    },
    {
      id: 2,
      external_provider: "plaid",
      import_connection_id: 3,
      import_account_key: "new",
      transaction_date: "2026-11-01",
      kind: "income",
      amount: 100,
      currency: "USD",
      merchant: "Transfer",
      pending: 0,
    },
  ];
  const { api, queries, lifecycle } = backend((sql, params) => {
    if (sql.startsWith("SELECT a.*, c.institution_id"))
      return rows.map((row) => ({
        ...row,
        ...(sql.endsWith("FOR UPDATE") && row.id === 2
          ? { is_sync_excluded: 1, is_archived: 1 }
          : {}),
      }));
    if (sql.startsWith("SELECT id, institution_id")) return [];
    if (sql.startsWith("SELECT *, DATE_FORMAT")) return tx;
    if (sql.startsWith("SELECT document, revision"))
      return [{ document: JSON.stringify(planner), revision: 1 }];
    if (
      sql.startsWith(
        "SELECT id FROM personal_finance_accounts WHERE connection_id",
      )
    )
      return params[0] === 1 ? [] : [{ id: 2 }];
    return { affectedRows: 1 };
  });
  const result = await api.repairDuplicateFinanceAccounts({ preview: false });
  assert.equal(result.mergedAccounts, 1);
  assert.equal(result.duplicateTransactions, 1);
  assert.deepEqual(lifecycle, ["begin", "commit", "release"]);
  const canonicalUpdate = queries.find((query) =>
    query.sql.includes("SET connection_id = ?"),
  );
  assert.equal(
    canonicalUpdate.params.at(-3),
    1,
    "concurrent exclusion stays set",
  );
  assert.equal(
    canonicalUpdate.params.at(-2),
    1,
    "removed account stays archived",
  );
  const plannerUpdate = queries.find((query) =>
    query.sql.startsWith("UPDATE personal_finance_planner"),
  );
  assert.equal(
    JSON.parse(plannerUpdate.params[0]).bills[0].reserveAccountId,
    2,
  );
  assert.equal(JSON.parse(plannerUpdate.params[0]).bills[0].savedAmount, 503.7);
  assert.ok(
    queries.some((query) => query.sql.includes("duplicate_of_id = CASE id")),
  );
  assert.ok(!queries.some((query) => /^DELETE/.test(query.sql)));
});

function syncBackend({ excluded = false, removedOwner = 3, onQuery } = {}) {
  return backend((sql, params) => {
    const intercepted = onQuery?.(sql, params);
    if (intercepted !== undefined) return intercepted;
    if (
      sql.startsWith("SELECT id, provider, status") ||
      sql.startsWith("SELECT id, institution_name, status")
    ) {
      return [
        {
          id: 3,
          provider: "plaid",
          status: "active",
          institution_name: "Bank",
          encrypted_access_token: encryptedToken("sync-token"),
        },
      ];
    }
    if (sql.startsWith("SELECT institution_id, status"))
      return [{ institution_id: "bank", status: "active" }];
    if (sql.startsWith("SELECT status FROM personal_finance_connections"))
      return [{ status: "active" }];
    if (sql.startsWith("SELECT a.id FROM personal_finance_account_aliases"))
      return [{ id: 2 }];
    if (sql.startsWith("SELECT a.id FROM personal_finance_accounts a"))
      return [{ id: 2 }];
    if (sql.startsWith("SELECT is_sync_excluded"))
      return [{ is_sync_excluded: excluded ? 1 : 0 }];
    if (sql.startsWith("SELECT DISTINCT account_id"))
      return [{ account_id: 2 }];
    if (sql.startsWith("SELECT t.id, t.duplicate_of_id"))
      return [
        { id: 20, duplicate_of_id: 10, owner_connection_id: removedOwner },
      ];
    if (sql.startsWith("SELECT *, DATE_FORMAT")) return [];
    return { affectedRows: 1 };
  });
}
function bankSyncResponse(url, transactions) {
  return response(
    url.endsWith("/accounts/balance/get")
      ? {
          item: { institution_id: "bank" },
          accounts: [
            {
              account_id: "account-new",
              name: "Savings",
              type: "depository",
              subtype: "savings",
              mask: "1234",
              persistent_account_id: "persistent-savings",
              balances: {
                current: 100,
                available: 100,
                iso_currency_code: "USD",
              },
            },
          ],
        }
      : {
          added: [],
          modified: [],
          removed: [],
          next_cursor: "new-cursor",
          has_more: false,
          ...transactions,
        },
  );
}

test("resync preserves an explicitly removed account and skips importing its new transactions", async (t) => {
  bankEnvironment(t, async (url) =>
    bankSyncResponse(url, {
      added: [
        {
          transaction_id: "new-transaction",
          account_id: "account-new",
          amount: 25,
          iso_currency_code: "USD",
          date: "2026-11-02",
          name: "Coffee",
        },
      ],
    }),
  );
  const { api, queries } = syncBackend({ excluded: true });
  const result = await api.syncFinanceConnection(3);
  assert.equal(result.transactions.added, 0);
  assert.ok(
    queries.some((query) =>
      query.sql.includes("is_archived = IF(is_sync_excluded = 1, 1, 0)"),
    ),
  );
  assert.ok(
    !queries.some((query) =>
      query.sql.startsWith("INSERT INTO personal_finance_accounts"),
    ),
  );
  assert.ok(
    !queries.some((query) =>
      query.sql.startsWith("INSERT INTO personal_finance_transactions"),
    ),
  );
});

test("primary Item removal tombstones the whole known duplicate cluster instead of reviving a stale copy", async (t) => {
  bankEnvironment(t, async (url) =>
    bankSyncResponse(url, { removed: [{ transaction_id: "removed-copy" }] }),
  );
  const { api, queries } = syncBackend();
  const result = await api.syncFinanceConnection(3);
  assert.equal(result.transactions.removed, 1);
  const tombstone = queries.find((query) =>
    query.sql.includes("is_provider_removed = 1"),
  );
  assert.ok(tombstone.sql.includes("WHERE id = ? OR duplicate_of_id = ?"));
  assert.deepEqual(tombstone.params, [10, 10]);
  assert.ok(
    queries.some(
      (query) =>
        query.sql.startsWith("SELECT *, DATE_FORMAT") &&
        query.sql.includes("is_provider_removed = 0"),
    ),
  );
  assert.ok(!queries.some((query) => /^DELETE/.test(query.sql)));
});

test("nonprimary Item removal suppresses only its own copy and retains the current bank source", async (t) => {
  bankEnvironment(t, async (url) =>
    bankSyncResponse(url, {
      removed: [{ transaction_id: "removed-old-copy" }],
    }),
  );
  const { api, queries } = syncBackend({ removedOwner: 4 });
  await api.syncFinanceConnection(3);
  const tombstone = queries.find((query) =>
    query.sql.includes("is_provider_removed = 1"),
  );
  assert.ok(!tombstone.sql.includes("OR duplicate_of_id"));
  assert.deepEqual(tombstone.params, [20]);
});

const importedPageTransaction = (id) => ({
  transaction_id: id,
  account_id: "account-new",
  amount: 25,
  iso_currency_code: "USD",
  date: "2026-11-02",
  name: "Coffee",
});

test("each sync page deduplicates before committing and the final cursor is published atomically", async (t) => {
  let harness;
  let page = 0;
  const requestCursors = [];
  bankEnvironment(t, async (url, options) => {
    const openTransactions =
      harness.lifecycle.filter((event) => event === "begin").length -
      harness.lifecycle.filter((event) =>
        ["commit", "rollback"].includes(event),
      ).length;
    assert.equal(
      openTransactions,
      0,
      "provider I/O runs outside database transactions",
    );
    if (url.endsWith("/accounts/balance/get")) return bankSyncResponse(url);
    requestCursors.push(JSON.parse(options.body).cursor);
    page++;
    return bankSyncResponse(url, {
      added: [importedPageTransaction(`page-${page}`)],
      next_cursor: `cursor-${page}`,
      has_more: page === 1,
    });
  });
  harness = syncBackend();
  const result = await harness.api.syncFinanceConnection(3);
  assert.equal(result.transactions.added, 2);
  assert.deepEqual(requestCursors, [null, "cursor-1"]);
  assert.deepEqual(harness.lifecycle, [
    "begin",
    "commit",
    "release",
    "begin",
    "commit",
    "release",
    "begin",
    "commit",
    "release",
  ]);
  let chunk = [];
  let pageCommits = 0;
  for (const event of harness.events) {
    if (event.type === "begin") chunk = [];
    else if (event.type === "query") chunk.push(event);
    else if (
      event.type === "commit" &&
      chunk.some((query) =>
        query.sql.startsWith("INSERT INTO personal_finance_transactions"),
      )
    ) {
      pageCommits++;
      assert.ok(chunk.every((query) => query.inTransaction));
      assert.ok(
        chunk.some(
          (query) =>
            query.sql.startsWith(
              "SELECT a.id FROM personal_finance_accounts a",
            ) && query.sql.endsWith("FOR UPDATE"),
        ),
      );
      const inserted = chunk.findIndex((query) =>
        query.sql.startsWith("INSERT INTO personal_finance_transactions"),
      );
      const collapsed = chunk.findIndex((query) =>
        query.sql.startsWith(
          "UPDATE personal_finance_transactions SET duplicate_of_id",
        ),
      );
      assert.ok(
        collapsed > inserted,
        "copy suppression completes inside the transaction",
      );
    }
  }
  assert.equal(pageCommits, 2);
  const cursors = harness.queries.filter((query) =>
    query.sql.startsWith("UPDATE personal_finance_connections SET sync_cursor"),
  );
  assert.equal(cursors.length, 1);
  assert.equal(cursors[0].params[0], "cursor-2");
  assert.equal(cursors[0].inTransaction, true);
});

test("failed final-page deduplication rolls back and keeps the original pagination restart cursor", async (t) => {
  let page = 0;
  bankEnvironment(t, async (url) => {
    if (url.endsWith("/accounts/balance/get")) return bankSyncResponse(url);
    page++;
    return bankSyncResponse(url, {
      added: [importedPageTransaction(`page-${page}`)],
      next_cursor: `cursor-${page}`,
      has_more: page === 1,
    });
  });
  let collapses = 0;
  const harness = syncBackend({
    onQuery(sql) {
      if (
        sql.startsWith(
          "UPDATE personal_finance_transactions SET duplicate_of_id",
        ) &&
        ++collapses === 2
      )
        throw new Error("Simulated deduplication failure");
    },
  });
  await assert.rejects(
    harness.api.syncFinanceConnection(3),
    /Simulated deduplication failure/,
  );
  assert.deepEqual(harness.lifecycle, [
    "begin",
    "commit",
    "release",
    "begin",
    "commit",
    "release",
    "begin",
    "rollback",
    "release",
  ]);
  assert.equal(
    harness.queries.filter((query) =>
      query.sql.startsWith(
        "UPDATE personal_finance_connections SET sync_cursor",
      ),
    ).length,
    0,
  );
});
