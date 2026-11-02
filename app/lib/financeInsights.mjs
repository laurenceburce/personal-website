import {
  billOccurrences,
  convert,
  getSummary,
  localDate,
  roundMoney,
} from "./financePlanner.mjs";

const CURRENCIES = new Set(["USD", "PHP"]);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TRANSFER_CATEGORIES = new Set([
  "transfer in",
  "transfer out",
  "loan payments",
]);
const value = (number) =>
  Number.isFinite(Number(number)) ? Number(number) : 0;

function validDate(date) {
  return (
    typeof date === "string" &&
    DATE_PATTERN.test(date) &&
    Number.isFinite(Date.parse(`${date}T00:00:00Z`)) &&
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
  );
}

function safeMonth(month, today) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ""))
    ? month
    : today.slice(0, 7);
}

function monthAt(month, offset) {
  const [year, index] = month.split("-").map(Number);
  return new Date(Date.UTC(year, index - 1 + offset, 1))
    .toISOString()
    .slice(0, 7);
}

function monthEnd(month) {
  const [year, index] = month.split("-").map(Number);
  return new Date(Date.UTC(year, index, 0)).toISOString().slice(0, 10);
}

/** Actual activity and planned commitments deliberately remain separate. */
export function getFinanceInsights({
  document = {},
  activity = {},
  rate = 1,
  month,
  currency = "USD",
  today = localDate(),
} = {}) {
  const displayCurrency = CURRENCIES.has(currency) ? currency : "USD";
  const selectedMonth = safeMonth(month, today);
  const monthStart = `${selectedMonth}-01`;
  const end = monthEnd(selectedMonth);
  const historyStart = `${monthAt(selectedMonth, -5)}-01`;
  const supportedTransactions = (activity.transactions || []).filter(
    (transaction) =>
      validDate(transaction.date) &&
      CURRENCIES.has(transaction.currency) &&
      ["income", "expense"].includes(transaction.kind) &&
      Number.isFinite(Number(transaction.amount)) &&
      Number(transaction.amount) >= 0,
  );
  const actualTransactions = supportedTransactions.filter(
    (transaction) =>
      !transaction.pending &&
      transaction.date <= today &&
      transaction.date >= historyStart &&
      transaction.date <= end &&
      !TRANSFER_CATEGORIES.has(
        String(transaction.category || "")
          .trim()
          .toLowerCase()
          .replace(/\s+/g, " "),
      ),
  );
  const selectedTransactions = actualTransactions.filter(
    (transaction) => transaction.date >= monthStart,
  );
  const series = Array.from({ length: 6 }, (_, index) => ({
    month: monthAt(selectedMonth, index - 5),
    income: 0,
    expenses: 0,
    net: 0,
    count: 0,
  }));
  const byMonth = new Map(series.map((row) => [row.month, row]));
  for (const transaction of actualTransactions) {
    const period = byMonth.get(transaction.date.slice(0, 7));
    if (!period) continue;
    const converted = convert(
      transaction.amount,
      transaction.currency,
      displayCurrency,
      rate,
    );
    if (transaction.kind === "income")
      period.income = roundMoney(period.income + converted);
    else period.expenses = roundMoney(period.expenses + converted);
    period.count += 1;
  }
  for (const period of series)
    period.net = roundMoney(period.income - period.expenses);
  const selected = series.at(-1);

  const accounts = activity.accounts || [];
  const knownAccounts = accounts.filter(
    (account) =>
      CURRENCIES.has(account.currency) &&
      account.nativeCurrentBalance !== null &&
      account.nativeCurrentBalance !== undefined &&
      Number.isFinite(Number(account.nativeCurrentBalance)),
  );
  let assets = 0;
  let liabilities = 0;
  for (const account of knownAccounts) {
    const balance = convert(
      account.nativeCurrentBalance,
      account.currency,
      displayCurrency,
      rate,
    );
    // Providers use a positive liability balance for money owed and a negative balance for overpayment.
    if (["credit", "loan"].includes(account.type)) liabilities += balance;
    else assets += balance;
  }
  assets = roundMoney(assets);
  liabilities = roundMoney(liabilities);

  const plan = getSummary(document, rate);
  const plannedIncome =
    displayCurrency === "PHP" ? plan.monthlyPhp : plan.monthlyUsd;
  const usdBills = convert(plan.billsUsd, "USD", displayCurrency, rate);
  const phpBills = convert(plan.billsPhp, "PHP", displayCurrency, rate);
  const annualReserve =
    displayCurrency === "PHP" ? plan.annualMonthlyPhp : plan.annualMonthlyUsd;
  const allocations = roundMoney(
    (document.allocations || []).reduce(
      (sum, allocation) =>
        sum +
        (convert(
          allocation.amount,
          allocation.currency,
          displayCurrency,
          rate,
        ) *
          plan.payPeriods) /
          12,
      0,
    ),
  );
  const plannedCommitted = roundMoney(
    usdBills + phpBills + annualReserve + allocations,
  );
  const plannedRemaining = roundMoney(plannedIncome - plannedCommitted);
  const allocationSegments = [
    {
      id: "usd-bills",
      label: "Bills in USD",
      value: usdBills,
      color: "#267e5c",
    },
    {
      id: "php-bills",
      label: "Bills in PHP",
      value: phpBills,
      color: "#b66a32",
    },
    {
      id: "annual",
      label: "Annual reserve",
      value: annualReserve,
      color: "#4d8197",
    },
    {
      id: "allocations",
      label: "Savings & extras",
      value: allocations,
      color: "#8572a4",
    },
    {
      id: "remaining",
      label: "Unallocated",
      value: Math.max(0, plannedRemaining),
      color: "#c6ddcf",
    },
  ];
  const allocationTotal = roundMoney(
    allocationSegments.reduce((sum, segment) => sum + segment.value, 0),
  );
  const scheduledBills = (document.bills || [])
    .flatMap((bill) =>
      billOccurrences(bill, monthStart, end).map((occurrence) => ({
        ...occurrence,
        name: bill.name,
        cadence: bill.cadence,
        paymentMethod: bill.paymentMethod,
        isAutopay: bill.isAutopay,
      })),
    )
    .sort(
      (first, second) =>
        first.date.localeCompare(second.date) ||
        first.name.localeCompare(second.name),
    );
  const recentTransactions = supportedTransactions
    .filter(
      (transaction) =>
        transaction.date >= monthStart && transaction.date <= end,
    )
    .sort(
      (first, second) =>
        second.date.localeCompare(first.date) ||
        String(second.createdAt || "").localeCompare(
          String(first.createdAt || ""),
        ) ||
        value(second.id) - value(first.id),
    )
    .slice(0, 5)
    .map((transaction) => ({
      ...transaction,
      displayAmount: convert(
        transaction.amount,
        transaction.currency,
        displayCurrency,
        rate,
      ),
      scheduled: transaction.date > today,
    }));
  return {
    currency: displayCurrency,
    month: selectedMonth,
    monthStart,
    monthEnd: end,
    historyStart,
    asOf: today < end ? today : end,
    income: selected.income,
    expenses: selected.expenses,
    net: selected.net,
    transactionCount: selected.count,
    pendingCount: supportedTransactions.filter(
      (transaction) =>
        transaction.pending &&
        transaction.date >= monthStart &&
        transaction.date <= end,
    ).length,
    scheduledCount: supportedTransactions.filter(
      (transaction) =>
        transaction.date > today &&
        transaction.date >= monthStart &&
        transaction.date <= end,
    ).length,
    transferCount: supportedTransactions.filter(
      (transaction) =>
        transaction.date >= monthStart &&
        transaction.date <= end &&
        TRANSFER_CATEGORIES.has(
          String(transaction.category || "")
            .trim()
            .toLowerCase()
            .replace(/\s+/g, " "),
        ),
    ).length,
    series,
    hasHistory: series.some((period) => period.count > 0),
    netWorth: knownAccounts.length ? roundMoney(assets - liabilities) : null,
    assets,
    liabilities,
    accountCount: accounts.length,
    knownAccountCount: knownAccounts.length,
    unavailableAccountCount: accounts.length - knownAccounts.length,
    plannedIncome,
    plannedCommitted,
    plannedRemaining,
    overBudget: Math.max(0, -plannedRemaining),
    allocationSegments,
    allocationTotal,
    scheduledBills,
    undatedBillCount: (document.bills || []).filter((bill) => !bill.dueDay)
      .length,
    recentTransactions,
    partial: Boolean(activity.limitHit),
    excludedUnsupportedCount: (activity.transactions || []).filter(
      (transaction) => !CURRENCIES.has(transaction.currency),
    ).length,
  };
}
