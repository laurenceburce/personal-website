// Pure calculations shared by the personal finance views and their tests.
const DAY_MS = 86_400_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function roundMoney(value) {
  const amount = number(value);
  return Math.round((amount + Math.sign(amount) * Number.EPSILON) * 100) / 100;
}

function dateTime(value) {
  if (!DATE_PATTERN.test(String(value || ""))) return Number.NaN;
  const [year, month, day] = value.split("-").map(Number);
  const time = Date.UTC(year, month - 1, day);
  return new Date(time).toISOString().slice(0, 10) === value
    ? time
    : Number.NaN;
}

function isoDate(time) {
  return new Date(time).toISOString().slice(0, 10);
}

function lastDay(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function monthDate(year, month, day) {
  return isoDate(Date.UTC(year, month, Math.min(day, lastDay(year, month))));
}

function validRange(start, end) {
  return (
    Number.isFinite(dateTime(start)) &&
    Number.isFinite(dateTime(end)) &&
    start <= end
  );
}

function eachMonth(start, end, visit) {
  if (!validRange(start, end)) return;
  const first = new Date(dateTime(start));
  const last = new Date(dateTime(end));
  for (
    let index = first.getUTCFullYear() * 12 + first.getUTCMonth();
    index <= last.getUTCFullYear() * 12 + last.getUTCMonth();
    index += 1
  ) {
    visit(Math.floor(index / 12), index % 12);
  }
}

export function localDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function addDays(value, days) {
  const time = dateTime(value);
  return Number.isFinite(time)
    ? isoDate(time + Math.trunc(number(days)) * DAY_MS)
    : "";
}

export function formatDate(value, options = {}) {
  const time = dateTime(value);
  if (!Number.isFinite(time)) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...options,
    timeZone: "UTC",
  }).format(new Date(time));
}

export function money(value, currency = "USD") {
  return new Intl.NumberFormat(currency === "PHP" ? "en-PH" : "en-US", {
    style: "currency",
    currency: currency === "PHP" ? "PHP" : "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(number(value));
}

export function convert(value, from, to, rate) {
  const safeRate =
    Number.isFinite(Number(rate)) && Number(rate) > 0 ? Number(rate) : 1;
  if (from === to) return roundMoney(value);
  return roundMoney(
    from === "PHP" ? number(value) / safeRate : number(value) * safeRate,
  );
}

export function billDueDays(bill) {
  if (bill.cadence === "payday") return [];
  const source =
    bill.cadence === "monthly" && Array.isArray(bill.dueDays)
      ? bill.dueDays
      : [bill.dueDay];
  return [
    ...new Set(
      source
        .map(Number)
        .filter((day) => Number.isInteger(day) && day >= 1 && day <= 31),
    ),
  ].sort((a, b) => a - b);
}

function installmentAmount(total, count, index) {
  const totalCents = Math.round(number(total) * 100);
  const installmentCents = Math.floor(totalCents / count);
  return (
    (installmentCents + (index === count - 1 ? totalCents % count : 0)) / 100
  );
}

export function billOccurrences(bill, start, end, salary) {
  if (!validRange(start, end)) return [];
  if (bill.cadence === "payday") {
    if (!salary || !["biweekly", "semimonthly"].includes(salary.payFrequency))
      return [];
    return salaryOccurrences(salary, start, end).map(({ date }) => ({
      date,
      amount: roundMoney(bill.amount),
      currency: bill.currency,
      billId: bill.id,
    }));
  }
  const days = billDueDays(bill);
  if (!days.length) return [];
  const months = [
    ...new Set(
      (bill.dueMonths || [])
        .map(Number)
        .filter(
          (month) => Number.isInteger(month) && month >= 1 && month <= 12,
        ),
    ),
  ].sort((a, b) => a - b);
  if (bill.cadence === "annual" && !months.length) return [];
  const occurrences = [];
  eachMonth(start, end, (year, month) => {
    if (bill.cadence === "annual" && !months.includes(month + 1)) return;
    const monthly = new Map();
    for (const [index, day] of days.entries()) {
      const date = monthDate(year, month, day);
      const amount =
        bill.cadence === "annual"
          ? installmentAmount(
              bill.amount,
              months.length,
              months.indexOf(month + 1),
            )
          : installmentAmount(bill.amount, days.length, index);
      // Two selected dates can both become February's last day; combine them.
      monthly.set(date, roundMoney((monthly.get(date) || 0) + amount));
    }
    for (const [date, amount] of monthly) {
      if (date >= start && date <= end)
        occurrences.push({
          date,
          amount,
          currency: bill.currency,
          billId: bill.id,
        });
    }
  });
  return occurrences;
}

/** A suggested reserve target within the current renewal cycle, not a bank balance. */
export function annualSavingsTarget(bill, asOf = localDate()) {
  const missing = {
    target: null,
    currency: bill.currency,
    cycleStart: null,
    nextDueDate: null,
    installmentAmount: null,
    progress: 0,
    needsDate: true,
  };
  if (bill.cadence !== "annual" || !Number.isFinite(dateTime(asOf)))
    return missing;
  const year = Number(asOf.slice(0, 4));
  const payments = billOccurrences(
    bill,
    `${year - 1}-01-01`,
    `${year + 1}-12-31`,
  );
  const previous = payments.filter((payment) => payment.date < asOf).at(-1);
  const next = payments.find((payment) => payment.date >= asOf);
  if (!previous || !next) return missing;
  const cycleDays = (dateTime(next.date) - dateTime(previous.date)) / DAY_MS;
  const elapsedDays = (dateTime(asOf) - dateTime(previous.date)) / DAY_MS;
  const progress =
    cycleDays > 0 ? Math.max(0, Math.min(1, elapsedDays / cycleDays)) : 0;
  return {
    target: Math.min(next.amount, roundMoney(next.amount * progress)),
    currency: bill.currency,
    cycleStart: previous.date,
    nextDueDate: next.date,
    installmentAmount: next.amount,
    progress,
    needsDate: false,
  };
}

/** Current reserve and the contribution needed before the next annual payment. */
export function getAnnualBillFunding(bill, payPeriods = 26, options = {}) {
  const amount =
    bill?.cadence === "annual" ? Math.max(0, roundMoney(bill.amount)) : 0;
  const savedAmount =
    bill?.cadence === "annual" ? Math.max(0, roundMoney(bill.savedAmount)) : 0;
  const remainingAmount = Math.max(0, roundMoney(amount - savedAmount));
  const periods = number(payPeriods) > 0 ? number(payPeriods) : 26;
  const asOf = Number.isFinite(dateTime(options.asOf))
    ? options.asOf
    : localDate();
  const salary = options.salary;
  const needsSchedule =
    !salary ||
    !["biweekly", "semimonthly"].includes(salary.payFrequency) ||
    !Number.isFinite(dateTime(salary.firstPayDate));
  const afterDate = Number.isFinite(dateTime(options.afterDate))
    ? options.afterDate
    : "";
  const payments =
    bill?.cadence === "annual"
      ? billOccurrences(bill, asOf, addDays(asOf, 740))
      : [];
  const next =
    Number.isFinite(dateTime(options.nextPayment?.date)) &&
    options.nextPayment.date >= asOf
      ? options.nextPayment
      : payments.find((payment) => payment.date > afterDate);
  const needsDate = !next;
  const remainingForNextPayment = next
    ? Math.max(0, roundMoney(next.amount - savedAmount))
    : remainingAmount;
  const estimated = needsDate || needsSchedule;
  const paydayDates =
    next && !needsSchedule
      ? Array.isArray(options.paydayDates)
        ? options.paydayDates
        : salaryOccurrences(salary, asOf, next.date).map(
            (payday) => payday.date,
          )
      : [];
  const paydaysRemaining = new Set(
    paydayDates.filter(
      (date) =>
        Number.isFinite(dateTime(date)) && date >= asOf && date <= next.date,
    ),
  ).size;
  const perPeriodAmount = estimated
    ? roundMoney(remainingAmount / periods)
    : paydaysRemaining > 0
      ? Math.ceil(
          Math.round(remainingForNextPayment * 100) / paydaysRemaining,
        ) / 100
      : 0;
  return {
    amount,
    savedAmount,
    remainingAmount,
    monthlyAmount: estimated
      ? roundMoney(remainingAmount / 12)
      : roundMoney((perPeriodAmount * periods) / 12),
    perPeriodAmount,
    fullyFunded: remainingAmount === 0,
    nextDueDate: next?.date || null,
    installmentAmount: next ? roundMoney(next.amount) : null,
    remainingForNextPayment,
    paydaysRemaining,
    needsDate,
    needsSchedule,
    immediateAmount:
      !estimated && paydaysRemaining === 0 ? remainingForNextPayment : 0,
    estimated,
  };
}

export function salaryOccurrences(salary, start, end) {
  if (
    !validRange(start, end) ||
    !Number.isFinite(dateTime(salary.firstPayDate))
  )
    return [];
  const anchor = salary.firstPayDate;
  if (anchor > end) return [];
  const payPeriods = salary.payFrequency === "biweekly" ? 26 : 24;
  const amount = roundMoney((number(salary.amount) * 12) / payPeriods);
  const result = [];
  if (salary.payFrequency === "biweekly") {
    const anchorTime = dateTime(anchor);
    const offset = Math.max(
      0,
      Math.ceil((dateTime(start) - anchorTime) / (14 * DAY_MS)),
    );
    for (
      let time = anchorTime + offset * 14 * DAY_MS;
      time <= dateTime(end);
      time += 14 * DAY_MS
    ) {
      result.push({ date: isoDate(time), amount, currency: salary.currency });
    }
  } else {
    const day = Number(anchor.slice(8));
    const days = day <= 15 ? [day, day + 15] : [day - 15, day];
    eachMonth(start, end, (year, month) => {
      for (const dueDay of days) {
        const date = monthDate(year, month, dueDay);
        if (date >= start && date <= end && date >= anchor)
          result.push({ date, amount, currency: salary.currency });
      }
    });
  }
  return result;
}

export function getSummary(document, rate, asOf = localDate()) {
  const salary = document.salary || {};
  const bills = document.bills || [];
  const allocations = document.allocations || [];
  const monthlyUsd = convert(salary.amount, salary.currency, "USD", rate);
  const monthlyPhp = convert(salary.amount, salary.currency, "PHP", rate);
  const payPeriods = salary.payFrequency === "biweekly" ? 26 : 24;
  const monthlyBills = bills.filter(
    (bill) => bill.cadence !== "annual" && bill.cadence !== "payday",
  );
  const paydayBills = bills.filter((bill) => bill.cadence === "payday");
  const annualBills = bills.filter((bill) => bill.cadence === "annual");
  const annualFunding = annualBills.map((bill) => ({
    billId: bill.id,
    name: bill.name,
    currency: bill.currency,
    ...getAnnualBillFunding(bill, payPeriods, { salary, asOf }),
  }));
  const monthlyBillsUsd = roundMoney(
    monthlyBills
      .filter((bill) => bill.currency !== "PHP")
      .reduce((total, bill) => total + number(bill.amount), 0),
  );
  const monthlyBillsPhp = roundMoney(
    monthlyBills
      .filter((bill) => bill.currency === "PHP")
      .reduce((total, bill) => total + number(bill.amount), 0),
  );
  const paydayBillsUsd = roundMoney(
    paydayBills
      .filter((bill) => bill.currency !== "PHP")
      .reduce((total, bill) => total + number(bill.amount), 0),
  );
  const paydayBillsPhp = roundMoney(
    paydayBills
      .filter((bill) => bill.currency === "PHP")
      .reduce((total, bill) => total + number(bill.amount), 0),
  );
  const paydayMonthlyUsd = roundMoney((paydayBillsUsd * payPeriods) / 12);
  const paydayMonthlyPhp = roundMoney((paydayBillsPhp * payPeriods) / 12);
  // Recurring bill totals are monthly equivalents for charts and commitments.
  const billsUsd = roundMoney(monthlyBillsUsd + paydayMonthlyUsd);
  const billsPhp = roundMoney(monthlyBillsPhp + paydayMonthlyPhp);
  function annualTotal(field, currency) {
    const native = annualFunding.reduce(
      (totals, bill) => {
        totals[bill.currency === "PHP" ? "PHP" : "USD"] += bill[field];
        return totals;
      },
      { USD: 0, PHP: 0 },
    );
    // Convert the opposite native total once to retain cents in each currency.
    return currency === "PHP"
      ? roundMoney(native.PHP + convert(native.USD, "USD", "PHP", rate))
      : roundMoney(native.USD + convert(native.PHP, "PHP", "USD", rate));
  }
  const annualUsd = annualTotal("amount", "USD");
  const annualPhp = annualTotal("amount", "PHP");
  const annualSavedUsd = annualTotal("savedAmount", "USD");
  const annualSavedPhp = annualTotal("savedAmount", "PHP");
  const annualRemainingUsd = annualTotal("remainingAmount", "USD");
  const annualRemainingPhp = annualTotal("remainingAmount", "PHP");
  const annualMonthlyUsd = annualTotal("monthlyAmount", "USD");
  const annualMonthlyPhp = annualTotal("monthlyAmount", "PHP");
  const annualPerPeriodUsd = annualTotal("perPeriodAmount", "USD");
  const annualPerPeriodPhp = annualTotal("perPeriodAmount", "PHP");
  const annualImmediateUsd = annualTotal("immediateAmount", "USD");
  const annualImmediatePhp = annualTotal("immediateAmount", "PHP");
  const monthlyCommitmentsUsd = roundMoney(
    billsUsd + convert(billsPhp, "PHP", "USD", rate) + annualMonthlyUsd,
  );
  const monthlyCommitmentsPhp = roundMoney(
    billsPhp + convert(billsUsd, "USD", "PHP", rate) + annualMonthlyPhp,
  );
  const incomePerPeriodUsd = roundMoney((monthlyUsd * 12) / payPeriods);
  // Add native per-payday amounts directly instead of round-tripping monthly averages.
  const billsUsdPerPeriod = roundMoney(
    (monthlyBillsUsd * 12) / payPeriods + paydayBillsUsd,
  );
  const billsPhpPerPeriod = roundMoney(
    (monthlyBillsPhp * 12) / payPeriods + paydayBillsPhp,
  );
  const billsPhpPerPeriodUsd = convert(billsPhpPerPeriod, "PHP", "USD", rate);
  const remainingPerPeriodUsd = roundMoney(
    incomePerPeriodUsd -
      billsUsdPerPeriod -
      billsPhpPerPeriodUsd -
      annualPerPeriodUsd,
  );
  const allocationsPerPeriodUsd = roundMoney(
    allocations.reduce(
      (total, allocation) =>
        total + convert(allocation.amount, allocation.currency, "USD", rate),
      0,
    ),
  );
  return {
    monthlyUsd,
    monthlyPhp,
    billsUsd,
    billsPhp,
    monthlyBillsUsd,
    monthlyBillsPhp,
    paydayBillsUsd,
    paydayBillsPhp,
    paydayMonthlyUsd,
    paydayMonthlyPhp,
    annualUsd,
    annualPhp,
    annualSavedUsd,
    annualSavedPhp,
    annualRemainingUsd,
    annualRemainingPhp,
    annualFunding,
    annualImmediateUsd,
    annualImmediatePhp,
    annualEstimatedCount: annualFunding.filter((funding) => funding.estimated)
      .length,
    annualMonthlyUsd,
    annualMonthlyPhp,
    monthlyCommitmentsUsd,
    monthlyRemainingUsd: roundMoney(monthlyUsd - monthlyCommitmentsUsd),
    monthlyCommitmentsPhp,
    monthlyRemainingPhp: roundMoney(monthlyPhp - monthlyCommitmentsPhp),
    payPeriods,
    incomePerPeriodUsd,
    billsUsdPerPeriod,
    billsPhpPerPeriod,
    billsPhpPerPeriodUsd,
    annualPerPeriodUsd,
    annualPerPeriodPhp,
    remainingPerPeriodUsd,
    allocationsPerPeriodUsd,
    unallocatedPerPeriodUsd: roundMoney(
      remainingPerPeriodUsd - allocationsPerPeriodUsd,
    ),
  };
}

function nativeFlow(amount, currency, kind) {
  const signed = (kind === "income" ? 1 : -1) * roundMoney(amount);
  return {
    amount: roundMoney(amount),
    currency,
    usd: currency === "PHP" ? 0 : signed,
    php: currency === "PHP" ? signed : 0,
  };
}

function normalizedDescription(value) {
  return (
    String(value || "")
      .toLowerCase()
      .match(/[a-z0-9]+/g) || []
  ).join(" ");
}

function forecastMatchesTransaction(forecast, transaction) {
  if (
    ["conversion", "transfer"].includes(forecast.kind) ||
    forecast.kind !== transaction.kind ||
    forecast.currency !== transaction.currency
  )
    return false;
  if (
    forecast.accountId != null &&
    Number(forecast.accountId) !== Number(transaction.accountId)
  )
    return false;
  if (Math.abs(forecast.amount - transaction.amount) > 0.0100001) return false;
  const distance =
    Math.abs(dateTime(forecast.date) - dateTime(transaction.date)) / DAY_MS;
  if (distance > 3) return false;
  const actualDescription = normalizedDescription(
    [transaction.merchant, transaction.category, transaction.note]
      .filter(Boolean)
      .join(" "),
  );
  if (forecast.source === "salary")
    return /\b(salary|payroll|paycheck|wages|direct deposit)\b/.test(
      actualDescription,
    );
  if (forecast.source === "manual")
    return (
      distance === 0 &&
      normalizedDescription(forecast.description) ===
        normalizedDescription(transaction.merchant)
    );
  if (forecast.source === "bill") {
    const billName = normalizedDescription(forecast.description);
    if (!billName) return false;
    if (` ${actualDescription} `.includes(` ${billName} `)) return true;
    const ignored = new Set([
      "bill",
      "annual",
      "monthly",
      "subscription",
      "domain",
      "webapp",
    ]);
    const tokens = billName
      .split(" ")
      .filter((token) => token.length >= 3 && !ignored.has(token));
    const actualTokens = new Set(actualDescription.split(" "));
    return (
      tokens.length > 0 && tokens.every((token) => actualTokens.has(token))
    );
  }
  return false;
}

function paydayIndex(salary, date) {
  if (salary.payFrequency === "biweekly")
    return Math.round(
      (dateTime(date) - dateTime(salary.firstPayDate)) / (14 * DAY_MS),
    );
  const anchor = salary.firstPayDate;
  const day = Number(anchor.slice(8));
  const firstDay = day <= 15 ? day : day - 15;
  const [year, month] = date.split("-").map(Number);
  const [anchorYear, anchorMonth] = anchor.split("-").map(Number);
  const firstDate = monthDate(year, month - 1, firstDay);
  return (
    ((year - anchorYear) * 12 + month - anchorMonth) * 2 +
    (date === firstDate ? 0 : 1) -
    (day <= 15 ? 0 : 1)
  );
}

function reserveContribution(annualAmount, periods, index) {
  const cents = Math.round(number(annualAmount) * 100);
  const base = Math.floor(cents / periods);
  const remainder = cents % periods;
  const position = ((index % periods) + periods) % periods;
  // Spread pennies over complete pay cycles instead of accumulating rounding drift.
  return (base + (position < remainder ? 1 : 0)) / 100;
}

/** Item savings are part of, rather than additional to, an existing opening reserve. */
export function getAnnualReserveOpening(plan, document) {
  const savings = { USD: 0, PHP: 0 };
  for (const bill of document?.bills || []) {
    if (bill.cadence !== "annual" || !["USD", "PHP"].includes(bill.currency))
      continue;
    savings[bill.currency] = roundMoney(
      savings[bill.currency] + getAnnualBillFunding(bill).savedAmount,
    );
  }
  const openingUsd = Math.max(0, roundMoney(plan?.openingReserveUsd));
  const openingPhp = Math.max(0, roundMoney(plan?.openingReservePhp));
  return {
    usd: Math.max(openingUsd, savings.USD),
    php: Math.max(openingPhp, savings.PHP),
    billSavingsUsd: savings.USD,
    billSavingsPhp: savings.PHP,
    unassignedUsd: Math.max(0, roundMoney(openingUsd - savings.USD)),
    unassignedPhp: Math.max(0, roundMoney(openingPhp - savings.PHP)),
  };
}

/** Resolve the selected share of current native balances each time a plan is read. */
export function getPlanOpening(plan, accounts = [], document = {}) {
  const flatUsd = roundMoney(plan?.openingUsd);
  const flatPhp = roundMoney(plan?.openingPhp);
  const contributions = [];
  const warnings = [];
  const byId = new Map(accounts.map((account) => [Number(account.id), account]));
  const seen = new Set();
  let accountUsd = 0;
  let accountPhp = 0;
  let reserveExcludedUsd = 0;
  let reserveExcludedPhp = 0;
  const earmarks = new Map();
  for (const bill of document.bills || []) {
    if (bill.cadence !== "annual" || bill.reserveAccountId == null) continue;
    const key = `${Number(bill.reserveAccountId)}:${bill.currency}`;
    earmarks.set(key, roundMoney((earmarks.get(key) || 0) + getAnnualBillFunding(bill).savedAmount));
  }
  for (const selected of plan?.startingAccounts || []) {
    const accountId = Number(selected.accountId);
    const percentage = Number(selected.percentage);
    if (!Number.isSafeInteger(accountId) || accountId < 1 || seen.has(accountId)) {
      warnings.push("A starting balance account is invalid or selected more than once.");
      continue;
    }
    seen.add(accountId);
    const account = byId.get(accountId);
    const name = account?.name || `Account ${accountId}`;
    if (
      !account || account.isArchived || account.is_archived ||
      account.mergedIntoAccountId || account.merged_into_account_id
    ) {
      warnings.push(`${name}: its live starting balance account is unavailable or removed.`);
      continue;
    }
    if (
      !["USD", "PHP"].includes(account.currency) ||
      ["credit", "loan"].includes(account.type || account.account_type)
    ) {
      warnings.push(`${name}: choose a USD or PHP account that holds funds for the starting balance.`);
      continue;
    }
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
      warnings.push(`${name}: its starting balance percentage must be between 0 and 100.`);
      continue;
    }
    const value = Object.hasOwn(account, "nativeCurrentBalance")
      ? account.nativeCurrentBalance : account.currentBalance;
    if (!["number", "string"].includes(typeof value) ||
        (typeof value === "string" && !value.trim()) || !Number.isFinite(Number(value))) {
      warnings.push(`${name}: a current bank balance is unavailable; it is excluded from the starting balance.`);
      continue;
    }
    const balance = roundMoney(value);
    const normalizedPercentage = roundMoney(percentage);
    const amount = roundMoney(balance * normalizedPercentage / 100);
    const reserveExcluded = Math.min(Math.max(0, amount), earmarks.get(`${accountId}:${account.currency}`) || 0);
    const availableAmount = roundMoney(amount - reserveExcluded);
    contributions.push({
      accountId, currency: account.currency, percentage: normalizedPercentage,
      balance, amount, availableAmount, reserveExcluded, name, mask: account.mask || "",
    });
    if (account.currency === "USD") {
      accountUsd = roundMoney(accountUsd + amount);
      reserveExcludedUsd = roundMoney(reserveExcludedUsd + reserveExcluded);
    } else {
      accountPhp = roundMoney(accountPhp + amount);
      reserveExcludedPhp = roundMoney(reserveExcludedPhp + reserveExcluded);
    }
  }
  const totalUsd = roundMoney(flatUsd + accountUsd);
  const totalPhp = roundMoney(flatPhp + accountPhp);
  return {
    usd: roundMoney(totalUsd - reserveExcludedUsd), php: roundMoney(totalPhp - reserveExcludedPhp),
    totalUsd, totalPhp, reserveExcludedUsd, reserveExcludedPhp,
    flatUsd, flatPhp, accountUsd, accountPhp, contributions, warnings,
  };
}

const transferTransaction = (row) =>
  /^(?:transfer(?: in| out)?|internal transfer|account transfer|loan payments?)$/i.test(
    String(row.category || "").trim(),
  );

function planCompletion(rows, plan, actual, document, rate, today) {
  const manual = new Map((plan.completedRows || []).map((row) => [row.rowId, row.completedAt]));
  const posted = actual.filter((row) => !row.scheduled && row.date <= today);
  const consumed = new Set(posted.filter((row) => row.matchedForecast).map((row) => row.id));
  const transferLegs = (row) => {
    const legs = [];
    const add = (accountId, amount, currency) => {
      if (accountId == null || !amount) return false;
      legs.push({ accountId: Number(accountId), amount: roundMoney(amount), currency });
      return true;
    };
    const pair = (from, to, amount, currency, toAmount = amount, toCurrency = currency) => {
      if (from == null || to == null || Number(from) === Number(to)) return false;
      add(from, -amount, currency);
      add(to, toAmount, toCurrency);
      return true;
    };
    if (row.source === "reserve") {
      if (!(row.reserveAllocations || []).every((allocation) => pair(
        allocation.sourceAccountId, allocation.reserveAccountId, allocation.amount, row.currency,
      ))) return [];
    } else if (row.source === "allocation" && row.allocationKind === "savings") {
      if (!pair(row.sourceAccountId, row.accountId, row.amount, row.currency)) return [];
    } else if (row.kind === "transfer" || row.kind === "conversion") {
      const opposite = row.currency === "USD" ? "PHP" : "USD";
      if (!pair(row.fromAccountId, row.toAccountId, row.amount, row.currency,
        row.kind === "conversion" ? convert(row.amount, row.currency, opposite, rate) : row.amount,
        row.kind === "conversion" ? opposite : row.currency)) return [];
    }
    const grouped = new Map();
    for (const leg of legs) {
      const key = `${leg.accountId}:${leg.currency}:${Math.sign(leg.amount)}`;
      const previous = grouped.get(key);
      grouped.set(key, { ...leg, amount: roundMoney(leg.amount + (previous?.amount || 0)) });
    }
    return [...grouped.values()];
  };
  return rows.map((row) => {
    const completionKey = row.matchedForecast?.id || row.id;
    let matches = row.source === "transaction" && !row.scheduled && row.date <= today ? [row] : [];
    if (!matches.length && row.source !== "transaction") {
      if (["salary", "bill", "manual"].includes(row.source)) {
        const match = posted.find((transaction) =>
          !consumed.has(transaction.id) && forecastMatchesTransaction(row, transaction),
        );
        if (match) matches = [match];
      }
      const legs = transferLegs(row);
      if (!matches.length && legs.length) {
        const selected = new Set();
        const candidates = legs.map((leg) => {
          const match = posted.find((transaction) =>
            !consumed.has(transaction.id) && !selected.has(transaction.id) &&
            transferTransaction(transaction) &&
            Number(transaction.accountId) === leg.accountId &&
            transaction.currency === leg.currency &&
            (transaction.kind === "income" ? 1 : -1) === Math.sign(leg.amount) &&
            Math.abs(transaction.amount - Math.abs(leg.amount)) < 0.005 &&
            Math.abs(dateTime(transaction.date) - dateTime(row.date)) <= 3 * DAY_MS,
          );
          if (match) selected.add(match.id);
          return match;
        });
        if (candidates.every(Boolean)) matches = candidates;
      } else if (!matches.length && row.source === "allocation" && row.allocationKind === "expense" && row.accountId != null) {
        const allocation = document.allocations?.find((allocation) => allocation.id === row.allocationId);
        const match = posted.find((transaction) =>
          !consumed.has(transaction.id) && forecastMatchesTransaction(
            { ...row, source: "bill", description: allocation?.name || row.description }, transaction,
          ),
        );
        if (match) matches = [match];
      }
    }
    // A recorded row can be shown as posted and also explain one forecast task.
    // Only forecast matches consume its eligibility for another forecast task.
    if (row.source !== "transaction")
      for (const match of matches) consumed.add(match.id);
    const automatic = matches.length > 0;
    const completedAt = automatic
      ? `${matches.map((match) => match.date).sort().at(-1)}T00:00:00.000Z`
      : manual.get(completionKey);
    return {
      ...row, completionKey,
      completed: automatic || Boolean(completedAt),
      completionSource: automatic ? "transaction" : completedAt ? "manual" : null,
      ...(completedAt ? { completedAt } : {}),
      matchedTransactionIds: matches.map((match) => match.transactionId).filter((id) => id != null),
    };
  });
}

/** Available money and the annual-bill reserve are tracked as separate pockets. */
export function buildPlanRows(plan, document, rate, options = {}) {
  if (!validRange(plan.startDate, plan.endDate)) return [];
  const forecasts = [];
  const salary = document.salary || {};
  const matchingStart = addDays(plan.startDate, -3);
  const matchingEnd = addDays(plan.endDate, 3);
  const paydays = salaryOccurrences(salary, matchingStart, matchingEnd);
  const payPeriods = salary.payFrequency === "biweekly" ? 26 : 24;
  // Keep boundary paydays as matching candidates even when forecast income is off.
  for (const occurrence of paydays)
    forecasts.push({
      id: `salary:${occurrence.date}`,
      date: occurrence.date,
      description: "Salary",
      kind: "income",
      source: "salary",
      accountId: salary.accountId ?? null,
      paydayDate: occurrence.date,
      ...nativeFlow(occurrence.amount, occurrence.currency, "income"),
    });
  for (const bill of document.bills || []) {
    for (const occurrence of billOccurrences(
      bill,
      matchingStart,
      matchingEnd,
      salary,
    ))
      forecasts.push({
        id: `bill:${bill.id}:${occurrence.date}`,
        billId: bill.id,
        date: occurrence.date,
        description: bill.name,
        kind: "expense",
        source: "bill",
        annualPayment: bill.cadence === "annual",
        accountId: bill.accountId ?? null,
        reserveAccountId: bill.reserveAccountId ?? null,
        sourceAccountId: bill.sourceAccountId ?? salary.accountId ?? null,
        ...nativeFlow(occurrence.amount, occurrence.currency, "expense"),
      });
  }
  for (const entry of plan.entries || []) {
    if (
      !Number.isFinite(dateTime(entry.date)) ||
      entry.date < plan.startDate ||
      entry.date > plan.endDate
    )
      continue;
    const flow = nativeFlow(entry.amount, entry.currency, entry.kind);
    if (entry.kind === "transfer") {
      flow.usd = 0;
      flow.php = 0;
    }
    if (entry.kind === "conversion") {
      if (entry.currency === "PHP")
        flow.usd = convert(entry.amount, "PHP", "USD", rate);
      else flow.php = convert(entry.amount, "USD", "PHP", rate);
    }
    forecasts.push({
      id: `entry:${entry.id}`,
      entryId: entry.id,
      date: entry.date,
      description: entry.description,
      kind: entry.kind,
      source: "manual",
      accountId: entry.accountId ?? null,
      fromAccountId: entry.fromAccountId ?? null,
      toAccountId: entry.toAccountId ?? null,
      ...flow,
    });
  }

  const actual = [];
  const seenTransactions = new Set();
  const today = Number.isFinite(dateTime(options.today))
    ? options.today
    : localDate();
  {
    for (const transaction of options.transactions || []) {
      if (
        !Number.isFinite(dateTime(transaction.date)) ||
        transaction.date < plan.startDate ||
        transaction.date > plan.endDate ||
        transaction.pending
      )
        continue;
      if (
        !["income", "expense"].includes(transaction.kind) ||
        !["USD", "PHP"].includes(transaction.currency) ||
        !Number.isFinite(Number(transaction.amount)) ||
        Number(transaction.amount) <= 0
      )
        continue;
      const transactionKey =
        transaction.id === undefined || transaction.id === null
          ? `row-${actual.length}`
          : String(transaction.id);
      if (seenTransactions.has(transactionKey)) continue;
      seenTransactions.add(transactionKey);
      actual.push({
        id: `transaction:${transactionKey}`,
        transactionId: transaction.id,
        date: transaction.date,
        description:
          transaction.merchant ||
          transaction.category ||
          (transaction.kind === "income" ? "Income" : "Expense"),
        merchant: transaction.merchant || "",
        category: transaction.category || "",
        note: transaction.note || "",
        provider: transaction.provider || "",
        accountName: transaction.accountName || "",
        accountType: transaction.accountType || "",
        accountId: transaction.accountId ?? null,
        kind: transaction.kind,
        source: "transaction",
        scheduled: transaction.date > today,
        ...nativeFlow(
          transaction.amount,
          transaction.currency,
          transaction.kind,
        ),
      });
    }
  }
  // Completion checks always see posted records, even when their cash flows are
  // excluded from this hypothetical ledger by the plan's display setting.
  const completionActual = actual;
  const visibleActual = plan.includeTransactions === false ? [] : actual;
  const usedForecasts = new Set();
  const actualPayDates = new Map();
  const forecastPriority = (row) =>
    row.source === "bill" ? 0 : row.source === "salary" ? 1 : 2;
  actual.sort(
    (first, second) =>
      first.date.localeCompare(second.date) ||
      first.id.localeCompare(second.id),
  );
  for (const transaction of visibleActual) {
    const candidates = forecasts.filter(
      (forecast) =>
        !usedForecasts.has(forecast.id) &&
        forecastMatchesTransaction(forecast, transaction),
    );
    candidates.sort(
      (first, second) =>
        Math.abs(dateTime(first.date) - dateTime(transaction.date)) -
          Math.abs(dateTime(second.date) - dateTime(transaction.date)) ||
        forecastPriority(first) - forecastPriority(second) ||
        first.id.localeCompare(second.id),
    );
    const matched = candidates[0];
    if (!matched) continue;
    usedForecasts.add(matched.id);
    transaction.scheduledSource = matched.source;
    transaction.scheduledDate = matched.date;
    transaction.matchedForecast = {
      id: matched.id,
      source: matched.source,
      date: matched.date,
      description: matched.description,
    };
    if (matched.billId !== undefined) transaction.billId = matched.billId;
    if (matched.entryId !== undefined) transaction.entryId = matched.entryId;
    if (matched.reserveAccountId !== undefined)
      transaction.reserveAccountId = matched.reserveAccountId;
    if (matched.sourceAccountId !== undefined)
      transaction.sourceAccountId = matched.sourceAccountId;
    transaction.annualPayment = Boolean(matched.annualPayment);
    if (matched.source === "salary")
      actualPayDates.set(matched.date, transaction.date);
  }
  const rows = [
    ...forecasts.filter(
      (row) =>
        !usedForecasts.has(row.id) &&
        row.date >= plan.startDate &&
        row.date <= plan.endDate &&
        (row.source !== "salary" || plan.includeIncome),
    ),
    ...visibleActual,
  ];
  const annualBills = (document.bills || []).filter(
    (bill) =>
      bill.cadence === "annual" && ["USD", "PHP"].includes(bill.currency),
  );
  for (const payday of paydays) {
    const date = actualPayDates.get(payday.date) || payday.date;
    if (date < plan.startDate || date > plan.endDate) continue;
    if (plan.includeAnnualReserve !== false) {
      for (const currency of ["USD", "PHP"]) {
        const reserveAllocations = annualBills
          .filter((bill) => bill.currency === currency)
          .map((bill) => ({
            billId: bill.id,
            reserveAccountId: bill.reserveAccountId ?? null,
            sourceAccountId: bill.sourceAccountId ?? salary.accountId ?? null,
            amount: 0,
          }));
        if (!reserveAllocations.length) continue;
        // Keep candidates for funded items: a payment can reopen funding later in the plan.
        rows.push({
          id: `reserve:${currency}:${payday.date}`,
          date,
          paydayDate: payday.date,
          description: "Set aside for annual bills",
          kind: "reserve",
          source: "reserve",
          reserveAllocations,
          ...nativeFlow(0, currency, "expense"),
        });
      }
    }
    if (plan.includeAllocations !== false) {
      for (const allocation of document.allocations || []) {
        if (number(allocation.amount) <= 0) continue;
        rows.push({
          id: `allocation:${allocation.id}:${payday.date}`,
          allocationId: allocation.id,
          date,
          paydayDate: payday.date,
          description: `${allocation.kind === "savings" ? "Savings" : "Expense allocation"} · ${allocation.name}`,
          kind: "expense",
          source: "allocation",
          allocationKind: allocation.kind,
          accountId: allocation.accountId ?? null,
          sourceAccountId:
            allocation.sourceAccountId ?? salary.accountId ?? null,
          ...nativeFlow(allocation.amount, allocation.currency, "expense"),
        });
      }
    }
  }
  const priority = (row) =>
    row.kind === "income"
      ? 0
      : row.kind === "conversion"
        ? 1
        : row.source === "reserve"
          ? 2
          : row.source === "allocation"
            ? 3
            : 4;
  rows.sort(
    (first, second) =>
      first.date.localeCompare(second.date) ||
      priority(first) - priority(second) ||
      String(first.currency).localeCompare(String(second.currency)) ||
      first.id.localeCompare(second.id),
  );
  const opening = getPlanOpening(plan, options.accounts || [], document);
  const liveAccounts = new Set(opening.contributions.filter((contribution) => contribution.percentage > 0).map((contribution) => contribution.accountId));
  let balanceUsd = opening.usd;
  let balancePhp = opening.php;
  const openingReserve = getAnnualReserveOpening(plan, document);
  let reserveUsd = openingReserve.usd;
  let reservePhp = openingReserve.php;
  const unassigned = {
    USD: openingReserve.unassignedUsd,
    PHP: openingReserve.unassignedPhp,
  };
  const billReserves = new Map();
  const billFunding = new Map();
  const reserveKey = (billId, currency) => `${currency}:${billId}`;
  const annualPayments = new Map();
  for (const row of rows.filter((row) => row.annualPayment)) {
    const key = reserveKey(row.billId, row.currency);
    if (!annualPayments.has(key)) annualPayments.set(key, []);
    annualPayments.get(key).push(row);
  }
  for (const bill of annualBills) {
    const key = reserveKey(bill.id, bill.currency);
    const funding = getAnnualBillFunding(bill, payPeriods);
    billFunding.set(key, {
      bill,
      amount: funding.amount,
      base: funding.remainingAmount,
      paidThrough: "",
    });
    billReserves.set(
      key,
      roundMoney((billReserves.get(key) || 0) + funding.savedAmount),
    );
  }
  const result = [];
  const isBankReflected = (row, accountId) => liveAccounts.has(Number(accountId)) &&
    (row.date < today || (row.source === "transaction" && row.date <= today && !row.scheduled));
  function append(row) {
    const flowAccount = row.source === "allocation"
      ? row.allocationKind === "savings" ? row.sourceAccountId : row.accountId
      : row.fromAccountId ?? row.accountId;
    let balanceAppliedUsd = isBankReflected(row, flowAccount) ? 0 : row.usd;
    let balanceAppliedPhp = isBankReflected(row, flowAccount) ? 0 : row.php;
    if (row.kind === "conversion") {
      const sourceReflected = isBankReflected(row, row.fromAccountId);
      const destinationReflected = isBankReflected(row, row.toAccountId);
      balanceAppliedUsd = (row.currency === "USD" ? sourceReflected : destinationReflected) ? 0 : row.usd;
      balanceAppliedPhp = (row.currency === "PHP" ? sourceReflected : destinationReflected) ? 0 : row.php;
    }
    if (row.source === "reserve") {
      const reflectedAmount = roundMoney((row.reserveAllocations || []).filter((allocation) =>
        isBankReflected(row, allocation.sourceAccountId) || isBankReflected(row, allocation.reserveAccountId),
      ).reduce((total, allocation) => total + allocation.amount, 0));
      if (row.currency === "USD") balanceAppliedUsd = roundMoney(row.usd + reflectedAmount);
      else balanceAppliedPhp = roundMoney(row.php + reflectedAmount);
    }
    const reflected = balanceAppliedUsd !== row.usd || balanceAppliedPhp !== row.php;
    balanceUsd = roundMoney(balanceUsd + balanceAppliedUsd);
    balancePhp = roundMoney(balancePhp + balanceAppliedPhp);
    reserveUsd = roundMoney(reserveUsd + number(row.reserveAppliedUsd ?? row.reserveDeltaUsd));
    reservePhp = roundMoney(reservePhp + number(row.reserveAppliedPhp ?? row.reserveDeltaPhp));
    result.push({
      ...row,
      balanceAppliedUsd,
      balanceAppliedPhp,
      reflectedInStartingBalance: reflected,
      reserveDeltaUsd: number(row.reserveDeltaUsd),
      reserveDeltaPhp: number(row.reserveDeltaPhp),
      balanceUsd,
      balancePhp,
      reserveUsd,
      reservePhp,
    });
  }
  for (const row of rows) {
    if (row.source === "reserve") {
      const reserveAllocations = row.reserveAllocations
        .map(({ billId, reserveAccountId, sourceAccountId }) => {
          const key = reserveKey(billId, row.currency);
          const state = billFunding.get(key);
          const savedAmount = billReserves.get(key) || 0;
          // Recorded payments can move the actual funding deadline by a few days.
          // Once consumed, their original scheduled occurrence cannot be funded twice.
          const nextPayment = annualPayments
            .get(key)
            ?.find(
              (payment) =>
                payment.date >= row.date &&
                (payment.scheduledDate || payment.date) > state.paidThrough,
            );
          const context = {
            salary,
            asOf: row.date,
            afterDate: state.paidThrough,
            nextPayment,
          };
          const currentBill = { ...state.bill, savedAmount };
          let funding = getAnnualBillFunding(currentBill, payPeriods, context);
          if (!funding.estimated) {
            // A reconciled paycheck may post early or late. Count its actual date
            // once while keeping the configured future salary dates intact.
            const paydayDates = salaryOccurrences(
              salary,
              addDays(row.date, -3),
              addDays(funding.nextDueDate, 3),
            ).map((payday) => actualPayDates.get(payday.date) || payday.date);
            funding = getAnnualBillFunding(currentBill, payPeriods, {
              ...context,
              paydayDates,
            });
          }
          const capacity = funding.estimated
            ? Math.max(0, roundMoney(state.amount - savedAmount))
            : funding.remainingForNextPayment;
          const contribution = funding.estimated
            ? reserveContribution(
                state.base,
                payPeriods,
                paydayIndex(salary, row.paydayDate),
              )
            : funding.perPeriodAmount;
          const amount = Math.min(capacity, contribution);
          const reflected = isBankReflected(row, sourceAccountId) || isBankReflected(row, reserveAccountId);
          if (!reflected) billReserves.set(key, roundMoney((billReserves.get(key) || 0) + amount));
          return { billId, amount, reserveAccountId, sourceAccountId,
            ...(reflected ? { reflectedInStartingBalance: true } : {}),
          };
        })
        .filter((allocation) => allocation.amount > 0);
      const amount = roundMoney(
        reserveAllocations.reduce(
          (total, allocation) => total + allocation.amount,
          0,
        ),
      );
      if (amount <= 0) continue;
      const appliedAmount = roundMoney(reserveAllocations.filter((allocation) => !allocation.reflectedInStartingBalance)
        .reduce((total, allocation) => total + allocation.amount, 0));
      append({
        ...row,
        reserveAllocations,
        ...nativeFlow(amount, row.currency, "expense"),
        reserveDeltaUsd: row.currency === "USD" ? amount : 0,
        reserveDeltaPhp: row.currency === "PHP" ? amount : 0,
        reserveAppliedUsd: row.currency === "USD" ? appliedAmount : 0,
        reserveAppliedPhp: row.currency === "PHP" ? appliedAmount : 0,
      });
      continue;
    }
    if (row.annualPayment) {
      const key = reserveKey(row.billId, row.currency);
      const saved = billReserves.get(key) || 0;
      const grossAmount = roundMoney(row.amount);
      const fromBill = Math.min(grossAmount, saved);
      const fromUnassigned = Math.min(
        roundMoney(grossAmount - fromBill),
        unassigned[row.currency] || 0,
      );
      const reserveUsed = roundMoney(fromBill + fromUnassigned);
      const reserveShortfall = roundMoney(grossAmount - reserveUsed);
      const reserveReflected = isBankReflected(row, row.accountId) || isBankReflected(row, row.reserveAccountId);
      if (!reserveReflected) billReserves.set(key, roundMoney(saved - fromBill));
      const funding = billFunding.get(key);
      if (funding && !reserveReflected) {
        funding.base = funding.amount;
        funding.paidThrough = row.scheduledDate || row.date;
      }
      if (!reserveReflected) unassigned[row.currency] = roundMoney((unassigned[row.currency] || 0) - fromUnassigned);
      // Reconciliation keeps the full payment; only its unfunded portion uses available cash.
      append({
        ...row,
        grossAmount,
        reserveUsed,
        reserveShortfall,
        usd:
          row.currency === "USD" && reserveShortfall > 0
            ? -reserveShortfall
            : 0,
        php:
          row.currency === "PHP" && reserveShortfall > 0
            ? -reserveShortfall
            : 0,
        reserveDeltaUsd:
          row.currency === "USD" && reserveUsed > 0 ? -reserveUsed : 0,
        reserveDeltaPhp:
          row.currency === "PHP" && reserveUsed > 0 ? -reserveUsed : 0,
        ...(reserveReflected ? { reserveAppliedUsd: 0, reserveAppliedPhp: 0 } : {}),
      });
      continue;
    }
    append(row);
  }
  const completed = planCompletion(result, plan, completionActual, document, rate, today);
  // A matched conversion or expense allocation is represented by its posted
  // transactions. Keep the task visible without counting the same cash twice.
  let reconciledUsd = opening.usd;
  let reconciledPhp = opening.php;
  return completed.map((row) => {
    const recordedFlow = plan.includeTransactions !== false && row.completionSource === "transaction" && row.source !== "transaction" &&
      (row.kind === "conversion" || (row.source === "allocation" && row.allocationKind === "expense"));
    const balanceAppliedUsd = recordedFlow ? 0 : row.balanceAppliedUsd;
    const balanceAppliedPhp = recordedFlow ? 0 : row.balanceAppliedPhp;
    reconciledUsd = roundMoney(reconciledUsd + balanceAppliedUsd);
    reconciledPhp = roundMoney(reconciledPhp + balanceAppliedPhp);
    return {
      ...row, balanceAppliedUsd, balanceAppliedPhp,
      ...(recordedFlow ? { reflectedInRecordedTransactions: true } : {}),
      balanceUsd: reconciledUsd, balancePhp: reconciledPhp,
    };
  });
}
