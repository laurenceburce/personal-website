import {
  buildPlanRows,
  convert,
  getAnnualReserveOpening,
  getPlanOpening,
  getSummary,
  localDate,
  roundMoney,
} from "./financePlanner.mjs";

const id = (value) =>
  Number.isSafeInteger(Number(value)) && Number(value) > 0
    ? Number(value)
    : null;
const liability = (account) =>
  ["credit", "loan"].includes(account?.type || account?.account_type);
const archived = (account) =>
  Boolean(account?.isArchived || account?.is_archived || account?.mergedIntoAccountId || account?.merged_into_account_id);
const finiteBalance = (value) =>
  ["number", "string"].includes(typeof value) &&
    !(typeof value === "string" && !value.trim()) && Number.isFinite(Number(value))
    ? roundMoney(value)
    : null;
const accountBalance = (account) =>
  finiteBalance(Object.hasOwn(account, "nativeCurrentBalance") ? account.nativeCurrentBalance : account.currentBalance);
const distance = (first, second) =>
  Math.abs(
    Date.parse(`${first}T00:00:00Z`) - Date.parse(`${second}T00:00:00Z`),
  ) / 86400000;
const transferCategory = (row) =>
  /^(?:transfer(?: in| out)?|internal transfer|account transfer|loan payments?)$/i.test(
    String(row.category || "").trim(),
  );

/** Associations and earmarks describe a plan; they never change provider balances. */
export function getFinanceAccountAllocations(
  document,
  accounts = [],
  rate = 1,
  today = localDate(),
) {
  const summary = getSummary(document, rate, today);
  const rows = accounts.map((account) => {
    const bankBalance = accountBalance(account);
    return {
      accountId: Number(account.id),
      name: account.name,
      currency: account.currency,
      mask: account.mask || "",
      institutionName: account.institutionName || "",
      type: account.type,
      isArchived: archived(account),
      bankBalance,
      annualReserved: 0,
      annualPerPayday: 0,
      savingsPerPayday: 0,
      salaryPerPayday: 0,
      billsPerPayday: 0,
      fundingOutPerPayday: 0,
      totalPerPayday: 0,
      unallocatedBalance: bankBalance,
      overassigned: bankBalance === null ? null : 0,
      roles: [],
    };
  });
  const byId = new Map(rows.map((row) => [row.accountId, row]));
  const role = (accountId, currency, kind, entityId, name, amount, field) => {
    const row = byId.get(id(accountId));
    if (!row || row.currency !== currency) return;
    const value = Math.max(0, roundMoney(amount));
    if (field) row[field] = roundMoney(row[field] + value);
    row.roles.push({ kind, id: entityId, name, amount: value, currency });
  };
  const salary = document.salary || {};
  role(
    salary.accountId,
    salary.currency,
    "salary",
    "salary",
    "Salary",
    roundMoney((Number(salary.amount || 0) * 12) / summary.payPeriods),
    "salaryPerPayday",
  );
  const funding = new Map(
    summary.annualFunding.map((bill) => [bill.billId, bill]),
  );
  for (const bill of document.bills || []) {
    if (bill.cadence === "annual") {
      const reserve = funding.get(bill.id);
      role(
        bill.reserveAccountId,
        bill.currency,
        "annualReserve",
        bill.id,
        bill.name,
        reserve.savedAmount,
        "annualReserved",
      );
      role(
        bill.reserveAccountId,
        bill.currency,
        "annualFunding",
        bill.id,
        bill.name,
        reserve.perPeriodAmount,
        "annualPerPayday",
      );
      role(
        bill.sourceAccountId ?? salary.accountId,
        bill.currency,
        "annualSource",
        bill.id,
        bill.name,
        reserve.perPeriodAmount,
        "fundingOutPerPayday",
      );
      role(
        bill.accountId,
        bill.currency,
        "annualPayment",
        bill.id,
        bill.name,
        bill.amount,
      );
    } else {
      role(
        bill.accountId,
        bill.currency,
        "bill",
        bill.id,
        bill.name,
        bill.cadence === "payday"
          ? bill.amount
          : (Number(bill.amount || 0) * 12) / summary.payPeriods,
        "billsPerPayday",
      );
    }
  }
  for (const allocation of document.allocations || []) {
    const savings = allocation.kind === "savings";
    role(
      allocation.accountId,
      allocation.currency,
      savings ? "savings" : "expense",
      allocation.id,
      allocation.name,
      allocation.amount,
      savings ? "savingsPerPayday" : "billsPerPayday",
    );
    if (savings)
      role(
        allocation.sourceAccountId ?? salary.accountId,
        allocation.currency,
        "savingsSource",
        allocation.id,
        allocation.name,
        allocation.amount,
        "fundingOutPerPayday",
      );
  }
  for (const row of rows) {
    row.totalPerPayday = roundMoney(row.annualPerPayday + row.savingsPerPayday);
    row.unallocatedBalance =
      row.bankBalance === null || liability(row)
        ? null
        : roundMoney(row.bankBalance - row.annualReserved);
    row.overassigned =
      row.unallocatedBalance === null
        ? null
        : Math.max(0, roundMoney(-row.unallocatedBalance));
  }
  return rows;
}

/** Forecast each selected native account independently from the plan's available-funds totals. */
export function buildAccountPlan(plan, document, rate, options = {}) {
  const accounts = options.accounts || [];
  const sourceRows =
    options.rows || buildPlanRows(plan, document, rate, options);
  const today = options.today || localDate();
  const associations = getFinanceAccountAllocations(
    document,
    accounts,
    rate,
    today,
  );
  const associationById = new Map(
    associations.map((account) => [account.accountId, account]),
  );
  const accountById = new Map(
    accounts.map((account) => [Number(account.id), account]),
  );
  const accountLinks = plan.accountLinks || {};
  const linkedIds = new Set(Object.values(accountLinks).map(id).filter(Boolean));
  const linkedId = (kind, currency) => id(accountLinks[`${kind}${currency === "USD" ? "Usd" : "Php"}AccountId`]);
  const opening = new Map(
    (plan.accountOpeningBalances || []).map((balance) => [
      id(balance.accountId),
      roundMoney(balance.balance),
    ]),
  );
  const liveOpening = getPlanOpening(plan, accounts, document);
  const live = new Map(liveOpening.contributions.map((contribution) => [contribution.accountId, contribution.amount]));
  // Explicit column links can also review a dated account opening. The legacy
  // percentage-based starting amounts continue to use current bank balances.
  for (const accountId of live.keys())
    if (!linkedIds.has(accountId)) opening.delete(accountId);
  const warnings = new Set(liveOpening.warnings);
  const balances = new Map();
  const annualReserved = new Map();
  const savingsAllocated = new Map();
  for (const account of accounts) {
    const accountId = Number(account.id);
    const current = accountBalance(account);
    balances.set(
      accountId,
      linkedIds.has(accountId) ? opening.has(accountId) ? opening.get(accountId) : current
        : live.has(accountId) ? live.get(accountId) : opening.has(accountId) ? opening.get(accountId) : current,
    );
    annualReserved.set(
      accountId,
      associationById.get(accountId)?.annualReserved || 0,
    );
    savingsAllocated.set(accountId, 0);
  }
  const salary = document.salary || {};
  const linkedBalance = (kind, currency, fallback) => {
    const selected = linkedId(kind, currency);
    if (!selected) return plan.accountLinks ? 0 : fallback;
    const account = accountById.get(selected);
    const label = kind === "available" ? "Available funds" : kind === "annualReserve" ? "Annual reserves" : "Savings";
    if (!account || archived(account) || liability(account) || account.currency !== currency) {
      warnings.add(`${label}: its linked ${currency} account is unavailable; choose an active account in ${currency}.`);
      return null;
    }
    const value = balances.get(selected);
    if (value == null) warnings.add(`${account.name}: its linked ${label.toLowerCase()} balance is unavailable.`);
    return value ?? null;
  };
  const openingBalances = {
    usd: linkedBalance("available", "USD", liveOpening.usd),
    php: linkedBalance("available", "PHP", liveOpening.php),
  };
  const reserveOpening = getAnnualReserveOpening(plan, document);
  const openingReserve = {
    ...reserveOpening,
    usd: linkedBalance("annualReserve", "USD", reserveOpening.usd),
    php: linkedBalance("annualReserve", "PHP", reserveOpening.php),
  };
  const savingsAccounts = new Map();
  const unknownSavings = new Set();
  const unassignedSavings = { USD: 0, PHP: 0 };
  for (const allocation of document.allocations || []) {
    if (allocation.kind !== "savings" || !["USD", "PHP"].includes(allocation.currency)) continue;
    const selected = id(allocation.accountId);
    if (!selected) continue;
    const account = accountById.get(selected);
    if (!account || archived(account) || liability(account) || account.currency !== allocation.currency) {
      unknownSavings.add(allocation.currency);
      warnings.add(`${allocation.name}: its savings balance is unavailable; choose an active savings destination in ${allocation.currency}.`);
      continue;
    }
    savingsAccounts.set(selected, allocation.currency);
  }
  const savingsBalance = () => {
    const totals = { USD: unassignedSavings.USD, PHP: unassignedSavings.PHP };
    const unknown = new Set(unknownSavings);
    for (const [accountId, currency] of savingsAccounts) {
      const balance = balances.get(accountId);
      if (balance === null || balance === undefined) {
        unknown.add(currency);
        warnings.add(`${accountById.get(accountId)?.name || "Savings account"}: its current savings balance is unavailable.`);
      } else {
        totals[currency] = roundMoney(totals[currency] + balance - (annualReserved.get(accountId) || 0));
      }
    }
    return {
      usd: unknown.has("USD") ? null : totals.USD,
      php: unknown.has("PHP") ? null : totals.PHP,
      accountIds: [...savingsAccounts.keys()],
      unassignedUsd: unassignedSavings.USD,
      unassignedPhp: unassignedSavings.PHP,
    };
  };
  const openingSavings = savingsBalance();
  for (const currency of ["USD", "PHP"])
    openingSavings[currency.toLowerCase()] = linkedBalance("savings", currency, openingSavings[currency.toLowerCase()]);
  if (plan.accountLinks)
    openingSavings.accountIds = [...new Set(["USD", "PHP"]
      .map((currency) => linkedId("savings", currency)).filter(Boolean))];
  const openingSource = live.size ? "live" : opening.size ? "plan" : "bank";
  if (!opening.size && plan.startDate < today)
    warnings.add(
      live.size
        ? "Selected account shares start with current bank balances. Earlier account movements are already reflected and are not replayed."
        : "Account projections start with current bank balances. Set dated account opening balances to review a historical plan.",
    );
  const accountName = (accountId) => {
    const account = accountById.get(id(accountId));
    return account
      ? `${account.name}${account.mask ? ` · •${account.mask}` : ""}${archived(account) ? " (removed)" : ""}`
      : "Unassigned account";
  };
  const checkedId = (accountId, currency, description) => {
    const selected = id(accountId);
    if (!selected) return null;
    const account = accountById.get(selected);
    if (!account || archived(account)) {
      warnings.add(
        `${description}: its selected account is unavailable or removed.`,
      );
      return null;
    }
    if (account.currency !== currency) {
      warnings.add(
        `${description}: account currency differs from ${currency}. Add an explicit conversion instead of moving converted bank funds automatically.`,
      );
      return null;
    }
    return selected;
  };
  const movement = (accountId, amount, currency, kind, label) => {
    const selected = checkedId(accountId, currency, label);
    if (!selected || !amount) return null;
    return {
      accountId: selected,
      amount: roundMoney(amount),
      currency,
      kind,
      label,
      accountName: accountName(selected),
    };
  };
  const transfer = (from, to, amount, currency, label) => {
    const fromId = checkedId(from, currency, label);
    const toId = checkedId(to, currency, label);
    if (!amount || (fromId !== null && fromId === toId)) return [];
    if (!fromId || !toId)
      warnings.add(
        `${label}: choose both a funding and destination account to track the complete transfer.`,
      );
    return [
      movement(fromId, -amount, currency, "transfer", label),
      movement(toId, amount, currency, "transfer", label),
    ].filter(Boolean);
  };
  const defaultSource = (selected, currency, label) => {
    const value = plan.accountLinks ? linkedId("available", currency) : selected ?? salary.accountId;
    if (!value) return null;
    return checkedId(value, currency, label);
  };
  const embeddedTransactions = new Map();
  const visibleTransactionIds = new Set(sourceRows.filter((row) => row.source === "transaction")
    .map((row) => String(row.transactionId ?? row.id)));
  const usedEmbeddedTransactions = new Set();
  for (const row of sourceRows) {
    const transactions = (row.recordedTransactions || []).filter((transaction) => {
      const key = String(transaction.transactionId ?? transaction.id);
      if (visibleTransactionIds.has(key) || usedEmbeddedTransactions.has(key) || transaction.pending ||
          !["income", "expense"].includes(transaction.kind) ||
          !["USD", "PHP"].includes(transaction.currency) || !(Number(transaction.amount) > 0)) return false;
      usedEmbeddedTransactions.add(key);
      return true;
    });
    embeddedTransactions.set(row.id, transactions);
  }
  const cardReserveConsumptions = new Map();
  const rawRows = sourceRows.map((row) => {
    let movements = [];
    const currency = row.currency || (row.php ? "PHP" : "USD");
    if (row.source === "transaction" && embeddedTransactions.get(row.id)?.length) {
      // A grouped pair contains actual bank records rather than another
      // projected transfer between their source and destination.
    } else if (row.source === "reserve") {
      for (const allocation of row.reserveAllocations || []) {
        const bill = document.bills?.find(
          (bill) => bill.id === allocation.billId,
        );
        const destination =
          plan.accountLinks ? linkedId("annualReserve", currency) : allocation.reserveAccountId ?? bill?.reserveAccountId;
        const from = defaultSource(
          allocation.sourceAccountId ?? bill?.sourceAccountId,
          currency,
          `Annual funding · ${bill?.name || row.description}`,
        );
        movements.push(
          ...transfer(
            from,
            destination,
            allocation.amount,
            currency,
            `Annual funding · ${bill?.name || row.description}`,
          ),
        );
      }
    } else if (
      row.source === "allocation" &&
      row.allocationKind === "savings"
    ) {
      movements = transfer(
        defaultSource(row.sourceAccountId, currency, row.description),
        plan.accountLinks ? linkedId("savings", currency) : row.accountId,
        row.amount,
        currency,
        row.description,
      );
    } else if (row.source === "creditCardDue") {
      const result = movement(row.creditAccountId, row.amount, currency, "cardPayment", row.description);
      if (result) movements.push(result);
      let reserveFunding = 0;
      const reserveConsumptions = [];
      for (const coverage of row.annualBillCoverage || []) {
        const selected = plan.accountLinks ? linkedId("annualReserve", currency) : id(coverage.reserveAccountId);
        const account = accountById.get(selected);
        const earmark = Math.max(0, roundMoney(coverage.reserveUsed));
        const alreadyPaid = Math.min(earmark, Math.max(0, roundMoney(coverage.reserveAlreadyPaidAmount)));
        const transferred = Math.min(roundMoney(earmark - alreadyPaid), Math.max(0, roundMoney(coverage.reserveTransferredAmount)));
        const amount = Math.min(roundMoney(earmark - alreadyPaid - transferred), Math.max(0, roundMoney(row.amount - reserveFunding)));
        const covered = roundMoney(amount + alreadyPaid + transferred);
        if (!covered) continue;
        if (!account || archived(account) || liability(account) || account.currency !== currency) {
          warnings.add(`${coverage.billName || "Annual bill"}: its statement reserve account is unavailable; the remaining card payment needs another funding account.`);
          continue;
        }
        reserveConsumptions.push({ accountId: selected, amount: covered });
        const reserve = movement(selected, -amount, currency, "cardReserveFunding", `${coverage.billName || "Annual bill"} · statement reserve`);
        if (reserve) {
          movements.push({ ...reserve, billId: coverage.billId });
          reserveFunding = roundMoney(reserveFunding + amount);
        }
      }
      cardReserveConsumptions.set(row.id, reserveConsumptions);
      const remainingFunding = Math.max(0, roundMoney(row.amount - reserveFunding));
      const funding = movement(linkedId("available", currency), -remainingFunding, currency, "cardFunding", row.description);
      if (funding) movements.push(funding);
      if (remainingFunding > 0 && !funding)
        warnings.add(plan.accountLinks
          ? `${row.description}: choose a linked available-funds account in ${currency} to include this planned payment in that balance.`
          : `${row.description}: the funding account is unknown; available funds include this payment, but no bank account debit is projected.`);
    } else if (row.annualPayment && row.cardCreditActivity) {
      const result = movement(row.accountId, -(row.grossAmount ?? row.amount), currency, "payment", row.description);
      if (result) movements.push(result);
    } else if (row.annualPayment) {
      const reserve = checkedId(
        plan.accountLinks ? linkedId("annualReserve", currency) : row.reserveAccountId,
        currency,
        row.description,
      );
      const payFrom = checkedId(row.accountId ?? linkedId("available", currency), currency, row.description);
      const gross = row.grossAmount ?? row.amount;
      if (reserve && payFrom) {
        movements.push(
          ...transfer(
            reserve,
            payFrom,
            row.reserveUsed || 0,
            currency,
            `Use annual reserve · ${row.description}`,
          ),
        );
        movements.push(
          movement(payFrom, -gross, currency, "payment", row.description),
        );
      } else {
        if (reserve)
          movements.push(
            movement(
              reserve,
              -(row.reserveUsed || 0),
              currency,
              "payment",
              row.description,
            ),
          );
        if (payFrom)
          movements.push(
            movement(
              payFrom,
              -(row.reserveShortfall ?? gross),
              currency,
              "payment",
              row.description,
            ),
          );
        if (gross > 0 && (!payFrom || (!reserve && row.reserveUsed > 0)))
          warnings.add(
            `${row.description}: assign payment and reserve accounts to track its complete cash movement.`,
          );
      }
    } else if (row.kind === "transfer") {
      movements = transfer(
        row.fromAccountId,
        row.toAccountId,
        row.amount,
        currency,
        row.description,
      );
    } else if (row.kind === "conversion") {
      const destinationCurrency = currency === "USD" ? "PHP" : "USD";
      movements = [
        movement(
          row.fromAccountId ?? linkedId("available", currency),
          -row.amount,
          currency,
          "conversion",
          row.description,
        ),
        movement(
          row.toAccountId ?? linkedId("available", destinationCurrency),
          convert(row.amount, currency, destinationCurrency, rate),
          destinationCurrency,
          "conversion",
          row.description,
        ),
      ].filter(Boolean);
      if (!(row.fromAccountId ?? linkedId("available", currency)) || !(row.toAccountId ?? linkedId("available", destinationCurrency)))
        warnings.add(
          `${row.description}: choose conversion source and destination accounts for account projections.`,
        );
    } else {
      const value = row.kind === "income" ? row.amount : -row.amount;
      const result = movement(
        row.accountId ?? (row.source !== "transaction" ? linkedId("available", currency) : null),
        value,
        currency,
        row.source === "transaction" ? "recorded" : "payment",
        row.description,
      );
      if (result) movements.push(result);
      if (!row.accountId && !(row.source !== "transaction" && linkedId("available", currency)) && row.amount > 0)
        warnings.add(`${row.description}: no account assigned.`);
    }
    const grouped = new Map();
    const direct = [];
    for (const move of movements.filter(Boolean)) {
      if (!["transfer", "conversion"].includes(move.kind)) {
        direct.push(move);
        continue;
      }
      const key = `${move.kind}:${move.accountId}:${move.currency}:${Math.sign(move.amount)}`;
      const previous = grouped.get(key);
      if (previous) {
        previous.label = row.description;
        previous.amount = roundMoney(previous.amount + move.amount);
      } else {
        grouped.set(key, move);
        direct.push(move);
      }
    }
    // A reconciled task owns its bank records. Keep their actual movement on
    // that row so dated openings replay it once while live balances skip it.
    for (const transaction of embeddedTransactions.get(row.id) || []) {
      // Scalar forecasts such as salary can retain their bank evidence when
      // recorded rows are hidden. That evidence replaces, rather than adds to,
      // the same predicted native payment.
      const duplicatePayment = direct.findIndex((move) =>
        !["transfer", "conversion", "recorded"].includes(move.kind) &&
        move.accountId === Number(transaction.accountId) && move.currency === transaction.currency &&
        Math.sign(move.amount) === (transaction.kind === "income" ? 1 : -1) &&
        Math.abs(Math.abs(move.amount) - transaction.amount) < 0.005 && distance(transaction.date, row.date) <= 3);
      if (duplicatePayment >= 0) direct.splice(duplicatePayment, 1);
      const recorded = movement(transaction.accountId,
        transaction.kind === "income" ? transaction.amount : -transaction.amount,
        transaction.currency, "recorded", transaction.description || row.description);
      if (recorded) direct.push({ ...recorded, recordedDate: transaction.date,
        transactionId: transaction.transactionId ?? transaction.id });
    }
    return { ...row, accountMovements: direct };
  });
  // Imported bank-transfer legs already move their native accounts. Suppress only
  // corresponding forecast legs, once each, leaving the reserve/allocation earmark.
  const transferActuals = [...rawRows.filter(
    (row) =>
      row.source === "transaction" &&
      (transferCategory(row) || row.creditCardPaymentFor) &&
      !row.annualPayment &&
      (!row.scheduledSource || row.scheduledSource === "creditCardDue"),
  ), ...sourceRows.flatMap((row) => (embeddedTransactions.get(row.id) || [])
    .filter((transaction) => transferCategory(transaction) || transaction.creditCardPaymentFor)
    .map((transaction) => ({ ...transaction, coalescedOwnerId: row.id })))];
  const consumed = new Set();
  let previousAvailable = { ...openingBalances };
  let previousReserve = { usd: openingReserve.usd, php: openingReserve.php };
  const rows = rawRows.map((row) => {
    const currentReserveReceipts = new Set();
    const partialTransfer = row.source === "manual" && row.kind === "transfer" && row.completionSource !== "transaction" &&
      (embeddedTransactions.get(row.id) || []).some((transaction) => !transaction.pending && transaction.date <= today);
    const projected = row.accountMovements
      .filter((move) => {
        if (row.reflectedInRecordedTransactions && row.source === "allocation" && row.allocationKind === "expense" && !move.recordedDate)
          return false;
        // Posted legs remain known when recorded ledger rows are hidden.
        // Current bank balances already include each posted leg; explicitly
        // dated openings still need those movements replayed.
        if (plan.includeTransactions === false && row.source === "manual" &&
            row.kind === "transfer" &&
            (row.completionSource === "transaction" || row.postedTransferAccountIds?.includes(move.accountId)) &&
            !opening.has(move.accountId))
          return false;
        if (
          !["transfer", "conversion"].includes(move.kind) ||
          (row.source === "transaction" && !row.annualPayment)
        )
          return true;
        const match = transferActuals.find(
          (actual) =>
            !consumed.has(actual.id) &&
            (!actual.coalescedOwnerId || actual.coalescedOwnerId === row.id) &&
            Number(actual.accountId) === move.accountId &&
            actual.currency === move.currency &&
            (actual.kind === "income" ? 1 : -1) === Math.sign(move.amount) &&
            Math.abs(actual.amount - Math.abs(move.amount)) < 0.005 &&
            distance(actual.date, row.date) <= 3,
        );
        if (!match) return true;
        consumed.add(match.id);
        if (
          move.amount > 0 &&
          match.date <= today &&
          !opening.has(move.accountId)
        )
          currentReserveReceipts.add(move.accountId);
        return false;
      })
      .filter(
        (move) =>
          opening.has(move.accountId) ||
          (move.recordedDate ? move.recordedDate > today :
            ((row.date >= today || (partialTransfer && move.kind === "transfer")) &&
              !(row.source === "transaction" && row.date <= today))),
      );
    for (const move of projected) {
      const account = accountById.get(move.accountId);
      move.balanceDelta = roundMoney(
        liability(account) ? -move.amount : move.amount,
      );
      const current = balances.get(move.accountId);
      if (current !== null && current !== undefined)
        balances.set(move.accountId, roundMoney(current + move.balanceDelta));
    }
    if (row.source === "reserve") {
      for (const allocation of row.reserveAllocations || []) {
        const selected = id(allocation.reserveAccountId);
        if (
          selected &&
          (opening.has(selected) ||
            (row.date >= today && !currentReserveReceipts.has(selected)))
        )
          annualReserved.set(
            selected,
            roundMoney((annualReserved.get(selected) || 0) + allocation.amount),
          );
      }
    }
    if (row.annualPayment && row.reserveAccountId != null) {
      const selected = Number(row.reserveAccountId);
      if (
        opening.has(selected) ||
        (row.date >= today &&
          !(row.source === "transaction" && row.date <= today))
      )
        annualReserved.set(
          selected,
          Math.max(
            0,
            roundMoney(
              (annualReserved.get(selected) || 0) - (row.reserveUsed || 0),
            ),
          ),
        );
    }
    if (row.source === "creditCardDue") {
      for (const consumption of cardReserveConsumptions.get(row.id) || [])
        if (opening.has(consumption.accountId) || row.date >= today)
          annualReserved.set(consumption.accountId, Math.max(0, roundMoney((annualReserved.get(consumption.accountId) || 0) - consumption.amount)));
    }
    if (
      row.source === "allocation" &&
      row.allocationKind === "savings" &&
      row.accountId != null
    ) {
      const selected = Number(row.accountId);
      if (opening.has(selected) || row.date >= today)
        savingsAllocated.set(
          selected,
          roundMoney((savingsAllocated.get(selected) || 0) + row.amount),
        );
    }
    if (row.source === "allocation" && row.allocationKind === "savings" &&
        !id(row.accountId) && ["USD", "PHP"].includes(row.currency)) {
      unassignedSavings[row.currency] = roundMoney(unassignedSavings[row.currency] + row.amount);
    }
    const savings = savingsBalance();
    const linkedColumns = {};
    for (const currency of ["USD", "PHP"]) {
      const unit = currency.toLowerCase();
      const suffix = currency === "USD" ? "Usd" : "Php";
      const available = linkedBalance("available", currency, row[`balance${suffix}`]);
      const reserve = linkedBalance("annualReserve", currency, row[`reserve${suffix}`]);
      if (plan.accountLinks) {
        linkedColumns[`balance${suffix}`] = available;
        linkedColumns[`balanceApplied${suffix}`] = available == null || previousAvailable[unit] == null
          ? null : roundMoney(available - previousAvailable[unit]);
        const change = reserve == null || previousReserve[unit] == null
          ? null : roundMoney(reserve - previousReserve[unit]);
        linkedColumns[`earmarkedReserve${suffix}`] = row[`reserve${suffix}`];
        linkedColumns[`reserve${suffix}`] = reserve;
        linkedColumns[`reserveDelta${suffix}`] = change;
        linkedColumns[`reserveApplied${suffix}`] = change;
      }
      savings[unit] = linkedBalance("savings", currency, savings[unit]);
      previousAvailable[unit] = available;
      previousReserve[unit] = reserve;
    }
    return {
      ...row,
      ...linkedColumns,
      ...(plan.accountLinks && row.recordedTransactions?.length && !projected.length
        ? { reflectedInStartingBalance: true } : {}),
      ...(row.source === "creditCardDue" && linkedId("available", row.currency)
        ? { fundingAccountId: linkedId("available", row.currency) } : {}),
      savingsUsd: savings.usd,
      savingsPhp: savings.php,
      accountMovements: projected,
      accountNames: [
        ...new Set([
          ...row.accountMovements.map((move) => move.accountName),
          ...[
            row.accountId,
            row.reserveAccountId,
            row.fromAccountId,
            row.toAccountId,
            row.creditAccountId,
            ...(row.reserveAllocations || []).flatMap((allocation) => [
              allocation.reserveAccountId,
              allocation.sourceAccountId,
            ]),
          ]
            .filter((selected) => id(selected) && accountById.has(id(selected)))
            .map(accountName),
        ]),
      ],
      accountBalances: Object.fromEntries(balances),
      accountAnnualReserves: Object.fromEntries(annualReserved),
    };
  });
  return {
    openingSource,
    openingBalances,
    openingReserve,
    openingSavings,
    warnings: [...warnings],
    rows,
    accounts: associations.map((account) => {
      const source = accountById.get(account.accountId);
      const openingBalance = linkedIds.has(account.accountId)
        ? opening.has(account.accountId) ? opening.get(account.accountId) : accountBalance(source)
        : live.has(account.accountId) ? live.get(account.accountId)
          : opening.has(account.accountId) ? opening.get(account.accountId) : accountBalance(source);
      const endingBalance = balances.get(account.accountId);
      const endingAnnualReserved = annualReserved.get(account.accountId) || 0;
      return {
        ...account,
        openingBalance,
        endingBalance,
        endingAnnualReserved,
        savingsAllocated: savingsAllocated.get(account.accountId) || 0,
        openingSource: linkedIds.has(account.accountId) ? opening.has(account.accountId) ? "plan" : "live"
          : live.has(account.accountId) ? "live" : opening.has(account.accountId) ? "plan" : "bank",
        availableAfterAnnualReserve:
          endingBalance === null || liability(source)
            ? null
            : roundMoney(endingBalance - endingAnnualReserved),
      };
    }),
  };
}
