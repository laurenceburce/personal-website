import { addDays, billOccurrences, entryOccurrences, localDate, roundMoney } from "./financePlanner.mjs";
import { getPlannerAccountLabel } from "./financePlanPresentation.mjs";

const supportedCurrencies = new Set(["USD", "PHP"]);
const active = (account) => account && !account.isArchived && !account.is_archived &&
  !account.isSyncExcluded && !account.is_sync_excluded && !account.mergedIntoAccountId && !account.merged_into_account_id;
const cardType = (account) => (account?.type || account?.account_type) === "credit";
const knownMoney = (value) => ["number", "string"].includes(typeof value) && String(value).trim() !== "" && Number.isFinite(Number(value));
const validDate = (date) => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= "1900-01-01" && date <= "2200-12-31" &&
  Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
const primaryPlan = (document) => document?.plans?.[0];
const scheduleLabel = (cadence) => ({ monthly: "Monthly", annual: "Annual", payday: "Every payday" })[cadence] || "Unscheduled";

/** Exact assigned charges and explicitly planned payments, without inferred statements. */
export function getFinanceCreditCardContext(document, account, today = localDate()) {
  const empty = { assignedCharges: [], payments: [], nextPayment: null };
  if (!cardType(account) || !active(account) || !(Number(account.id) > 0)) return empty;
  const date = validDate(today) ? today : localDate();
  const endDate = [addDays(date, 731), "2200-12-31"].sort()[0];
  const plan = primaryPlan(document);
  const overrides = new Map((plan?.rowOverrides || []).map((row) => [row.rowId, row]));
  const completed = new Set((plan?.completedRows || []).map((row) => row.rowId));
  const originalFrom = addDays(date, -731);
  const originalThrough = addDays(endDate, 731);
  const assignedCharges = (document?.bills || []).filter((bill) => Number(bill.accountId) === Number(account.id) && bill.currency === account.currency)
    .map((bill) => {
      const prefix = `bill:${bill.id}:`;
      const candidates = billOccurrences(bill, date, endDate, document.salary);
      const existing = new Set(candidates.map((row) => row.date));
      for (const [rowId] of overrides) {
        if (!rowId.startsWith(prefix)) continue;
        const originalDate = rowId.slice(prefix.length);
        if (!validDate(originalDate) || originalDate < originalFrom || originalDate > originalThrough || existing.has(originalDate)) continue;
        candidates.push(...billOccurrences(bill, originalDate, originalDate, document.salary));
        existing.add(originalDate);
      }
      const next = candidates.flatMap((occurrence) => {
        const id = `${prefix}${occurrence.date}`;
        const override = overrides.get(id);
        const chargeDate = override?.date || occurrence.date;
        if (!validDate(chargeDate) || chargeDate < date || chargeDate > endDate || completed.has(id) ||
            (plan?.restart?.version === 1 && chargeDate <= plan.restart.date)) return [];
        return [{ date: chargeDate,
          amount: knownMoney(override?.amount ?? bill.amount) ? roundMoney(Number(override?.amount ?? occurrence.amount)) : null,
          name: typeof override?.description === "string" && override.description.trim() ? override.description : bill.name }];
      }).sort((first, second) => first.date.localeCompare(second.date))[0];
      return { billId: bill.id, name: next?.name || bill.name, currency: bill.currency,
        amount: next?.amount ?? null, date: next?.date || null, cadence: scheduleLabel(bill.cadence) };
    });
  if (!plan || plan.isArchived || plan.is_archived || (!plan.continuous && (!validDate(plan.endDate) || plan.endDate < date)))
    return { ...empty, assignedCharges };
  const start = [date, validDate(plan.startDate) ? plan.startDate : date, plan.restart?.date || date].sort().at(-1);
  const end = plan.continuous ? endDate : [endDate, plan.endDate].sort()[0];
  const covered = new Set(plan.restart?.coveredEntryIds || []);
  const payments = (plan.entries || []).filter((entry) => entry.kind === "transfer" &&
    Number(entry.toAccountId) === Number(account.id) && entry.currency === account.currency)
    .flatMap((entry) => {
      const recurring = entry.recurrence && entry.recurrence !== "once";
      const prefix = `entry:${entry.id}:`;
      const candidates = entryOccurrences(entry, start, end, document.salary);
      const existing = new Set(candidates.map((row) => row.date));
      for (const [rowId] of overrides) {
        const originalDate = recurring && rowId.startsWith(prefix) ? rowId.slice(prefix.length)
          : !recurring && rowId === `entry:${entry.id}` ? entry.date : null;
        if (!validDate(originalDate) || existing.has(originalDate)) continue;
        candidates.push(...entryOccurrences(entry, originalDate, originalDate, document.salary));
        existing.add(originalDate);
      }
      const next = candidates.flatMap((occurrence) => {
        const id = recurring ? `${prefix}${occurrence.date}` : `entry:${entry.id}`;
        const override = overrides.get(id);
        const paymentDate = override?.date || occurrence.date;
        if (!validDate(paymentDate) || paymentDate < start || paymentDate > end || completed.has(id) ||
            (covered.has(entry.id) && paymentDate <= plan.restart?.date)) return [];
        const amountMode = entry.amountMode || "fixed";
        return [{ entry, date: paymentDate, amountMode,
          amount: amountMode === "cardBalance" ? null : knownMoney(override?.amount ?? entry.amount)
            ? roundMoney(Number(override?.amount ?? occurrence.amount)) : null }];
      }).sort((first, second) => first.date.localeCompare(second.date))[0];
      return next ? [next] : [];
    }).sort((first, second) => first.date.localeCompare(second.date) || String(first.entry.id).localeCompare(String(second.entry.id)));
  return { assignedCharges, payments, nextPayment: payments[0] || null };
}

/** Prepare an editable payment plan from known debt; selecting its date remains explicit. */
export function createFinanceCardPaymentDraft(account, { document = {}, accounts = [], today = localDate() } = {}) {
  if (!cardType(account) || !active(account) || !Number.isSafeInteger(Number(account.id)) || Number(account.id) <= 0 ||
      !supportedCurrencies.has(account.currency)) return null;
  const plan = primaryPlan(document);
  const sourceIds = [plan?.accountLinks?.[`available${account.currency === "USD" ? "Usd" : "Php"}AccountId`],
    document.salary?.currency === account.currency ? document.salary.accountId : null];
  const source = sourceIds.map((id) => id == null ? null : accounts.find((item) => Number(item.id) === Number(id) && active(item) &&
    item.currency === account.currency && !["credit", "loan"].includes(item.type || item.account_type) && Number(item.id) !== Number(account.id)))
    .find(Boolean);
  const balance = Object.hasOwn(account, "nativeCurrentBalance") ? account.nativeCurrentBalance : account.currentBalance;
  return { kind: "transfer", description: `${getPlannerAccountLabel(account, accounts)} (Payment)`, currency: account.currency,
    amount: knownMoney(balance) ? Math.max(0, roundMoney(Number(balance))) : "", amountMode: "cardBalance",
    toAccountId: Number(account.id), fromAccountId: source ? Number(source.id) : null,
    date: "", recurrence: "once", repeatUntil: null };
}
