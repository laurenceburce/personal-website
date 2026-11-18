import { addDays, localDate, roundMoney } from "./financePlanner.mjs";

const DAY = 86_400_000;
const CURRENCIES = ["USD", "PHP"];
const invalid = (message) => Object.assign(new Error(message), { status: 400 });
const dateTime = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "1900-01-01" || value > "2200-12-31") return NaN;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? parsed : NaN;
};
const nativeMoney = (value) => ["number", "string"].includes(typeof value) && String(value).trim() !== "" && Number.isFinite(Number(value))
  ? roundMoney(Number(value)) : null;
const isDebt = (account) => ["credit", "loan"].includes(account.type || account.account_type);
const active = (account) => !account.isArchived && !account.is_archived && !account.mergedIntoAccountId && !account.merged_into_account_id;
const orderedPastRows = (rows, range, today) => rows.filter((row) => row.date >= range.startDate && row.date < today &&
  row.date <= range.endDate && !row.completed && !row.pending && row.source !== "transaction").length;

/** A viewing window never changes the planner's saved entries or account openings. */
export function getLivePlannerRange({ startDate, endDate, today = localDate() } = {}) {
  if (!Number.isFinite(dateTime(today))) throw invalid("Choose a valid current date.");
  const start = startDate ?? addDays(today, -14);
  const end = endDate ?? addDays(today, 90);
  if (!Number.isFinite(dateTime(start)) || !Number.isFinite(dateTime(end)))
    throw invalid("Choose valid start and end dates between 1900 and 2200.");
  if (end < start) throw invalid("The end date must be on or after the start date.");
  if ((dateTime(end) - dateTime(start)) / DAY > 731)
    throw invalid("Choose a date range of up to two years.");
  if (end >= today && (dateTime(end) - dateTime(start < today ? start : today)) / DAY > 731)
    throw invalid("Future projections can extend up to two years from today.");
  return { startDate: start, endDate: end };
}

/** Include hidden earlier future flows so narrowing the view cannot change a projection. */
export function getLivePlannerComputationRange(range, today = localDate()) {
  const safe = getLivePlannerRange({ ...range, today });
  return safe.endDate < today ? safe : {
    startDate: safe.startDate < today ? safe.startDate : today,
    endDate: safe.endDate,
  };
}

export function filterLivePlannerRows(rows = [], range) {
  return rows.filter((row) => row.date >= range.startDate && row.date <= range.endDate);
}

const sumBalances = (accounts, balances, currency, debt) => {
  const selected = accounts.filter((account) => account.currency === currency && isDebt(account) === debt);
  if (selected.some((account) => balances.get(Number(account.id)) == null)) return null;
  return roundMoney(selected.reduce((sum, account) => sum + balances.get(Number(account.id)), 0));
};

/** Table totals use the same native account funds as the summary. */
export function withLivePlannerBalances({ accounts = [], rows = [], today = localDate() } = {}) {
  const selected = accounts.filter((account) => active(account) && CURRENCIES.includes(account.currency) && !isDebt(account));
  const byId = new Map(selected.map((account) => [Number(account.id), account]));
  const balances = new Map(selected.map((account) => [Number(account.id), nativeMoney(
    Object.hasOwn(account, "nativeCurrentBalance") ? account.nativeCurrentBalance : account.currentBalance,
  )]));
  return rows.map((row) => {
    if (row.date >= today && !row.completed && !row.pending && !(row.source === "transaction" && row.date <= today))
      for (const move of row.accountMovements || []) {
        const account = byId.get(Number(move.accountId));
        if (!account || account.currency !== move.currency || (move.recordedDate && move.recordedDate <= today)) continue;
        const value = balances.get(Number(move.accountId));
        const delta = nativeMoney(move.balanceDelta ?? move.amount);
        if (value != null && delta != null) balances.set(Number(move.accountId), roundMoney(value + delta));
      }
    return { ...row, projectedBalanceUsd: sumBalances(selected, balances, "USD", false),
      projectedBalancePhp: sumBalances(selected, balances, "PHP", false) };
  });
}

/** Project from today's native account balances, independently of the history viewing window. */
export function getLivePlannerAnalytics({ accounts = [], rows = [], range, today = localDate() } = {}) {
  const safeRange = getLivePlannerRange({ ...range, today });
  const supported = accounts.filter((account) => active(account) && CURRENCIES.includes(account.currency));
  const byId = new Map(supported.map((account) => [Number(account.id), account]));
  const current = new Map(supported.map((account) => [Number(account.id), nativeMoney(
    Object.hasOwn(account, "nativeCurrentBalance") ? account.nativeCurrentBalance : account.currentBalance,
  )]));
  const projected = new Map(current);
  const hasProjection = safeRange.endDate >= today;
  const currentAssets = Object.fromEntries(CURRENCIES.map((currency) => [currency, sumBalances(supported, current, currency, false)]));
  const cashflow = Object.fromEntries(CURRENCIES.map((currency) => [currency, { income: 0, payments: 0, net: 0 }]));
  const points = hasProjection ? [{ date: today, ...currentAssets }] : [];
  const visibleStart = safeRange.startDate > today ? safeRange.startDate : today;
  let upcomingCount = 0;
  const overdueCount = orderedPastRows(rows, safeRange, today);
  let unassignedCount = 0;
  const ordered = rows.map((row, index) => ({ row, index })).sort((first, second) => first.row.date.localeCompare(second.row.date) || first.index - second.index);
  const seen = new Set();
  if (hasProjection) for (const { row } of ordered) {
    if (!Number.isFinite(dateTime(row.date)) || row.date < today || row.date > safeRange.endDate || row.completed || row.pending ||
        (row.source === "transaction" && row.date <= today)) continue;
    if (row.id != null && seen.has(String(row.id))) continue;
    if (row.id != null) seen.add(String(row.id));
    const validMoves = (row.accountMovements || []).filter((move) => {
      const account = byId.get(Number(move.accountId));
      return account && account.currency === move.currency && (!move.recordedDate || move.recordedDate > today);
    });
    const unfundedCardPayment = row.source === "creditCardDue" && Number(row.amount) > 0 &&
      !validMoves.some((move) => !isDebt(byId.get(Number(move.accountId))) && Number(move.balanceDelta ?? move.amount) < 0);
    // A receiving card leg alone cannot pay debt. Keep the obligation visible
    // until a valid funding account supplies its corresponding cash movement.
    const moves = unfundedCardPayment ? validMoves.filter((move) => {
      const account = byId.get(Number(move.accountId));
      return !(isDebt(account) && Number(move.balanceDelta ?? -Number(move.amount)) < 0 &&
        (row.creditAccountId == null || Number(row.creditAccountId) === Number(move.accountId)));
    }) : validMoves;
    const inWindow = row.date >= visibleStart;
    if (inWindow) {
      upcomingCount++;
      if (Number(row.amount) > 0 && (unfundedCardPayment || (!moves.length && ["salary", "bill", "manual"].includes(row.source)))) unassignedCount++;
    }
    const rowCashChange = { USD: 0, PHP: 0 };
    for (const move of moves) {
      const account = byId.get(Number(move.accountId));
      const change = nativeMoney(move.balanceDelta ?? (isDebt(account) ? -Number(move.amount) : Number(move.amount)));
      if (change == null) continue;
      const prior = projected.get(Number(move.accountId));
      if (prior != null) projected.set(Number(move.accountId), roundMoney(prior + change));
      if (!isDebt(account)) rowCashChange[move.currency] = roundMoney(rowCashChange[move.currency] + change);
    }
    if (inWindow && row.kind !== "conversion") for (const currency of CURRENCIES) {
      const change = rowCashChange[currency];
      if (change > 0) cashflow[currency].income = roundMoney(cashflow[currency].income + change);
      if (change < 0) cashflow[currency].payments = roundMoney(cashflow[currency].payments - change);
    }
    if (moves.length) {
      const day = row.date < today ? today : row.date;
      const point = { date: day, ...Object.fromEntries(CURRENCIES.map((currency) => [currency, sumBalances(supported, projected, currency, false)])) };
      if (points.at(-1)?.date === day && points.length > 1) points[points.length - 1] = point;
      else points.push(point);
    }
  }
  if (hasProjection && points.at(-1)?.date !== safeRange.endDate) points.push({ date: safeRange.endDate,
    ...Object.fromEntries(CURRENCIES.map((currency) => [currency, sumBalances(supported, projected, currency, false)])) });
  const summary = (debt) => Object.fromEntries(CURRENCIES.map((currency) => {
    const value = sumBalances(supported, current, currency, debt);
    const end = hasProjection ? sumBalances(supported, projected, currency, debt) : null;
    return [currency, { current: value, projected: end, change: value == null || end == null ? null : roundMoney(end - value) }];
  }));
  for (const currency of CURRENCIES) cashflow[currency].net = roundMoney(cashflow[currency].income - cashflow[currency].payments);
  return {
    range: safeRange, today, throughDate: safeRange.endDate, hasProjection,
    assets: summary(false), debt: summary(true), cashflow, points, upcomingCount, overdueCount, unassignedCount,
    awaitingBankSyncCount: supported.filter((account) => account.awaitingBankSync).length,
    accounts: supported.map((account) => {
      const value = current.get(Number(account.id));
      const end = hasProjection ? projected.get(Number(account.id)) : null;
      return { id: Number(account.id), name: account.name || "Account", mask: account.mask || "", type: account.type || account.account_type,
        currency: account.currency, current: value, projected: end, change: value == null || end == null ? null : roundMoney(end - value), isDebt: isDebt(account) };
    }),
  };
}
