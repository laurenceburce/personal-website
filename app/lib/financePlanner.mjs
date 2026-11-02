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

export function billOccurrences(bill, start, end) {
  const days = billDueDays(bill);
  if (!days.length || !validRange(start, end)) return [];
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

/** Funding still needed for this item's current annual reserve. */
export function getAnnualBillFunding(bill, payPeriods = 26) {
  const amount =
    bill?.cadence === "annual" ? Math.max(0, roundMoney(bill.amount)) : 0;
  const savedAmount =
    bill?.cadence === "annual" ? Math.max(0, roundMoney(bill.savedAmount)) : 0;
  const remainingAmount = Math.max(0, roundMoney(amount - savedAmount));
  const periods = number(payPeriods) > 0 ? number(payPeriods) : 26;
  return {
    amount,
    savedAmount,
    remainingAmount,
    monthlyAmount: roundMoney(remainingAmount / 12),
    perPeriodAmount: roundMoney(remainingAmount / periods),
    fullyFunded: remainingAmount === 0,
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

export function getSummary(document, rate) {
  const salary = document.salary || {};
  const bills = document.bills || [];
  const allocations = document.allocations || [];
  const monthlyUsd = convert(salary.amount, salary.currency, "USD", rate);
  const monthlyPhp = convert(salary.amount, salary.currency, "PHP", rate);
  const monthlyBills = bills.filter((bill) => bill.cadence !== "annual");
  const annualBills = bills.filter((bill) => bill.cadence === "annual");
  const annualFunding = annualBills.map((bill) => ({
    currency: bill.currency,
    ...getAnnualBillFunding(bill),
  }));
  const billsUsd = roundMoney(
    monthlyBills
      .filter((bill) => bill.currency !== "PHP")
      .reduce((total, bill) => total + number(bill.amount), 0),
  );
  const billsPhp = roundMoney(
    monthlyBills
      .filter((bill) => bill.currency === "PHP")
      .reduce((total, bill) => total + number(bill.amount), 0),
  );
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
  const annualMonthlyUsd = roundMoney(annualRemainingUsd / 12);
  const annualMonthlyPhp = roundMoney(annualRemainingPhp / 12);
  const monthlyCommitmentsUsd = roundMoney(
    billsUsd + convert(billsPhp, "PHP", "USD", rate) + annualMonthlyUsd,
  );
  const monthlyCommitmentsPhp = roundMoney(
    billsPhp + convert(billsUsd, "USD", "PHP", rate) + annualMonthlyPhp,
  );
  const payPeriods = salary.payFrequency === "biweekly" ? 26 : 24;
  const incomePerPeriodUsd = roundMoney((monthlyUsd * 12) / payPeriods);
  const billsUsdPerPeriod = roundMoney((billsUsd * 12) / payPeriods);
  const billsPhpPerPeriod = roundMoney((billsPhp * 12) / payPeriods);
  const billsPhpPerPeriodUsd = convert(billsPhpPerPeriod, "PHP", "USD", rate);
  const annualPerPeriodUsd = roundMoney(annualRemainingUsd / payPeriods);
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
    annualUsd,
    annualPhp,
    annualSavedUsd,
    annualSavedPhp,
    annualRemainingUsd,
    annualRemainingPhp,
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
    forecast.kind === "conversion" ||
    forecast.kind !== transaction.kind ||
    forecast.currency !== transaction.currency
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
      paydayDate: occurrence.date,
      ...nativeFlow(occurrence.amount, occurrence.currency, "income"),
    });
  for (const bill of document.bills || []) {
    for (const occurrence of billOccurrences(bill, matchingStart, matchingEnd))
      forecasts.push({
        id: `bill:${bill.id}:${occurrence.date}`,
        billId: bill.id,
        date: occurrence.date,
        description: bill.name,
        kind: "expense",
        source: "bill",
        annualPayment: bill.cadence === "annual",
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
      ...flow,
    });
  }

  const actual = [];
  const seenTransactions = new Set();
  const today = Number.isFinite(dateTime(options.today))
    ? options.today
    : localDate();
  if (plan.includeTransactions !== false) {
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
  const usedForecasts = new Set();
  const actualPayDates = new Map();
  const forecastPriority = (row) =>
    row.source === "bill" ? 0 : row.source === "salary" ? 1 : 2;
  actual.sort(
    (first, second) =>
      first.date.localeCompare(second.date) ||
      first.id.localeCompare(second.id),
  );
  for (const transaction of actual) {
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
    ...actual,
  ];
  const annualBills = (document.bills || []).filter(
    (bill) => bill.cadence === "annual" && ["USD", "PHP"].includes(bill.currency),
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
  let balanceUsd = roundMoney(plan.openingUsd);
  let balancePhp = roundMoney(plan.openingPhp);
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
  for (const bill of annualBills) {
    const key = reserveKey(bill.id, bill.currency);
    const funding = getAnnualBillFunding(bill, payPeriods);
    billFunding.set(key, {
      amount: funding.amount,
      base: funding.remainingAmount,
    });
    billReserves.set(
      key,
      roundMoney(
        (billReserves.get(key) || 0) + funding.savedAmount,
      ),
    );
  }
  const result = [];
  function append(row) {
    balanceUsd = roundMoney(balanceUsd + row.usd);
    balancePhp = roundMoney(balancePhp + row.php);
    reserveUsd = roundMoney(reserveUsd + number(row.reserveDeltaUsd));
    reservePhp = roundMoney(reservePhp + number(row.reserveDeltaPhp));
    result.push({
      ...row,
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
        .map(({ billId }) => {
          const key = reserveKey(billId, row.currency);
          const funding = billFunding.get(key);
          const capacity = Math.max(
            0,
            roundMoney(funding.amount - (billReserves.get(key) || 0)),
          );
          const amount = Math.min(
            capacity,
            reserveContribution(
              funding.base,
              payPeriods,
              paydayIndex(salary, row.paydayDate),
            ),
          );
          billReserves.set(
            key,
            roundMoney((billReserves.get(key) || 0) + amount),
          );
          return { billId, amount };
        })
        .filter((allocation) => allocation.amount > 0);
      const amount = roundMoney(
        reserveAllocations.reduce(
          (total, allocation) => total + allocation.amount,
          0,
        ),
      );
      if (amount <= 0) continue;
      append({
        ...row,
        reserveAllocations,
        ...nativeFlow(amount, row.currency, "expense"),
        reserveDeltaUsd: row.currency === "USD" ? amount : 0,
        reserveDeltaPhp: row.currency === "PHP" ? amount : 0,
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
      billReserves.set(key, roundMoney(saved - fromBill));
      const funding = billFunding.get(key);
      if (funding) funding.base = funding.amount;
      unassigned[row.currency] = roundMoney(
        (unassigned[row.currency] || 0) - fromUnassigned,
      );
      // Reconciliation keeps the full payment; only its unfunded portion uses available cash.
      append({
        ...row,
        grossAmount,
        reserveUsed,
        reserveShortfall,
        usd: row.currency === "USD" && reserveShortfall > 0 ? -reserveShortfall : 0,
        php: row.currency === "PHP" && reserveShortfall > 0 ? -reserveShortfall : 0,
        reserveDeltaUsd: row.currency === "USD" && reserveUsed > 0 ? -reserveUsed : 0,
        reserveDeltaPhp: row.currency === "PHP" && reserveUsed > 0 ? -reserveUsed : 0,
      });
      continue;
    }
    append(row);
  }
  return result;
}
