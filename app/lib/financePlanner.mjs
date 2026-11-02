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
  return new Date(time).toISOString().slice(0, 10) === value ? time : Number.NaN;
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
  return Number.isFinite(dateTime(start)) && Number.isFinite(dateTime(end)) && start <= end;
}

function eachMonth(start, end, visit) {
  if (!validRange(start, end)) return;
  const first = new Date(dateTime(start));
  const last = new Date(dateTime(end));
  for (let index = first.getUTCFullYear() * 12 + first.getUTCMonth(); index <= last.getUTCFullYear() * 12 + last.getUTCMonth(); index += 1) {
    visit(Math.floor(index / 12), index % 12);
  }
}

export function localDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function addDays(value, days) {
  const time = dateTime(value);
  return Number.isFinite(time) ? isoDate(time + Math.trunc(number(days)) * DAY_MS) : "";
}

export function formatDate(value, options = {}) {
  const time = dateTime(value);
  if (!Number.isFinite(time)) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", ...options, timeZone: "UTC"
  }).format(new Date(time));
}

export function money(value, currency = "USD") {
  return new Intl.NumberFormat(currency === "PHP" ? "en-PH" : "en-US", {
    style: "currency", currency: currency === "PHP" ? "PHP" : "USD",
    minimumFractionDigits: 2, maximumFractionDigits: 2
  }).format(number(value));
}

export function convert(value, from, to, rate) {
  const safeRate = Number.isFinite(Number(rate)) && Number(rate) > 0 ? Number(rate) : 1;
  if (from === to) return roundMoney(value);
  return roundMoney(from === "PHP" ? number(value) / safeRate : number(value) * safeRate);
}

export function billOccurrences(bill, start, end) {
  const day = Number(bill.dueDay);
  if (!Number.isInteger(day) || day < 1 || day > 31 || !validRange(start, end)) return [];
  const months = [...new Set((bill.dueMonths || []).map(Number).filter((month) => Number.isInteger(month) && month >= 1 && month <= 12))].sort((a, b) => a - b);
  if (bill.cadence === "annual" && !months.length) return [];
  const occurrences = [];
  eachMonth(start, end, (year, month) => {
    if (bill.cadence === "annual" && !months.includes(month + 1)) return;
    const date = monthDate(year, month, day);
    if (date < start || date > end) return;
    let amount = roundMoney(bill.amount);
    if (bill.cadence === "annual") {
      const totalCents = Math.round(number(bill.amount) * 100);
      const installmentCents = Math.floor(totalCents / months.length);
      // Put the rounding remainder in the last installment to preserve the annual total.
      amount = (installmentCents + (month + 1 === months.at(-1) ? totalCents % months.length : 0)) / 100;
    }
    occurrences.push({ date, amount, currency: bill.currency, billId: bill.id });
  });
  return occurrences;
}

export function salaryOccurrences(salary, start, end) {
  if (!validRange(start, end) || !Number.isFinite(dateTime(salary.firstPayDate))) return [];
  const anchor = salary.firstPayDate;
  if (anchor > end) return [];
  const payPeriods = salary.payFrequency === "biweekly" ? 26 : 24;
  const amount = roundMoney(number(salary.amount) * 12 / payPeriods);
  const result = [];
  if (salary.payFrequency === "biweekly") {
    const anchorTime = dateTime(anchor);
    const offset = Math.max(0, Math.ceil((dateTime(start) - anchorTime) / (14 * DAY_MS)));
    for (let time = anchorTime + offset * 14 * DAY_MS; time <= dateTime(end); time += 14 * DAY_MS) {
      result.push({ date: isoDate(time), amount, currency: salary.currency });
    }
  } else {
    const day = Number(anchor.slice(8));
    const days = day <= 15 ? [day, day + 15] : [day - 15, day];
    eachMonth(start, end, (year, month) => {
      for (const dueDay of days) {
        const date = monthDate(year, month, dueDay);
        if (date >= start && date <= end && date >= anchor) result.push({ date, amount, currency: salary.currency });
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
  const billsUsd = roundMoney(monthlyBills.filter((bill) => bill.currency !== "PHP").reduce((total, bill) => total + number(bill.amount), 0));
  const billsPhp = roundMoney(monthlyBills.filter((bill) => bill.currency === "PHP").reduce((total, bill) => total + number(bill.amount), 0));
  const annualNativeUsd = annualBills.filter((bill) => bill.currency !== "PHP").reduce((total, bill) => total + number(bill.amount), 0);
  const annualNativePhp = annualBills.filter((bill) => bill.currency === "PHP").reduce((total, bill) => total + number(bill.amount), 0);
  const annualUsd = roundMoney(annualNativeUsd + convert(annualNativePhp, "PHP", "USD", rate));
  // Calculate each currency from its native amounts rather than converting a rounded USD total back to PHP.
  const annualPhp = roundMoney(annualNativePhp + convert(annualNativeUsd, "USD", "PHP", rate));
  const annualMonthlyUsd = roundMoney(annualUsd / 12);
  const annualMonthlyPhp = roundMoney(annualPhp / 12);
  const monthlyCommitmentsUsd = roundMoney(billsUsd + convert(billsPhp, "PHP", "USD", rate) + annualMonthlyUsd);
  const monthlyCommitmentsPhp = roundMoney(billsPhp + convert(billsUsd, "USD", "PHP", rate) + annualMonthlyPhp);
  const payPeriods = salary.payFrequency === "biweekly" ? 26 : 24;
  const incomePerPeriodUsd = roundMoney(monthlyUsd * 12 / payPeriods);
  const billsUsdPerPeriod = roundMoney(billsUsd * 12 / payPeriods);
  const billsPhpPerPeriod = roundMoney(billsPhp * 12 / payPeriods);
  const billsPhpPerPeriodUsd = convert(billsPhpPerPeriod, "PHP", "USD", rate);
  const annualPerPeriodUsd = roundMoney(annualUsd / payPeriods);
  const remainingPerPeriodUsd = roundMoney(incomePerPeriodUsd - billsUsdPerPeriod - billsPhpPerPeriodUsd - annualPerPeriodUsd);
  const allocationsPerPeriodUsd = roundMoney(allocations.reduce((total, allocation) => total + convert(allocation.amount, allocation.currency, "USD", rate), 0));
  return {
    monthlyUsd, monthlyPhp, billsUsd, billsPhp, annualUsd, annualPhp, annualMonthlyUsd, annualMonthlyPhp,
    monthlyCommitmentsUsd, monthlyRemainingUsd: roundMoney(monthlyUsd - monthlyCommitmentsUsd),
    monthlyCommitmentsPhp, monthlyRemainingPhp: roundMoney(monthlyPhp - monthlyCommitmentsPhp),
    payPeriods, incomePerPeriodUsd, billsUsdPerPeriod, billsPhpPerPeriod,
    billsPhpPerPeriodUsd, annualPerPeriodUsd, remainingPerPeriodUsd,
    allocationsPerPeriodUsd, unallocatedPerPeriodUsd: roundMoney(remainingPerPeriodUsd - allocationsPerPeriodUsd)
  };
}

export function buildPlanRows(plan, document, rate) {
  const rows = [];
  if (!validRange(plan.startDate, plan.endDate)) return rows;
  if (plan.includeIncome) {
    for (const occurrence of salaryOccurrences(document.salary || {}, plan.startDate, plan.endDate)) {
      rows.push({
        id: `salary:${occurrence.date}`, date: occurrence.date, description: "Salary",
        kind: "income", source: "salary", usd: occurrence.currency === "PHP" ? 0 : occurrence.amount,
        php: occurrence.currency === "PHP" ? occurrence.amount : 0
      });
    }
  }
  for (const bill of document.bills || []) {
    for (const occurrence of billOccurrences(bill, plan.startDate, plan.endDate)) {
      rows.push({
        id: `bill:${bill.id}:${occurrence.date}`, billId: bill.id, date: occurrence.date,
        description: bill.name, kind: "expense", source: "bill",
        usd: bill.currency === "PHP" ? 0 : -occurrence.amount,
        php: bill.currency === "PHP" ? -occurrence.amount : 0
      });
    }
  }
  for (const entry of plan.entries || []) {
    if (!Number.isFinite(dateTime(entry.date)) || entry.date < plan.startDate || entry.date > plan.endDate) continue;
    const amount = roundMoney(entry.amount);
    const sign = entry.kind === "income" ? 1 : -1;
    let usd = entry.currency === "PHP" ? 0 : sign * amount;
    let php = entry.currency === "PHP" ? sign * amount : 0;
    if (entry.kind === "conversion") {
      if (entry.currency === "PHP") usd = convert(amount, "PHP", "USD", rate);
      else php = convert(amount, "USD", "PHP", rate);
    }
    rows.push({
      id: `entry:${entry.id}`, entryId: entry.id, date: entry.date,
      description: entry.description, kind: entry.kind, source: "manual", usd, php
    });
  }
  const priority = (row) => row.kind === "income" ? 0 : row.kind === "conversion" ? 1 : 2;
  rows.sort((first, second) => first.date.localeCompare(second.date) || priority(first) - priority(second));
  let balanceUsd = roundMoney(plan.openingUsd);
  let balancePhp = roundMoney(plan.openingPhp);
  return rows.map((row) => {
    balanceUsd = roundMoney(balanceUsd + row.usd);
    balancePhp = roundMoney(balancePhp + row.php);
    return { ...row, balanceUsd, balancePhp };
  });
}
