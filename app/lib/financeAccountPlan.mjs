import {
  buildPlanRows,
  convert,
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
  Boolean(account?.isArchived || account?.is_archived);
const finiteBalance = (value) =>
  value !== null && value !== undefined && Number.isFinite(Number(value))
    ? roundMoney(value)
    : null;
const accountBalance = (account) =>
  finiteBalance(account.nativeCurrentBalance ?? account.currentBalance);
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
  const opening = new Map(
    (plan.accountOpeningBalances || []).map((balance) => [
      id(balance.accountId),
      roundMoney(balance.balance),
    ]),
  );
  const warnings = new Set();
  const balances = new Map();
  const annualReserved = new Map();
  const savingsAllocated = new Map();
  for (const account of accounts) {
    const accountId = Number(account.id);
    const current = accountBalance(account);
    balances.set(
      accountId,
      opening.has(accountId) ? opening.get(accountId) : current,
    );
    annualReserved.set(
      accountId,
      associationById.get(accountId)?.annualReserved || 0,
    );
    savingsAllocated.set(accountId, 0);
  }
  const salary = document.salary || {};
  const openingSource = opening.size ? "plan" : "bank";
  if (!opening.size && plan.startDate < today)
    warnings.add(
      "Account projections start with current bank balances. Set dated account opening balances to review a historical plan.",
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
    const value = selected ?? salary.accountId;
    if (!value) return null;
    return checkedId(value, currency, label);
  };
  const rawRows = sourceRows.map((row) => {
    let movements = [];
    const currency = row.currency || (row.php ? "PHP" : "USD");
    if (row.source === "reserve") {
      for (const allocation of row.reserveAllocations || []) {
        const bill = document.bills?.find(
          (bill) => bill.id === allocation.billId,
        );
        const destination =
          allocation.reserveAccountId ?? bill?.reserveAccountId;
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
        row.accountId,
        row.amount,
        currency,
        row.description,
      );
    } else if (row.annualPayment) {
      const reserve = checkedId(
        row.reserveAccountId,
        currency,
        row.description,
      );
      const payFrom = checkedId(row.accountId, currency, row.description);
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
          row.fromAccountId,
          -row.amount,
          currency,
          "conversion",
          row.description,
        ),
        movement(
          row.toAccountId,
          convert(row.amount, currency, destinationCurrency, rate),
          destinationCurrency,
          "conversion",
          row.description,
        ),
      ].filter(Boolean);
      if (!row.fromAccountId || !row.toAccountId)
        warnings.add(
          `${row.description}: choose conversion source and destination accounts for account projections.`,
        );
    } else {
      const value = row.kind === "income" ? row.amount : -row.amount;
      const result = movement(
        row.accountId,
        value,
        currency,
        row.source === "transaction" ? "recorded" : "payment",
        row.description,
      );
      if (result) movements.push(result);
      if (!row.accountId && row.amount > 0)
        warnings.add(`${row.description}: no account assigned.`);
    }
    return { ...row, accountMovements: movements.filter(Boolean) };
  });
  // Imported bank-transfer legs already move their native accounts. Suppress only
  // corresponding forecast legs, once each, leaving the reserve/allocation earmark.
  const transferActuals = rawRows.filter(
    (row) =>
      row.source === "transaction" &&
      transferCategory(row) &&
      !row.annualPayment &&
      !row.scheduledSource,
  );
  const consumed = new Set();
  const rows = rawRows.map((row) => {
    const currentReserveReceipts = new Set();
    const projected = row.accountMovements
      .filter((move) => {
        if (
          !["transfer", "conversion"].includes(move.kind) ||
          (row.source === "transaction" && !row.annualPayment)
        )
          return true;
        const match = transferActuals.find(
          (actual) =>
            !consumed.has(actual.id) &&
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
          (row.date >= today &&
            !(row.source === "transaction" && row.date <= today)),
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
    return {
      ...row,
      accountMovements: projected,
      accountNames: [
        ...new Set([
          ...row.accountMovements.map((move) => move.accountName),
          ...[
            row.accountId,
            row.reserveAccountId,
            row.fromAccountId,
            row.toAccountId,
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
    warnings: [...warnings],
    rows,
    accounts: associations.map((account) => {
      const source = accountById.get(account.accountId);
      const openingBalance = opening.has(account.accountId)
        ? opening.get(account.accountId)
        : accountBalance(source);
      const endingBalance = balances.get(account.accountId);
      const endingAnnualReserved = annualReserved.get(account.accountId) || 0;
      return {
        ...account,
        openingBalance,
        endingBalance,
        endingAnnualReserved,
        savingsAllocated: savingsAllocated.get(account.accountId) || 0,
        openingSource: opening.has(account.accountId) ? "plan" : "bank",
        availableAfterAnnualReserve:
          endingBalance === null || liability(source)
            ? null
            : roundMoney(endingBalance - endingAnnualReserved),
      };
    }),
  };
}
