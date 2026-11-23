import test from "node:test";
import assert from "node:assert/strict";
import { createFinanceCardPaymentDraft, getFinanceCreditCardContext } from "../app/lib/financeCreditCardContext.mjs";

const today = "2026-11-22";
const visa = { id: 2, name: "RCBC Gold Visa", type: "credit", currency: "PHP", nativeCurrentBalance: 2240.01,
  creditCardAutopayEnabled: true, creditCardDue: null };
const checking = { id: 1, name: "Checking", type: "checking", currency: "PHP", nativeCurrentBalance: 30000 };
const jcb = { id: 3, name: "RCBC Gold JCB", type: "credit", currency: "PHP", nativeCurrentBalance: 13696.72 };
const document = (entries = []) => ({ salary: { currency: "PHP", accountId: 1, firstPayDate: "2026-11-20", payFrequency: "biweekly", amount: 2000 },
  bills: [], allocations: [], plans: [{ id: "live", continuous: true, startDate: "2026-11-01", endDate: "2027-11-22",
    accountLinks: { availablePhpAccountId: 1 }, entries, rowOverrides: [], completedRows: [] }] });
const payment = (id, date, amount = 100, extra = {}) => ({ id, date, description: `${id} payment`, kind: "transfer",
  amount, amountMode: "fixed", currency: "PHP", fromAccountId: 1, toAccountId: 2, recurrence: "once", ...extra });

test("card context shows original assigned charge amounts and dates rather than payday allocation amounts", () => {
  const source = document();
  source.bills = [
    { id: "spotify", name: "Spotify", accountId: 2, amount: 169, currency: "PHP", cadence: "monthly", dueDay: 28 },
    { id: "globe", name: "Globe", accountId: 2, amount: 1799, currency: "PHP", cadence: "monthly", dueDay: 11 },
    { id: "converge", name: "Converge", accountId: 2, amount: 2500, currency: "PHP", cadence: "monthly", dueDay: 28 },
    { id: "jcb", name: "Other card bill", accountId: 3, amount: 999, currency: "PHP", cadence: "monthly", dueDay: 28 },
    { id: "wrong-currency", name: "Mismatched assignment", accountId: 2, amount: 99, currency: "USD", cadence: "monthly", dueDay: 28 },
  ];
  source.allocations = [{ id: "prorated", accountId: 2, amount: 84.5, currency: "PHP", kind: "expense" }];
  const before = structuredClone({ source, visa });
  const result = getFinanceCreditCardContext(source, visa, today);
  assert.deepEqual(result.assignedCharges, [
    { billId: "spotify", name: "Spotify", currency: "PHP", amount: 169, date: "2026-11-28", cadence: "Monthly" },
    { billId: "globe", name: "Globe", currency: "PHP", amount: 1799, date: "2026-12-11", cadence: "Monthly" },
    { billId: "converge", name: "Converge", currency: "PHP", amount: 2500, date: "2026-11-28", cadence: "Monthly" },
  ]);
  assert.equal(result.nextPayment, null, "autopay enabled without a saved date is not an explicit payment plan");
  assert.deepEqual({ source, visa }, before);
});

test("charge context respects native installments, split months and paydays without inventing unscheduled dates", () => {
  const source = document();
  source.bills = [
    { id: "annual", name: "Annual installment", accountId: 2, amount: 100.01, currency: "PHP", cadence: "annual", dueMonths: [5, 11], dueDay: 25 },
    { id: "split", name: "Split monthly", accountId: 2, amount: 101, currency: "PHP", cadence: "monthly", dueDays: [10, 25] },
    { id: "payday", name: "Every payday", accountId: 2, amount: 30, currency: "PHP", cadence: "payday" },
    { id: "unscheduled", name: "No charge date", accountId: 2, amount: 99, currency: "PHP", cadence: "monthly", dueDay: null },
    { id: "unknown", name: "Unknown amount", accountId: 2, amount: null, currency: "PHP", cadence: "monthly", dueDay: 28 },
  ];
  assert.deepEqual(getFinanceCreditCardContext(source, visa, today).assignedCharges.map(({ billId, amount, date, cadence }) =>
    ({ billId, amount, date, cadence })), [
    { billId: "annual", amount: 50.01, date: "2026-11-25", cadence: "Annual" },
    { billId: "split", amount: 50.5, date: "2026-11-25", cadence: "Monthly" },
    { billId: "payday", amount: 30, date: "2026-12-04", cadence: "Every payday" },
    { billId: "unscheduled", amount: null, date: null, cadence: "Monthly" },
    { billId: "unknown", amount: null, date: "2026-11-28", cadence: "Monthly" },
  ]);
});

test("next charge uses effective occurrence date, native amount and description without mutating saved settings", () => {
  const source = document();
  source.bills = [{ id: "subscription", name: "Subscription", accountId: 2, amount: 169,
    currency: "PHP", cadence: "monthly", dueDay: 28 }];
  source.plans[0].rowOverrides = [{ rowId: "bill:subscription:2026-11-28", date: "2026-12-04", amount: 99,
    description: "Adjusted subscription" }];
  const before = structuredClone(source);
  assert.deepEqual(getFinanceCreditCardContext(source, visa, today).assignedCharges, [
    { billId: "subscription", name: "Adjusted subscription", currency: "PHP", amount: 99,
      date: "2026-12-04", cadence: "Monthly" },
  ]);
  assert.deepEqual(source, before);
  source.plans[0].rowOverrides[0].amount = 0;
  source.plans[0].rowOverrides[0].description = "";
  assert.deepEqual(getFinanceCreditCardContext(source, visa, today).assignedCharges[0], {
    billId: "subscription", name: "Subscription", currency: "PHP", amount: 0, date: "2026-12-04", cadence: "Monthly",
  });
});

test("next charge selects the earliest effective occurrence and validates overrides moved into the future", () => {
  const source = document();
  source.bills = [{ id: "split", name: "Split subscription", accountId: 2, amount: 338,
    currency: "PHP", cadence: "monthly", dueDays: [4, 28] }];
  source.plans[0].rowOverrides = [{ rowId: "bill:split:2026-11-28", date: "2026-12-10", amount: 99 }];
  const next = () => getFinanceCreditCardContext(source, visa, today).assignedCharges[0];
  assert.equal(next().date, "2026-12-04", "an unmoved regular occurrence can precede the moved next occurrence");
  assert.equal(next().amount, 169, "the earliest occurrence retains its native installment amount");
  source.plans[0].rowOverrides.push(
    { rowId: "bill:split:2026-11-04", date: "2026-11-23", amount: 25, description: "Deferred charge" },
    { rowId: "bill:split:2026-11-05", date: "2026-11-22", amount: 1000 },
    { rowId: "bill:split:2031-12-04", date: "2026-11-22", amount: 2000 },
  );
  assert.deepEqual(next(), { billId: "split", name: "Deferred charge", currency: "PHP", amount: 25,
    date: "2026-11-23", cadence: "Monthly" }, "only actual, bounded original charge dates are eligible");
  source.plans[0].rowOverrides[1].date = "2026-11-21";
  assert.equal(next().date, "2026-12-04", "a saved charge moved into the past is no longer upcoming");
});

test("completed charges and restart-covered bill occurrences advance to the next eligible charge", () => {
  const source = document();
  source.bills = [{ id: "subscription", name: "Subscription", accountId: 2, amount: 169,
    currency: "PHP", cadence: "monthly", dueDay: 28 }];
  source.plans[0].completedRows = [{ rowId: "bill:subscription:2026-11-28", completedAt: "2026-11-21T12:00:00.000Z" }];
  const next = () => getFinanceCreditCardContext(source, visa, today).assignedCharges[0];
  assert.equal(next().date, "2026-12-28", "an already completed future occurrence is not another upcoming charge");
  source.plans[0].completedRows = [];
  source.plans[0].restart = { version: 1, date: "2026-11-28", coveredEntryIds: [] };
  assert.equal(next().date, "2026-12-28", "the reset baseline already includes automatic charges through its day");
  source.plans[0].rowOverrides = [{ rowId: "bill:subscription:2026-10-28", date: "2026-12-01", amount: 9 }];
  assert.equal(next().date, "2026-12-01", "an earlier occurrence explicitly deferred beyond cutover remains upcoming");
  assert.equal(next().amount, 9);
});

test("explicit payment context uses effective dates, skips completed occurrences and ignores legacy plans", () => {
  const source = document([
    payment("past", "2026-11-10"), payment("fixed", "2026-11-30", 500),
    payment("monthly", "2026-11-10", 100, { recurrence: "monthly" }),
    payment("full", "2026-11-25", 0, { amountMode: "cardBalance" }),
    payment("done", "2026-11-23", 50), payment("other-card", "2026-11-23", 99, { toAccountId: 3 }),
    payment("foreign", "2026-11-23", 10, { currency: "USD" }),
  ]);
  source.plans[0].rowOverrides = [
    { rowId: "entry:monthly:2026-11-10", date: "2026-11-24", amount: 125 },
    { rowId: "entry:monthly:2026-12-10", date: "2026-11-23", amount: 222 },
  ];
  source.plans[0].completedRows = [{ rowId: "entry:done", completedAt: "2026-11-22T12:00:00.000Z" }];
  source.plans.push({ id: "legacy", startDate: "2026-11-01", endDate: "2027-01-01", entries: [payment("legacy", "2026-11-23", 999)] });
  const before = structuredClone(source);
  const result = getFinanceCreditCardContext(source, visa, today);
  assert.deepEqual(result.payments.map(({ entry, date, amountMode, amount }) => ({ id: entry.id, date, amountMode, amount })), [
    { id: "monthly", date: "2026-11-23", amountMode: "fixed", amount: 222 },
    { id: "full", date: "2026-11-25", amountMode: "cardBalance", amount: null },
    { id: "fixed", date: "2026-11-30", amountMode: "fixed", amount: 500 },
  ]);
  assert.equal(result.nextPayment.entry.id, "monthly");
  assert.deepEqual(source, before);
});

test("reset-covered payments and expired plans do not become new upcoming payments", () => {
  const source = document([payment("covered", today, 100), payment("new", today, 50)]);
  source.plans[0].restart = { version: 1, date: today, coveredEntryIds: ["covered"] };
  assert.deepEqual(getFinanceCreditCardContext(source, visa, today).payments.map(({ entry }) => entry.id), ["new"]);
  source.plans[0].continuous = false;
  source.plans[0].endDate = "2026-11-21";
  source.plans.push({ id: "legacy", continuous: true, entries: [payment("legacy", "2026-11-23")] });
  assert.equal(getFinanceCreditCardContext(source, visa, today).nextPayment, null);
  assert.deepEqual(getFinanceCreditCardContext(source, checking, today), { assignedCharges: [], payments: [], nextPayment: null });
});

test("payment drafts prefill known debt and configured funding while leaving dates and statement facts untouched", () => {
  const source = document();
  const account = { ...visa, creditCardDue: { statementBalance: 2000, dueDate: "2026-11-25" } };
  const before = structuredClone({ source, account, checking, jcb });
  const draft = createFinanceCardPaymentDraft(account, { document: source, accounts: [checking, account, jcb], today });
  assert.deepEqual(draft, { kind: "transfer", description: "RCBC Gold Visa (PH) (Payment)", currency: "PHP", amount: 2240.01,
    amountMode: "cardBalance", toAccountId: 2, fromAccountId: 1, date: "", recurrence: "once", repeatUntil: null });
  assert.deepEqual({ source, account, checking, jcb }, before);
  assert.equal(createFinanceCardPaymentDraft({ ...visa, nativeCurrentBalance: -125 }, { document: source, accounts: [checking] }).amount, 0);
  assert.equal(createFinanceCardPaymentDraft({ ...visa, nativeCurrentBalance: null, currentBalance: 999 }, { document: source, accounts: [checking] }).amount, "");
});

test("payment draft funding prefers configured accounts then same-currency salary while respecting active assets", () => {
  for (const from of [{ ...checking, currency: "USD" }, { ...checking, isArchived: true },
    { ...checking, isSyncExcluded: true }, { ...checking, type: "loan" }]) {
    assert.equal(createFinanceCardPaymentDraft(visa, { document: document(), accounts: [from, visa] }).fromAccountId, null);
  }
  const source = document();
  source.plans[0].accountLinks.availablePhpAccountId = null;
  assert.equal(createFinanceCardPaymentDraft(visa, { document: source, accounts: [checking, visa] }).fromAccountId, 1);
  delete source.plans[0].accountLinks;
  assert.equal(createFinanceCardPaymentDraft(visa, { document: source, accounts: [checking, visa] }).fromAccountId, 1);
  source.salary.currency = "USD";
  assert.equal(createFinanceCardPaymentDraft(visa, { document: source, accounts: [checking, visa] }).fromAccountId, null);
  assert.equal(createFinanceCardPaymentDraft(checking, { document: source, accounts: [checking, visa] }), null);
});
