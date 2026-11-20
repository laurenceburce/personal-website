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
const active = (account) => !account.isArchived && !account.is_archived && !account.isSyncExcluded && !account.is_sync_excluded &&
  !account.mergedIntoAccountId && !account.merged_into_account_id;
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
const projectedAccountMoves = (row, byId, today) => {
  const validMoves = (row.accountMovements || []).filter((move) => {
    const account = byId.get(Number(move.accountId));
    return account && account.currency === move.currency && (!move.recordedDate || move.recordedDate > today);
  });
  const paymentAmount = nativeMoney(row.amount);
  if (row.source !== "creditCardDue" || !(paymentAmount > 0))
    return { moves: validMoves, unfundedCardPayment: false };
  const paymentCredit = (move) => {
    const account = byId.get(Number(move.accountId));
    return isDebt(account) && nativeMoney(move.balanceDelta ?? -Number(move.amount)) < 0 &&
      (row.creditAccountId == null || Number(row.creditAccountId) === Number(move.accountId));
  };
  const funding = new Map();
  for (const move of validMoves) {
    const delta = nativeMoney(move.balanceDelta ?? move.amount);
    if (!isDebt(byId.get(Number(move.accountId))) && delta < 0)
      funding.set(move.currency, roundMoney((funding.get(move.currency) || 0) - delta));
  }
  const currencies = row.currency ? [row.currency] : [...new Set(validMoves.filter(paymentCredit).map((move) => move.currency))];
  const knownFunding = roundMoney(currencies.reduce((total, currency) => total + (funding.get(currency) || 0), 0));
  const unfundedCardPayment = knownFunding < paymentAmount;
  let remainingPayment = paymentAmount;
  // A reserve can fund part of a due while its remaining funding account is
  // unavailable. Only the known native cash debits can reduce projected debt.
  const moves = validMoves.flatMap((move) => {
    if (!paymentCredit(move)) return [move];
    const reduction = -nativeMoney(move.balanceDelta ?? -Number(move.amount));
    const available = !row.currency || row.currency === move.currency ? funding.get(move.currency) || 0 : 0;
    const funded = roundMoney(Math.min(reduction, available, remainingPayment));
    if (!(funded > 0)) return [];
    funding.set(move.currency, roundMoney(available - funded));
    remainingPayment = roundMoney(remainingPayment - funded);
    return [funded === reduction ? move : { ...move, amount: funded, balanceDelta: -funded }];
  });
  return { moves, unfundedCardPayment };
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
      for (const move of projectedAccountMoves(row, byId, today).moves) {
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

const transactionKey = (value) => {
  const key = String(value ?? "").replace(/^transaction:/, "");
  return /^\d+$/.test(key) && BigInt(key) > 0n ? BigInt(key).toString() : null;
};
const compareRecorded = (first, second) => first.date.localeCompare(second.date) ||
  (BigInt(first.key) < BigInt(second.key) ? -1 : BigInt(first.key) > BigInt(second.key) ? 1 : 0);

/** Preserve a full native account snapshot for each logical transaction row. */
export function withLivePlannerAccountSnapshots({ accounts = [], rows = [], today = localDate(),
  historyTransactions = [], historyFrom, historyThrough, historyComplete = false } = {}) {
  const selected = accounts.filter((account) => active(account) && CURRENCIES.includes(account.currency));
  const byId = new Map(selected.map((account) => [Number(account.id), account]));
  const current = new Map(selected.map((account) => [Number(account.id), nativeMoney(
    Object.hasOwn(account, "nativeCurrentBalance") ? account.nativeCurrentBalance : account.currentBalance,
  )]));
  const snapshot = (balances) => selected.map((account) => ({ accountId: Number(account.id), name: account.name || "Account",
    mask: account.mask || "", type: account.type || account.account_type, currency: account.currency,
    balance: balances.get(Number(account.id)) ?? null, isDebt: isDebt(account) }));
  const seen = new Set();
  const history = historyTransactions.flatMap((transaction) => {
    const key = transactionKey(transaction.id);
    if (!key || seen.has(key) || transaction.pending || !Number.isFinite(dateTime(transaction.date)) ||
        transaction.date > today || !["income", "expense"].includes(transaction.kind) ||
        !Number.isFinite(Number(transaction.amount)) || Number(transaction.amount) <= 0) return [];
    seen.add(key);
    return [{ ...transaction, key }];
  }).sort(compareRecorded);
  const historyById = new Map(history.map((transaction) => [transaction.key, transaction]));
  const prepared = rows.map((row, index) => {
    const isRecorded = Boolean(row.recordedInAccounts || ["plan", "transaction"].includes(row.completionSource) ||
      (row.source === "transaction" && row.date <= today && !row.scheduled));
    const ids = [...new Set([row.transactionId, ...(row.matchedTransactionIds || []),
      ...(row.recordedTransactions || []).map((transaction) => transaction.transactionId ?? transaction.id),
      ...(row.source === "transaction" ? [row.id] : [])].map(transactionKey).filter(Boolean))];
    const records = ids.map((id) => historyById.get(id));
    const cutoff = records.filter(Boolean).sort(compareRecorded).at(-1);
    const complete = historyComplete && historyThrough >= today && cutoff &&
      records.length > 0 && records.every((transaction) => transaction && historyFrom <= transaction.date);
    // Statement payment IDs explain the due; their transaction rows own the movements.
    return { row, index, isRecorded, hasEvidence: ids.length > 0, evidenceOnly: row.source === "creditCardDue",
      complete, cutoff, records };
  });
  const claims = new Map();
  for (const item of prepared.filter((item) => item.complete && !item.evidenceOnly)) for (const transaction of item.records) {
    const owners = claims.get(transaction.key) || [];
    owners.push(item);
    claims.set(transaction.key, owners);
  }
  // Ambiguous evidence cannot identify a unique logical balance after either row.
  for (const owners of claims.values()) if (owners.length > 1) for (const owner of owners) owner.complete = false;
  const owners = new Map(prepared.filter((item) => item.complete && !item.evidenceOnly).flatMap((item) =>
    item.records.map((transaction) => [transaction.key, item])));
  const grouped = new Map();
  for (const transaction of history) {
    const owner = owners.get(transaction.key);
    const key = owner ? `row:${owner.index}:${transaction.date}` : `transaction:${transaction.key}`;
    const event = grouped.get(key) || { date: transaction.date, records: [], owner };
    event.key = transaction.key;
    event.records.push(transaction);
    grouped.set(key, event);
  }
  const savedEvents = [...grouped.values()].sort(compareRecorded);
  const logicalByDate = new Map();
  for (const event of savedEvents) if (event.owner) {
    const logical = logicalByDate.get(event.date) || [];
    logical.push(event);
    logicalByDate.set(event.date, logical);
  }
  for (const logical of logicalByDate.values()) logical.sort((first, second) => first.owner.index - second.owner.index);
  const dayCursors = new Map();
  // Posting IDs reflect write order, so use planner order in the represented slots.
  // Hidden history keeps its saved slot; cross-date transfer legs keep their actual dates.
  const events = savedEvents.map((event) => {
    if (!event.owner) return event;
    const index = dayCursors.get(event.date) || 0;
    dayCursors.set(event.date, index + 1);
    return logicalByDate.get(event.date)[index];
  });
  const historical = new Map();
  const beforeRecorded = new Map();
  const dateClosings = new Map();
  const reversed = new Map(current);
  const dates = [...new Set([today, ...events.map((event) => event.date),
    ...prepared.map(({ row }) => row.date).filter((date) => date <= today && Number.isFinite(dateTime(date)))])].sort().reverse();
  let cursor = events.length - 1;
  for (const date of dates) {
    dateClosings.set(date, new Map(reversed));
    while (cursor >= 0 && events[cursor].date === date) {
      const event = events[cursor--];
      const finalLeg = event.owner?.cutoff.date === event.date;
      if (finalLeg) historical.set(event.owner.index, new Map(reversed));
      for (const transaction of [...event.records].reverse()) {
        const account = byId.get(Number(transaction.accountId));
        const value = reversed.get(Number(transaction.accountId));
        if (!account || account.currency !== transaction.currency || value == null) continue;
        const delta = (transaction.kind === "income" ? 1 : -1) * (isDebt(account) ? -1 : 1) * Number(transaction.amount);
        reversed.set(Number(transaction.accountId), roundMoney(value - delta));
      }
      if (finalLeg) beforeRecorded.set(event.owner.index, new Map(reversed));
    }
  }
  const displayBases = new Map();
  const nextByDate = new Map();
  for (const item of [...prepared].reverse()) {
    const { row, index, complete, cutoff, evidenceOnly } = item;
    if (row.date > today) continue;
    if (complete && !evidenceOnly && cutoff.date === row.date && beforeRecorded.has(index))
      nextByDate.set(row.date, beforeRecorded.get(index));
    displayBases.set(index, nextByDate.get(row.date) || dateClosings.get(row.date));
  }
  const todayEvidence = prepared.filter(({ row, isRecorded, hasEvidence, evidenceOnly, records }) => !evidenceOnly &&
    (isRecorded || hasEvidence) && (row.date === today || records.some((transaction) => transaction?.date === today)));
  const todayComplete = !todayEvidence.length || (historyComplete && historyFrom <= today && historyThrough >= today &&
    todayEvidence.every((item) => item.complete));
  const projectedDeltas = new Map();
  let hasProjectedActivity = false;
  const withProjections = (balances) => new Map([...balances].map(([id, value]) =>
    [id, value == null ? null : roundMoney(value + (projectedDeltas.get(id) || 0))]));
  const result = (row, balances, kind, note) => ({ ...row, accountBalanceSnapshot: snapshot(balances),
    accountBalanceSnapshotKind: kind, accountBalanceSnapshotNote: note,
    projectedBalanceUsd: kind === "unavailable" ? null : sumBalances(selected, balances, "USD", false),
    projectedBalancePhp: kind === "unavailable" ? null : sumBalances(selected, balances, "PHP", false) });
  return prepared.map(({ row, index, isRecorded, hasEvidence, evidenceOnly, complete, cutoff }) => {
    if (row.date >= today && !row.completed && !row.pending && !(row.source === "transaction" && row.date <= today))
      for (const move of projectedAccountMoves(row, byId, today).moves) {
        const account = byId.get(Number(move.accountId));
        if (!account || account.currency !== move.currency || (move.recordedDate && move.recordedDate <= today)) continue;
        const delta = nativeMoney(move.balanceDelta ?? (isDebt(account) ? -Number(move.amount) : Number(move.amount)));
        if (delta != null && delta !== 0) {
          projectedDeltas.set(Number(move.accountId), roundMoney((projectedDeltas.get(Number(move.accountId)) || 0) + delta));
          hasProjectedActivity = true;
        }
      }
    if (row.date <= today && (isRecorded || hasEvidence)) {
      if (!complete || (evidenceOnly && row.date === today && !todayComplete)) return result(row, new Map(), "unavailable",
        "Recorded balance history is incomplete for this row. Current balances are available in the summary above.");
      const base = !evidenceOnly && (isRecorded || cutoff.date === row.date) && historical.has(index)
        ? historical.get(index) : displayBases.get(index);
      // The bank's current value anchors the latest recorded event on its date.
      // Pending forecasts must not rewrite that event or earlier actual history.
      if (isRecorded || row.completed) return result(row, base, "recorded",
        `After recorded activity on ${cutoff.date}. Reconstructed from the dated current balance and later recorded movements; planned entries are excluded.`);
      return result(row, withProjections(base), hasProjectedActivity ? "projected" : "recorded", hasProjectedActivity
        ? "Account balances after this row, including earlier planned movements. Recorded transactions are counted once."
        : `After recorded activity on ${cutoff.date}. Reconstructed from current balances and later recorded movements; same-day rows follow planner order.`);
    }
    if (row.date >= today && (!row.completed || hasEvidence || isRecorded)) {
      if (row.date === today && !todayComplete) return result(row, new Map(), "unavailable",
        "Recorded balance history is incomplete for this day. Current balances are available in the summary above.");
      return result(row, withProjections(row.date === today ? displayBases.get(index) : current), "projected",
        "Projected account balances after this transaction in planner order. Card and loan balances show the amount owed.");
    }
    return result(row, new Map(), "unavailable",
      "This past row has no linked recorded transaction. Record or reschedule it to update account balances.");
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
    const { moves, unfundedCardPayment } = projectedAccountMoves(row, byId, today);
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
