import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultFinancePlanner,
  validateFinancePlanner,
  validateFinancePlannerAccounts,
} from "../app/lib/financePlannerStore.js";

const document = () => ({
  salary: {
    amount: 2000,
    currency: "USD",
    payFrequency: "semimonthly",
    firstPayDate: "2026-11-06",
  },
  bills: [
    {
      id: "bill-1",
      name: " Microsoft ",
      amount: 100,
      currency: "USD",
      cadence: "annual",
      dueDay: 9,
      dueMonths: [9],
      paymentMethod: "US Bank Credit",
      isAutopay: true,
    },
  ],
  allocations: [
    {
      id: "saving-1",
      name: "Savings",
      amount: 500,
      currency: "USD",
      kind: "savings",
    },
  ],
  plans: [
    {
      id: "plan-1",
      name: "November",
      startDate: "2026-11-01",
      endDate: "2026-11-30",
      openingUsd: 750,
      openingPhp: 0,
      includeIncome: true,
      entries: [
        {
          id: "conversion-1",
          date: "2026-11-06",
          description: "Convert for bills",
          kind: "conversion",
          amount: 333.09,
          currency: "USD",
        },
      ],
    },
  ],
});

test("default is an empty personal planner with a USD salary and real local date", () => {
  const planner = createDefaultFinancePlanner();
  assert.equal(planner.salary.currency, "USD");
  assert.equal(planner.salary.payFrequency, "biweekly");
  assert.match(planner.salary.firstPayDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(validateFinancePlanner(planner), planner);
});

test("planner account links and native opening balances round trip as positive numeric identifiers", () => {
  const planner = document();
  planner.salary.accountId = "1";
  Object.assign(planner.bills[0], {
    accountId: 4,
    reserveAccountId: 2,
    sourceAccountId: 1,
  });
  Object.assign(planner.allocations[0], { accountId: 3, sourceAccountId: 1 });
  planner.plans[0].accountOpeningBalances = [
    { accountId: "1", balance: -25.126 },
    { accountId: 2, balance: 500 },
  ];
  Object.assign(planner.plans[0].entries[0], {
    fromAccountId: 1,
    toAccountId: 5,
  });
  const before = structuredClone(planner);
  const clean = validateFinancePlanner(planner);
  assert.equal(clean.salary.accountId, 1);
  assert.equal(clean.bills[0].reserveAccountId, 2);
  assert.equal(clean.bills[0].sourceAccountId, 1);
  assert.equal(clean.allocations[0].accountId, 3);
  assert.deepEqual(clean.plans[0].accountOpeningBalances, [
    { accountId: 1, balance: -25.13 },
    { accountId: 2, balance: 500 },
  ]);
  assert.deepEqual(validateFinancePlanner(clean), clean);
  assert.deepEqual(planner, before);
});

test("manual transfers require two distinct accounts and reject unsafe account IDs", () => {
  const planner = document();
  Object.assign(planner.plans[0].entries[0], {
    kind: "transfer",
    fromAccountId: "1",
    toAccountId: "2",
  });
  const clean = validateFinancePlanner(planner);
  assert.equal(clean.plans[0].entries[0].fromAccountId, 1);
  assert.equal(clean.plans[0].entries[0].toAccountId, 2);
  for (const [fromAccountId, toAccountId] of [
    [1, 1],
    [null, 2],
    [1, null],
    ["bad", 2],
    [1, 2.5],
  ]) {
    planner.plans[0].entries[0].fromAccountId = fromAccountId;
    planner.plans[0].entries[0].toAccountId = toAccountId;
    assert.throws(() => validateFinancePlanner(planner), /accounts|account/);
  }
  for (const value of [
    -1,
    0,
    true,
    {},
    [],
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    "1e2",
  ]) {
    const current = document();
    current.salary.accountId = value;
    assert.throws(() => validateFinancePlanner(current), /valid account/);
  }
});

test("account validation requires native currencies and active funding accounts, while retaining removed historical links", () => {
  const planner = validateFinancePlanner(document());
  planner.salary.accountId = 1;
  planner.bills[0].reserveAccountId = 2;
  const accounts = [
    { id: 1, currency: "USD", account_type: "checking", is_archived: 0 },
    { id: 2, currency: "USD", account_type: "savings", is_archived: 0 },
  ];
  assert.deepEqual(validateFinancePlannerAccounts(planner, accounts), [1, 2]);
  assert.throws(
    () =>
      validateFinancePlannerAccounts(planner, [
        { ...accounts[0], currency: "PHP" },
        accounts[1],
      ]),
    /currency must match USD/,
  );
  assert.throws(
    () =>
      validateFinancePlannerAccounts(planner, [
        accounts[0],
        { ...accounts[1], account_type: "credit" },
      ]),
    /must hold funds/,
  );
  assert.throws(
    () =>
      validateFinancePlannerAccounts(planner, [
        { ...accounts[0], is_archived: 1 },
        accounts[1],
      ]),
    /unavailable/,
  );
  assert.doesNotThrow(() =>
    validateFinancePlannerAccounts(
      planner,
      [{ ...accounts[0], is_archived: 1 }, accounts[1]],
      planner,
    ),
  );
  const changed = structuredClone(planner);
  changed.salary.accountId = 3;
  assert.throws(
    () => validateFinancePlannerAccounts(changed, accounts, planner),
    /unavailable/,
  );
  planner.plans[0].entries[0].fromAccountId = 1;
  planner.plans[0].entries[0].toAccountId = 2;
  assert.throws(
    () => validateFinancePlannerAccounts(planner, accounts),
    /currency must match PHP/,
  );
});

test("account opening balances reject duplicate IDs and invalid native values", () => {
  for (const opening of [
    [
      { accountId: 1, balance: 1 },
      { accountId: 1, balance: 2 },
    ],
    [{ accountId: null, balance: 1 }],
    [{ accountId: 1, balance: Infinity }],
    [{ accountId: 1, balance: "100" }],
    null,
  ]) {
    const planner = document();
    planner.plans[0].accountOpeningBalances = opening;
    assert.throws(
      () => validateFinancePlanner(planner),
      /opening balance|opening balances/,
    );
  }
});

test("live starting account selections persist bounded percentages and validate active asset accounts", () => {
  const planner = document();
  planner.plans[0].startingAccounts = [
    { accountId: "1", percentage: 80.126, secret: "discard" },
    { accountId: 2, percentage: 0 },
  ];
  const clean = validateFinancePlanner(planner);
  assert.deepEqual(clean.plans[0].startingAccounts, [
    { accountId: 1, percentage: 80.13 }, { accountId: 2, percentage: 0 },
  ]);
  const accounts = [
    { id: 1, currency: "USD", account_type: "checking" },
    { id: 2, currency: "PHP", account_type: "savings" },
  ];
  assert.deepEqual(validateFinancePlannerAccounts(clean, accounts), [1, 2]);
  assert.throws(() => validateFinancePlannerAccounts(clean, [{ ...accounts[0], account_type: "credit" }, accounts[1]]), /must hold funds/);
  assert.throws(() => validateFinancePlannerAccounts(clean, [{ ...accounts[0], currency: "EUR" }, accounts[1]]), /USD or PHP/);
  assert.throws(() => validateFinancePlannerAccounts(clean, [{ ...accounts[0], is_archived: 1 }, accounts[1]]), /unavailable/);
  assert.doesNotThrow(() => validateFinancePlannerAccounts(clean, [{ ...accounts[0], is_archived: 1 }, accounts[1]], clean));
  for (const starting of [
    [{ accountId: 1, percentage: -1 }], [{ accountId: 1, percentage: 100.001 }],
    [{ accountId: 1, percentage: "80" }], [{ accountId: 1, percentage: Infinity }],
    [{ accountId: null, percentage: 80 }],
    [{ accountId: 1, percentage: 80 }, { accountId: 1, percentage: 20 }],
    null,
  ]) {
    planner.plans[0].startingAccounts = starting;
    assert.throws(() => validateFinancePlanner(planner), /Starting balance|Starting balances|starting balance/);
  }
});

test("completed plan rows retain orphan history but store only validated identifiers and timestamps", () => {
  const planner = document();
  const completedAt = "2026-11-02T15:00:00.000Z";
  planner.plans[0].completedRows = [
    { rowId: "bill:removed-bill:2025-01-01", completedAt, arbitrary: "discard" },
    { rowId: "entry:conversion-1", completedAt },
  ];
  const clean = validateFinancePlanner(planner);
  assert.deepEqual(clean.plans[0].completedRows, [
    { rowId: "bill:removed-bill:2025-01-01", completedAt },
    { rowId: "entry:conversion-1", completedAt },
  ]);
  assert.deepEqual(validateFinancePlanner(clean), clean);
  for (const completed of [
    [{ rowId: "arbitrary:thing", completedAt }],
    [{ rowId: "salary:2026-02-30", completedAt }],
    [{ rowId: "entry:conversion-1", completedAt: "2026-02-30T15:00:00.000Z" }],
    [{ rowId: "entry:conversion-1", completedAt: "yesterday" }],
    [{ rowId: "entry:conversion-1", completedAt }, { rowId: "entry:conversion-1", completedAt }],
  ]) {
    planner.plans[0].completedRows = completed;
    assert.throws(() => validateFinancePlanner(planner), /Completed row/);
  }
});

test("merged account aliases stay unavailable even if an older sync unarchives them", () => {
  const planner = validateFinancePlanner(document());
  planner.salary.accountId = 7;
  const accounts = [
    {
      id: 7,
      currency: "USD",
      account_type: "checking",
      is_archived: 0,
      merged_into_account_id: 1,
    },
  ];
  assert.throws(
    () => validateFinancePlannerAccounts(planner, accounts),
    /unavailable/,
  );
  assert.doesNotThrow(() =>
    validateFinancePlannerAccounts(planner, accounts, planner),
  );
  assert.throws(
    () =>
      validateFinancePlannerAccounts(planner, [
        {
          ...accounts[0],
          merged_into_account_id: null,
          mergedIntoAccountId: 1,
        },
      ]),
    /unavailable/,
  );
});

test("round trips annual installments, savings and two-currency conversion entries", () => {
  const planner = document();
  planner.bills[0].dueMonths = [9, 3, 9];
  const clean = validateFinancePlanner(planner);
  assert.equal(clean.bills[0].name, "Microsoft");
  assert.deepEqual(clean.bills[0].dueMonths, [3, 9]);
  assert.deepEqual(
    clean.plans[0].entries,
    planner.plans[0].entries.map((entry) => ({
      ...entry,
      accountId: null,
      fromAccountId: null,
      toAccountId: null,
    })),
  );
});

test("legacy annual bills receive zero saved funds without changing their source document", () => {
  const planner = document();
  const before = structuredClone(planner);
  const clean = validateFinancePlanner(planner);
  assert.equal(clean.bills[0].savedAmount, 0);
  assert.deepEqual(planner, before);
  assert.equal(Object.hasOwn(planner.bills[0], "savedAmount"), false);
  assert.deepEqual(validateFinancePlanner(clean), clean);
});

test("annual saved funds round trip in the bill currency and can exceed the yearly cost", () => {
  const planner = document();
  planner.bills[0].savedAmount = 150.126;
  planner.bills.push({
    ...planner.bills[0],
    id: "php-bill",
    currency: "PHP",
    savedAmount: 12600.5,
  });
  const clean = validateFinancePlanner(planner);
  assert.equal(clean.bills[0].amount, 100);
  assert.equal(clean.bills[0].savedAmount, 150.13);
  assert.equal(clean.bills[0].currency, "USD");
  assert.equal(clean.bills[1].savedAmount, 12600.5);
  assert.equal(clean.bills[1].currency, "PHP");
  assert.deepEqual(validateFinancePlanner(clean), clean);
  planner.bills[0].savedAmount = 999_999_999;
  assert.equal(
    validateFinancePlanner(planner).bills[0].savedAmount,
    999_999_999,
  );
});

test("annual saved funds reject negative, nonfinite, nonnumeric and excessive values", () => {
  for (const savedAmount of [
    -0.01,
    NaN,
    Infinity,
    -Infinity,
    1_000_000_000,
    "100",
    null,
    true,
    {},
    [],
  ]) {
    const planner = document();
    planner.bills[0].savedAmount = savedAmount;
    assert.throws(
      () => validateFinancePlanner(planner),
      /Saved amount/,
      `saved amount ${String(savedAmount)}`,
    );
  }
});

test("monthly bills normalize stale annual saved funds to zero", () => {
  for (const savedAmount of [undefined, 100, 999_999_999, null, "stale"]) {
    const planner = document();
    Object.assign(planner.bills[0], {
      cadence: "monthly",
      dueMonths: [],
      savedAmount,
    });
    const clean = validateFinancePlanner(planner);
    assert.equal(clean.bills[0].savedAmount, 0);
    assert.deepEqual(validateFinancePlanner(clean), clean);
  }
});

test("retains a signed opening balance and allows a zero salary", () => {
  const planner = document();
  planner.salary.amount = 0;
  planner.plans[0].openingUsd = -120;
  assert.equal(validateFinancePlanner(planner).plans[0].openingUsd, -120);
});

test("rejects invalid calendar dates instead of silently rolling them forward", () => {
  const planner = document();
  planner.salary.firstPayDate = "2026-02-29";
  assert.throws(() => validateFinancePlanner(planner), /valid date/);
  planner.salary.firstPayDate = "2028-02-29";
  assert.equal(
    validateFinancePlanner(planner).salary.firstPayDate,
    "2028-02-29",
  );
});

test("rejects unknown currencies and pay schedules", () => {
  for (const [key, value] of [
    ["currency", "EUR"],
    ["payFrequency", "weekly"],
  ]) {
    const planner = document();
    planner.salary[key] = value;
    assert.throws(() => validateFinancePlanner(planner), /invalid/);
  }
});

test("rejects NaN, infinity, negative and out of bounds monthly salary", () => {
  for (const value of [NaN, Infinity, -1, 1_000_000_000, "2000", null]) {
    const planner = document();
    planner.salary.amount = value;
    assert.throws(() => validateFinancePlanner(planner), /amount/);
  }
});

test("requires an annual due month and allows an open due day for both bill frequencies", () => {
  const planner = document();
  planner.bills[0].dueMonths = [];
  assert.throws(
    () => validateFinancePlanner(planner),
    /at least one due month/,
  );
  planner.bills[0].cadence = "monthly";
  planner.bills[0].dueDay = null;
  assert.equal(validateFinancePlanner(planner).bills[0].dueDay, null);
  planner.bills[0].cadence = "annual";
  planner.bills[0].dueMonths = [11];
  assert.equal(validateFinancePlanner(planner).bills[0].dueDay, null);
});

test("monthly payments normalize two due days without changing the total monthly bill amount", () => {
  const planner = document();
  Object.assign(planner.bills[0], {
    cadence: "monthly",
    amount: 100.01,
    dueDay: 20,
    dueDays: [20, 5, 20],
    dueMonths: [],
  });
  const bill = validateFinancePlanner(planner).bills[0];
  assert.deepEqual(bill.dueDays, [5, 20]);
  assert.equal(bill.dueDay, 5);
  assert.equal(bill.amount, 100.01);
  assert.deepEqual(
    validateFinancePlanner({ ...planner, bills: [bill] }).bills[0],
    bill,
  );
});

test("legacy monthly due days are preserved and explicit empty dates remain open", () => {
  const planner = document();
  Object.assign(planner.bills[0], {
    cadence: "monthly",
    dueDay: 11,
    dueMonths: [],
  });
  assert.deepEqual(validateFinancePlanner(planner).bills[0].dueDays, [11]);
  planner.bills[0].dueDays = [];
  const open = validateFinancePlanner(planner).bills[0];
  assert.deepEqual(open.dueDays, []);
  assert.equal(open.dueDay, null);
  assert.equal(
    validateFinancePlanner(planner).salary.payFrequency,
    "semimonthly",
  );
});

test("monthly schedules reject more than two unique dates and invalid day values", () => {
  for (const dueDays of [
    [1, 15, 30],
    [0, 15],
    [15, 32],
    [1.5],
    ["15"],
    null,
    "1,15",
  ]) {
    const planner = document();
    Object.assign(planner.bills[0], {
      cadence: "monthly",
      dueMonths: [],
      dueDays,
    });
    assert.throws(
      () => validateFinancePlanner(planner),
      /two monthly due days/,
    );
  }
});

test("annual month schedules retain their single due day independently of monthly split dates", () => {
  const planner = document();
  planner.bills[0].dueDays = [4, 19];
  const annual = validateFinancePlanner(planner).bills[0];
  assert.equal(annual.dueDay, 9);
  assert.deepEqual(annual.dueMonths, [9]);
  assert.deepEqual(annual.dueDays, []);
});

test("payday bills round trip the full amount per payday with salary-owned dates", () => {
  const planner = document();
  Object.assign(planner.bills[0], {
    name: "House",
    cadence: "payday",
    currency: "PHP",
    amount: 19000.01,
    dueDay: 14,
    dueDays: [14, 28],
    dueMonths: [3, 9],
    savedAmount: 100,
  });
  const before = structuredClone(planner);
  const clean = validateFinancePlanner(planner);
  assert.equal(clean.bills[0].cadence, "payday");
  assert.equal(clean.bills[0].amount, 19000.01);
  assert.equal(clean.bills[0].currency, "PHP");
  assert.equal(clean.bills[0].dueDay, null);
  assert.deepEqual(clean.bills[0].dueDays, []);
  assert.deepEqual(clean.bills[0].dueMonths, []);
  assert.equal(clean.bills[0].savedAmount, 0);
  assert.deepEqual(validateFinancePlanner(clean), clean);
  assert.deepEqual(planner, before);
});

test("payday bills do not require fixed dates and discard stale calendar or annual fields", () => {
  for (const stale of [
    { dueDay: undefined, dueDays: undefined, dueMonths: undefined },
    {
      dueDay: 99,
      dueDays: "old dates",
      dueMonths: "old months",
      savedAmount: "old savings",
    },
    { dueDay: "14", dueDays: [0, 32], dueMonths: [0, 13], savedAmount: -100 },
  ]) {
    const planner = document();
    Object.assign(planner.bills[0], { cadence: "payday", ...stale });
    const clean = validateFinancePlanner(planner).bills[0];
    assert.equal(clean.dueDay, null);
    assert.deepEqual(clean.dueDays, []);
    assert.deepEqual(clean.dueMonths, []);
    assert.equal(clean.savedAmount, 0);
  }
});

test("payday bills still validate the payment amount, currency, name and autopay", () => {
  for (const [key, value] of [
    ["amount", -1],
    ["amount", Infinity],
    ["amount", "19000"],
    ["amount", 1_000_000_000],
    ["currency", "EUR"],
    ["name", ""],
    ["isAutopay", "false"],
    ["cadence", "weekly"],
  ]) {
    const planner = document();
    Object.assign(planner.bills[0], { cadence: "payday", [key]: value });
    assert.throws(
      () => validateFinancePlanner(planner),
      `${key} remains validated`,
    );
  }
});

test("legacy plans default to full money flow and distinct zero opening annual reserves", () => {
  const plan = validateFinancePlanner(document()).plans[0];
  assert.deepEqual(plan.rowOverrides, []);
  assert.equal(plan.includeIncome, true);
  assert.equal(plan.includeTransactions, true);
  assert.equal(plan.includeAllocations, true);
  assert.equal(plan.includeAnnualReserve, true);
  assert.equal(plan.openingReserveUsd, 0);
  assert.equal(plan.openingReservePhp, 0);
  assert.equal(plan.openingUsd, 750);
  assert.equal(plan.openingPhp, 0);
});

test("scheduled row overrides round trip per plan without changing recurring values", () => {
  const planner = document();
  planner.plans[0].rowOverrides = [
    { rowId: "allocation:saving-1:2026-11-06", date: "2026-11-07", description: "  Smaller savings this payday  ", amount: 175.126, arbitrary: "discard" },
    { rowId: "salary:2026-11-06", date: "2026-11-06", description: "Adjusted salary", amount: 1000 },
    { rowId: "bill:bill-1:2026-11-09", date: "2026-11-10", description: "Single payment", amount: 80 },
    { rowId: "reserve:PHP:2026-11-06", date: "2026-11-06", description: "Skip reserve once", amount: 0 },
    // Keep stable IDs when the source schedule or plan date range has changed.
    { rowId: "allocation:removed-allocation:2026-10-23", date: "2026-11-02", description: "Moved occurrence", amount: 25 },
  ];
  const before = structuredClone(planner);
  const clean = validateFinancePlanner(planner);
  assert.deepEqual(clean.plans[0].rowOverrides, planner.plans[0].rowOverrides.map(({ arbitrary, ...row }, index) => ({
    ...row,
    description: row.description.trim(),
    amount: index === 0 ? 175.13 : row.amount,
  })));
  assert.equal(clean.allocations[0].amount, 500);
  assert.equal(clean.salary.amount, 2000);
  assert.equal(clean.bills[0].amount, 100);
  assert.deepEqual(validateFinancePlanner(clean), clean);
  assert.deepEqual(planner, before);
});

test("row overrides reject duplicate or non-scheduled identifiers and invalid original dates", () => {
  const override = { rowId: "allocation:saving-1:2026-11-06", date: "2026-11-06", description: "Savings", amount: 250 };
  for (const rowId of [
    "entry:conversion-1", "transaction:123", "reserve:EUR:2026-11-06",
    "allocation:saving-1:2026-02-30", "salary:2026-13-01", "salary:1899-12-31",
    "bill:bad/id:2026-11-06", "allocation::2026-11-06", "unknown:2026-11-06",
  ]) {
    const planner = document();
    planner.plans[0].rowOverrides = [{ ...override, rowId }];
    assert.throws(() => validateFinancePlanner(planner), /row ID|row date/);
  }
  const planner = document();
  planner.plans[0].rowOverrides = [override, { ...override, amount: 100 }];
  assert.throws(() => validateFinancePlanner(planner), /unique scheduled/);
});

test("occurrence descriptions preserve prefixed allocation labels at the recurring name limit", () => {
  const planner = document();
  planner.allocations[0].name = "s".repeat(120);
  const description = `Savings · ${planner.allocations[0].name}`;
  planner.plans[0].rowOverrides = [{
    rowId: "allocation:saving-1:2026-11-06",
    date: "2026-11-06",
    description,
    amount: 250,
  }];
  const clean = validateFinancePlanner(planner);
  assert.equal(clean.plans[0].rowOverrides[0].description, description);
  assert.equal(clean.allocations[0].name.length, 120);
  assert.equal(clean.allocations[0].amount, 500);
});

test("row overrides validate bounded money, descriptions, edited dates and collection shape", () => {
  const override = { rowId: "allocation:saving-1:2026-11-06", date: "2026-11-06", description: "Savings", amount: 250 };
  for (const [field, value] of [
    ["amount", -1], ["amount", Infinity], ["amount", NaN], ["amount", "250"],
    ["amount", null], ["amount", 1_000_000_000], ["description", "   "],
    ["description", "x".repeat(161)], ["description", null],
    ["date", "2026-02-30"], ["date", "2026-10-31"], ["date", "2026-12-01"],
  ]) {
    const planner = document();
    planner.plans[0].rowOverrides = [{ ...override, [field]: value }];
    assert.throws(() => validateFinancePlanner(planner), `Invalid override ${field} must be rejected`);
  }
  for (const rowOverrides of [null, {}, [null], new Array(10001).fill(0)]) {
    const planner = document();
    planner.plans[0].rowOverrides = rowOverrides;
    assert.throws(() => validateFinancePlanner(planner), /row override|row overrides/);
  }
});

test("plans retain selected flow switches and native opening annual reserves", () => {
  const planner = document();
  Object.assign(planner.plans[0], {
    includeTransactions: false,
    includeAllocations: false,
    includeAnnualReserve: false,
    openingReserveUsd: 120.126,
    openingReservePhp: 6500.5,
  });
  const clean = validateFinancePlanner(planner).plans[0];
  assert.equal(clean.includeTransactions, false);
  assert.equal(clean.includeAllocations, false);
  assert.equal(clean.includeAnnualReserve, false);
  assert.equal(clean.openingReserveUsd, 120.13);
  assert.equal(clean.openingReservePhp, 6500.5);
  assert.deepEqual(
    validateFinancePlanner({ ...planner, plans: [clean] }).plans[0],
    clean,
  );
});

test("reserve balances cannot be negative or nonnumeric and flow switches must be booleans", () => {
  for (const [key, value] of [
    ["openingReserveUsd", -1],
    ["openingReservePhp", null],
    ["openingReservePhp", "500"],
    ["openingReserveUsd", Infinity],
    ["openingReserveUsd", 1_000_000_000],
    ["includeTransactions", "false"],
    ["includeAllocations", null],
    ["includeAnnualReserve", 0],
  ]) {
    const planner = document();
    planner.plans[0][key] = value;
    assert.throws(() => validateFinancePlanner(planner));
  }
});

test("rejects invalid due days, due months and automatic payment flags", () => {
  for (const [key, value] of [
    ["dueDay", 32],
    ["dueDay", 1.5],
    ["dueMonths", [0]],
    ["dueMonths", [13]],
    ["isAutopay", "false"],
  ]) {
    const planner = document();
    planner.bills[0][key] = value;
    assert.throws(() => validateFinancePlanner(planner));
  }
});

test("rejects duplicate IDs to prevent ambiguous edits", () => {
  const planner = document();
  planner.bills.push({ ...planner.bills[0] });
  assert.throws(() => validateFinancePlanner(planner), /IDs must be unique/);
});

test("rejects inverted dates, plans over two years and out of range entries", () => {
  const planner = document();
  planner.plans[0].endDate = "2026-10-31";
  assert.throws(
    () => validateFinancePlanner(planner),
    /dates must be in order/,
  );
  planner.plans[0].endDate = "2029-11-30";
  assert.throws(() => validateFinancePlanner(planner), /two years/);
  planner.plans[0].endDate = "2026-11-30";
  planner.plans[0].entries[0].date = "2026-12-01";
  assert.throws(() => validateFinancePlanner(planner), /within the plan/);
});

test("strips arbitrary properties and prototype names from stored records", () => {
  const planner = document();
  planner.admin = true;
  planner.salary.sensitive = "discard";
  planner.bills[0].constructor = "discard";
  const clean = validateFinancePlanner(planner);
  assert.equal(Object.hasOwn(clean, "admin"), false);
  assert.equal(Object.hasOwn(clean.salary, "sensitive"), false);
  assert.equal(Object.hasOwn(clean.bills[0], "constructor"), false);
});

test("caps row counts and total UTF-8 document size", () => {
  const planner = document();
  planner.bills = Array.from({ length: 301 }, (_, index) => ({
    ...planner.bills[0],
    id: `bill-${index}`,
  }));
  assert.throws(() => validateFinancePlanner(planner), /at most 300/);
  planner.bills = [];
  planner.ignored = "x".repeat(1_000_000);
  assert.throws(
    () => validateFinancePlanner(planner),
    (error) => error.status === 413,
  );
});
