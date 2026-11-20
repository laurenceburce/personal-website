import { addDays, localDate, roundMoney } from "./financePlanner.mjs";
import { ensurePrimaryFinancePlanner } from "./financePrimaryPlanner.mjs";

const active = (account) => !account.isArchived && !account.is_archived &&
  !account.isSyncExcluded && !account.is_sync_excluded && !account.mergedIntoAccountId && !account.merged_into_account_id;
const rowDate = (rowId) => /(?:^|:)(\d{4}-\d{2}-\d{2})$/.exec(String(rowId || ""))?.[1];
const nativeBalance = (account) => {
  const value = Object.hasOwn(account, "nativeCurrentBalance") ? account.nativeCurrentBalance : account.currentBalance;
  return ["number", "string"].includes(typeof value) && String(value).trim() !== "" && Number.isFinite(Number(value))
    ? roundMoney(Number(value)) : null;
};

/** Start a new planner timeline without changing its account or transaction ledger. */
export function createRestartedFinancePlanner(document, accounts = [], { date = localDate(), transactionId = 0 } = {}) {
  const prepared = ensurePrimaryFinancePlanner(document, date);
  const primary = prepared.plans[0];
  const oldPrimary = document.plans?.[0] || primary;
  if (oldPrimary.restart?.version === 1) return prepared;
  const entryDates = new Map((primary.entries || []).map((entry) => [entry.id, entry.date]));
  const overridesById = new Map((primary.rowOverrides || []).map((row) => [row.rowId, row]));
  const candidates = (primary.rowOverrides || []).filter((row) => {
    const oneoff = /^entry:([^:]+)$/.exec(row.rowId)?.[1];
    return row.date > date || (rowDate(row.rowId) || (oneoff && entryDates.get(oneoff))) > date;
  });
  const movedFutureEntries = new Set(candidates.filter((row) => row.date > date)
    .flatMap((row) => /^entry:([^:]+)(?::|$)/.exec(row.rowId)?.[1] || []));
  const entries = (primary.entries || []).filter((entry) => entry.recurrence && entry.recurrence !== "once"
    ? !entry.repeatUntil || entry.repeatUntil > date || movedFutureEntries.has(entry.id)
    : (overridesById.get(`entry:${entry.id}`)?.date || entry.date) > date);
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const futureOverrides = candidates.filter((row) => {
    const entryId = /^entry:([^:]+)(?::|$)/.exec(row.rowId)?.[1];
    return !entryId || entriesById.has(entryId);
  });
  const overrideDates = new Map(futureOverrides.map((row) => [row.rowId, row.date]));
  const completedRows = (primary.completedRows || []).filter((row) => {
    const entry = /^entry:([^:]+)$/.exec(row.rowId)?.[1];
    const effectiveDate = overrideDates.get(row.rowId) || rowDate(row.rowId) ||
      (entry ? entriesById.get(entry)?.date : row.completedAt?.slice(0, 10));
    return effectiveDate > date;
  });
  const seen = new Set();
  const balances = accounts.filter((account) => active(account) && ["USD", "PHP"].includes(account.currency) &&
    Number.isSafeInteger(Number(account.id)) && Number(account.id) > 0 &&
    !seen.has(Number(account.id)) && seen.add(Number(account.id))).map((account) => ({
    accountId: Number(account.id), currency: account.currency, type: account.type || account.account_type,
    balance: nativeBalance(account),
  }));
  const storageDates = [date, ...entries.map((entry) => entry.date), ...futureOverrides.flatMap((row) => [row.date, rowDate(row.rowId)])]
    .filter(Boolean).sort();
  const horizon = addDays(date, 365) > "2200-12-31" ? "2200-12-31" : addDays(date, 365);
  const endDate = [primary.endDate, horizon, ...entries.flatMap((entry) => [entry.date, entry.repeatUntil]),
    ...futureOverrides.map((row) => row.date)].filter(Boolean).sort().at(-1);
  const restart = { version: 1, date, transactionId, balances,
    coveredEntryIds: [...new Set((primary.entries || []).filter((entry) => entry.date <= date ||
      overridesById.get(`entry:${entry.id}`)?.date <= date).map((entry) => entry.id))] };
  return { ...prepared, plans: [{ ...primary, startDate: storageDates[0], endDate,
    includeTransactions: oldPrimary.includeTransactions ?? true,
    openingUsd: 0, openingPhp: 0, openingReserveUsd: 0, openingReservePhp: 0,
    startingAccounts: [], accountOpeningBalances: [], entries, completedRows, rowOverrides: futureOverrides, restart,
  }, ...prepared.plans.slice(1)] };
}
