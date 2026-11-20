import { addDays, buildPlanRows, convert, entryOccurrences, forecastMatchesTransaction, localDate, roundMoney } from "./financePlanner.mjs";
import { buildAccountPlan } from "./financeAccountPlan.mjs";
import { mapFinanceActivityAccount } from "./financeActivity.mjs";

const DAY = 86400000;
const keyFor = (planId, rowId, leg) => JSON.stringify([planId, rowId, leg]);
const providerRecord = (row) => Boolean(row.external_provider || row.external_transaction_id);
const parse = (value) => {
  try { return typeof value === "string" ? JSON.parse(value) : value || {}; } catch { return {}; }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const dateOnly = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value || "").slice(0, 10);
const money = (value) => roundMoney(Number(value) || 0);
const manualAccount = (account) => account && Number(account.id) > 0 &&
  !account.isLinked && !account.external_provider && !account.provider && !account.external_account_id && !account.externalAccountId &&
  !account.connection_id && !account.connectionId && !account.is_archived && !account.isArchived &&
  !account.is_sync_excluded && !account.isSyncExcluded && !account.merged_into_account_id && !account.mergedIntoAccountId;
const posted = (row, today) => !row.pending && !row.is_provider_removed && row.duplicate_of_id == null &&
  dateOnly(row.posting_date || row.transaction_date) <= today;
const nativeDelta = (row) => (row.kind === "income" ? 1 : -1) * Number(row.amount);
const tooManyMovements = () => Object.assign(new Error("The live planner contains more than 10,000 manual transactions through today. Shorten recurring schedules before saving."), { status: 400 });
const ownGenerated = (row, plan) => plan && String(row.source_plan_id) === String(plan.id) && row.plan_generated &&
  !providerRecord(row) && !parse(row.plan_record_json).detached;

// A refresh rebuilds the planner's movements from its baseline, rather than
// treating yesterday's derived receipts as another source of money.
function manualPlannerBaseline(accounts, existing, primary, today) {
  if (!primary?.continuous) return accounts;
  const movement = new Map();
  const pending = new Map();
  for (const row of existing.filter((row) => ownGenerated(row, primary) && posted(row, today))) {
    const id = Number(row.account_id);
    movement.set(id, (movement.get(id) || 0) + nativeDelta(row));
    if (row.plan_provisional) pending.set(id, (pending.get(id) || 0) + nativeDelta(row));
  }
  return accounts.map((account) => ({ ...account,
    native_movement: money(Number(account.native_movement || 0) - (movement.get(Number(account.id)) || 0)),
    plan_pending_movement: money(Number(account.plan_pending_movement || 0) - (pending.get(Number(account.id)) || 0)),
  }));
}

export const financePlanPendingMovementSql = (alias = "a", currentDate = localDate()) => `(SELECT COALESCE(SUM(CASE WHEN pt.kind = 'income' THEN pt.amount ELSE -pt.amount END), 0)
  FROM personal_finance_transactions pt WHERE pt.account_id = ${alias}.id AND pt.currency = ${alias}.currency
    AND pt.plan_provisional = 1 AND pt.source_plan_id IS NOT NULL AND pt.pending = 0
    AND pt.duplicate_of_id IS NULL AND pt.is_provider_removed = 0 AND pt.transaction_date <= '${/^\d{4}-\d{2}-\d{2}$/.test(currentDate) ? currentDate : localDate()}')`;

/** The live planner owns manual movements through today; linked accounts require recording. */
export function financePlanPostingSpecs(document, accounts, existing = [], { today = localDate(), rate = 58, transactions = [] } = {}) {
  const primary = document.plans?.[0]?.continuous ? document.plans[0] : null;
  accounts = manualPlannerBaseline(accounts, existing, primary, today);
  const byId = new Map(accounts.map((row) => [Number(row.id), row]));
  const prior = new Map(existing.map((row) => [keyFor(row.source_plan_id, row.source_plan_row_id, row.source_plan_leg), parse(row.plan_record_json)]));
  const specs = [];
  const dynamicPayments = [];
  const nativeBalance = (account) => {
    const liability = ["credit", "loan"].includes(account.account_type || account.type);
    if (account.external_provider && account.external_account_id)
      return money(Number(account.current_balance || 0) + (liability ? -1 : 1) * Number(account.plan_pending_movement || 0));
    return money(Number(account.opening_balance || 0) + (liability ? -1 : 1) * Number(account.native_movement || 0));
  };
  for (const plan of document.plans || []) {
    const authoritative = plan === primary;
    const completed = new Set((plan.completedRows || []).map((row) => row.rowId));
    if (!completed.size && !authoritative) continue;
    const overrides = new Map((plan.rowOverrides || []).map((row) => [row.rowId, row]));
    const candidates = [];
    for (const savedEntry of plan.entries || []) {
      const available = (currency) => plan.accountLinks?.[`available${currency === "PHP" ? "Php" : "Usd"}AccountId`] ?? null;
      const entry = authoritative && ["income", "expense"].includes(savedEntry.kind)
        ? { ...savedEntry, accountId: savedEntry.accountId ?? available(savedEntry.currency) }
        : authoritative && savedEntry.kind === "conversion" ? { ...savedEntry,
          fromAccountId: savedEntry.fromAccountId ?? available(savedEntry.currency),
          toAccountId: savedEntry.toAccountId ?? available(savedEntry.currency === "USD" ? "PHP" : "USD"),
        } : savedEntry;
      const recurring = entry.recurrence && entry.recurrence !== "once";
      const automaticEntry = authoritative && [entry.accountId, entry.fromAccountId, entry.toAccountId]
        .some((id) => manualAccount(byId.get(Number(id))));
      const prefix = `entry:${entry.id}:`;
      const occurrenceDates = recurring
        ? [...new Set([
          ...(automaticEntry ? entryOccurrences(entry, entry.date, today, document.salary).map((row) => row.date) : []),
          ...[...completed, ...overrides.keys()].filter((rowId) => rowId.startsWith(prefix)).map((rowId) => rowId.slice(prefix.length)),
        ])]
        : automaticEntry || completed.has(`entry:${entry.id}`) ? [entry.date] : [];
      const occurrences = occurrenceDates.flatMap((day) => entryOccurrences(entry, day, day, document.salary));
      for (const occurrence of occurrences) {
        const rowId = recurring ? `entry:${entry.id}:${occurrence.date}` : `entry:${entry.id}`;
        if (!completed.has(rowId) && !automaticEntry) continue;
        const row = { ...entry, date: occurrence.date, ...overrides.get(rowId) };
        if (!row.date || row.date > today) continue;
        candidates.push({ row, rowId });
        if (authoritative && candidates.length > 10000) throw tooManyMovements();
      }
    }
    const running = new Map();
    const priority = (row) => row.kind === "transfer" ? 2 : row.kind === "conversion" ? 1 : 0;
    candidates.sort((first, second) => first.row.date.localeCompare(second.row.date) || priority(first.row) - priority(second.row));
    for (const { row, rowId } of candidates) {
        const explicitlyRecorded = completed.has(rowId);
        const transfer = ["transfer", "conversion"].includes(row.kind);
        const partialConversion = authoritative && row.kind === "conversion";
        if (transfer ? partialConversion ? !row.fromAccountId && !row.toAccountId : !row.fromAccountId || !row.toAccountId : !row.accountId) continue;
        const source = byId.get(Number(transfer ? row.fromAccountId : row.accountId));
        const target = transfer ? byId.get(Number(row.toAccountId)) : null;
        if ((source ? source.currency !== row.currency : !partialConversion) || (transfer && (target
          ? target.currency !== (row.kind === "conversion" ? row.currency === "USD" ? "PHP" : "USD" : row.currency) : !partialConversion))) continue;
        const signature = [row.kind, Number(row.accountId) || null, Number(row.fromAccountId) || null,
          Number(row.toAccountId) || null, row.date, money(row.amount), row.currency, row.amountMode || "fixed"];
        const old = prior.get(keyFor(plan.id, rowId, transfer ? "debit" : "single")) ||
          (transfer ? prior.get(keyFor(plan.id, rowId, "credit")) : null);
        const frozen = same(old?.signature, signature);
        const dynamic = authoritative && manualAccount(target) && row.amountMode === "cardBalance" && !frozen;
        if (dynamic) dynamicPayments.push({ planId: plan.id, rowId, date: row.date, accountId: Number(target.id) });
        const recordedRate = frozen ? old.conversionRate : Number.isFinite(Number(rate)) && Number(rate) > 0 ? Number(rate) : 58;
        const amount = frozen ? old.sourceAmount : row.amountMode === "cardBalance" && target
          ? Math.max(0, nativeBalance(target) + (running.get(Number(target.id)) || 0)) : money(row.amount);
        if (!Number.isFinite(amount) || (amount <= 0 && !dynamic)) continue;
        const card = transfer && (target?.account_type || target?.type) === "credit" ? target : null;
        const due = parse(card?.credit_card_due_json);
        const explicitDue = card && new RegExp(`^creditCardDue:${Number(card.id)}:(\\d{4}-\\d{2}-\\d{2})$`).exec(row.scheduledRowId || "")?.[1];
        const dueDate = explicitDue || (frozen ? old.creditCardPaymentDueDate || null
          : /^\d{4}-\d{2}-\d{2}$/.test(due.dueDate || "") &&
            (!due.lastStatementDate || row.date >= due.lastStatementDate) && row.date <= due.dueDate ? due.dueDate : null);
        const base = { planId: plan.id, rowId, date: row.date, sourceAmount: amount,
          description: row.description, category: transfer ? "Transfer" : "Uncategorized",
          signature, conversionRate: recordedRate, creditCardPaymentFor: card ? Number(card.id) : null,
          planScheduledRowId: row.scheduledRowId || null,
          creditCardPaymentDueDate: dueDate };
        const append = (leg, account, kind, value, counterpart) => {
          if (!account) return;
          const automatic = authoritative && manualAccount(account);
          if (!explicitlyRecorded && !automatic) return;
          specs.push({ ...base, leg,
            accountId: Number(account.id), currency: account.currency, kind, amount: money(value),
            transferAccountId: counterpart ? Number(counterpart.id) : null,
            awaitingBankSync: Boolean(account.external_provider && account.external_account_id),
            ...(automatic ? { manualPlannerSource: true } : {}),
          });
          if (automatic) running.set(Number(account.id), money((running.get(Number(account.id)) || 0) +
            (kind === "income" ? 1 : -1) * (["credit", "loan"].includes(account.account_type || account.type) ? -1 : 1) * value));
        };
        if (transfer) {
          append("debit", source, "expense", amount, target);
          append("credit", target, "income", row.kind === "conversion" && target ? convert(amount, row.currency, target.currency, recordedRate) : amount, source);
        } else append("single", source, row.kind, amount, null);
    }
  }
  if (primary) reuseManualReceipts(document, primary, accounts, specs, transactions, today, rate);
  // New balance-following payments include the same generated card charges as
  // the table. Previously recorded payment amounts remain fixed on refresh.
  for (let index = 0; index < dynamicPayments.length; index++) {
    const payment = dynamicPayments[index];
    const unresolved = new Set(dynamicPayments.slice(index).map((item) => keyFor(item.planId, item.rowId, "")));
    const evidence = specs.filter((spec) => !unresolved.has(keyFor(spec.planId, spec.rowId, "")));
    const scheduled = scheduledManualSpecs(document, primary, accounts, existing, evidence, transactions, today, rate);
    const target = byId.get(payment.accountId);
    const earlierCustom = evidence.filter((spec) => spec.planId === primary.id && spec.accountId === payment.accountId &&
      spec.date <= payment.date && !spec.reusedTransactionId);
    const earlierScheduled = scheduled.filter((spec) => spec.accountId === payment.accountId &&
      (spec.date < payment.date || (spec.date === payment.date && spec.plannerSource !== "creditCardDue")));
    const amount = Math.max(0, money(nativeBalance(target) - [...earlierCustom, ...earlierScheduled].reduce((total, spec) => total + nativeDelta(spec), 0)));
    for (const spec of specs.filter((spec) => spec.planId === payment.planId && spec.rowId === payment.rowId)) {
      spec.amount = amount;
      spec.sourceAmount = amount;
    }
  }
  const positive = specs.filter((spec) => spec.amount > 0);
  if (primary && accounts.some(manualAccount))
    positive.push(...scheduledManualSpecs(document, primary, accounts, existing, positive, transactions, today, rate));
  if (new Set(positive.filter((spec) => spec.manualPlannerSource).map((spec) => keyFor(spec.planId, spec.rowId, ""))).size > 10000)
    throw tooManyMovements();
  return positive;
}

function reuseManualReceipts(document, primary, accounts, specs, transactions, today, rate) {
  const automatic = specs.filter((spec) => spec.manualPlannerSource && spec.amount > 0);
  if (!automatic.length || !transactions.length) return;
  const scheduled = scheduledManualSpecs(document, primary, accounts, [], [], [], today, rate);
  const candidates = transactions.filter((row) => !providerRecord(row) && !ownGenerated(row, primary) && posted(row, today));
  const transaction = (row) => ({ date: dateOnly(row.posting_date || row.transaction_date),
    kind: row.kind, amount: Number(row.amount), currency: row.currency, accountId: Number(row.account_id),
    merchant: row.merchant, category: row.category, note: row.note, ...financePlanTransactionMetadata(row) });
  const matches = (spec, row, source = "manual") => {
    const receipt = transaction(row);
    if (receipt.accountId !== spec.accountId || receipt.currency !== spec.currency || receipt.kind !== spec.kind ||
        Math.abs(receipt.amount - spec.amount) >= 0.005 ||
        Math.abs(Date.parse(`${receipt.date}T00:00:00Z`) - Date.parse(`${spec.date}T00:00:00Z`)) > 3 * DAY) return false;
    if (row.source_plan_id && (String(row.source_plan_id) !== String(spec.planId) || String(row.source_plan_row_id) !== String(spec.rowId))) return false;
    if (spec.category === "Transfer") return /^(?:transfer(?: in| out)?|internal transfer|account transfer|loan payments?)$/i.test(String(receipt.category || "").trim()) ||
      (receipt.planId === spec.planId && receipt.planRowId === spec.rowId) ||
      (Number(spec.creditCardPaymentFor) > 0 && Number(receipt.creditCardPaymentFor) === Number(spec.creditCardPaymentFor));
    return forecastMatchesTransaction({ id: spec.rowId, source, planId: spec.planId, kind: spec.kind,
      accountId: spec.accountId, currency: spec.currency, amount: spec.amount, date: spec.date, description: spec.description }, receipt);
  };
  const possible = new Map(automatic.map((spec) => [spec, candidates.filter((row) => matches(spec, row))]));
  for (const spec of automatic) {
    const eligible = possible.get(spec);
    if (eligible.length !== 1) continue;
    const receipt = eligible[0];
    if (automatic.filter((other) => possible.get(other).some((row) => Number(row.id) === Number(receipt.id))).length !== 1) continue;
    if (scheduled.some((other) => other.rowId !== spec.planScheduledRowId && matches(other, receipt, other.plannerSource))) continue;
    spec.reusedTransactionId = Number(receipt.id);
  }
}

function scheduledManualSpecs(document, primary, accounts, existing, custom, transactions, today, rate) {
  const mapped = accounts.map(mapFinanceActivityAccount).filter(Boolean);
  const hasPaydays = document.salary?.firstPayDate && (primary.includeIncome ||
    (primary.includeAllocations !== false && document.allocations?.length) ||
    (primary.includeAnnualReserve !== false && document.bills?.some((bill) => bill.cadence === "annual")));
  if (!hasPaydays && !document.bills?.length && !mapped.some((account) => account.creditCardDue)) return [];
  const byId = new Map(accounts.map((account) => [Number(account.id), account]));
  const reused = new Set(custom.map((spec) => spec.reusedTransactionId).filter(Boolean));
  const history = transactions.filter((row) => !reused.has(Number(row.id)) && !ownGenerated(row, primary) && posted(row, today)).map((row) => ({
    id: row.id, date: dateOnly(row.posting_date || row.transaction_date), kind: row.kind,
    amount: Number(row.amount), currency: row.currency, accountId: Number(row.account_id),
    merchant: row.merchant, category: row.category, note: row.note, provider: row.external_provider || "",
    ...financePlanTransactionMetadata(row),
  }));
  // Same-save custom receipts must replace their scheduled source before any
  // salary, bill, savings or reserve remainder is made authoritative.
  history.push(...custom.filter((spec) => spec.planId === primary.id).map((spec) => ({
    id: `plan:${keyFor(spec.planId, spec.rowId, spec.leg)}`, date: spec.date, kind: spec.kind,
    amount: spec.amount, currency: spec.currency, accountId: spec.accountId,
    merchant: spec.description, category: spec.category, planId: spec.planId, planRowId: spec.rowId,
    planScheduledRowId: spec.planScheduledRowId, transferAccountId: spec.transferAccountId,
    creditCardPaymentFor: spec.creditCardPaymentFor, creditCardPaymentDueDate: spec.creditCardPaymentDueDate,
    planGenerated: true, manualPlannerSource: Boolean(spec.manualPlannerSource),
  })));
  const startDate = [primary.startDate, ...(primary.entries || []).map((entry) => entry.date)].filter(Boolean).sort()[0];
  if (!startDate || startDate > today) return [];
  // Include the next annual renewal when calculating adaptive funding, while
  // never expanding years of unrelated future recurring entries.
  const limit = addDays(today, 366) > "2200-12-31" ? "2200-12-31" : addDays(today, 366);
  const endDate = [primary.endDate || limit, limit].sort()[0] < today ? today : [primary.endDate || limit, limit].sort()[0];
  const plan = { ...primary, startDate, endDate, entries: [], completedRows: [], includeTransactions: true };
  const rows = buildPlanRows(plan, document, rate, { accounts: mapped, transactions: history, today });
  // Snapshot openings retain raw past/completed legs. Normal live projections
  // intentionally omit them because their account balances already include them.
  const native = buildAccountPlan({ ...plan, balanceMode: "snapshot",
    accountOpeningBalances: mapped.map((account) => ({ accountId: account.id, balance: account.nativeCurrentBalance || 0 })),
  }, document, rate, { accounts: mapped, rows, today }).rows;
  const specs = [];
  for (const row of native) {
    if (row.date > today || ["transaction", "manual"].includes(row.source)) continue;
    const moves = (row.accountMovements || []).filter((move) => move.kind !== "recorded" && !move.recordedDate);
    // An unfunded statement is an obligation, not proof that debt was paid.
    if (row.source === "creditCardDue" && !moves.some((move) => move.amount < 0 &&
      !["credit", "loan"].includes(byId.get(Number(move.accountId))?.account_type))) continue;
    const grouped = new Map();
    for (const move of moves) {
      const account = byId.get(Number(move.accountId));
      if (!manualAccount(account) || account.currency !== move.currency || !move.amount) continue;
      const key = `${Number(account.id)}:${move.currency}:${Math.sign(move.amount)}`;
      const previous = grouped.get(key);
      if (previous) previous.amount = money(previous.amount + Math.abs(move.amount));
      else grouped.set(key, { accountId: Number(account.id), currency: move.currency,
        kind: move.amount > 0 ? "income" : "expense", amount: money(Math.abs(move.amount)) });
    }
    const legs = [...grouped.values()].sort((a, b) => a.accountId - b.accountId || a.kind.localeCompare(b.kind));
    legs.forEach((move, index) => specs.push({ ...move, planId: primary.id, rowId: row.id, leg: `m${index}`,
      date: row.date, sourceAmount: row.grossAmount ?? row.amount, description: row.description,
      category: row.source === "reserve" || row.source === "creditCardDue" ||
        (row.source === "allocation" && row.allocationKind === "savings") ? "Transfer" : "Uncategorized",
      conversionRate: rate, manualPlannerSource: true, plannerSource: row.source,
      planScheduledRowId: row.id, awaitingBankSync: false,
      transferAccountId: legs.length === 2 ? legs[1 - index].accountId : null,
      creditCardPaymentFor: row.source === "creditCardDue" ? row.creditAccountId : null,
      creditCardPaymentDueDate: row.source === "creditCardDue" ? row.dueDate : null,
    }));
  }
  return specs;
}

/** Run inside the caller's transaction while holding the planner row lock. */
export async function synchronizeFinancePlanPostings(connection, document, { today = localDate(), rate = 58 } = {}) {
  const hasCompleted = (document.plans || []).some((plan) => (plan.completedRows || []).some((row) => row.rowId.startsWith("entry:")));
  const [existing] = await connection.query(`SELECT t.*, DATE_FORMAT(t.transaction_date, '%Y-%m-%d') AS posting_date
    FROM personal_finance_transactions t WHERE t.source_plan_id IS NOT NULL FOR UPDATE`);
  const authoritative = document.plans?.[0]?.continuous === true;
  if (!hasCompleted && !existing.length && !authoritative) return { recorded: 0, reconciled: 0 };
  const [accounts] = await connection.query(`SELECT a.*,
    (SELECT COALESCE(SUM(CASE WHEN t.kind = 'income' THEN t.amount ELSE -t.amount END), 0)
     FROM personal_finance_transactions t WHERE t.account_id = a.id AND t.currency = a.currency
       AND t.pending = 0 AND t.duplicate_of_id IS NULL AND t.is_provider_removed = 0 AND t.transaction_date <= ?) AS native_movement,
    ${financePlanPendingMovementSql()} AS plan_pending_movement
    FROM personal_finance_accounts a`, [today]);
  let transactions = [];
  if (authoritative && accounts.some(manualAccount)) {
    [transactions] = await connection.query(`SELECT t.*, DATE_FORMAT(t.transaction_date, '%Y-%m-%d') AS posting_date
      FROM personal_finance_transactions t WHERE t.pending = 0 AND t.duplicate_of_id IS NULL
        AND t.is_provider_removed = 0 AND t.transaction_date <= ? FOR UPDATE`, [today]);
  }
  const specs = financePlanPostingSpecs(document, accounts, existing, { today, rate, transactions });
  const planIds = new Set((document.plans || []).map((plan) => plan.id));
  // Removing a whole forecast never erases payments already made. Preserve its
  // receipts as editable history, including bank reconciliation still in flight.
  for (const row of existing) {
    const saved = parse(row.plan_record_json);
    if (saved.manualPlannerSource && !planIds.has(row.source_plan_id)) continue;
    if (planIds.has(row.source_plan_id) && !saved.detached) continue;
    if (!saved.planId || !saved.rowId || !saved.leg) continue;
    const changedAccount = Number(row.account_id) !== Number(saved.accountId) || row.kind !== saved.kind;
    const spec = { ...saved, detached: true,
      ...(row.plan_generated ? { accountId: Number(row.account_id), currency: row.currency, kind: row.kind,
        date: dateOnly(row.posting_date || row.transaction_date), amount: money(row.amount),
        description: row.merchant, category: row.category, note: row.note } : {}),
      ...(changedAccount ? { transferAccountId: null, creditCardPaymentFor: null,
        creditCardPaymentDueDate: null, planScheduledRowId: null } : {}),
    };
    const account = accounts.find((item) => Number(item.id) === spec.accountId);
    spec.awaitingBankSync = Boolean(account?.external_provider && account?.external_account_id);
    specs.push(spec);
  }
  const wanted = new Map(specs.map((spec) => [keyFor(spec.planId, spec.rowId, spec.leg), spec]));
  const old = new Map();
  for (const row of existing) {
    const key = keyFor(row.source_plan_id, row.source_plan_row_id, row.source_plan_leg);
    if (wanted.has(key) && !row.is_provider_removed && row.duplicate_of_id == null) old.set(key, row);
    else await releasePosting(connection, row);
  }
  const linkedSpecs = specs.filter((spec) => spec.awaitingBankSync);
  let candidates = [];
  if (linkedSpecs.length) {
    const dates = linkedSpecs.map((spec) => Date.parse(`${spec.date}T00:00:00Z`));
    const [rows] = await connection.query(`SELECT t.*, DATE_FORMAT(t.transaction_date, '%Y-%m-%d') AS posting_date
      FROM personal_finance_transactions t WHERE t.account_id IN (?) AND t.pending = 0
        AND t.duplicate_of_id IS NULL AND t.is_provider_removed = 0
        AND (t.external_provider IS NOT NULL AND t.external_provider <> '')
        AND t.transaction_date BETWEEN ? AND ? FOR UPDATE`,
      [[...new Set(linkedSpecs.map((spec) => spec.accountId))], new Date(Math.min(...dates) - 3 * DAY).toISOString().slice(0, 10),
        new Date(Math.max(...dates) + 3 * DAY).toISOString().slice(0, 10)]);
    candidates = rows;
  }
  const matches = new Map();
  const competing = new Map();
  for (const spec of linkedSpecs) {
    const key = keyFor(spec.planId, spec.rowId, spec.leg);
    const eligible = candidates.filter((row) => Number(row.account_id) === spec.accountId && row.kind === spec.kind &&
      row.currency === spec.currency && Math.abs(Number(row.amount) - spec.amount) < 0.005 &&
      Math.abs(Date.parse(`${dateOnly(row.posting_date || row.transaction_date)}T00:00:00Z`) - Date.parse(`${spec.date}T00:00:00Z`)) <= 3 * DAY &&
      (!row.source_plan_id || keyFor(row.source_plan_id, row.source_plan_row_id, row.source_plan_leg) === key));
    matches.set(key, eligible);
    for (const row of eligible) competing.set(Number(row.id), (competing.get(Number(row.id)) || 0) + 1);
  }
  for (const spec of specs.filter((item) => item.reusedTransactionId))
    matches.set(keyFor(spec.planId, spec.rowId, spec.leg), transactions.filter((row) => Number(row.id) === spec.reusedTransactionId));
  let recorded = 0;
  let reconciled = 0;
  for (const spec of specs) {
    const key = keyFor(spec.planId, spec.rowId, spec.leg);
    let previous = old.get(key);
    const possible = matches.get(key) || [];
    const matched = possible.length === 1 && (spec.reusedTransactionId || competing.get(Number(possible[0].id)) === 1) ? possible[0] : null;
    if (previous && (providerRecord(previous) || !previous.plan_generated) && (!matched || Number(matched.id) !== Number(previous.id))) {
      await releasePosting(connection, previous);
      previous = null;
    }
    if (matched) {
      if (previous && Number(previous.id) !== Number(matched.id)) await releasePosting(connection, previous);
      await connection.query(`UPDATE personal_finance_transactions SET source_plan_id = ?, source_plan_row_id = ?,
        source_plan_leg = ?, plan_generated = 0, plan_provisional = 0, plan_record_json = ? WHERE id = ?`,
        [spec.planId, spec.rowId, spec.leg, JSON.stringify(spec), Number(matched.id)]);
      reconciled++;
    } else {
      // Repeated saves update the same provisional/manual row; no balance baseline is rewritten.
      await connection.query(`INSERT INTO personal_finance_transactions
        (transaction_date, kind, account_id, category, merchant, note, amount, currency,
         source_plan_id, source_plan_row_id, source_plan_leg, plan_generated, plan_provisional, plan_record_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NOW(3), NOW(3))
        ON DUPLICATE KEY UPDATE transaction_date = VALUES(transaction_date), kind = VALUES(kind),
          account_id = VALUES(account_id), category = VALUES(category), merchant = VALUES(merchant), note = VALUES(note),
          amount = VALUES(amount), currency = VALUES(currency), plan_provisional = VALUES(plan_provisional),
          plan_record_json = VALUES(plan_record_json), updated_at = NOW(3)`,
        [spec.date, spec.kind, spec.accountId, spec.category, spec.description.slice(0, 120), spec.note ?? "Recorded from Budget Plans",
          spec.amount, spec.currency, spec.planId, spec.rowId, spec.leg, spec.awaitingBankSync ? 1 : 0, JSON.stringify(spec)]);
      recorded++;
    }
  }
  return { recorded, reconciled };
}

async function releasePosting(connection, row) {
  if (row.plan_generated && !providerRecord(row))
    await connection.query(`DELETE FROM personal_finance_transactions WHERE id = ? AND plan_generated = 1
      AND (external_provider IS NULL OR external_provider = '') AND (external_transaction_id IS NULL OR external_transaction_id = '')`, [Number(row.id)]);
  else await connection.query(`UPDATE personal_finance_transactions SET source_plan_id = NULL, source_plan_row_id = NULL,
    source_plan_leg = NULL, plan_generated = 0, plan_provisional = 0, plan_record_json = NULL WHERE id = ?`, [Number(row.id)]);
}

/** Refresh/backfill previously completed entries and reconcile newly imported bank transactions. */
export async function refreshFinancePlanPostings(database, currentDate) {
  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    let rows;
    try {
      [rows] = await connection.query("SELECT document, exchange_rate FROM personal_finance_planner WHERE id = 1 FOR UPDATE");
    } catch (error) {
      if (error?.errno === 1146) { await connection.commit(); return; }
      throw error;
    }
    if (rows.length) {
      const document = parse(rows[0].document);
      const rate = Number(parse(rows[0].exchange_rate).rate) || 58;
      await synchronizeFinancePlanPostings(connection, document, { today: currentDate, rate });
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally { connection.release(); }
}

export function financePlanTransactionMetadata(row) {
  if (!row.source_plan_id) return {};
  const details = parse(row.plan_record_json);
  return {
    planId: row.source_plan_id, planRowId: row.source_plan_row_id,
    planScheduledRowId: details.planScheduledRowId || null,
    transferAccountId: details.transferAccountId || null,
    creditCardPaymentFor: details.creditCardPaymentFor || null,
    creditCardPaymentDueDate: details.creditCardPaymentDueDate || null,
    awaitingBankSync: Boolean(row.plan_provisional),
    recordedFromPlan: Boolean(row.plan_generated),
    planGenerated: Boolean(row.plan_generated && !details.detached),
    planDetached: Boolean(details.detached),
    ...(details.manualPlannerSource ? { manualPlannerSource: true } : {}),
  };
}
