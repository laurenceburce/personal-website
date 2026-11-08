import { localDate, roundMoney } from "./financePlanner.mjs";

const validId = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const knownBalance = (value) => ["number", "string"].includes(typeof value) &&
  String(value).trim() !== "" && Number.isFinite(Number(value));

/** Accounts whose bank balances would otherwise change a plan's opening funds. */
export function planOpeningAccountIds(plan, document = {}) {
  return [...new Set([
    ...(plan.startingAccounts || []).map((row) => row.accountId),
    ...Object.values(plan.accountLinks || {}),
    ...(document.allocations || []).filter((row) => row.kind === "savings").map((row) => row.accountId),
    ...(document.bills || []).filter((row) => row.cadence === "annual").map((row) => row.reserveAccountId),
  ].filter(validId).map(Number))];
}

/**
 * Save native balances immediately before the first day of a plan. Reverse all
 * known posted movements since that date, even movements after the plan ends.
 * Existing dated openings are user-owned and are never refreshed from the bank.
 */
export function capturePlanAccountOpenings(
  plan,
  document,
  accounts = [],
  transactions = [],
  today = localDate(),
  previousPlan = {},
) {
  const required = new Set(planOpeningAccountIds(plan, document));
  const openings = new Map((plan.accountOpeningBalances || []).map((row) => [Number(row.accountId), row]));
  // An older open browser tab can omit the newly saved snapshots. Preserve those
  // openings during unrelated edits instead of silently taking another sample.
  if (previousPlan.startDate === plan.startDate) {
    for (const row of previousPlan.accountOpeningBalances || [])
      if (required.has(Number(row.accountId)) && !openings.has(Number(row.accountId)))
        openings.set(Number(row.accountId), row);
  }
  const movement = new Map();
  for (const row of transactions) {
    if (row.pending || row.date < plan.startDate || row.date > today ||
        !["income", "expense"].includes(row.kind) || !knownBalance(row.amount)) continue;
    const key = `${Number(row.accountId)}:${row.currency}`;
    movement.set(key, roundMoney((movement.get(key) || 0) +
      (row.kind === "income" ? Number(row.amount) : -Number(row.amount))));
  }
  for (const account of accounts) {
    const accountId = Number(account.id);
    if (!required.has(accountId) || openings.has(accountId) || account.isArchived || account.is_archived ||
        account.mergedIntoAccountId || account.merged_into_account_id ||
        !["USD", "PHP"].includes(account.currency) ||
        ["credit", "loan"].includes(account.type || account.account_type)) continue;
    const balance = Object.hasOwn(account, "nativeCurrentBalance") ? account.nativeCurrentBalance : account.currentBalance;
    if (!knownBalance(balance)) continue;
    openings.set(accountId, {
      accountId,
      balance: roundMoney(Number(balance) - (movement.get(`${accountId}:${account.currency}`) || 0)),
    });
  }
  return { ...plan, accountOpeningBalances: [...openings.values()] };
}
