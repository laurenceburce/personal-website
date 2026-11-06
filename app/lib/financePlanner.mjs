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

/** A plan entry repeats from its original calendar date, in its native currency. */
export function entryOccurrences(entry, start, end, salary) {
  if (!validRange(start, end) || !Number.isFinite(dateTime(entry?.date))) return [];
  const recurrence = entry.recurrence || "once";
  if (!["once", "daily", "monthly", "payday"].includes(recurrence)) return [];
  const occurrence = (date) => ({
    date,
    amount: roundMoney(entry.amount),
    currency: entry.currency,
    entryId: entry.id,
  });
  if (recurrence === "once")
    return entry.date >= start && entry.date <= end ? [occurrence(entry.date)] : [];
  if (entry.repeatUntil && !Number.isFinite(dateTime(entry.repeatUntil))) return [];
  const first = [start, entry.date].sort().at(-1);
  const last = entry.repeatUntil ? [end, entry.repeatUntil].sort()[0] : end;
  if (first > last) return [];
  if (recurrence === "daily") {
    const result = [];
    for (let time = dateTime(first); time <= dateTime(last); time += DAY_MS)
      result.push(occurrence(isoDate(time)));
    return result;
  }
  if (recurrence === "payday") {
    if (!salary || !["biweekly", "semimonthly"].includes(salary.payFrequency)) return [];
    return salaryOccurrences(salary, first, last).map(({ date }) => occurrence(date));
  }
  const result = [];
  const day = Number(entry.date.slice(8));
  eachMonth(first, last, (year, month) => {
    const date = monthDate(year, month, day);
    if (date >= first && date <= last) result.push(occurrence(date));
  });
  return result;
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
  const rounded = roundMoney(amount);
  const signed = rounded === 0 ? 0 : (kind === "income" ? 1 : -1) * rounded;
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
    return /\b(salary|payroll|paycheck|wages|direct deposit|electronic deposit)\b/.test(
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

// Issued statements remain bank-reported obligations. Unbilled balances are
// projected separately so the same debt is never charged in both cycles.
function creditCardStatements(accounts) {
  const statements = new Map();
  for (const account of accounts) {
    const due = account.creditCardDue;
    const balance = due?.statementBalance;
    if ((account.type || account.account_type) !== "credit" ||
        account.isArchived || account.is_archived || account.mergedIntoAccountId || account.merged_into_account_id ||
        !["USD", "PHP"].includes(account.currency) || !Number.isSafeInteger(Number(account.id)) || Number(account.id) <= 0 ||
        !Number.isFinite(dateTime(due?.dueDate)) ||
        !["number", "string"].includes(typeof balance) || !String(balance).trim() ||
        !Number.isFinite(Number(balance)) || Number(balance) < 0) continue;
    statements.set(Number(account.id), { account, due, statementBalance: roundMoney(balance) });
  }
  return statements;
}

function creditCardPayments(statement, transactions, today, consumedDebits, statements, accountsById) {
  const { account, due, statementBalance } = statement;
  const statementDate = Number.isFinite(dateTime(due.lastStatementDate)) && due.lastStatementDate <= due.dueDate
    ? due.lastStatementDate : null;
  const inStatement = (date) => Number.isFinite(dateTime(date)) && date <= today &&
    (statementDate ? date > statementDate : date >= addDays(due.dueDate, -3));
  const seen = new Set();
  const posted = transactions.filter((transaction) => {
    if (transaction.id != null) {
      if (seen.has(String(transaction.id))) return false;
      seen.add(String(transaction.id));
    }
    return !transaction.pending && inStatement(transaction.date) && transaction.currency === account.currency &&
      Number.isFinite(Number(transaction.amount)) && Number(transaction.amount) > 0;
  });
  const paymentDescription = (row) => /\b(payment|payments|autopay|autopayment)\b/.test(normalizedDescription(
    [row.merchant, row.category, row.note].filter(Boolean).join(" "),
  ));
  const credits = posted.filter((transaction) => Number(transaction.accountId) === Number(account.id) &&
    transaction.kind === "income" && (transferTransaction(transaction) || paymentDescription(transaction)));
  const evidence = [...credits];
  // Bank debits only reduce this particular card's due when the receiving leg
  // identifies it, or the debit explicitly names the card. An equal amount alone
  // cannot identify which card was paid.
  const explicitlyNamesCard = (row) => {
    const words = new Set(normalizedDescription([row.merchant, row.note].filter(Boolean).join(" ")).split(" "));
    const named = [...statements.values()].filter(({ account: candidate }) => {
      if (candidate.mask && words.has(String(candidate.mask))) return true;
      const names = [candidate.name, candidate.institutionName].filter(Boolean).map((name) => normalizedDescription(name)
        .split(" ").filter((word) => word.length >= 3 && !["credit", "card", "bank", "checking", "savings", "account"].includes(word)));
      return names.some((tokens) => tokens.length && tokens.every((word) => words.has(word)));
    });
    const masked = named.filter(({ account: candidate }) => candidate.mask && words.has(String(candidate.mask)));
    const candidates = masked.length ? masked : named;
    return candidates.length === 1 && Number(candidates[0].account.id) === Number(account.id);
  };
  const debits = posted.filter((transaction) => transaction.kind === "expense" &&
    Number(transaction.accountId) !== Number(account.id) && !consumedDebits.has(String(transaction.id)) &&
    !["credit", "loan"].includes(accountsById.get(Number(transaction.accountId))?.type || transaction.accountType) &&
    (transferTransaction(transaction) || paymentDescription(transaction)));
  for (const credit of credits) {
    const candidates = debits.filter((debit) => !consumedDebits.has(String(debit.id)) &&
      Math.abs(Number(debit.amount) - Number(credit.amount)) < 0.005 &&
      Math.abs(dateTime(debit.date) - dateTime(credit.date)) <= 3 * DAY_MS);
    const debit = candidates.length === 1 ? candidates[0] : candidates.find(explicitlyNamesCard);
    if (debit) { evidence.push(debit); consumedDebits.add(String(debit.id)); }
  }
  let paidAmount = roundMoney(credits.reduce((total, payment) => total + Number(payment.amount), 0));
  for (const debit of debits.filter((row) => !consumedDebits.has(String(row.id)) && explicitlyNamesCard(row))) {
    evidence.push(debit);
    consumedDebits.add(String(debit.id));
    paidAmount = roundMoney(paidAmount + Number(debit.amount));
  }
  const lastAmount = Number(due.lastPaymentAmount);
  if (inStatement(due.lastPaymentDate) && Number.isFinite(lastAmount) && lastAmount > 0 &&
      !evidence.some((row) => Math.abs(dateTime(row.date) - dateTime(due.lastPaymentDate)) <= 3 * DAY_MS && Math.abs(Number(row.amount) - lastAmount) < 0.005))
    paidAmount = roundMoney(paidAmount + lastAmount);
  return {
    paidAmount: Math.min(statementBalance, paidAmount),
    paymentTransactionIds: [...new Set(evidence.map((row) => row.id).filter((value) => value != null))],
    lastPaymentDate: evidence.map((row) => row.date).concat(inStatement(due.lastPaymentDate) && lastAmount > 0 ? [due.lastPaymentDate] : []).sort().at(-1),
  };
}

function knownCardBalance(value) {
  return ["number", "string"].includes(typeof value) && String(value).trim() && Number.isFinite(Number(value))
    ? roundMoney(value) : null;
}

function creditCardObligations(accounts, options = {}) {
  const today = Number.isFinite(dateTime(options.today)) ? options.today : localDate();
  const statements = creditCardStatements(accounts);
  const accountsById = new Map(accounts.map((account) => [Number(account.id), account]));
  const transactions = options.transactions || [];
  const consumedDebits = new Set();
  const payments = new Map();
  const obligations = [];
  for (const [accountId, statement] of statements)
    payments.set(accountId, creditCardPayments(statement, transactions, today, consumedDebits, statements, accountsById));
  for (const account of accounts) {
    const accountId = Number(account.id);
    const statement = statements.get(accountId);
    const due = account.creditCardDue;
    const currentBalance = knownCardBalance(Object.hasOwn(account, "nativeCurrentBalance") ? account.nativeCurrentBalance : account.currentBalance);
    const payment = payments.get(accountId);
    const row = (date, amount, metadata) => ({
      id: `creditCardDue:${accountId}:${date}`,
      date,
      description: `${account.name || "Credit card"} · ${metadata.estimated ? "estimated next statement" : "statement due"}`,
      kind: "expense", source: "creditCardDue", accountId: null, creditAccountId: accountId,
      accountName: account.name || "Credit card", lastStatementDate: due?.lastStatementDate || null,
      currentBalance, plannedPaymentAmount: 0, editable: false,
      ...metadata, ...nativeFlow(amount, account.currency, "expense"),
    });
    const remainingStatement = statement ? roundMoney(statement.statementBalance - payment.paidAmount) : 0;
    if (statement?.statementBalance > 0)
      obligations.push(row(due.dueDate, remainingStatement, { statementBalance: statement.statementBalance, ...payment }));
    if (account.isLinked !== true || (account.type || account.account_type) !== "credit" ||
        account.isArchived || account.is_archived || account.mergedIntoAccountId || account.merged_into_account_id ||
        !["USD", "PHP"].includes(account.currency) || !Number.isSafeInteger(accountId) || accountId <= 0 ||
        !Number.isFinite(dateTime(due?.dueDate)) || currentBalance === null || currentBalance <= 0) continue;
    const reportedStatement = knownCardBalance(due.statementBalance);
    if (reportedStatement !== null && reportedStatement < 0) continue;
    const unbilled = roundMoney(Math.max(0, currentBalance - remainingStatement));
    if (unbilled <= 0) continue;
    const issued = Number.isFinite(dateTime(due.lastStatementDate)) && due.lastStatementDate <= due.dueDate && due.lastStatementDate <= today;
    const knownCycle = Boolean(statement && (statement.statementBalance > 0 || issued));
    let estimateDate = due.dueDate;
    if (knownCycle) {
      const anchor = new Date(dateTime(due.dueDate));
      const baseMonth = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth();
      const current = new Date(dateTime(today));
      let month = Math.max(baseMonth + 1, current.getUTCFullYear() * 12 + current.getUTCMonth());
      estimateDate = monthDate(Math.floor(month / 12), month % 12, anchor.getUTCDate());
      if (estimateDate < today) {
        month += 1;
        estimateDate = monthDate(Math.floor(month / 12), month % 12, anchor.getUTCDate());
      }
    } else if (estimateDate < today) continue;
    obligations.push(row(estimateDate, unbilled, {
      estimated: true, estimatedBalance: unbilled, estimateDateIsReported: !knownCycle,
      statementBalance: null, paidAmount: 0, paymentTransactionIds: [],
    }));
    // A linked card with only a dated estimate still changes debt rather than
    // charging cash for each purchase as well as its projected payment.
    if (!statements.has(accountId)) statements.set(accountId, { account, due, statementBalance: null });
  }
  // Explicit planned transfers can already have posted outside the current
  // statement window. Their recorded legs must not fund the snapshot twice.
  const recordedPayments = new Map();
  const firstRecordedDate = transactions.filter((transaction) => Number.isFinite(dateTime(transaction.date)) && transaction.date <= today)
    .map((transaction) => transaction.date).sort()[0];
  if (firstRecordedDate) {
    const consumedRecordedDebits = new Set();
    for (const [accountId, statement] of statements)
      recordedPayments.set(accountId, creditCardPayments({ ...statement, statementBalance: 0,
        due: { ...statement.due, lastStatementDate: addDays(firstRecordedDate, -1) } },
      transactions, today, consumedRecordedDebits, statements, accountsById));
  }
  return { statements, payments, recordedPayments, obligations };
}

/** Current bank-reported dues and one estimate of each card's unbilled debt. */
export function getCreditCardObligations(accounts, options = {}) {
  return creditCardObligations(accounts || [], options).obligations;
}

// Allocate a one-off reserve total in cents while respecting each next payment's
// remaining funding. Repeating the weighted split after a cap is reached keeps
// larger overrides useful without overfunding an individual annual bill.
function overriddenReserveAllocations(candidates, requested) {
  const allocations = candidates.map((candidate) => ({ ...candidate, amount: 0 }));
  let remaining = Math.min(
    Math.max(0, Math.round(number(requested) * 100)),
    candidates.reduce((total, candidate) => total + Math.round(candidate.capacity * 100), 0),
  );
  while (remaining > 0) {
    const active = allocations.filter((allocation) => Math.round((allocation.capacity - allocation.amount) * 100) > 0);
    if (!active.length) break;
    const weight = (allocation) => allocation.defaultAmount || allocation.capacity;
    const totalWeight = active.reduce((total, allocation) => total + weight(allocation), 0);
    const shares = active.map((allocation, index) => {
      const exact = remaining * weight(allocation) / totalWeight;
      const capacity = Math.round((allocation.capacity - allocation.amount) * 100);
      return { allocation, index, exact, cents: Math.min(capacity, Math.floor(exact)), capacity };
    });
    let applied = shares.reduce((total, share) => total + share.cents, 0);
    for (const share of [...shares].sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)) || a.index - b.index)) {
      if (applied >= remaining) break;
      if (share.cents < share.capacity) { share.cents += 1; applied += 1; }
    }
    if (!applied) break;
    for (const share of shares)
      share.allocation.amount = roundMoney(share.allocation.amount + share.cents / 100);
    remaining -= applied;
  }
  return allocations;
}

function planTransferLegs(row, rate) {
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
}

function planCompletion(rows, plan, actual, document, rate, today) {
  const manual = new Map((plan.completedRows || []).map((row) => [row.rowId, row.completedAt]));
  const posted = actual.filter((row) => !row.scheduled && row.date <= today);
  const consumed = new Set(posted.filter((row) => row.matchedForecast && row.matchedForecast.source !== "creditCardDue").map((row) => row.id));
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
      const legs = planTransferLegs(row, rate);
      if (!matches.length && legs.length) {
        const selected = new Set();
        const candidates = legs.map((leg) => {
          const match = posted.find((transaction) =>
            !consumed.has(transaction.id) && !selected.has(transaction.id) &&
            (transferTransaction(transaction) || Number(transaction.creditCardPaymentFor) === Number(row.toAccountId)) &&
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
            { ...row, source: "bill", description: row.isOverride ? row.description : allocation?.name || row.description }, transaction,
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
    const statementPaid = row.source === "creditCardDue" && !row.estimated && row.statementBalance > 0 && row.amount === 0 && row.paidAmount >= row.statementBalance;
    const completedAt = automatic
      ? `${matches.map((match) => match.date).sort().at(-1)}T00:00:00.000Z`
      : statementPaid && row.lastPaymentDate ? `${row.lastPaymentDate}T00:00:00.000Z` : manual.get(completionKey);
    return {
      ...row, completionKey,
      completed: automatic || statementPaid || Boolean(completedAt),
      completionSource: automatic || statementPaid ? "transaction" : completedAt ? "manual" : null,
      ...(completedAt ? { completedAt } : {}),
      matchedTransactionIds: row.source === "creditCardDue" ? row.paymentTransactionIds || [] : matches.map((match) => match.transactionId).filter((id) => id != null),
    };
  });
}

// Linked funding can vary from its forecast. Adopt a bank amount only when one
// complete, same-day pair identifies this task without a competing plan entry.
function linkedFundingPair(row, expectedAmount, rows, actual, today, document) {
  const fundingAccounts = (candidate) => {
    if (candidate.source === "reserve")
      return (candidate.reserveAllocations || []).map((allocation) => [allocation.sourceAccountId, allocation.reserveAccountId]);
    if (candidate.source === "allocation" && candidate.allocationKind === "savings")
      return [[candidate.sourceAccountId, candidate.accountId]];
    if (candidate.kind === "transfer") return [[candidate.fromAccountId, candidate.toAccountId]];
    return [];
  };
  const accounts = fundingAccounts(row);
  if (!accounts.length) return null;
  const [source, destination] = accounts[0].map(Number);
  if (!source || !destination || source === destination || accounts.some(([from, to]) => Number(from) !== source || Number(to) !== destination)) return null;
  if (rows.some((other) => other.id !== row.id && other.currency === row.currency &&
      Math.abs(dateTime(other.date) - dateTime(row.date)) <= 3 * DAY_MS &&
      fundingAccounts(other).some(([from, to]) => Number(from) === source && Number(to) === destination))) return null;
  const posted = actual.filter((transaction) => !transaction.scheduled && transaction.date <= today &&
    transaction.date === row.date && transaction.currency === row.currency && transferTransaction(transaction) &&
    !transaction.matchedForecast &&
    !rows.some((other) => other.id !== row.id && other.source === "allocation" && other.allocationKind === "expense" &&
      forecastMatchesTransaction({ ...other, source: "bill", description: other.isOverride ? other.description :
        document.allocations?.find((allocation) => allocation.id === other.allocationId)?.name || other.description }, transaction)));
  const pairs = [];
  for (const debit of posted.filter((transaction) => transaction.kind === "expense" && Number(transaction.accountId) === source)) {
    for (const credit of posted.filter((transaction) => transaction.kind === "income" && Number(transaction.accountId) === destination &&
        Math.abs(transaction.amount - debit.amount) < 0.005)) pairs.push([debit, credit]);
  }
  if (pairs.some(([debit]) => Math.abs(debit.amount - expectedAmount) < 0.005) || pairs.length !== 1) return null;
  const [debit, credit] = pairs[0];
  const sameAmount = (transaction) => Math.abs(transaction.amount - debit.amount) < 0.005;
  if (posted.filter((transaction) => transaction.kind === "income" && Number(transaction.accountId) !== source && sameAmount(transaction)).length !== 1 ||
      posted.filter((transaction) => transaction.kind === "expense" && Number(transaction.accountId) !== destination && sameAmount(transaction)).length !== 1) return null;
  return { amount: debit.amount, debit, credit, source, destination };
}

// Linked columns describe native accounts. A planned transfer and its imported
// debit/credit are one ledger event, with the bank records retained as evidence.
function linkedPlanTransactions(rows, plan, actual, accounts, rate, today) {
  const posted = actual.filter((row) => !row.scheduled && row.date <= today);
  const consumed = new Set(posted.filter((row) => row.matchedForecast && row.matchedForecast.source !== "creditCardDue")
    .map((row) => String(row.transactionId)));
  const coalescedIds = new Set();
  const byId = new Map(posted.map((row) => [String(row.transactionId), row]));
  const logical = new Map();
  for (const row of rows) {
    if (row.source === "transaction" || row.source === "creditCardDue") continue;
    const legs = planTransferLegs(row, rate);
    const expenseAllocation = row.source === "allocation" && row.allocationKind === "expense";
    const matchedPayment = ["salary", "bill", "manual"].includes(row.source) && row.completionSource === "transaction";
    if (!legs.length && !expenseAllocation && !matchedPayment) continue;
    const selected = new Set();
    const candidates = legs.length ? legs.map((leg) => {
      const match = posted.find((transaction) =>
        !consumed.has(String(transaction.transactionId)) && !selected.has(String(transaction.transactionId)) &&
        (transferTransaction(transaction) || Number(transaction.creditCardPaymentFor) === Number(row.toAccountId)) &&
        Number(transaction.accountId) === leg.accountId && transaction.currency === leg.currency &&
        (transaction.kind === "income" ? 1 : -1) === Math.sign(leg.amount) &&
        Math.abs(transaction.amount - Math.abs(leg.amount)) < 0.005 &&
        Math.abs(dateTime(transaction.date) - dateTime(row.date)) <= 3 * DAY_MS);
      if (match) selected.add(String(match.transactionId));
      return match;
    }) : (row.matchedTransactionIds || []).map((id) => byId.get(String(id)))
      .filter((transaction) => transaction && !consumed.has(String(transaction.transactionId)));
    const evidence = candidates.filter(Boolean);
    if (!evidence.length) continue;
    for (const transaction of evidence) {
      consumed.add(String(transaction.transactionId));
      coalescedIds.add(String(transaction.transactionId));
    }
    const complete = legs.length ? candidates.every(Boolean) : true;
    const recordedDate = evidence.map((transaction) => transaction.date).sort().at(-1);
    logical.set(row.id, {
      ...row,
      ...(complete && plan.includeTransactions !== false ? { date: recordedDate, scheduledDate: row.date } : {}),
      recordedTransactions: evidence.map((transaction) => ({ ...transaction })),
      recordedTransactionsIncluded: plan.includeTransactions !== false,
      matchedTransactionIds: evidence.map((transaction) => transaction.transactionId),
      postedTransferAccountIds: [...new Set(evidence.map((transaction) => Number(transaction.accountId)))],
      ...(complete ? { completed: true, completionSource: "transaction", completedAt: `${recordedDate}T00:00:00.000Z` } : {}),
    });
  }
  const visible = rows.filter((row) => row.source !== "transaction" || !coalescedIds.has(String(row.transactionId)))
    .map((row) => logical.get(row.id) || row);
  if (plan.includeTransactions !== false) {
    const linkedIds = new Set(Object.values(plan.accountLinks).filter((id) => id != null).map(Number));
    const byAccount = new Map(accounts.map((account) => [Number(account.id), account]));
    const unclaimed = posted.filter((transaction) => !consumed.has(String(transaction.transactionId)) &&
      !transaction.creditCardPaymentFor && transferTransaction(transaction) && linkedIds.has(Number(transaction.accountId)) &&
      !["credit", "loan"].includes(byAccount.get(Number(transaction.accountId))?.type));
    const counterparts = (transaction) => unclaimed.filter((other) => other.kind !== transaction.kind &&
      Number(other.accountId) !== Number(transaction.accountId) && other.currency === transaction.currency &&
      Math.abs(other.amount - transaction.amount) < 0.005 && Math.abs(dateTime(other.date) - dateTime(transaction.date)) <= 3 * DAY_MS);
    const paired = new Set();
    for (const debit of unclaimed.filter((transaction) => transaction.kind === "expense")) {
      if (paired.has(String(debit.transactionId))) continue;
      const credits = counterparts(debit);
      if (credits.length !== 1 || counterparts(credits[0]).length !== 1) continue;
      const credit = credits[0];
      if (paired.has(String(credit.transactionId))) continue;
      paired.add(String(debit.transactionId));
      paired.add(String(credit.transactionId));
      const date = [debit.date, credit.date].sort().at(-1);
      const from = byAccount.get(Number(debit.accountId));
      const to = byAccount.get(Number(credit.accountId));
      visible.push({
        id: `transaction-pair:${debit.transactionId}:${credit.transactionId}`,
        date, description: `${from?.name || "Account transfer"} → ${to?.name || "Account"}`,
        source: "transaction", kind: "transfer", amount: debit.amount, currency: debit.currency,
        fromAccountId: Number(debit.accountId), toAccountId: Number(credit.accountId),
        usd: roundMoney(debit.usd + credit.usd), php: roundMoney(debit.php + credit.php),
        scheduled: false, completed: true, completionSource: "transaction", completedAt: `${date}T00:00:00.000Z`,
        completionKey: debit.id, matchedTransactionIds: [debit.transactionId, credit.transactionId],
        recordedTransactions: [{ ...debit }, { ...credit }], recordedTransactionsIncluded: true,
      });
    }
    if (paired.size) {
      for (let index = visible.length - 1; index >= 0; index--)
        if (visible[index].source === "transaction" && paired.has(String(visible[index].transactionId))) visible.splice(index, 1);
    }
  }
  const priority = (row) => row.kind === "income" ? 0 : row.kind === "conversion" ? 1 : row.source === "reserve" ? 2 : row.source === "allocation" ? 3 : 4;
  return visible.sort((first, second) => first.date.localeCompare(second.date) || priority(first) - priority(second) ||
    String(first.currency).localeCompare(String(second.currency)) || first.id.localeCompare(second.id));
}

/** Available money and the annual-bill reserve are tracked as separate pockets. */
export function buildPlanRows(plan, document, rate, options = {}) {
  if (!validRange(plan.startDate, plan.endDate)) return [];
  const forecasts = [];
  const salary = document.salary || {};
  const linkedAccount = (pocket, currency, fallback) =>
    plan.accountLinks
      ? plan.accountLinks[`${pocket}${currency === "PHP" ? "Php" : "Usd"}AccountId`] ?? null
      : fallback ?? null;
  const cardAccountsById = new Map((options.accounts || []).map((account) => [Number(account.id), account]));
  const cardPaymentTransactions = [...(options.transactions || []), ...(options.creditCardPaymentTransactions || [])];
  const today = Number.isFinite(dateTime(options.today)) ? options.today : localDate();
  const cardObligations = creditCardObligations(options.accounts || [], { transactions: cardPaymentTransactions, today });
  const { statements } = cardObligations;
  const overrides = new Map((plan.rowOverrides || []).map((row) => [row.rowId, row]));
  // Keep an occurrence addressable when its date is moved across a plan boundary.
  const originalDates = [...overrides.keys()]
    .map((rowId) => String(rowId).slice(-10))
    .filter((date) => Number.isFinite(dateTime(date)) &&
      date >= addDays(plan.startDate, -731) && date <= addDays(plan.endDate, 731));
  const matchingStart = [addDays(plan.startDate, -3), ...originalDates].sort()[0];
  const matchingEnd = [addDays(plan.endDate, 3), ...originalDates].sort().at(-1);
  const applyOverride = (row) => {
    const override = overrides.get(row.id);
    const metadata = {
      editable: true,
      isOverride: Boolean(override),
      originalDate: row.date,
      originalDescription: row.description,
      originalAmount: row.amount,
    };
    if (!override) return { ...row, ...metadata };
    return {
      ...row,
      ...metadata,
      date: override.date,
      description: override.description,
      ...nativeFlow(override.amount, row.currency, row.kind),
    };
  };
  const paydays = salaryOccurrences(salary, matchingStart, matchingEnd);
  const payPeriods = salary.payFrequency === "biweekly" ? 26 : 24;
  // Keep boundary paydays as matching candidates even when forecast income is off.
  for (const occurrence of paydays)
    forecasts.push(applyOverride({
      id: `salary:${occurrence.date}`,
      date: occurrence.date,
      description: "Salary",
      kind: "income",
      source: "salary",
      accountId: linkedAccount("available", occurrence.currency, salary.accountId),
      paydayDate: occurrence.date,
      ...nativeFlow(occurrence.amount, occurrence.currency, "income"),
    }));
  for (const bill of document.bills || []) {
    for (const occurrence of billOccurrences(
      bill,
      matchingStart,
      matchingEnd,
      salary,
    ))
      forecasts.push(applyOverride({
        id: `bill:${bill.id}:${occurrence.date}`,
        billId: bill.id,
        date: occurrence.date,
        description: bill.name,
        kind: "expense",
        source: "bill",
        annualPayment: bill.cadence === "annual",
        accountId: bill.accountId ?? null,
        reserveAccountId: linkedAccount("annualReserve", occurrence.currency, bill.reserveAccountId),
        sourceAccountId: linkedAccount("available", occurrence.currency, bill.sourceAccountId ?? salary.accountId),
        ...nativeFlow(occurrence.amount, occurrence.currency, "expense"),
      }));
  }
  const entryFlow = (entry) => {
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
    return flow;
  };
  for (const entry of plan.entries || []) {
    const recurring = Boolean(entry.recurrence && entry.recurrence !== "once");
    const occurrences = entryOccurrences(entry, plan.startDate, plan.endDate, salary);
    if (recurring) {
      // Only reconstruct an out-of-range date when it is a real occurrence of
      // this series with an override. Unrelated IDs cannot invent extra rows.
      const prefix = `entry:${entry.id}:`;
      for (const rowId of overrides.keys()) {
        if (!String(rowId).startsWith(prefix)) continue;
        const originalDate = String(rowId).slice(prefix.length);
        if (originalDate >= plan.startDate && originalDate <= plan.endDate) continue;
        if (!originalDates.includes(originalDate)) continue;
        occurrences.push(...entryOccurrences(entry, originalDate, originalDate, salary));
      }
    }
    for (const occurrence of occurrences) {
      let row = {
        id: recurring ? `entry:${entry.id}:${occurrence.date}` : `entry:${entry.id}`,
        entryId: entry.id,
        date: occurrence.date,
        description: entry.description,
        kind: entry.kind,
        source: "manual",
        accountId: entry.accountId ?? null,
        fromAccountId: entry.fromAccountId ?? null,
        toAccountId: entry.toAccountId ?? null,
        ...(recurring ? { recurring: true, recurrence: entry.recurrence } : {}),
        ...entryFlow(entry),
      };
      if (recurring) row = applyOverride(row);
      forecasts.push({ ...row, ...entryFlow(row) });
    }
  }

  const actual = [];
  const seenTransactions = new Set();
  const plannedCardPayments = new Map();
  const recordedEntryPayments = new Map();
  for (const [accountId, statement] of statements) {
    const payment = cardObligations.recordedPayments.get(accountId);
    const consumedEvidence = new Set();
    const entries = [];
    for (const entry of forecasts.filter((row) => row.source === "manual").sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
      const source = cardAccountsById.get(Number(entry.fromAccountId));
      if (entry.kind !== "transfer" || Number(entry.toAccountId) !== accountId || entry.currency !== statement.account.currency ||
          !source || source.currency !== entry.currency || ["credit", "loan"].includes(source.type || source.account_type) ||
          source.isArchived || source.is_archived || source.mergedIntoAccountId || source.merged_into_account_id ||
          !Number.isFinite(dateTime(entry.date)) || entry.date < plan.startDate || entry.date > plan.endDate ||
          (Number.isFinite(dateTime(statement.due.lastStatementDate)) && entry.date <= statement.due.lastStatementDate) ||
          !(Number(entry.amount) > 0)) continue;
      const evidence = cardPaymentTransactions.filter((transaction) =>
        payment?.paymentTransactionIds.some((value) => String(value) === String(transaction.id)) &&
        !consumedEvidence.has(String(transaction.id)) && Math.abs(Number(transaction.amount) - Number(entry.amount)) < 0.005 &&
        Math.abs(dateTime(transaction.date) - dateTime(entry.date)) <= 3 * DAY_MS &&
        ((transaction.kind === "income" && Number(transaction.accountId) === accountId) ||
          (transaction.kind === "expense" && Number(transaction.accountId) === Number(entry.fromAccountId))));
      if (evidence.length) {
        for (const transaction of evidence) {
          consumedEvidence.add(String(transaction.id));
          recordedEntryPayments.set(String(transaction.id), accountId);
        }
      } else entries.push({ date: entry.date, remaining: roundMoney(entry.amount) });
    }
    plannedCardPayments.set(accountId, entries);
  }
  for (const obligation of [...cardObligations.obligations].sort((a, b) => a.date.localeCompare(b.date))) {
    if (obligation.date < plan.startDate || obligation.date > plan.endDate) continue;
    let remaining = obligation.amount;
    for (const payment of plannedCardPayments.get(obligation.creditAccountId) || []) {
      if (payment.date > obligation.date || (obligation.estimated && payment.date < today)) continue;
      const allocated = Math.min(remaining, payment.remaining);
      remaining = roundMoney(remaining - allocated);
      payment.remaining = roundMoney(payment.remaining - allocated);
    }
    forecasts.push({ ...obligation, plannedPaymentAmount: roundMoney(obligation.amount - remaining),
      ...nativeFlow(remaining, obligation.currency, "expense") });
  }
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
  for (const transaction of actual) {
    const accountId = recordedEntryPayments.get(String(transaction.transactionId));
    if (accountId) {
      transaction.creditCardPaymentFor = accountId;
      transaction.scheduledSource = "creditCardDue";
    }
  }
  for (const statement of forecasts.filter((row) => row.source === "creditCardDue")) {
    for (const transaction of actual.filter((row) => statement.paymentTransactionIds.some((value) => String(value) === String(row.transactionId)))) {
      transaction.creditCardPaymentFor = statement.creditAccountId;
      transaction.scheduledSource = statement.source;
      transaction.scheduledDate = statement.date;
      transaction.matchedForecast = { id: statement.id, source: statement.source, date: statement.date, description: statement.description };
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
    if (transaction.creditCardPaymentFor) continue;
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
      ...(matched.entryId !== undefined ? { entryId: matched.entryId } : {}),
      ...(matched.recurring ? { recurring: true, recurrence: matched.recurrence } : {}),
    };
    if (matched.billId !== undefined) transaction.billId = matched.billId;
    if (matched.entryId !== undefined) transaction.entryId = matched.entryId;
    if (matched.reserveAccountId !== undefined)
      transaction.reserveAccountId = matched.reserveAccountId;
    if (matched.sourceAccountId !== undefined)
      transaction.sourceAccountId = matched.sourceAccountId;
    if (matched.originalDate !== undefined)
      transaction.originalDate = matched.originalDate;
    if (matched.recurring) {
      transaction.recurring = true;
      transaction.recurrence = matched.recurrence;
      transaction.originalDescription = matched.originalDescription;
      transaction.originalAmount = matched.originalAmount;
    }
    transaction.annualPayment = Boolean(matched.annualPayment);
    if (matched.source === "salary")
      actualPayDates.set(matched.paydayDate || matched.originalDate || matched.date, transaction.date);
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
    if (plan.includeAnnualReserve !== false) {
      for (const currency of ["USD", "PHP"]) {
        const reserveAllocations = annualBills
          .filter((bill) => bill.currency === currency)
          .map((bill) => ({
            billId: bill.id,
            reserveAccountId: linkedAccount("annualReserve", currency, bill.reserveAccountId),
            sourceAccountId: linkedAccount("available", currency, bill.sourceAccountId ?? salary.accountId),
            amount: 0,
          }));
        if (!reserveAllocations.length) continue;
        // Keep candidates for funded items: a payment can reopen funding later in the plan.
        const row = applyOverride({
          id: `reserve:${currency}:${payday.date}`,
          date,
          paydayDate: payday.date,
          description: "Set aside for annual bills",
          kind: "reserve",
          source: "reserve",
          reserveAllocations,
          ...nativeFlow(0, currency, "expense"),
        });
        if (row.date >= plan.startDate && row.date <= plan.endDate) rows.push(row);
      }
    }
    if (plan.includeAllocations !== false) {
      for (const allocation of document.allocations || []) {
        if (number(allocation.amount) <= 0 && !overrides.has(`allocation:${allocation.id}:${payday.date}`)) continue;
        const row = applyOverride({
          id: `allocation:${allocation.id}:${payday.date}`,
          allocationId: allocation.id,
          date,
          paydayDate: payday.date,
          description: `${allocation.kind === "savings" ? "Savings" : "Expense allocation"} · ${allocation.name}`,
          kind: "expense",
          source: "allocation",
          allocationKind: allocation.kind,
          accountId: allocation.kind === "savings" ? linkedAccount("savings", allocation.currency, allocation.accountId) : allocation.accountId ?? null,
          sourceAccountId:
            linkedAccount("available", allocation.currency, allocation.sourceAccountId ?? salary.accountId),
          ...nativeFlow(allocation.amount, allocation.currency, "expense"),
        });
        if (row.date >= plan.startDate && row.date <= plan.endDate) rows.push(row);
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
  const linkedReserveUnassigned = new Map();
  const matchedReserveReceipts = new Set();
  if (plan.accountLinks) {
    const savedByAccount = new Map();
    for (const bill of annualBills) {
      const accountId = linkedAccount("annualReserve", bill.currency, bill.reserveAccountId);
      if (accountId == null) continue;
      savedByAccount.set(Number(accountId), roundMoney((savedByAccount.get(Number(accountId)) || 0) + getAnnualBillFunding(bill).savedAmount));
    }
    for (const [accountId, saved] of savedByAccount) {
      const account = cardAccountsById.get(accountId);
      const value = account && (Object.hasOwn(account, "nativeCurrentBalance") ? account.nativeCurrentBalance : account.currentBalance);
      if (value != null && Number.isFinite(Number(value)))
        linkedReserveUnassigned.set(accountId, Math.max(0, roundMoney(Number(value) - saved)));
    }
  }
  const result = [];
  const isBankReflected = (row, accountId) => liveAccounts.has(Number(accountId)) &&
    (row.date < today || (row.source === "transaction" && row.date <= today && !row.scheduled));
  function append(row) {
    if (!row.annualPayment && ["income", "expense"].includes(row.kind) &&
        row.source !== "creditCardDue" && statements.has(Number(row.accountId)))
      row = { ...row, usd: 0, php: 0, cardCreditActivity: true };
    if (plan.accountLinks && row.source === "transaction" &&
        Number(row.accountId) !== Number(plan.accountLinks[row.currency === "PHP" ? "availablePhpAccountId" : "availableUsdAccountId"]))
      row = { ...row, usd: 0, php: 0, linkedPocketActivity: true };
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
  for (let row of rows) {
    if (row.source === "reserve") {
      const candidates = row.reserveAllocations
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
                (payment.originalDate || payment.scheduledDate || payment.date) > state.paidThrough,
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
          return { billId, amount, defaultAmount: amount, capacity, reserveAccountId, sourceAccountId,
            ...(reflected ? { reflectedInStartingBalance: true } : {}),
          };
        });
      const originalAmount = roundMoney(candidates.reduce((total, allocation) => total + allocation.amount, 0));
      const plannedAmount = row.isOverride ? row.amount : originalAmount;
      const fundingPair = plan.accountLinks
        ? linkedFundingPair({ ...row, reserveAllocations: candidates }, plannedAmount, rows, completionActual, today, document) : null;
      const reserveAllocations = (fundingPair || row.isOverride
        ? overriddenReserveAllocations(candidates, fundingPair?.amount ?? row.amount)
        : candidates)
        .filter((allocation) => allocation.amount > 0)
        .map(({ defaultAmount, capacity, ...allocation }) => allocation);
      if (fundingPair) {
        const allocated = roundMoney(reserveAllocations.reduce((total, allocation) => total + allocation.amount, 0));
        const unassignedAmount = roundMoney(fundingPair.amount - allocated);
        if (unassignedAmount > 0) reserveAllocations.push({ billId: null, amount: unassignedAmount,
          sourceAccountId: fundingPair.source, reserveAccountId: fundingPair.destination });
      }
      const recordedReserveAccounts = new Set();
      if (plan.accountLinks) {
        for (const leg of planTransferLegs({ ...row, reserveAllocations }, rate).filter((leg) => leg.amount > 0)) {
          const receipt = completionActual.find((transaction) => !transaction.scheduled && transaction.date <= today &&
            !matchedReserveReceipts.has(String(transaction.transactionId)) && transferTransaction(transaction) &&
            transaction.kind === "income" && Number(transaction.accountId) === leg.accountId && transaction.currency === leg.currency &&
            Math.abs(transaction.amount - leg.amount) < 0.005 && Math.abs(dateTime(transaction.date) - dateTime(row.date)) <= 3 * DAY_MS);
          if (receipt) {
            matchedReserveReceipts.add(String(receipt.transactionId));
            recordedReserveAccounts.add(leg.accountId);
          }
        }
      }
      for (const allocation of reserveAllocations) {
        let internalContribution = allocation.reflectedInStartingBalance ? 0 : allocation.amount;
        const accountId = Number(allocation.reserveAccountId);
        if (recordedReserveAccounts.has(accountId)) {
          // The receipt is already in the linked bank balance. Assign only its
          // unearmarked portion to bill funding, independently of cash replay.
          internalContribution = Math.min(allocation.amount, linkedReserveUnassigned.get(accountId) || 0);
          linkedReserveUnassigned.set(accountId, roundMoney((linkedReserveUnassigned.get(accountId) || 0) - internalContribution));
        }
        if (internalContribution > 0) {
          if (allocation.billId == null) unassigned[row.currency] = roundMoney((unassigned[row.currency] || 0) + internalContribution);
          else {
            const key = reserveKey(allocation.billId, row.currency);
            billReserves.set(key, roundMoney((billReserves.get(key) || 0) + internalContribution));
          }
        }
      }
      const amount = roundMoney(
        reserveAllocations.reduce(
          (total, allocation) => total + allocation.amount,
          0,
        ),
      );
      if (amount <= 0 && !row.isOverride) continue;
      const appliedAmount = roundMoney(reserveAllocations.filter((allocation) => !allocation.reflectedInStartingBalance)
        .reduce((total, allocation) => total + allocation.amount, 0));
      append({
        ...row,
        originalAmount,
        ...(fundingPair ? { plannedAmount, actualTransferAmount: true } : {}),
        ...(row.isOverride ? { overrideRequestedAmount: row.amount } : {}),
        reserveAllocations,
        ...nativeFlow(amount, row.currency, "expense"),
        reserveDeltaUsd: row.currency === "USD" ? amount : 0,
        reserveDeltaPhp: row.currency === "PHP" ? amount : 0,
        reserveAppliedUsd: row.currency === "USD" ? appliedAmount : 0,
        reserveAppliedPhp: row.currency === "PHP" ? appliedAmount : 0,
      });
      continue;
    }
    if (plan.accountLinks && row.source === "allocation" && row.allocationKind === "savings") {
      const fundingPair = linkedFundingPair(row, row.amount, rows, completionActual, today, document);
      if (fundingPair) row = { ...row, plannedAmount: row.amount, actualTransferAmount: true,
        ...nativeFlow(fundingPair.amount, row.currency, "expense") };
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
        funding.paidThrough = row.originalDate || row.scheduledDate || row.date;
      }
      if (!reserveReflected) unassigned[row.currency] = roundMoney((unassigned[row.currency] || 0) - fromUnassigned);
      // Reconciliation keeps the full payment; only its unfunded portion uses available cash.
      append({
        ...row,
        grossAmount,
        reserveUsed,
        reserveShortfall,
        usd: row.currency === "USD" ? statements.has(Number(row.accountId)) ? reserveUsed : reserveShortfall > 0 ? -reserveShortfall : 0 : 0,
        php: row.currency === "PHP" ? statements.has(Number(row.accountId)) ? reserveUsed : reserveShortfall > 0 ? -reserveShortfall : 0 : 0,
        ...(statements.has(Number(row.accountId)) ? { cardCreditActivity: true } : {}),
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
  // General savings are outside the spending pocket, while a selected opening
  // share of the same account can already be available. Keep that ownership as
  // later savings allocations and transfers move funds between the pockets.
  const savingsAccounts = new Set((document.allocations || [])
    .filter((allocation) => allocation.kind === "savings" && allocation.accountId != null)
    .map((allocation) => `${Number(allocation.accountId)}:${allocation.currency}`));
  const annualByAccount = new Map();
  for (const bill of annualBills) {
    if (bill.reserveAccountId == null) continue;
    const key = `${Number(bill.reserveAccountId)}:${bill.currency}`;
    annualByAccount.set(key, roundMoney((annualByAccount.get(key) || 0) + getAnnualBillFunding(bill).savedAmount));
  }
  const accountsById = new Map((options.accounts || []).map((account) => [Number(account.id), account]));
  const holdsFunds = (accountId, currency) => {
    const account = accountsById.get(Number(accountId));
    return account && account.currency === currency && !account.isArchived && !account.is_archived &&
      !account.mergedIntoAccountId && !account.merged_into_account_id &&
      !["credit", "loan"].includes(account.type || account.account_type);
  };
  const selectedAvailable = new Map(opening.contributions.map((contribution) =>
    [`${contribution.accountId}:${contribution.currency}`, contribution.availableAmount]));
  const datedSavingsOpening = new Map((plan.accountOpeningBalances || [])
    .filter((selected) => {
      const key = `${Number(selected.accountId)}:${accountsById.get(Number(selected.accountId))?.currency}`;
      return !selectedAvailable.has(key);
    })
    .map((selected) => [`${Number(selected.accountId)}:${accountsById.get(Number(selected.accountId))?.currency}`, roundMoney(selected.balance)]));
  const outsideSavings = new Map();
  for (const key of savingsAccounts) {
    const account = accountsById.get(Number(key.split(":")[0]));
    const value = datedSavingsOpening.has(key) ? datedSavingsOpening.get(key)
      : account && (Object.hasOwn(account, "nativeCurrentBalance") ? account.nativeCurrentBalance : account.currentBalance);
    const known = ["number", "string"].includes(typeof value) && String(value).trim() && Number.isFinite(Number(value));
    outsideSavings.set(key, known
      ? roundMoney(Number(value) - (annualByAccount.get(key) || 0) - (selectedAvailable.get(key) || 0))
      : 0);
  }
  const releaseSavings = (key, amount, postedDebit) => {
    // Current bank balances already include a posted withdrawal. Reconstruct
    // the money in transit for this transfer without debiting that balance
    // again. Preserve a reserve deficit so it cannot be released as spare cash.
    const capacity = (outsideSavings.get(key) || 0) +
      (!datedSavingsOpening.has(key) && postedDebit ? amount : 0);
    return Math.min(amount, Math.max(0, capacity));
  };
  const transferFlows = new Map();
  const postedTransferFlows = new Map();
  const transferActuals = completionActual.filter((row) => !row.scheduled && row.date <= today &&
    (transferTransaction(row) || row.creditCardPaymentFor));
  const usedTransferActuals = new Set(completed.filter((row) => row.source !== "transaction" && row.source !== "creditCardDue")
    .flatMap((row) => row.matchedTransactionIds).map(String));
  for (const row of completed) {
    const future = row.date >= today && row.completionSource !== "transaction";
    if (row.source === "allocation" && row.allocationKind === "savings") {
      const key = `${Number(row.accountId)}:${row.currency}`;
      if (savingsAccounts.has(key) && (future || datedSavingsOpening.has(key)))
        outsideSavings.set(key, roundMoney((outsideSavings.get(key) || 0) + row.amount));
    }
    if (row.source !== "manual" || row.kind !== "transfer") continue;
    const from = `${Number(row.fromAccountId)}:${row.currency}`;
    const to = `${Number(row.toAccountId)}:${row.currency}`;
    const fromSavings = savingsAccounts.has(from);
    const toSavings = savingsAccounts.has(to);
    const matchedLegs = row.completionSource === "transaction"
      ? transferActuals.filter((actual) => row.matchedTransactionIds.some((transactionId) => String(transactionId) === String(actual.transactionId)))
      : [];
    for (const [accountId, kind] of [[row.fromAccountId, "expense"], [row.toAccountId, "income"]]) {
      if (matchedLegs.some((actual) => Number(actual.accountId) === Number(accountId) && actual.kind === kind)) continue;
      const match = transferActuals.find((actual) => !usedTransferActuals.has(String(actual.transactionId)) &&
        Number(actual.accountId) === Number(accountId) && actual.kind === kind && actual.currency === row.currency &&
        Math.abs(actual.amount - row.amount) < 0.005 && Math.abs(dateTime(actual.date) - dateTime(row.date)) <= 3 * DAY_MS);
      if (match) {
        matchedLegs.push(match);
        usedTransferActuals.add(String(match.transactionId));
      }
    }
    const fromPosted = matchedLegs.some((actual) => Number(actual.accountId) === Number(row.fromAccountId) && actual.kind === "expense");
    const toPosted = matchedLegs.some((actual) => Number(actual.accountId) === Number(row.toAccountId) && actual.kind === "income");
    // A bank transfer does not release an annual bill's earmark. Its reserve
    // assignment must be changed explicitly rather than counted as spare cash.
    const annualOnly = (annualByAccount.has(from) && !fromSavings) || (annualByAccount.has(to) && !toSavings);
    let delta = 0;
    let availableAccountId = null;
    if (Number(row.fromAccountId) !== Number(row.toAccountId) &&
        statements.has(Number(row.toAccountId)) && holdsFunds(row.fromAccountId, row.currency)) {
      const released = fromSavings ? releaseSavings(from, row.amount, fromPosted) : 0;
      delta = roundMoney(released - row.amount);
      availableAccountId = Number(row.fromAccountId);
      if (fromSavings && (datedSavingsOpening.has(from) || (future && !fromPosted)))
        outsideSavings.set(from, roundMoney((outsideSavings.get(from) || 0) - released));
    } else if (Number(row.fromAccountId) !== Number(row.toAccountId) && !annualOnly &&
        holdsFunds(row.fromAccountId, row.currency) && holdsFunds(row.toAccountId, row.currency)) {
      const released = fromSavings ? releaseSavings(from, row.amount, fromPosted) : 0;
      const replaySource = datedSavingsOpening.has(from) || (future && !fromPosted);
      const replayDestination = datedSavingsOpening.has(to) || (future && !toPosted);
      if (fromSavings && !toSavings) {
        delta = released;
        availableAccountId = Number(row.toAccountId);
        if (replaySource) outsideSavings.set(from, roundMoney((outsideSavings.get(from) || 0) - released));
      } else if (!fromSavings && toSavings) {
        delta = -row.amount;
        availableAccountId = Number(row.fromAccountId);
        if (replayDestination) outsideSavings.set(to, roundMoney((outsideSavings.get(to) || 0) + row.amount));
      } else if (fromSavings && toSavings) {
        if (replaySource) outsideSavings.set(from, roundMoney((outsideSavings.get(from) || 0) - released));
        if (replayDestination) outsideSavings.set(to, roundMoney((outsideSavings.get(to) || 0) + released));
      }
    }
    const availablePosted = matchedLegs.some((actual) => Number(actual.accountId) === availableAccountId);
    transferFlows.set(row.id, { delta, availableAccountId, availablePosted,
      postedAccountIds: [...new Set(matchedLegs.map((actual) => Number(actual.accountId)))],
      creditCardPaymentFor: statements.has(Number(row.toAccountId)) && holdsFunds(row.fromAccountId, row.currency) ? Number(row.toAccountId) : null,
    });
    if (plan.includeTransactions !== false) {
      for (const transaction of matchedLegs) {
        postedTransferFlows.set(String(transaction.transactionId),
          Number(transaction.accountId) === availableAccountId ? delta : 0);
      }
    }
  }
  // A matched conversion or expense allocation is represented by its posted
  // transactions. Keep the task visible without counting the same cash twice.
  let reconciledUsd = opening.usd;
  let reconciledPhp = opening.php;
  const reconciled = completed.map((row) => {
    const transfer = transferFlows.get(row.id);
    const postedTransfer = row.source === "transaction" && postedTransferFlows.has(String(row.transactionId));
    const nativeTransfer = transfer?.delta ?? (postedTransfer ? postedTransferFlows.get(String(row.transactionId)) : null);
    const usd = nativeTransfer === null ? row.usd : row.currency === "USD" ? nativeTransfer : 0;
    const php = nativeTransfer === null ? row.php : row.currency === "PHP" ? nativeTransfer : 0;
    const recordedFlow = plan.includeTransactions !== false && ((row.completionSource === "transaction" && row.source !== "transaction" &&
      (row.kind === "conversion" || row.kind === "transfer" || (row.source === "allocation" && row.allocationKind === "expense"))) || transfer?.availablePosted);
    const availableAccountId = transfer?.availableAccountId ?? row.accountId;
    const bankReflected = nativeTransfer !== null && (isBankReflected(row, availableAccountId) ||
      (transfer?.availablePosted && liveAccounts.has(Number(availableAccountId))));
    const balanceAppliedUsd = recordedFlow || bankReflected ? 0 : nativeTransfer === null ? row.balanceAppliedUsd : usd;
    const balanceAppliedPhp = recordedFlow || bankReflected ? 0 : nativeTransfer === null ? row.balanceAppliedPhp : php;
    reconciledUsd = roundMoney(reconciledUsd + balanceAppliedUsd);
    reconciledPhp = roundMoney(reconciledPhp + balanceAppliedPhp);
    return {
      ...row, usd, php, balanceAppliedUsd, balanceAppliedPhp,
      ...(transfer?.creditCardPaymentFor ? { creditCardPaymentFor: transfer.creditCardPaymentFor } : {}),
      ...(transfer ? { postedTransferAccountIds: transfer.postedAccountIds } : {}),
      ...(nativeTransfer !== null ? { reflectedInStartingBalance: Boolean(bankReflected && nativeTransfer) } : {}),
      ...(recordedFlow ? { reflectedInRecordedTransactions: true } : {}),
      balanceUsd: reconciledUsd, balancePhp: reconciledPhp,
    };
  });
  return plan.accountLinks
    ? linkedPlanTransactions(reconciled, plan, completionActual, options.accounts || [], rate, today)
    : reconciled;
}
