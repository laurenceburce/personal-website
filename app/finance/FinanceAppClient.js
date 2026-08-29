"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";

const TABS = ["home", "bills", "transactions", "profile"];
const TAB_ALIASES = {
  overview: "home",
  add: "transactions",
  goals: "profile",
  accounts: "profile"
};
const ACCOUNT_TYPES = ["checking", "savings", "credit", "cash", "investment", "loan", "other"];
const COLORS = ["#34d399", "#22d3ee", "#fbbf24", "#fb7185", "#a78bfa", "#f97316"];
const PAY_PERIOD_ANCHOR_START = "2026-07-18";
const MS_PER_DAY = 86_400_000;
const TRANSACTION_HISTORY_PAGE_SIZE = 50;
const WEEKDAY_DUE_ORDER = {
  monday: 41,
  tuesday: 42,
  wednesday: 43,
  thursday: 44,
  friday: 45,
  saturday: 46,
  sunday: 47
};

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

const phpFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "PHP",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

const phpRateFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "PHP",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4
});

function normalizeTab(tab) {
  const value = String(tab || "").toLowerCase();
  const normalized = TAB_ALIASES[value] || value;
  return TABS.includes(normalized) ? normalized : "home";
}

function loadPlaidScript() {
  if (typeof window === "undefined") return Promise.reject(new Error("Plaid Link is only available in the browser."));
  if (window.Plaid) return Promise.resolve(window.Plaid);

  return new Promise((resolve, reject) => {
    const existing = document.querySelector("script[data-plaid-link]");
    if (existing) {
      existing.addEventListener("load", () => resolve(window.Plaid));
      existing.addEventListener("error", () => reject(new Error("Plaid Link failed to load.")));
      return;
    }

    const script = document.createElement("script");
    script.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
    script.async = true;
    script.dataset.plaidLink = "true";
    script.onload = () => resolve(window.Plaid);
    script.onerror = () => reject(new Error("Plaid Link failed to load."));
    document.head.appendChild(script);
  });
}

function money(value, currency = "USD") {
  return currency === "PHP"
    ? phpFormatter.format(Number(value || 0))
    : usdFormatter.format(Number(value || 0));
}

function compactAmountText(value) {
  const amount = Math.abs(Number(value || 0));
  if (!Number.isFinite(amount)) return "0";

  const units = [
    { value: 1_000_000_000, suffix: "B" },
    { value: 1_000_000, suffix: "M" },
    { value: 1_000, suffix: "K" }
  ];
  const unit = units.find((item) => amount >= item.value);
  if (!unit) return amount.toFixed(2);

  const scaled = amount / unit.value;
  return `${scaled.toFixed(2)}${unit.suffix}`;
}

function compactMoney(value, currency = "USD") {
  const amount = Number(value || 0);
  const sign = amount < 0 ? "-" : "";
  const symbol = currency === "PHP" ? "\u20b1" : "$";
  return `${sign}${symbol}${compactAmountText(amount)}`;
}

function exchangeRateMoney(value) {
  return phpRateFormatter.format(Number(value || 0));
}

function toMoneyValue(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
}

function convertAmount(value, fromCurrency, toCurrency, exchangeRate) {
  const amount = Number(value || 0);
  const rate = Number(exchangeRate || 1);

  if (fromCurrency === toCurrency) return toMoneyValue(amount);
  if (fromCurrency === "USD" && toCurrency === "PHP") return toMoneyValue(amount * rate);
  if (fromCurrency === "PHP" && toCurrency === "USD") return toMoneyValue(amount / rate);
  return toMoneyValue(amount);
}

function formatRateTimestamp(value) {
  if (!value) return "Not refreshed yet";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function colorForConnection(provider) {
  return provider === "brankas" ? "#fbbf24" : "#22d3ee";
}

function niceAxisMax(value) {
  const amount = Math.abs(Number(value || 0));
  if (!Number.isFinite(amount) || amount <= 0) return 100;

  const exponent = Math.floor(Math.log10(amount));
  const base = 10 ** exponent;
  const fraction = amount / base;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;

  return niceFraction * base;
}

function shortChartLabel(label, maxLength = 12) {
  const text = String(label || "").trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(1, maxLength - 2))}...` : text;
}

function dueDayFromLabel(dueLabel) {
  const text = String(dueLabel || "").trim().toLowerCase();
  const exactDay = text.match(/^([1-9]|[12][0-9]|3[01])(?:st|nd|rd|th)?$/);
  const looseDay = text.match(/\b([1-9]|[12][0-9]|3[01])\b/);
  const day = Number(exactDay?.[1] || looseDay?.[1] || 0);
  return day >= 1 && day <= 31 ? day : null;
}

function dueSortValue(dueLabel) {
  const day = dueDayFromLabel(dueLabel);
  if (day) return day;

  const text = String(dueLabel || "").trim().toLowerCase();
  return WEEKDAY_DUE_ORDER[text] || 99;
}

function sortBillsByDueDate(first, second) {
  const dueDiff = dueSortValue(first.dueLabel) - dueSortValue(second.dueLabel);
  if (dueDiff !== 0) return dueDiff;
  return String(first.name || "").localeCompare(String(second.name || ""));
}

function billDueDate(bill, month) {
  const day = dueDayFromLabel(bill.dueLabel);
  if (!day) return null;

  const [year, monthNumber] = String(month || "").split("-").map(Number);
  if (!year || !monthNumber) return null;

  const lastDay = new Date(year, monthNumber, 0).getDate();
  return new Date(year, monthNumber - 1, Math.min(day, lastDay), 23, 59, 59, 999);
}

function monthName(month) {
  return new Date(`${month}-01T12:00:00`).toLocaleDateString("en-US", { month: "short" });
}

function formatShortDate(value) {
  if (!value) return "";
  return new Date(`${value}T12:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function formatMonthLabel(month) {
  if (!month) return "Month";
  return new Date(`${month}-01T12:00:00`).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric"
  });
}

function utcTimeForDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return Number.NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function dateFromUtcTime(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function latestTransactionDate(transactions, fallbackDate) {
  return [...transactions]
    .map((transaction) => transaction.date)
    .filter(Boolean)
    .sort()
    .at(-1) || fallbackDate;
}

function payPeriodForDate(value) {
  const dateTime = utcTimeForDate(value);
  const anchorTime = utcTimeForDate(PAY_PERIOD_ANCHOR_START);
  const safeDateTime = Number.isFinite(dateTime) ? dateTime : anchorTime;
  const periodIndex = Math.floor((safeDateTime - anchorTime) / (MS_PER_DAY * 14));
  const startTime = anchorTime + periodIndex * MS_PER_DAY * 14;
  const endTime = startTime + MS_PER_DAY * 13;
  const start = dateFromUtcTime(startTime);
  const end = dateFromUtcTime(endTime);

  return {
    id: start,
    start,
    end,
    label: `${formatShortDate(start)} - ${formatShortDate(end)}`,
    detail: `${start} to ${end}`
  };
}

function buildMonthOptions(transactions, fallbackMonth) {
  const months = new Set([
    fallbackMonth,
    ...transactions.map((transaction) => String(transaction.date || "").slice(0, 7)).filter((month) => /^\d{4}-\d{2}$/.test(month))
  ]);

  return [...months].sort().reverse();
}

function buildYearOptions(transactions, fallbackYear) {
  const years = new Set([
    fallbackYear,
    ...transactions.map((transaction) => String(transaction.date || "").slice(0, 4)).filter((year) => /^\d{4}$/.test(year))
  ]);

  return [...years].sort().reverse();
}

function buildPayPeriodOptions(transactions, fallbackDate) {
  const periods = new Map();
  const dates = transactions.map((transaction) => transaction.date).filter(Boolean);
  const sourceDates = dates.length > 0 ? dates : [fallbackDate];

  for (const date of sourceDates) {
    const period = payPeriodForDate(date);
    periods.set(period.id, period);
  }

  return [...periods.values()].sort((first, second) => second.start.localeCompare(first.start));
}

function transactionInPayPeriod(transaction, period) {
  if (!period || !transaction.date) return false;
  return transaction.date >= period.start && transaction.date <= period.end;
}

function transactionMatchesDateFilter(transaction, filter) {
  const date = String(transaction.date || "");
  if (!date) return false;
  if (filter.from && date < filter.from) return false;
  if (filter.to && date > filter.to) return false;
  return true;
}

function formatBillDue(bill, month) {
  const dueDate = billDueDate(bill, month);
  if (dueDate) {
    return dueDate.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric"
    });
  }

  const label = String(bill.dueLabel || "open").trim();
  const weekday = label.toLowerCase();
  if (WEEKDAY_DUE_ORDER[weekday]) {
    return `every ${label.charAt(0).toUpperCase()}${label.slice(1).toLowerCase()} in ${monthName(month)}`;
  }

  return `${monthName(month)} - ${label}`;
}

function joinSourceParts(parts) {
  const seen = new Set();
  const cleanParts = parts
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .filter((part) => {
      const key = part.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return cleanParts.length > 0 ? cleanParts.join(" - ") : "Account/bank not set";
}

function transactionSourceLabel(transaction) {
  return joinSourceParts([
    transaction.accountName,
    transaction.institutionName,
    transaction.provider
  ]);
}

function billSourceLabel(bill) {
  const match = bill.matchedTransaction || {};
  return joinSourceParts([
    bill.paymentAccount,
    match.accountName,
    match.institutionName,
    match.provider
  ]);
}

const TRANSACTION_TEXT_STOP_WORDS = new Set([
  "the",
  "and",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "from",
  "into",
  "acct",
  "account",
  "payment",
  "pmt",
  "bill",
  "auto",
  "online",
  "mobile"
]);

const TRANSFER_HINT_WORDS = [
  "transfer",
  "xfer",
  "payment",
  "pmt",
  "autopay",
  "automatic",
  "ach",
  "deposit",
  "withdrawal",
  "withdraw",
  "zelle",
  "venmo",
  "paypal",
  "gcash",
  "cashapp"
];

const FEE_WORDS = new Set(["fee", "fees", "charge", "charges", "maintenance", "service"]);
const REVERSAL_WORDS = new Set(["waived", "waiver", "refund", "refunded", "reversal", "reversed", "credit"]);

function transactionTitle(transaction) {
  return transaction.merchant || transaction.category || "Transaction";
}

function tokenizeFinanceText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .match(/[a-z0-9]+/g) || [];
}

function usefulFinanceTokens(value) {
  return tokenizeFinanceText(value)
    .filter((token) => token.length > 1 && !TRANSACTION_TEXT_STOP_WORDS.has(token));
}

function financeTextMatches(source, target) {
  const sourceTokens = tokenizeFinanceText(source);
  const targetTokens = usefulFinanceTokens(target);
  if (sourceTokens.length === 0 || targetTokens.length === 0) return false;

  const sourceText = sourceTokens.join(" ");
  const targetText = targetTokens.join(" ");
  if (sourceText.includes(targetText) || targetText.includes(sourceText)) return true;

  const matches = targetTokens.filter((targetToken) => (
    sourceTokens.some((sourceToken) => sourceToken === targetToken || sourceToken.includes(targetToken) || targetToken.includes(sourceToken))
  ));

  return matches.length >= Math.min(2, targetTokens.length);
}

function strictFinanceTextMatches(source, target) {
  const sourceTokens = tokenizeFinanceText(source);
  const targetTokens = usefulFinanceTokens(target);
  if (sourceTokens.length === 0 || targetTokens.length === 0) return false;

  const sourceTokenSet = new Set(sourceTokens);
  const exactMatches = targetTokens.filter((targetToken) => sourceTokenSet.has(targetToken));
  if (exactMatches.length === targetTokens.length) return true;

  if (targetTokens.length === 1) {
    const targetToken = targetTokens[0];
    return sourceTokens.some((sourceToken) => sourceToken === targetToken);
  }

  return exactMatches.length >= Math.max(2, Math.ceil(targetTokens.length * 0.75));
}

function transactionSearchText(transaction) {
  return [
    transaction.merchant,
    transaction.category,
    transaction.note
  ].filter(Boolean).join(" ");
}

function transactionAmountUsd(transaction, exchangeRate) {
  return Math.abs(convertAmount(transaction.amount, transaction.currency, "USD", exchangeRate));
}

function transactionSignedUsd(transaction, exchangeRate) {
  const amountUsd = transactionAmountUsd(transaction, exchangeRate);
  return transaction.kind === "income" ? amountUsd : -amountUsd;
}

function transactionSignedNativeAmount(transaction) {
  const amount = Number(transaction.amount || 0);
  return transaction.kind === "income" ? amount : -amount;
}

function transactionMonth(transaction) {
  return String(transaction.date || "").slice(0, 7) || "";
}

function dateDistanceInDays(firstDate, secondDate) {
  const first = new Date(`${firstDate}T12:00:00Z`).getTime();
  const second = new Date(`${secondDate}T12:00:00Z`).getTime();
  if (!Number.isFinite(first) || !Number.isFinite(second)) return 999;
  return Math.abs(Math.round((first - second) / 86_400_000));
}

function amountClose(firstAmount, secondAmount, percent = 0.08) {
  const first = Math.abs(Number(firstAmount || 0));
  const second = Math.abs(Number(secondAmount || 0));
  if (!first || !second) return false;

  const tolerance = Math.max(2, Math.min(first, second) * percent);
  return Math.abs(first - second) <= tolerance;
}

function billAmountClose(firstAmount, secondAmount) {
  const first = Math.abs(Number(firstAmount || 0));
  const second = Math.abs(Number(secondAmount || 0));
  if (!first || !second) return false;

  const tolerance = Math.max(0.25, Math.min(5, Math.min(first, second) * 0.05));
  return Math.abs(first - second) <= tolerance;
}

function textHasAnyToken(value, words) {
  const tokens = tokenizeFinanceText(value);
  return tokens.some((token) => words.has(token));
}

function billAllowsFeeTransaction(bill, transaction) {
  const transactionLooksLikeFee = textHasAnyToken(transactionSearchText(transaction), FEE_WORDS);
  if (!transactionLooksLikeFee) return true;
  return textHasAnyToken(bill.name, FEE_WORDS);
}

function findBillForTransaction(transaction, recurringBills, exchangeRate) {
  if (transaction.kind !== "expense" || transaction.pending) return null;

  const transactionUsd = transactionAmountUsd(transaction, exchangeRate);
  const transactionText = transactionSearchText(transaction);
  const sourceText = transactionSourceLabel(transaction);
  const matches = recurringBills
    .map((bill) => {
      const billUsd = Number(bill.amountUsd || 0);
      const matchedById = String(bill.matchedTransaction?.id || "") === String(transaction.id);
      const nameMatched = strictFinanceTextMatches(transactionText, bill.name);
      const sourceMatched = bill.paymentAccount ? financeTextMatches(sourceText, bill.paymentAccount) : false;
      const amountMatched = billUsd > 0 ? billAmountClose(transactionUsd, billUsd) : true;

      if (!matchedById && (!nameMatched || !billAllowsFeeTransaction(bill, transaction))) return null;

      return {
        bill,
        score: (matchedById ? 100 : 0) + (nameMatched ? 12 : 0) + (sourceMatched ? 4 : 0) + (amountMatched ? 4 : 0)
      };
    })
    .filter(Boolean)
    .sort((first, second) => second.score - first.score || String(first.bill.name || "").localeCompare(String(second.bill.name || "")));

  return matches[0]?.bill || null;
}

function relatedFeeTokens(transaction) {
  return usefulFinanceTokens(transactionSearchText(transaction))
    .filter((token) => !REVERSAL_WORDS.has(token));
}

function relatedFeeTextMatches(outgoing, incoming) {
  const outgoingTokens = new Set(relatedFeeTokens(outgoing));
  const incomingTokens = relatedFeeTokens(incoming);
  if (outgoingTokens.size === 0 || incomingTokens.length === 0) return false;

  const shared = incomingTokens.filter((token) => outgoingTokens.has(token));
  return shared.length >= Math.min(2, Math.max(1, incomingTokens.length - 1));
}

function feeReversalPairScore(outgoing, incoming, exchangeRate) {
  if (outgoing.kind !== "expense" || incoming.kind !== "income") return -1;
  if (String(outgoing.id) === String(incoming.id)) return -1;
  if (outgoing.accountId && incoming.accountId && String(outgoing.accountId) !== String(incoming.accountId)) return -1;

  const outgoingText = transactionSearchText(outgoing);
  const incomingText = transactionSearchText(incoming);
  const hasFee = textHasAnyToken(outgoingText, FEE_WORDS) || textHasAnyToken(incomingText, FEE_WORDS);
  const hasReversal = textHasAnyToken(incomingText, REVERSAL_WORDS) || textHasAnyToken(outgoingText, REVERSAL_WORDS);
  if (!hasFee || !hasReversal || !relatedFeeTextMatches(outgoing, incoming)) return -1;

  const outgoingUsd = transactionAmountUsd(outgoing, exchangeRate);
  const incomingUsd = transactionAmountUsd(incoming, exchangeRate);
  if (!billAmountClose(outgoingUsd, incomingUsd)) return -1;

  const dayDistance = dateDistanceInDays(outgoing.date, incoming.date);
  if (dayDistance > 7) return -1;

  return 120 - dayDistance * 4 - Math.abs(outgoingUsd - incomingUsd);
}

function transferHintScore(first, second) {
  const text = tokenizeFinanceText([
    transactionSearchText(first),
    transactionSearchText(second)
  ].join(" "));

  return TRANSFER_HINT_WORDS.reduce((score, word) => (
    text.some((token) => token === word || token.includes(word)) ? score + 1 : score
  ), 0);
}

function transferPairScore(outgoing, incoming, exchangeRate) {
  if (outgoing.kind !== "expense" || incoming.kind !== "income") return -1;
  if (String(outgoing.id) === String(incoming.id)) return -1;
  if (outgoing.accountId && incoming.accountId && String(outgoing.accountId) === String(incoming.accountId)) return -1;

  const outgoingUsd = transactionAmountUsd(outgoing, exchangeRate);
  const incomingUsd = transactionAmountUsd(incoming, exchangeRate);
  if (!amountClose(outgoingUsd, incomingUsd, 0.04)) return -1;

  const dayDistance = dateDistanceInDays(outgoing.date, incoming.date);
  if (dayDistance > 4) return -1;

  const hintScore = transferHintScore(outgoing, incoming);
  if (hintScore === 0) return -1;

  const amountDiff = Math.abs(outgoingUsd - incomingUsd);
  return 100 + hintScore * 10 - dayDistance * 6 - amountDiff;
}

function transactionLooksLikeCreditAccount(transaction) {
  const text = tokenizeFinanceText([
    transaction.accountType,
    transaction.accountName,
    transaction.category,
    transaction.merchant,
    transaction.note
  ].join(" "));

  return text.includes("credit") || text.includes("card");
}

function transactionLooksLikePayment(transaction) {
  const text = tokenizeFinanceText([
    transaction.category,
    transaction.merchant,
    transaction.note
  ].join(" "));

  return text.some((token) => ["payment", "pmt", "pay", "paid"].includes(token))
    || (text.includes("thank") && text.includes("you"));
}

function isCreditCardPaymentGroup(group) {
  if (group.type !== "transfer") return false;
  return group.transactions.some(transactionLooksLikeCreditAccount)
    && group.transactions.some(transactionLooksLikePayment);
}

function billExpectedAmountUsd(bill, exchangeRate) {
  const amountUsd = Number(bill?.amountUsd || 0);
  if (amountUsd > 0) return toMoneyValue(amountUsd);
  return toMoneyValue(convertAmount(bill?.amountPhp || 0, "PHP", "USD", exchangeRate));
}

function billActualPaidUsd(bill, exchangeRate) {
  if (bill?.matchedTransaction) return transactionAmountUsd(bill.matchedTransaction, exchangeRate);
  return bill?.isPaid ? billExpectedAmountUsd(bill, exchangeRate) : 0;
}

function billVarianceForGroup(group, transactionsInGroup, exchangeRate) {
  if (group.type !== "bill" || !group.bill) return null;

  const expectedUsd = billExpectedAmountUsd(group.bill, exchangeRate);
  const actualUsd = toMoneyValue(transactionsInGroup
    .filter((transaction) => transaction.kind === "expense")
    .reduce((sum, transaction) => sum + transactionAmountUsd(transaction, exchangeRate), 0));
  if (expectedUsd <= 0 || actualUsd <= 0) return null;

  const differenceUsd = toMoneyValue(actualUsd - expectedUsd);
  if (Math.abs(differenceUsd) < 0.01) return null;

  return {
    type: differenceUsd > 0 ? "over" : "overflow",
    amountUsd: Math.abs(differenceUsd),
    expectedUsd,
    actualUsd
  };
}

function buildFundsExpenseSeries(transactions, exchangeRate) {
  const sortedTransactions = [...transactions].sort((first, second) => (
    String(first.date || "").localeCompare(String(second.date || "")) || Number(first.id || 0) - Number(second.id || 0)
  ));
  let incomeUsd = 0;
  let expenseUsd = 0;

  return sortedTransactions.map((transaction, index) => {
    const amountUsd = transactionAmountUsd(transaction, exchangeRate);
    if (transaction.kind === "income") {
      incomeUsd = toMoneyValue(incomeUsd + amountUsd);
    } else {
      expenseUsd = toMoneyValue(expenseUsd + amountUsd);
    }

    return {
      id: transaction.id || `${transaction.date}-${index}`,
      date: transaction.date,
      incomeUsd,
      expenseUsd,
      transaction,
      amountUsd
    };
  });
}

function buildLinePath(items, valueKey, xForIndex, yForValue) {
  return items
    .map((item, index) => `${index === 0 ? "M" : "L"} ${xForIndex(index).toFixed(2)} ${yForValue(item[valueKey]).toFixed(2)}`)
    .join(" ");
}

function sourceName(transaction) {
  return joinSourceParts([
    transaction.accountName,
    transaction.institutionName
  ]);
}

function addTransactionToHistoryGroup(group, transaction) {
  const id = String(transaction.id);
  if (group.transactionIds.has(id)) return;

  group.transactionIds.add(id);
  group.transactions.push(transaction);
  if (!group.date || String(transaction.date || "") > group.date) group.date = transaction.date;
}

function buildTransactionHistoryGroups(transactions, recurringBills, exchangeRate) {
  const sortedTransactions = [...transactions].sort((first, second) => (
    String(second.date || "").localeCompare(String(first.date || "")) || Number(second.id || 0) - Number(first.id || 0)
  ));
  const groups = new Map();
  const assignedGroupIds = new Map();
  const pairedTransferIds = new Set();

  function ensureBillGroup(bill, month, transaction) {
    const id = `bill-${bill.id}-${month || transactionMonth(transaction) || "open"}`;
    if (!groups.has(id)) {
      groups.set(id, {
        id,
        type: "bill",
        title: bill.name || "Recurring bill",
        bill,
        month: month || transactionMonth(transaction),
        transactions: [],
        transactionIds: new Set(),
        date: transaction.date || "",
        transfer: null
      });
    }

    return groups.get(id);
  }

  function ensureTransferGroup(outgoing, incoming) {
    const id = `transfer-${Math.min(Number(outgoing.id), Number(incoming.id))}-${Math.max(Number(outgoing.id), Number(incoming.id))}`;
    if (!groups.has(id)) {
      groups.set(id, {
        id,
        type: "transfer",
        title: "Transfer",
        bill: null,
        month: transactionMonth(outgoing) || transactionMonth(incoming),
        transactions: [],
        transactionIds: new Set(),
        date: [outgoing.date, incoming.date].filter(Boolean).sort().pop() || "",
        transfer: { outgoing, incoming }
      });
    }

    return groups.get(id);
  }

  function ensureAdjustmentGroup(outgoing, incoming) {
    const id = `adjustment-${Math.min(Number(outgoing.id), Number(incoming.id))}-${Math.max(Number(outgoing.id), Number(incoming.id))}`;
    if (!groups.has(id)) {
      groups.set(id, {
        id,
        type: "adjustment",
        title: transactionTitle(outgoing),
        bill: null,
        month: transactionMonth(outgoing) || transactionMonth(incoming),
        transactions: [],
        transactionIds: new Set(),
        date: [outgoing.date, incoming.date].filter(Boolean).sort().pop() || "",
        transfer: null,
        adjustment: { outgoing, incoming }
      });
    }

    return groups.get(id);
  }

  for (const transaction of sortedTransactions) {
    const bill = findBillForTransaction(transaction, recurringBills, exchangeRate);
    if (!bill) continue;

    const group = ensureBillGroup(bill, transactionMonth(transaction), transaction);
    addTransactionToHistoryGroup(group, transaction);
    assignedGroupIds.set(String(transaction.id), group.id);
  }

  for (const outgoing of sortedTransactions) {
    if (outgoing.kind !== "expense") continue;

    const bestIncoming = sortedTransactions
      .filter((transaction) => transaction.kind === "income" && !assignedGroupIds.has(String(transaction.id)))
      .map((incoming) => ({ incoming, score: feeReversalPairScore(outgoing, incoming, exchangeRate) }))
      .filter((item) => item.score > 0)
      .sort((first, second) => second.score - first.score)[0]?.incoming;

    if (!bestIncoming) continue;

    const existingGroupId = assignedGroupIds.get(String(outgoing.id));
    const group = existingGroupId
      ? groups.get(existingGroupId)
      : ensureAdjustmentGroup(outgoing, bestIncoming);

    if (!group.adjustment) group.adjustment = { outgoing, incoming: bestIncoming };
    addTransactionToHistoryGroup(group, outgoing);
    addTransactionToHistoryGroup(group, bestIncoming);
    assignedGroupIds.set(String(outgoing.id), group.id);
    assignedGroupIds.set(String(bestIncoming.id), group.id);
  }

  for (const outgoing of sortedTransactions) {
    if (outgoing.kind !== "expense" || pairedTransferIds.has(String(outgoing.id)) || assignedGroupIds.has(String(outgoing.id))) continue;

    const bestIncoming = sortedTransactions
      .filter((transaction) => (
        transaction.kind === "income"
          && !pairedTransferIds.has(String(transaction.id))
          && !assignedGroupIds.has(String(transaction.id))
      ))
      .map((incoming) => ({ incoming, score: transferPairScore(outgoing, incoming, exchangeRate) }))
      .filter((item) => item.score > 0)
      .sort((first, second) => second.score - first.score)[0]?.incoming;

    if (!bestIncoming) continue;

    const existingGroupId = assignedGroupIds.get(String(outgoing.id)) || assignedGroupIds.get(String(bestIncoming.id));
    const group = existingGroupId
      ? groups.get(existingGroupId)
      : ensureTransferGroup(outgoing, bestIncoming);

    if (!group.transfer) group.transfer = { outgoing, incoming: bestIncoming };
    addTransactionToHistoryGroup(group, outgoing);
    addTransactionToHistoryGroup(group, bestIncoming);
    assignedGroupIds.set(String(outgoing.id), group.id);
    assignedGroupIds.set(String(bestIncoming.id), group.id);
    pairedTransferIds.add(String(outgoing.id));
    pairedTransferIds.add(String(bestIncoming.id));
  }

  for (const transaction of sortedTransactions) {
    if (assignedGroupIds.has(String(transaction.id))) continue;

    const id = `transaction-${transaction.id}`;
    groups.set(id, {
      id,
      type: "single",
      title: transactionTitle(transaction),
      bill: null,
      month: transactionMonth(transaction),
      transactions: [transaction],
      transactionIds: new Set([String(transaction.id)]),
      date: transaction.date || "",
      transfer: null
    });
  }

  return [...groups.values()]
    .map((group) => {
      const transactionsInGroup = [...group.transactions].sort((first, second) => (
        String(second.date || "").localeCompare(String(first.date || "")) || Number(second.id || 0) - Number(first.id || 0)
      ));
      const signedTotalUsd = toMoneyValue(transactionsInGroup.reduce((sum, transaction) => sum + transactionSignedUsd(transaction, exchangeRate), 0));
      const transferAmountUsd = group.transfer
        ? Math.max(
            transactionAmountUsd(group.transfer.outgoing, exchangeRate),
            transactionAmountUsd(group.transfer.incoming, exchangeRate)
          )
        : Math.abs(signedTotalUsd);
      const firstTransaction = transactionsInGroup[0];
      const subtitle = group.type === "bill"
        ? `${formatShortDate(group.date)} - ${billSourceLabel(group.bill)}`
        : group.type === "transfer"
          ? `${formatShortDate(group.date)} - ${sourceName(group.transfer.outgoing)} to ${sourceName(group.transfer.incoming)}`
          : group.type === "adjustment"
            ? `${formatShortDate(group.date)} - ${transactionSourceLabel(firstTransaction || {})}`
          : `${formatShortDate(firstTransaction?.date)} - ${transactionSourceLabel(firstTransaction || {})}`;
      const isCreditCardPayment = isCreditCardPaymentGroup({ ...group, transactions: transactionsInGroup });
      const billVariance = billVarianceForGroup(group, transactionsInGroup, exchangeRate);
      const amountUsd = group.type === "transfer"
        ? toMoneyValue(transferAmountUsd)
        : group.type === "bill"
          ? signedTotalUsd || -Number(group.bill?.amountUsd || 0)
          : signedTotalUsd;

      return {
        ...group,
        title: isCreditCardPayment ? "Credit Card Payment" : group.title,
        transactions: transactionsInGroup,
        subtitle,
        billVariance,
        amountUsd: toMoneyValue(amountUsd),
        tone: group.type === "transfer" || group.type === "adjustment" ? "info" : amountUsd >= 0 ? "good" : "bad",
        itemCount: transactionsInGroup.length + (group.bill ? 1 : 0)
      };
    })
    .sort((first, second) => (
      String(second.date || "").localeCompare(String(first.date || "")) || first.title.localeCompare(second.title)
    ));
}

function isBillOverdue(bill, month) {
  if (bill.isPaid) return false;

  const dueDate = billDueDate(bill, month);
  if (!dueDate) return false;

  const [year, monthNumber] = String(month || "").split("-").map(Number);
  if (!year || !monthNumber) return false;

  const now = new Date();
  const monthStart = new Date(year, monthNumber - 1, 1);
  const nextMonthStart = new Date(year, monthNumber, 1);

  if (now < monthStart) return false;
  if (now >= nextMonthStart) return true;
  return dueDate < now;
}

function todayForMonth(month) {
  const today = new Date().toISOString().slice(0, 10);
  return today.startsWith(month) ? today : `${month}-01`;
}

function defaultTransaction(month, accounts, displayCurrency = "USD") {
  return {
    date: todayForMonth(month),
    kind: "expense",
    amount: "",
    currency: displayCurrency,
    category: "Bills",
    accountId: accounts[0]?.id ? String(accounts[0].id) : "",
    merchant: "",
    note: ""
  };
}

function defaultBill(displayCurrency = "USD") {
  return {
    id: null,
    name: "",
    amount: "",
    currency: displayCurrency,
    dueLabel: "",
    paymentAccount: "",
    isPaid: false,
    isAutopay: false
  };
}

function defaultGoal(displayCurrency = "USD") {
  return {
    id: null,
    name: "",
    currency: displayCurrency,
    targetAmount: "",
    savedAmount: "",
    category: "PC Build",
    note: ""
  };
}

function defaultAccount() {
  return {
    id: null,
    name: "",
    type: "checking",
    openingBalance: "",
    color: COLORS[0]
  };
}

function progressClass(percent) {
  if (percent >= 100) return "finance-progress finance-progress-over";
  if (percent >= 80) return "finance-progress finance-progress-warn";
  return "finance-progress";
}

function Field({ label, children }) {
  return (
    <label className="finance-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Metric({ label, value, tone, detail }) {
  return (
    <article className="finance-metric">
      <span>{label}</span>
      <strong className={tone ? `finance-${tone}` : ""}>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </article>
  );
}

function Panel({ title, action, children, className = "" }) {
  return (
    <section className={`finance-panel ${className}`.trim()}>
      <header>
        <h2>{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

function FinanceHeader({ onHome }) {
  return (
    <header className="finance-topbar">
      <h1>Private Finance</h1>
      <button type="button" className="finance-header-home" onClick={onHome}>
        Home
      </button>
    </header>
  );
}

export default function FinanceAppClient({ snapshot, initialTab }) {
  const router = useRouter();
  const displayCurrency = snapshot.plan.displayCurrency || "USD";
  const exchangeRate = Number(snapshot.plan.exchangeRate || 1);
  const initialAllTransactions = snapshot.allTransactions || snapshot.transactions || [];
  const initialFundsDate = latestTransactionDate(initialAllTransactions, `${snapshot.month}-01`);
  const showCurrency = (value, fromCurrency = "USD") => (
    money(convertAmount(value, fromCurrency, displayCurrency, exchangeRate), displayCurrency)
  );
  const showCompactCurrency = (value, fromCurrency = "USD") => (
    compactMoney(convertAmount(value, fromCurrency, displayCurrency, exchangeRate), displayCurrency)
  );
  const toUsdFromDisplay = (value) => convertAmount(value, displayCurrency, "USD", exchangeRate);
  const toPhpFromDisplay = (value) => convertAmount(value, displayCurrency, "PHP", exchangeRate);
  const [activeTab, setActiveTab] = useState(() => normalizeTab(initialTab));
  const [saving, setSaving] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [installPrompt, setInstallPrompt] = useState(null);
  const [toolbarOpen, setToolbarOpen] = useState(false);
  const [chartTooltip, setChartTooltip] = useState(null);
  const [billTooltip, setBillTooltip] = useState(null);
  const [fundsFilter, setFundsFilter] = useState(() => ({
    mode: "month",
    month: snapshot.month,
    year: String(snapshot.month || "").slice(0, 4) || String(initialFundsDate).slice(0, 4),
    payPeriod: payPeriodForDate(initialFundsDate).id
  }));
  const [transactionDateFilter, setTransactionDateFilter] = useState({ from: "", to: "" });
  const [transactionPage, setTransactionPage] = useState(1);
  const [expandedTransactionGroups, setExpandedTransactionGroups] = useState(() => new Set());
  const [transactionModalOpen, setTransactionModalOpen] = useState(false);
  const [transactionEditId, setTransactionEditId] = useState(null);
  const [transactionForm, setTransactionForm] = useState(() => defaultTransaction(snapshot.month, snapshot.accounts, displayCurrency));
  const [planForm, setPlanForm] = useState(() => ({
    monthlyIncomeUsd: String(convertAmount(snapshot.plan.monthlyIncomeUsd, "USD", displayCurrency, exchangeRate)),
    biweeklyIncomeUsd: String(convertAmount(snapshot.plan.biweeklyIncomeUsd, "USD", displayCurrency, exchangeRate)),
    biweeklyBillsUsd: String(convertAmount(snapshot.plan.biweeklyBillsUsd, "USD", displayCurrency, exchangeRate)),
    biweeklySavingsUsd: String(convertAmount(snapshot.plan.biweeklySavingsUsd, "USD", displayCurrency, exchangeRate))
  }));
  const [billForm, setBillForm] = useState(() => defaultBill(displayCurrency));
  const [goalForm, setGoalForm] = useState(() => defaultGoal(displayCurrency));
  const [accountForm, setAccountForm] = useState(defaultAccount);

  const maxTrend = useMemo(() => {
    return Math.max(1, ...snapshot.monthlySeries.flatMap((item) => [item.incomeUsd, item.expensesUsd]));
  }, [snapshot.monthlySeries]);

  const connections = snapshot.connections || [];
  const allTransactions = initialAllTransactions;
  const recentTransactions = allTransactions.slice(0, 8);
  const filteredHistoryTransactions = useMemo(() => {
    if (!transactionDateFilter.from && !transactionDateFilter.to) return allTransactions;
    return allTransactions.filter((transaction) => transactionMatchesDateFilter(transaction, transactionDateFilter));
  }, [allTransactions, transactionDateFilter]);
  const transactionDateFilterActive = Boolean(transactionDateFilter.from || transactionDateFilter.to);
  const transactionPageCount = Math.max(1, Math.ceil(filteredHistoryTransactions.length / TRANSACTION_HISTORY_PAGE_SIZE));
  const safeTransactionPage = Math.min(transactionPage, transactionPageCount);
  const transactionPageStart = (safeTransactionPage - 1) * TRANSACTION_HISTORY_PAGE_SIZE;
  const pagedHistoryTransactions = filteredHistoryTransactions.slice(
    transactionPageStart,
    transactionPageStart + TRANSACTION_HISTORY_PAGE_SIZE
  );
  const transactionPageEnd = transactionPageStart + pagedHistoryTransactions.length;
  const fundsMonthOptions = useMemo(() => {
    return buildMonthOptions(allTransactions, snapshot.month);
  }, [allTransactions, snapshot.month]);
  const fundsYearOptions = useMemo(() => {
    return buildYearOptions(allTransactions, String(snapshot.month || "").slice(0, 4));
  }, [allTransactions, snapshot.month]);
  const fundsPayPeriodOptions = useMemo(() => {
    return buildPayPeriodOptions(allTransactions, initialFundsDate);
  }, [allTransactions, initialFundsDate]);
  const activeFundsPayPeriod = fundsPayPeriodOptions.find((period) => period.id === fundsFilter.payPeriod)
    || fundsPayPeriodOptions[0]
    || payPeriodForDate(initialFundsDate);
  const filteredFundsTransactions = useMemo(() => {
    if (fundsFilter.mode === "year") {
      return allTransactions.filter((transaction) => String(transaction.date || "").startsWith(`${fundsFilter.year}-`));
    }

    if (fundsFilter.mode === "payPeriod") {
      return allTransactions.filter((transaction) => transactionInPayPeriod(transaction, activeFundsPayPeriod));
    }

    if (fundsFilter.mode === "all") return allTransactions;

    return allTransactions.filter((transaction) => String(transaction.date || "").startsWith(fundsFilter.month));
  }, [allTransactions, fundsFilter, activeFundsPayPeriod]);
  const fundsFilterDetail = fundsFilter.mode === "year"
    ? fundsFilter.year
    : fundsFilter.mode === "payPeriod"
      ? activeFundsPayPeriod.detail
      : fundsFilter.mode === "all"
        ? "All transactions"
        : formatMonthLabel(fundsFilter.month);
  const sortedRecurringBills = useMemo(() => {
    return [...snapshot.recurringBills].sort(sortBillsByDueDate);
  }, [snapshot.recurringBills]);
  const transactionGroups = useMemo(() => {
    return buildTransactionHistoryGroups(pagedHistoryTransactions, sortedRecurringBills, exchangeRate);
  }, [pagedHistoryTransactions, sortedRecurringBills, exchangeRate]);
  const unpaidBills = sortedRecurringBills.filter((bill) => !bill.isPaid);
  const overdueBills = sortedRecurringBills.filter((bill) => isBillOverdue(bill, snapshot.month));
  const overdueBillIds = new Set(overdueBills.map((bill) => bill.id));
  const accountBalanceItems = snapshot.accounts.map((account) => {
    const valueUsd = ["credit", "loan"].includes(account.type)
      ? -Math.abs(Number(account.currentBalance || 0))
      : Number(account.currentBalance || 0);
    const details = [
      account.institutionName || account.provider || account.type,
      account.isLinked ? "linked" : "manual",
      account.isLinked && account.currency !== displayCurrency ? money(account.nativeCurrentBalance, account.currency) : ""
    ].filter(Boolean).join(" - ");

    return {
      id: `account-${account.id}`,
      label: account.name,
      detail: details,
      valueUsd: toMoneyValue(valueUsd),
      tone: valueUsd < 0 ? "bad" : "good"
    };
  });
  const totalAccountBalanceUsd = toMoneyValue(accountBalanceItems.reduce((sum, item) => sum + item.valueUsd, 0));
  const positiveFundsUsd = toMoneyValue(accountBalanceItems.filter((item) => item.valueUsd > 0).reduce((sum, item) => sum + item.valueUsd, 0));
  const negativeBalancesUsd = toMoneyValue(accountBalanceItems.filter((item) => item.valueUsd < 0).reduce((sum, item) => sum + item.valueUsd, 0));
  const balanceChartItems = [
    ...accountBalanceItems,
    {
      id: "accounts-total",
      label: "Total",
      detail: `${snapshot.accounts.length} accounts`,
      valueUsd: totalAccountBalanceUsd,
      tone: totalAccountBalanceUsd >= 0 ? "info" : "bad",
      isTotal: true
    }
  ];
  const balanceAxisMaxUsd = niceAxisMax(Math.max(1, ...balanceChartItems.map((item) => Math.abs(item.valueUsd))));
  const balanceChartWidth = Math.max(560, balanceChartItems.length * 88 + 92);
  const balanceChartHeight = 318;
  const balanceChartTop = 24;
  const balanceChartRight = balanceChartWidth - 18;
  const balanceChartBottom = balanceChartHeight - 70;
  const balanceChartLeft = 66;
  const balanceChartInnerHeight = balanceChartBottom - balanceChartTop;
  const balanceChartInnerWidth = balanceChartRight - balanceChartLeft;
  const balanceChartSlot = balanceChartInnerWidth / Math.max(1, balanceChartItems.length);
  const balanceBarWidth = Math.min(42, Math.max(24, balanceChartSlot * 0.46));
  const balanceChartTicks = [-balanceAxisMaxUsd, -balanceAxisMaxUsd / 2, 0, balanceAxisMaxUsd / 2, balanceAxisMaxUsd];
  const balanceTooltipWidth = 178;
  const balanceTooltipHeight = 60;
  const balanceChartY = (valueUsd) => {
    const value = Math.max(-balanceAxisMaxUsd, Math.min(balanceAxisMaxUsd, Number(valueUsd || 0)));
    return balanceChartTop + ((balanceAxisMaxUsd - value) / (balanceAxisMaxUsd * 2)) * balanceChartInnerHeight;
  };
  const balanceZeroY = balanceChartY(0);
  const activeChartItem = chartTooltip
    ? balanceChartItems.find((item) => item.id === chartTooltip.id)
    : null;
  const billChartTotals = sortedRecurringBills.reduce((totals, bill) => {
    const expectedUsd = billExpectedAmountUsd(bill, exchangeRate);
    const actualUsd = billActualPaidUsd(bill, exchangeRate);

    totals.expectedUsd = toMoneyValue(totals.expectedUsd + expectedUsd);

    if (!bill.isPaid) {
      totals.remainingUsd = toMoneyValue(totals.remainingUsd + expectedUsd);
      return totals;
    }

    const paidBaseUsd = expectedUsd > 0 ? Math.min(actualUsd || expectedUsd, expectedUsd) : actualUsd;
    totals.paidUsd = toMoneyValue(totals.paidUsd + paidBaseUsd);

    if (actualUsd > expectedUsd) {
      totals.overExpectedUsd = toMoneyValue(totals.overExpectedUsd + actualUsd - expectedUsd);
    } else if (actualUsd < expectedUsd) {
      totals.voidedOverflowUsd = toMoneyValue(totals.voidedOverflowUsd + expectedUsd - actualUsd);
    }

    return totals;
  }, {
    expectedUsd: 0,
    remainingUsd: 0,
    paidUsd: 0,
    voidedOverflowUsd: 0,
    overExpectedUsd: 0
  });
  const billPieLegendItems = [
    { id: "remaining", label: "Remaining", valueUsd: billChartTotals.remainingUsd, tone: "warn" },
    { id: "paid", label: "Paid", valueUsd: billChartTotals.paidUsd, tone: "good" },
    { id: "voided", label: "Voided/Overflow", valueUsd: billChartTotals.voidedOverflowUsd, tone: "info" },
    { id: "over", label: "Over expected", valueUsd: billChartTotals.overExpectedUsd, tone: "bad" }
  ];
  const billPieItems = billPieLegendItems.filter((item) => item.valueUsd > 0);
  const billPieTotalUsd = toMoneyValue(billPieItems.reduce((sum, item) => sum + item.valueUsd, 0));
  const billPieRadius = 42;
  const billPieCircumference = 2 * Math.PI * billPieRadius;
  let billPieRunningOffset = 0;
  const billPieSegments = billPieItems.map((item) => {
    const dash = billPieTotalUsd > 0 ? (item.valueUsd / billPieTotalUsd) * billPieCircumference : 0;
    const segment = { ...item, dash, offset: billPieRunningOffset };
    billPieRunningOffset += dash;
    return segment;
  });
  const fundsExpenseSeries = useMemo(() => {
    return buildFundsExpenseSeries(filteredFundsTransactions, exchangeRate);
  }, [filteredFundsTransactions, exchangeRate]);
  const latestFundsPoint = fundsExpenseSeries[fundsExpenseSeries.length - 1] || { incomeUsd: 0, expenseUsd: 0 };
  const fundsIncomeUsd = toMoneyValue(latestFundsPoint.incomeUsd);
  const fundsExpenseUsd = toMoneyValue(latestFundsPoint.expenseUsd);
  const fundsNetUsd = toMoneyValue(fundsIncomeUsd - fundsExpenseUsd);
  const fundsChartWidth = Math.max(620, fundsExpenseSeries.length * 22 + 108);
  const fundsChartHeight = 260;
  const fundsChartTop = 24;
  const fundsChartRight = fundsChartWidth - 18;
  const fundsChartBottom = fundsChartHeight - 42;
  const fundsChartLeft = 62;
  const fundsChartInnerWidth = fundsChartRight - fundsChartLeft;
  const fundsChartInnerHeight = fundsChartBottom - fundsChartTop;
  const fundsAxisMaxUsd = niceAxisMax(Math.max(1, ...fundsExpenseSeries.flatMap((item) => [item.incomeUsd, item.expenseUsd])));
  const fundsChartTicks = [0, fundsAxisMaxUsd / 2, fundsAxisMaxUsd];
  const fundsChartX = (index) => fundsChartLeft + (fundsExpenseSeries.length <= 1 ? 0 : (index / (fundsExpenseSeries.length - 1)) * fundsChartInnerWidth);
  const fundsChartY = (valueUsd) => fundsChartTop + ((fundsAxisMaxUsd - Number(valueUsd || 0)) / fundsAxisMaxUsd) * fundsChartInnerHeight;
  const fundsIncomePath = buildLinePath(fundsExpenseSeries, "incomeUsd", fundsChartX, fundsChartY);
  const fundsExpensePath = buildLinePath(fundsExpenseSeries, "expenseUsd", fundsChartX, fundsChartY);
  const fundsLabelSlots = Math.max(4, Math.floor(fundsChartInnerWidth / 120));
  const fundsLabelStep = Math.max(1, Math.ceil(fundsExpenseSeries.length / fundsLabelSlots));
  const connectionIssues = connections.filter((connection) => ["error", "needs_sync"].includes(connection.status));
  const attentionItems = [
    overdueBills.length > 0 ? `${overdueBills.length} overdue bill${overdueBills.length === 1 ? "" : "s"}.` : "",
    snapshot.summary.dueSoonBills > 0 ? `${snapshot.summary.dueSoonBills} bill${snapshot.summary.dueSoonBills === 1 ? "" : "s"} due soon.` : "",
    snapshot.summary.netUsd < 0 ? `This month is ${showCurrency(Math.abs(snapshot.summary.netUsd), "USD")} negative.` : "",
    snapshot.plan.recurringRemainingUsd < 0 ? `Recurring bills exceed monthly income by ${showCurrency(Math.abs(snapshot.plan.recurringRemainingUsd), "USD")}.` : "",
    connectionIssues.length > 0 ? `${connectionIssues.length} linked connection${connectionIssues.length === 1 ? "" : "s"} need attention.` : ""
  ].filter(Boolean);
  const disabled = !snapshot.configured;
  const status = saving ? "Saving..." : notice || error;

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }

    const handleBeforeInstallPrompt = (event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    return () => window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
  }, []);

  useEffect(() => {
    if (!transactionEditId && !transactionModalOpen) {
      setTransactionForm(defaultTransaction(snapshot.month, snapshot.accounts, displayCurrency));
    }

    setPlanForm({
      monthlyIncomeUsd: String(convertAmount(snapshot.plan.monthlyIncomeUsd, "USD", displayCurrency, exchangeRate)),
      biweeklyIncomeUsd: String(convertAmount(snapshot.plan.biweeklyIncomeUsd, "USD", displayCurrency, exchangeRate)),
      biweeklyBillsUsd: String(convertAmount(snapshot.plan.biweeklyBillsUsd, "USD", displayCurrency, exchangeRate)),
      biweeklySavingsUsd: String(convertAmount(snapshot.plan.biweeklySavingsUsd, "USD", displayCurrency, exchangeRate))
    });
  }, [snapshot.month, snapshot.accounts, snapshot.plan, transactionEditId, transactionModalOpen, displayCurrency, exchangeRate]);

  useEffect(() => {
    setTransactionPage(1);
  }, [transactionDateFilter.from, transactionDateFilter.to]);

  useEffect(() => {
    if (transactionPage > transactionPageCount) {
      setTransactionPage(transactionPageCount);
    }
  }, [transactionPage, transactionPageCount]);

  function setTab(tab) {
    const normalized = normalizeTab(tab);
    setActiveTab(normalized);
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      params.set("tab", normalized);
      params.set("month", snapshot.month);
      window.history.replaceState(null, "", `/finance?${params.toString()}`);
    }
  }

  function updateBillTooltip(event, item) {
    const figure = event.currentTarget.closest(".finance-pie-chart");
    const figureBounds = figure?.getBoundingClientRect();
    const targetBounds = event.currentTarget.getBoundingClientRect();
    const clientX = event.clientX || targetBounds.left + targetBounds.width / 2;
    const clientY = event.clientY || targetBounds.top + targetBounds.height / 2;
    const percent = billPieTotalUsd > 0 ? Math.round((item.valueUsd / billPieTotalUsd) * 100) : 0;

    setBillTooltip({
      id: item.id,
      label: item.label,
      value: showCurrency(item.valueUsd, "USD"),
      detail: `${percent}% of tracked bills`,
      x: figureBounds ? clientX - figureBounds.left : 70,
      y: figureBounds ? clientY - figureBounds.top : 70
    });
  }

  function hideBillTooltip() {
    setBillTooltip(null);
  }

  async function callFinanceAction(action, data) {
    const response = await fetch("/api/finance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, data })
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) throw new Error(payload.error || "Finance action failed.");
    return payload.result;
  }

  async function runAction(action, data, successMessage) {
    setSaving(action);
    setNotice("");
    setError("");

    try {
      await callFinanceAction(action, data);
      setNotice(successMessage);
      router.refresh();
      return true;
    } catch (err) {
      setError(err.message || "Finance action failed.");
      return false;
    } finally {
      setSaving("");
    }
  }

  async function installApp() {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => {});
    setInstallPrompt(null);
    setToolbarOpen(false);
  }

  async function submitPlan(event) {
    event.preventDefault();
    await runAction(
      "updatePlan",
      {
        monthlyIncomeUsd: toUsdFromDisplay(planForm.monthlyIncomeUsd),
        biweeklyIncomeUsd: toUsdFromDisplay(planForm.biweeklyIncomeUsd),
        biweeklyBillsUsd: toUsdFromDisplay(planForm.biweeklyBillsUsd),
        biweeklySavingsUsd: toUsdFromDisplay(planForm.biweeklySavingsUsd)
      },
      "Plan saved."
    );
  }

  async function switchDisplayCurrency() {
    const nextCurrency = displayCurrency === "USD" ? "PHP" : "USD";
    await runAction(
      "updateDisplayCurrency",
      { currency: nextCurrency },
      `Showing ${nextCurrency}.`
    );
    setToolbarOpen(false);
  }

  async function refreshExchangeRate() {
    await runAction("refreshExchangeRate", {}, "Exchange rate refreshed.");
  }

  async function connectPlaid() {
    setSaving("createPlaidLinkToken");
    setNotice("");
    setError("");

    try {
      const [{ linkToken }, Plaid] = await Promise.all([
        callFinanceAction("createPlaidLinkToken", {}),
        loadPlaidScript()
      ]);

      if (!linkToken || !Plaid?.create) throw new Error("Plaid Link did not initialize.");

      const handler = Plaid.create({
        token: linkToken,
        onSuccess: async (publicToken, metadata) => {
          setSaving("exchangePlaidPublicToken");
          setNotice("");
          setError("");

          try {
            await callFinanceAction("exchangePlaidPublicToken", { publicToken, metadata });
            setNotice("Plaid account linked.");
            router.refresh();
          } catch (err) {
            setError(err.message || "Plaid account link failed.");
          } finally {
            setSaving("");
          }
        },
        onExit: (err) => {
          if (err) setError(err.display_message || err.error_message || "Plaid Link was closed.");
        }
      });

      handler.open();
    } catch (err) {
      setError(err.message || "Plaid Link failed.");
    } finally {
      setSaving("");
    }
  }

  async function connectBrankas() {
    setSaving("createBrankasLink");
    setNotice("");
    setError("");

    try {
      const result = await callFinanceAction("createBrankasLink", {});
      if (!result?.url) throw new Error("Brankas did not return a link URL.");
      window.location.assign(result.url);
    } catch (err) {
      setError(err.message || "Brankas Link failed.");
      setSaving("");
    }
  }

  async function syncConnection(connection) {
    await runAction("syncConnection", { id: connection.id }, `${connection.institutionName} synced.`);
  }

  function openNewTransaction() {
    setTab("transactions");
    setTransactionEditId(null);
    setTransactionForm(defaultTransaction(snapshot.month, snapshot.accounts, displayCurrency));
    setTransactionModalOpen(true);
  }

  function closeTransactionModal() {
    setTransactionModalOpen(false);
    setTransactionEditId(null);
    setTransactionForm(defaultTransaction(snapshot.month, snapshot.accounts, displayCurrency));
  }

  async function submitTransaction(event) {
    event.preventDefault();
    const action = transactionEditId ? "updateTransaction" : "createTransaction";
    const ok = await runAction(
      action,
      { ...transactionForm, id: transactionEditId },
      transactionEditId ? "Transaction updated." : "Transaction added."
    );

    if (ok) {
      closeTransactionModal();
    }
  }

  function editTransaction(transaction) {
    setTab("transactions");
    setTransactionEditId(transaction.id);
    setTransactionForm({
      date: transaction.date,
      kind: transaction.kind,
      amount: String(transaction.amount),
      currency: transaction.currency,
      category: transaction.category,
      accountId: transaction.accountId ? String(transaction.accountId) : "",
      merchant: transaction.merchant,
      note: transaction.note
    });
    setTransactionModalOpen(true);
  }

  function toggleTransactionGroup(groupId) {
    setExpandedTransactionGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }

  async function deleteTransaction(transaction) {
    if (!window.confirm("Delete this transaction?")) return;
    const ok = await runAction("deleteTransaction", { id: transaction.id }, "Transaction deleted.");
    if (ok && transactionEditId === transaction.id) {
      closeTransactionModal();
    }
  }

  function renderTransactionDetail(transaction, className = "") {
    return (
      <article key={transaction.id} className={`finance-transaction-detail ${className}`.trim()}>
        <div className="finance-transaction-detail-main">
          <span className="finance-transaction-detail-head">
            <strong>{transactionTitle(transaction)}</strong>
            <b className={transaction.kind === "income" ? "finance-good" : "finance-bad"}>
              {showCurrency(transactionSignedNativeAmount(transaction), transaction.currency)}
            </b>
          </span>
          <span className="finance-transaction-detail-meta">
            <small>{formatShortDate(transaction.date)}</small>
            <small>{transactionSourceLabel(transaction)}</small>
            <small>{transaction.category}</small>
            <small>{transaction.kind === "income" ? "Inflow" : "Outflow"}</small>
            {transaction.pending ? <small className="finance-warn">Pending</small> : null}
          </span>
          {transaction.note ? <small className="finance-transaction-note">{transaction.note}</small> : null}
        </div>
        <div className="finance-transaction-actions">
          <button type="button" onClick={() => editTransaction(transaction)} aria-label={`Edit ${transactionTitle(transaction)}`}>Edit</button>
          <button type="button" onClick={() => deleteTransaction(transaction)} aria-label={`Delete ${transactionTitle(transaction)}`}>Delete</button>
        </div>
      </article>
    );
  }

  function renderTransactionForm() {
    return (
      <form className="finance-form" onSubmit={submitTransaction}>
        <div className="finance-form-grid">
          <Field label="Date">
            <input type="date" value={transactionForm.date} onChange={(event) => setTransactionForm((form) => ({ ...form, date: event.target.value }))} required disabled={disabled} />
          </Field>
          <Field label="Type">
            <select value={transactionForm.kind} onChange={(event) => setTransactionForm((form) => ({ ...form, kind: event.target.value }))} disabled={disabled}>
              <option value="expense">Expense</option>
              <option value="income">Income</option>
            </select>
          </Field>
        </div>

        <div className="finance-form-grid">
          <Field label="Amount">
            <input type="number" inputMode="decimal" step="0.01" min="0" value={transactionForm.amount} onChange={(event) => setTransactionForm((form) => ({ ...form, amount: event.target.value }))} required disabled={disabled} />
          </Field>
          <Field label="Currency">
            <select value={transactionForm.currency} onChange={(event) => setTransactionForm((form) => ({ ...form, currency: event.target.value }))} disabled={disabled}>
              <option value="USD">USD</option>
              <option value="PHP">PHP</option>
            </select>
          </Field>
        </div>

        <Field label="Category">
          <input list="finance-categories" value={transactionForm.category} onChange={(event) => setTransactionForm((form) => ({ ...form, category: event.target.value }))} required disabled={disabled} />
        </Field>

        <Field label="Account">
          <select value={transactionForm.accountId} onChange={(event) => setTransactionForm((form) => ({ ...form, accountId: event.target.value }))} disabled={disabled}>
            <option value="">Unassigned</option>
            {snapshot.accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {joinSourceParts([account.name, account.institutionName, account.provider])}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Merchant or payer">
          <input value={transactionForm.merchant} onChange={(event) => setTransactionForm((form) => ({ ...form, merchant: event.target.value }))} disabled={disabled} maxLength={120} />
        </Field>

        <Field label="Note">
          <textarea value={transactionForm.note} onChange={(event) => setTransactionForm((form) => ({ ...form, note: event.target.value }))} disabled={disabled} maxLength={300} />
        </Field>

        <div className="finance-button-row">
          <button type="submit" className="finance-primary" disabled={disabled || Boolean(saving)}>
            {transactionEditId ? "Save" : "Add"}
          </button>
          <button type="button" onClick={closeTransactionModal}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  async function submitBill(event) {
    event.preventDefault();
    const ok = await runAction(
      "upsertBill",
      {
        ...billForm,
        amountUsd: toUsdFromDisplay(billForm.amount),
        amountPhp: toPhpFromDisplay(billForm.amount)
      },
      billForm.id ? "Bill saved." : "Bill added."
    );
    if (ok) setBillForm(defaultBill(displayCurrency));
  }

  function editBill(bill) {
    setBillForm({
      id: bill.id,
      name: bill.name,
      amount: String(convertAmount(bill.amountUsd, "USD", displayCurrency, exchangeRate)),
      currency: displayCurrency,
      dueLabel: bill.dueLabel,
      paymentAccount: bill.paymentAccount,
      isPaid: Boolean(bill.isManuallyPaid),
      isAutopay: bill.isAutopay
    });
  }

  async function deleteBill(bill) {
    if (!window.confirm(`Delete ${bill.name}?`)) return;
    const ok = await runAction("deleteBill", { id: bill.id }, "Bill deleted.");
    if (ok && billForm.id === bill.id) setBillForm(defaultBill(displayCurrency));
  }

  async function toggleBill(bill, nextIsPaid = !bill.isManuallyPaid) {
    await runAction(
      "toggleBillPaid",
      { id: bill.id, isPaid: nextIsPaid },
      nextIsPaid ? "Bill marked paid." : "Bill marked unpaid."
    );
  }

  async function submitGoal(event) {
    event.preventDefault();
    const ok = await runAction("upsertGoal", goalForm, goalForm.id ? "Goal saved." : "Goal added.");
    if (ok) setGoalForm(defaultGoal(displayCurrency));
  }

  function editGoal(goal) {
    setGoalForm({
      id: goal.id,
      name: goal.name,
      currency: goal.currency,
      targetAmount: String(goal.targetAmount),
      savedAmount: String(goal.savedAmount),
      category: goal.category || "",
      note: goal.note || ""
    });
  }

  async function deleteGoal(goal) {
    if (!window.confirm(`Delete ${goal.name}?`)) return;
    const ok = await runAction("deleteGoal", { id: goal.id }, "Goal deleted.");
    if (ok && goalForm.id === goal.id) setGoalForm(defaultGoal(displayCurrency));
  }

  async function submitAccount(event) {
    event.preventDefault();
    const action = accountForm.id ? "updateAccount" : "createAccount";
    const ok = await runAction(
      action,
      {
        ...accountForm,
        openingBalance: toUsdFromDisplay(accountForm.openingBalance)
      },
      accountForm.id ? "Account saved." : "Account added."
    );
    if (ok) setAccountForm(defaultAccount());
  }

  function editAccount(account) {
    setAccountForm({
      id: account.id,
      name: account.name,
      type: account.type,
      openingBalance: String(convertAmount(account.openingBalance, "USD", displayCurrency, exchangeRate)),
      color: account.color
    });
  }

  async function archiveAccount(account) {
    if (!window.confirm(`Archive ${account.name}?`)) return;
    const ok = await runAction("archiveAccount", { id: account.id }, "Account archived.");
    if (ok && accountForm.id === account.id) setAccountForm(defaultAccount());
  }

  return (
    <div className="finance-app">
      <div className="finance-floating-toolbar">
        {toolbarOpen ? (
          <div id="finance-toolbar-menu" className="finance-toolbar-menu" role="menu">
            {installPrompt ? (
              <button type="button" role="menuitem" onClick={installApp}>Install</button>
            ) : null}
            <button type="button" role="menuitem" onClick={() => { setTab("home"); setToolbarOpen(false); }}>Home</button>
            <button type="button" role="menuitem" onClick={() => { setTab("profile"); setToolbarOpen(false); }}>Profile</button>
            <button type="button" role="menuitem" onClick={switchDisplayCurrency}>
              Show {displayCurrency === "USD" ? "PHP" : "USD"}
            </button>
            <button type="button" role="menuitem" onClick={() => signOut({ callbackUrl: "/finance/login" })}>Sign out</button>
          </div>
        ) : null}
        <button
          type="button"
          className={toolbarOpen ? "finance-toolbar-toggle active" : "finance-toolbar-toggle"}
          aria-controls="finance-toolbar-menu"
          aria-expanded={toolbarOpen}
          aria-label="Finance actions"
          onClick={() => setToolbarOpen((open) => !open)}
        >
          ...
        </button>
      </div>

      {transactionModalOpen ? (
        <div
          className="finance-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeTransactionModal();
          }}
        >
          <section
            className="finance-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="finance-transaction-modal-title"
          >
            <header className="finance-modal-header">
              <h2 id="finance-transaction-modal-title">{transactionEditId ? "Edit Transaction" : "Add Transaction"}</h2>
              <button type="button" onClick={closeTransactionModal} aria-label="Close transaction form">Close</button>
            </header>
            {renderTransactionForm()}
          </section>
        </div>
      ) : null}

      {activeTab !== "home" ? (
        <>
          <FinanceHeader onHome={() => setTab("home")} />

          {!snapshot.configured ? (
            <div className="finance-alert finance-alert-warn">
              FINANCE_DATABASE_URL, DATABASE_URL, or MYSQL_URL is required before records can be saved.
            </div>
          ) : null}

          {status ? (
            <div className={error ? "finance-alert finance-alert-error" : "finance-alert"}>
              {status}
            </div>
          ) : null}
        </>
      ) : null}

      {activeTab === "home" ? (
        <div className="finance-home-layout">
          <main className="finance-home-main" aria-label="Finance dashboard">
            <FinanceHeader onHome={() => setTab("home")} />

            {!snapshot.configured ? (
              <div className="finance-alert finance-alert-warn">
                FINANCE_DATABASE_URL, DATABASE_URL, or MYSQL_URL is required before records can be saved.
              </div>
            ) : null}

            {status ? (
              <div className={error ? "finance-alert finance-alert-error" : "finance-alert"}>
                {status}
              </div>
            ) : null}

            <section className="finance-metric-grid">
              <Metric label="Net" value={showCurrency(snapshot.summary.netUsd, "USD")} tone={snapshot.summary.netUsd >= 0 ? "good" : "bad"} detail={`${snapshot.summary.savingsRate}% saved`} />
              <Metric label="Recurring" value={showCurrency(snapshot.plan.recurringUsd, "USD")} detail={`1 USD = ${exchangeRateMoney(snapshot.plan.exchangeRate)}`} />
              <Metric label="Unpaid" value={snapshot.summary.unpaidBills} tone={snapshot.summary.unpaidBills ? "warn" : "good"} detail={`${snapshot.summary.dueSoonBills} due soon`} />
              <Metric label="Balance" value={showCurrency(totalAccountBalanceUsd, "USD")} tone="info" detail={`${snapshot.accounts.length} accounts`} />
            </section>

          <section className="finance-home-charts">
            <Panel title="Accounts" className="finance-chart-panel finance-accounts-panel">
              <div className="finance-balance-summary">
                <span>
                  <b>{showCurrency(positiveFundsUsd, "USD")}</b>
                  <small>funds</small>
                </span>
                <span>
                  <b className={negativeBalancesUsd < 0 ? "finance-bad" : ""}>{showCurrency(negativeBalancesUsd, "USD")}</b>
                  <small>credit debt</small>
                </span>
                <span>
                  <b className={totalAccountBalanceUsd >= 0 ? "finance-info" : "finance-bad"}>{showCurrency(totalAccountBalanceUsd, "USD")}</b>
                  <small>total</small>
                </span>
                <span>
                  <b>{snapshot.accounts.length}</b>
                  <small>accounts</small>
                </span>
              </div>

              <figure className="finance-axis-chart">
                <div className="finance-axis-scroll">
                  <svg
                    className="finance-axis-svg"
                    viewBox={`0 0 ${balanceChartWidth} ${balanceChartHeight}`}
                    role="img"
                    aria-labelledby="finance-balance-chart-title finance-balance-chart-desc"
                  >
                    <title id="finance-balance-chart-title">Accounts</title>
                    <desc id="finance-balance-chart-desc">Funds in every account, credit card balances as negative values, and the total balance.</desc>
                    {balanceChartTicks.map((tick) => {
                      const y = balanceChartY(tick);

                      return (
                        <g key={tick}>
                          <line
                            className={tick === 0 ? "finance-axis-zero-line" : "finance-axis-grid-line"}
                            x1={balanceChartLeft}
                            x2={balanceChartRight}
                            y1={y}
                            y2={y}
                          />
                          <text className="finance-axis-y-label" x={balanceChartLeft - 9} y={y + 4} textAnchor="end">
                            {showCompactCurrency(tick, "USD")}
                          </text>
                        </g>
                      );
                    })}
                    <line className="finance-axis-line" x1={balanceChartLeft} x2={balanceChartLeft} y1={balanceChartTop} y2={balanceChartBottom} />
                    <line className="finance-axis-line" x1={balanceChartLeft} x2={balanceChartRight} y1={balanceZeroY} y2={balanceZeroY} />
                    <text className="finance-axis-title" x={balanceChartLeft} y={16}>Amount</text>
                    <text className="finance-axis-title" x={balanceChartRight} y={balanceChartHeight - 12} textAnchor="end">Accounts</text>

                    {balanceChartItems.map((item, index) => {
                      const x = balanceChartLeft + index * balanceChartSlot + (balanceChartSlot - balanceBarWidth) / 2;
                      const valueY = balanceChartY(item.valueUsd);
                      const barY = Math.min(valueY, balanceZeroY);
                      const barHeight = Math.max(2, Math.abs(balanceZeroY - valueY));
                      const tooltipX = Math.min(
                        balanceChartRight - balanceTooltipWidth,
                        Math.max(balanceChartLeft, x + balanceBarWidth / 2 - balanceTooltipWidth / 2)
                      );
                      const tooltipY = item.valueUsd < 0
                        ? Math.min(balanceChartBottom - balanceTooltipHeight, barY + barHeight + 10)
                        : Math.max(balanceChartTop + 6, barY - balanceTooltipHeight - 10);
                      const labelY = item.valueUsd < 0
                        ? Math.min(balanceChartBottom + 18, barY + barHeight + 15)
                        : Math.max(14, barY - 8);
                      const labelClassName = item.valueUsd < 0 ? "finance-axis-value finance-axis-value-negative" : "finance-axis-value";
                      const openTooltip = () => setChartTooltip({ id: item.id, x: tooltipX, y: tooltipY });

                      return (
                        <g
                          key={item.id}
                          className="finance-axis-bar-group"
                          tabIndex={0}
                          role="button"
                          aria-label={`${item.label}: ${showCurrency(item.valueUsd, "USD")}. ${item.detail}`}
                          onClick={openTooltip}
                          onFocus={openTooltip}
                          onBlur={() => setChartTooltip(null)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              openTooltip();
                            }
                          }}
                          onPointerEnter={openTooltip}
                          onPointerLeave={() => setChartTooltip(null)}
                        >
                          <title>{`${item.label}: ${showCurrency(item.valueUsd, "USD")} - ${item.detail}`}</title>
                          <rect
                            className={`finance-axis-bar finance-axis-${item.tone}${item.isTotal ? " finance-axis-total" : ""}`}
                            x={x}
                            y={barY}
                            width={balanceBarWidth}
                            height={barHeight}
                            rx="5"
                          />
                          <text className={labelClassName} x={x + balanceBarWidth / 2} y={labelY} textAnchor="middle">
                            {showCompactCurrency(item.valueUsd, "USD")}
                          </text>
                          <text className="finance-axis-x-label" x={x + balanceBarWidth / 2} y={balanceChartBottom + 38} textAnchor="middle">
                            {shortChartLabel(item.label)}
                          </text>
                        </g>
                      );
                    })}
                    {activeChartItem && chartTooltip ? (
                      <g className="finance-axis-tooltip" transform={`translate(${chartTooltip.x}, ${chartTooltip.y})`} pointerEvents="none">
                        <rect width={balanceTooltipWidth} height={balanceTooltipHeight} rx="8" />
                        <text className="finance-axis-tooltip-label" x="11" y="19">
                          {shortChartLabel(activeChartItem.label, 22)}
                        </text>
                        <text className="finance-axis-tooltip-detail" x="11" y="38">
                          {shortChartLabel(activeChartItem.detail, 28)}
                        </text>
                        <text className="finance-axis-tooltip-value" x={balanceTooltipWidth - 11} y="53" textAnchor="end">
                          {showCurrency(activeChartItem.valueUsd, "USD")}
                        </text>
                      </g>
                    ) : null}
                  </svg>
                </div>

                <figcaption className="finance-chart-values">
                  {balanceChartItems.map((item) => (
                    <span key={item.id}>
                      <i className={`finance-chart-dot finance-${item.tone}`} />
                      <span>
                        <strong>{item.label}</strong>
                        <small>{item.detail}</small>
                      </span>
                      <b className={item.valueUsd >= 0 ? "finance-good" : "finance-bad"}>{showCurrency(item.valueUsd, "USD")}</b>
                    </span>
                  ))}
                </figcaption>
              </figure>
            </Panel>

            <Panel title="Bills" className="finance-chart-panel finance-bills-panel">
              <figure className="finance-pie-chart">
                <svg className="finance-pie-svg" viewBox="0 0 140 140" role="img" aria-labelledby="finance-bills-chart-title finance-bills-chart-desc">
                  <title id="finance-bills-chart-title">Bills</title>
                  <desc id="finance-bills-chart-desc">Remaining bills, paid bills, voided or overflow amount, and any paid amount over expected.</desc>
                  <circle className="finance-pie-track" cx="70" cy="70" r={billPieRadius} />
                  {billPieSegments.map((item) => (
                    <circle
                      key={item.id}
                      className={`finance-pie-slice finance-pie-${item.tone}`}
                      tabIndex={0}
                      role="img"
                      aria-label={`${item.label}: ${showCurrency(item.valueUsd, "USD")}`}
                      cx="70"
                      cy="70"
                      r={billPieRadius}
                      strokeDasharray={`${item.dash} ${Math.max(0, billPieCircumference - item.dash)}`}
                      strokeDashoffset={-item.offset}
                      transform="rotate(-90 70 70)"
                      onPointerEnter={(event) => updateBillTooltip(event, item)}
                      onPointerMove={(event) => updateBillTooltip(event, item)}
                      onPointerLeave={hideBillTooltip}
                      onFocus={(event) => updateBillTooltip(event, item)}
                      onBlur={hideBillTooltip}
                    >
                      <title>{`${item.label}: ${showCurrency(item.valueUsd, "USD")}`}</title>
                    </circle>
                  ))}
                  <text className="finance-pie-center-label" x="70" y="65" textAnchor="middle">Tracked</text>
                  <text className="finance-pie-center-value" x="70" y="82" textAnchor="middle">{showCompactCurrency(billPieTotalUsd, "USD")}</text>
                </svg>
                {billTooltip ? (
                  <div
                    className="finance-pie-tooltip"
                    style={{
                      left: `${billTooltip.x}px`,
                      top: `${billTooltip.y}px`
                    }}
                  >
                    <strong>{billTooltip.label}</strong>
                    <b>{billTooltip.value}</b>
                    <small>{billTooltip.detail}</small>
                  </div>
                ) : null}
              </figure>
            </Panel>

            <Panel
              title="Funds / Expense"
              className="finance-chart-panel finance-line-panel"
              action={(
                <div className="finance-chart-filter">
                  <select
                    aria-label="Funds chart range"
                    value={fundsFilter.mode}
                    onChange={(event) => setFundsFilter((filter) => ({ ...filter, mode: event.target.value }))}
                  >
                    <option value="month">Month</option>
                    <option value="year">Year</option>
                    <option value="payPeriod">Pay period</option>
                    <option value="all">All</option>
                  </select>
                  {fundsFilter.mode === "month" ? (
                    <select
                      aria-label="Funds chart month"
                      value={fundsFilter.month}
                      onChange={(event) => setFundsFilter((filter) => ({ ...filter, month: event.target.value }))}
                    >
                      {fundsMonthOptions.map((month) => (
                        <option key={month} value={month}>{formatMonthLabel(month)}</option>
                      ))}
                    </select>
                  ) : null}
                  {fundsFilter.mode === "year" ? (
                    <select
                      aria-label="Funds chart year"
                      value={fundsFilter.year}
                      onChange={(event) => setFundsFilter((filter) => ({ ...filter, year: event.target.value }))}
                    >
                      {fundsYearOptions.map((year) => (
                        <option key={year} value={year}>{year}</option>
                      ))}
                    </select>
                  ) : null}
                  {fundsFilter.mode === "payPeriod" ? (
                    <select
                      aria-label="Funds chart pay period"
                      value={activeFundsPayPeriod.id}
                      onChange={(event) => setFundsFilter((filter) => ({ ...filter, payPeriod: event.target.value }))}
                    >
                      {fundsPayPeriodOptions.map((period) => (
                        <option key={period.id} value={period.id}>{period.label}</option>
                      ))}
                    </select>
                  ) : null}
                </div>
              )}
            >
              <figure className="finance-line-chart">
                <div className="finance-chart-summary">
                  <span>{fundsFilterDetail}</span>
                  <b>{filteredFundsTransactions.length} transaction{filteredFundsTransactions.length === 1 ? "" : "s"}</b>
                </div>
                <div className="finance-line-scroll">
                  <svg className="finance-line-svg" style={{ minWidth: `${fundsChartWidth}px` }} viewBox={`0 0 ${fundsChartWidth} ${fundsChartHeight}`} role="img" aria-labelledby="finance-funds-chart-title finance-funds-chart-desc">
                    <title id="finance-funds-chart-title">Funds and expense</title>
                    <desc id="finance-funds-chart-desc">Cumulative incoming and outbound totals across all transactions.</desc>
                    {fundsChartTicks.map((tick) => {
                      const y = fundsChartY(tick);

                      return (
                        <g key={tick}>
                          <line className={tick === 0 ? "finance-axis-zero-line" : "finance-axis-grid-line"} x1={fundsChartLeft} x2={fundsChartRight} y1={y} y2={y} />
                          <text className="finance-axis-y-label" x={fundsChartLeft - 9} y={y + 4} textAnchor="end">
                            {showCompactCurrency(tick, "USD")}
                          </text>
                        </g>
                      );
                    })}
                    <line className="finance-axis-line" x1={fundsChartLeft} x2={fundsChartLeft} y1={fundsChartTop} y2={fundsChartBottom} />
                    <line className="finance-axis-line" x1={fundsChartLeft} x2={fundsChartRight} y1={fundsChartBottom} y2={fundsChartBottom} />
                    <path className="finance-line-path finance-line-income" d={fundsIncomePath} />
                    <path className="finance-line-path finance-line-expense" d={fundsExpensePath} />
                    {fundsExpenseSeries.map((item, index) => {
                      const showLabel = index === 0 || index === fundsExpenseSeries.length - 1 || index % fundsLabelStep === 0;
                      const pointTitle = [
                        transactionTitle(item.transaction),
                        formatShortDate(item.date),
                        showCurrency(transactionSignedNativeAmount(item.transaction), item.transaction?.currency || "USD"),
                        transactionSourceLabel(item.transaction)
                      ].filter(Boolean).join(" - ");

                      return (
                        <g key={item.id}>
                          {showLabel ? (
                            <text className="finance-axis-x-label" x={fundsChartX(index)} y={fundsChartBottom + 26} textAnchor="middle">
                              {formatShortDate(item.date)}
                            </text>
                          ) : null}
                          {item.transaction?.kind === "income" ? (
                            <circle className="finance-line-point finance-line-income-point" cx={fundsChartX(index)} cy={fundsChartY(item.incomeUsd)} r="3.2">
                              <title>{pointTitle}</title>
                            </circle>
                          ) : null}
                          {item.transaction?.kind === "expense" ? (
                            <circle className="finance-line-point finance-line-expense-point" cx={fundsChartX(index)} cy={fundsChartY(item.expenseUsd)} r="3.2">
                              <title>{pointTitle}</title>
                            </circle>
                          ) : null}
                        </g>
                      );
                    })}
                  </svg>
                </div>
                <figcaption className="finance-line-legend">
                  <span>
                    <i className="finance-chart-dot finance-good" />
                    <strong>Incoming</strong>
                    <b className="finance-good">{showCurrency(fundsIncomeUsd, "USD")}</b>
                  </span>
                  <span>
                    <i className="finance-chart-dot finance-bad" />
                    <strong>Outbound</strong>
                    <b className="finance-bad">{showCurrency(fundsExpenseUsd, "USD")}</b>
                  </span>
                  <span>
                    <i className="finance-chart-dot finance-info" />
                    <strong>Net</strong>
                    <b className={fundsNetUsd >= 0 ? "finance-good" : "finance-bad"}>{showCurrency(fundsNetUsd, "USD")}</b>
                  </span>
                </figcaption>
              </figure>
            </Panel>
          </section>

          {attentionItems.length > 0 ? (
            <Panel title="Needs Attention">
              <div className="finance-list">
                {attentionItems.map((item) => (
                  <div key={item} className="finance-attention-item">{item}</div>
                ))}
              </div>
            </Panel>
          ) : null}
          </main>

          <aside className="finance-home-sidebar" aria-label="Finance quick lists">
          <Panel title="Bills Left" action={<button type="button" onClick={() => setTab("bills")}>Open</button>}>
            {unpaidBills.length === 0 ? (
              <p className="finance-muted">No unpaid recurring bills.</p>
            ) : (
              <div className="finance-list">
                {unpaidBills.slice(0, 5).map((bill) => {
                  const overdue = overdueBillIds.has(bill.id);

                  return (
                    <article
                      key={bill.id}
                      className={overdue ? "finance-bill-left-item finance-bill-left-overdue" : "finance-bill-left-item"}
                    >
                      <div className="finance-bill-left-copy">
                        <strong>{bill.name}</strong>
                        <small>Due {formatBillDue(bill, snapshot.month)}{overdue ? " - overdue" : ""}</small>
                        <small>{billSourceLabel(bill)}</small>
                      </div>
                      <div className="finance-bill-left-actions">
                        <b>{showCurrency(bill.amountUsd, "USD")}</b>
                        <button
                          type="button"
                          className="finance-pay-button finance-bill-left-pay"
                          onClick={() => toggleBill(bill, true)}
                          disabled={disabled || Boolean(saving)}
                        >
                          Paid
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </Panel>

          <Panel title="Recent Transactions" action={<button type="button" onClick={() => setTab("transactions")}>Open</button>}>
            {recentTransactions.length === 0 ? (
              <p className="finance-muted">No transactions for this month.</p>
            ) : (
              <div className="finance-list">
                {recentTransactions.slice(0, 5).map((transaction) => (
                  <article key={transaction.id} className="finance-list-row finance-list-row-card">
                    <span>
                      <strong>{transaction.merchant || transaction.category}</strong>
                      <small>{formatShortDate(transaction.date)} - {transactionSourceLabel(transaction)}</small>
                    </span>
                    <b className={transaction.kind === "income" ? "finance-good" : "finance-bad"}>
                      {showCurrency(transaction.amount, transaction.currency)}
                    </b>
                    <button type="button" onClick={() => editTransaction(transaction)} aria-label={`Edit ${transactionTitle(transaction)}`}>Edit</button>
                  </article>
                ))}
              </div>
            )}
          </Panel>
          </aside>
        </div>
      ) : null}

      {activeTab === "transactions" ? (
        <main className="finance-stack finance-transactions-stack">
          <Panel
            title="Transaction History"
            action={(
              <div className="finance-panel-actions">
                <span className="finance-panel-count">
                  {filteredHistoryTransactions.length} transaction{filteredHistoryTransactions.length === 1 ? "" : "s"}
                </span>
                <button type="button" className="finance-primary" onClick={openNewTransaction} disabled={disabled}>Add</button>
              </div>
            )}
          >
            <div className="finance-transaction-history">
              <div className="finance-transaction-filter" aria-label="Transaction date filter">
                <label>
                  <span>From</span>
                  <input
                    type="date"
                    value={transactionDateFilter.from}
                    onChange={(event) => setTransactionDateFilter((filter) => ({ ...filter, from: event.target.value }))}
                  />
                </label>
                <label>
                  <span>To</span>
                  <input
                    type="date"
                    value={transactionDateFilter.to}
                    onChange={(event) => setTransactionDateFilter((filter) => ({ ...filter, to: event.target.value }))}
                  />
                </label>
                {transactionDateFilterActive ? (
                  <button type="button" onClick={() => setTransactionDateFilter({ from: "", to: "" })}>
                    Clear
                  </button>
                ) : null}
              </div>

              {filteredHistoryTransactions.length > 0 ? (
                <div className="finance-transaction-pager" aria-label="Transaction pages">
                  <span>
                    Showing {transactionPageStart + 1}-{transactionPageEnd} of {filteredHistoryTransactions.length}
                  </span>
                  <div>
                    <button
                      type="button"
                      onClick={() => setTransactionPage((page) => Math.max(1, page - 1))}
                      disabled={safeTransactionPage <= 1}
                    >
                      Previous
                    </button>
                    <b>Page {safeTransactionPage} of {transactionPageCount}</b>
                    <button
                      type="button"
                      onClick={() => setTransactionPage((page) => Math.min(transactionPageCount, page + 1))}
                      disabled={safeTransactionPage >= transactionPageCount}
                    >
                      Next
                    </button>
                  </div>
                </div>
              ) : null}

              {allTransactions.length === 0 ? (
                <p className="finance-muted">No transactions yet.</p>
              ) : filteredHistoryTransactions.length === 0 ? (
                <p className="finance-muted">No transactions match this date range.</p>
              ) : (
                <div className="finance-transaction-groups">
                  {transactionGroups.map((group) => {
                    if (group.itemCount <= 1 && group.transactions[0]) {
                      return renderTransactionDetail(group.transactions[0], "finance-transaction-single-row");
                    }

                    const expanded = expandedTransactionGroups.has(group.id);
                    const varianceLabel = group.billVariance
                      ? `${group.billVariance.type === "overflow" ? "Overflow" : "Over"} ${showCurrency(group.billVariance.amountUsd, "USD")}`
                      : "";
                    const groupDetail = group.type === "transfer"
                      ? group.title === "Credit Card Payment" ? "paid" : "moved"
                      : group.type === "adjustment"
                        ? "reversed"
                        : varianceLabel
                          ? varianceLabel
                          : `${group.itemCount} item${group.itemCount === 1 ? "" : "s"}`;

                    return (
                      <article key={group.id} className={`finance-transaction-group finance-transaction-group-${group.type}`}>
                        <button
                          type="button"
                          className="finance-transaction-group-summary"
                          aria-expanded={expanded}
                          onClick={() => toggleTransactionGroup(group.id)}
                        >
                          <span className="finance-transaction-group-toggle" aria-hidden="true">{expanded ? "-" : "+"}</span>
                          <span className="finance-transaction-group-copy">
                            <strong>{group.title}</strong>
                            <small>{group.subtitle}</small>
                          </span>
                          <span className="finance-transaction-group-amount">
                            <b className={`finance-${group.tone}`}>{showCurrency(group.amountUsd, "USD")}</b>
                            <small>{groupDetail}</small>
                          </span>
                        </button>

                        {expanded ? (
                          <div className="finance-transaction-group-body">
                            {group.bill ? (
                              <div className="finance-transaction-group-line finance-transaction-group-line-bill">
                                <span>
                                  <strong>Recurring bill</strong>
                                  <small>Due {formatBillDue(group.bill, group.month || snapshot.month)} - {billSourceLabel(group.bill)}</small>
                                </span>
                                <b className="finance-bad">{showCurrency(-Number(group.bill.amountUsd || 0), "USD")}</b>
                              </div>
                            ) : null}

                            {group.billVariance ? (
                              <div className={`finance-transaction-group-line finance-transaction-group-line-variance finance-transaction-group-line-${group.billVariance.type}`}>
                                <span>
                                  <strong>{group.billVariance.type === "overflow" ? "Overflow" : "Over expected"}</strong>
                                  <small>Expected {showCurrency(group.billVariance.expectedUsd, "USD")} - actual {showCurrency(group.billVariance.actualUsd, "USD")}</small>
                                </span>
                                <b className={group.billVariance.type === "overflow" ? "finance-good" : "finance-bad"}>
                                  {showCurrency(group.billVariance.amountUsd, "USD")}
                                </b>
                              </div>
                            ) : null}

                            {group.transactions.map((transaction) => (
                              renderTransactionDetail(transaction)
                            ))}
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          </Panel>
        </main>
      ) : null}

      {activeTab === "bills" ? (
        <main className="finance-stack">
          <Panel
            title="Exchange Rate"
            action={<button type="button" onClick={refreshExchangeRate} disabled={Boolean(saving)}>Refresh</button>}
          >
            <div className="finance-plan-grid">
              <Metric label="USD to PHP" value={exchangeRateMoney(snapshot.plan.exchangeRate)} detail={snapshot.plan.exchangeRateSource || "Frankfurter"} />
              <Metric label="Updated" value={snapshot.plan.exchangeRateDate || "Latest"} detail={formatRateTimestamp(snapshot.plan.exchangeRateUpdatedAt)} />
            </div>
          </Panel>

          <Panel title="Plan">
            <form className="finance-form" onSubmit={submitPlan}>
              <Field label={`Monthly income ${displayCurrency}`}>
                  <input type="number" inputMode="decimal" step="0.01" min="0" value={planForm.monthlyIncomeUsd} onChange={(event) => setPlanForm((form) => ({ ...form, monthlyIncomeUsd: event.target.value }))} disabled={disabled} />
              </Field>
              <div className="finance-form-grid">
                <Field label={`Bi-weekly income ${displayCurrency}`}>
                  <input type="number" inputMode="decimal" step="0.01" min="0" value={planForm.biweeklyIncomeUsd} onChange={(event) => setPlanForm((form) => ({ ...form, biweeklyIncomeUsd: event.target.value }))} disabled={disabled} />
                </Field>
                <Field label={`Bills set aside ${displayCurrency}`}>
                  <input type="number" inputMode="decimal" step="0.01" min="0" value={planForm.biweeklyBillsUsd} onChange={(event) => setPlanForm((form) => ({ ...form, biweeklyBillsUsd: event.target.value }))} disabled={disabled} />
                </Field>
              </div>
              <Field label={`Savings set aside ${displayCurrency}`}>
                <input type="number" inputMode="decimal" step="0.01" min="0" value={planForm.biweeklySavingsUsd} onChange={(event) => setPlanForm((form) => ({ ...form, biweeklySavingsUsd: event.target.value }))} disabled={disabled} />
              </Field>
              <button type="submit" className="finance-primary" disabled={disabled || Boolean(saving)}>Save Plan</button>
            </form>
          </Panel>

          <Panel title={billForm.id ? "Edit Bill" : "Add Bill"}>
            <form className="finance-form" onSubmit={submitBill}>
              <Field label="Name">
                <input value={billForm.name} onChange={(event) => setBillForm((form) => ({ ...form, name: event.target.value }))} required disabled={disabled} maxLength={120} />
              </Field>
              <div className="finance-form-grid">
                <Field label={`Amount ${displayCurrency}`}>
                  <input type="number" inputMode="decimal" step="0.01" min="0" value={billForm.amount} onChange={(event) => setBillForm((form) => ({ ...form, amount: event.target.value, currency: displayCurrency }))} disabled={disabled} />
                </Field>
              </div>
              <div className="finance-form-grid">
                <Field label="Due">
                  <input value={billForm.dueLabel} onChange={(event) => setBillForm((form) => ({ ...form, dueLabel: event.target.value }))} disabled={disabled} maxLength={40} />
                </Field>
                <Field label="Payment account/bank">
                  <input value={billForm.paymentAccount} onChange={(event) => setBillForm((form) => ({ ...form, paymentAccount: event.target.value }))} disabled={disabled} maxLength={80} />
                </Field>
              </div>
              <div className="finance-toggle-grid">
                <label><input type="checkbox" checked={billForm.isPaid} onChange={(event) => setBillForm((form) => ({ ...form, isPaid: event.target.checked }))} disabled={disabled} /> Paid</label>
                <label><input type="checkbox" checked={billForm.isAutopay} onChange={(event) => setBillForm((form) => ({ ...form, isAutopay: event.target.checked }))} disabled={disabled} /> Auto</label>
              </div>
              <div className="finance-button-row">
                <button type="submit" className="finance-primary" disabled={disabled || Boolean(saving)}>
                  {billForm.id ? "Save" : "Add"}
                </button>
                {billForm.id ? <button type="button" onClick={() => setBillForm(defaultBill(displayCurrency))}>Cancel</button> : null}
              </div>
            </form>
          </Panel>

          <Panel title="Recurring Bills">
            {sortedRecurringBills.length === 0 ? (
              <p className="finance-muted">No recurring bills yet.</p>
            ) : (
              <div className="finance-bill-list">
                {sortedRecurringBills.map((bill) => {
                  const overdue = overdueBillIds.has(bill.id);
                  const autoPaid = bill.paidSource === "transaction";
                  const billClassName = [
                    "finance-bill",
                    bill.isPaid ? "finance-bill-paid" : "",
                    overdue ? "finance-bill-overdue" : ""
                  ].filter(Boolean).join(" ");
                  const statusClassName = [
                    "finance-bill-status",
                    bill.isPaid ? "finance-bill-status-paid" : overdue ? "finance-bill-status-overdue" : "finance-bill-status-open"
                  ].join(" ");
                  const statusLabel = autoPaid ? "Matched" : bill.isPaid ? "Paid" : overdue ? "Overdue" : "Open";

                  return (
                    <article key={bill.id} className={billClassName}>
                      <span className={statusClassName}>{statusLabel}</span>
                      <div>
                        <strong>{bill.name}</strong>
                        <span>Due {formatBillDue(bill, snapshot.month)} - {billSourceLabel(bill)}{bill.isAutopay ? " - auto" : ""}</span>
                        {bill.matchedTransaction ? (
                          <small>
                            Matched {formatShortDate(bill.matchedTransaction.date)} - {bill.matchedTransaction.merchant || "Transaction"} - {transactionSourceLabel(bill.matchedTransaction)}
                          </small>
                        ) : null}
                      </div>
                      <b>{showCurrency(bill.amountUsd, "USD")}</b>
                      <div className="finance-mini-actions">
                        {autoPaid && !bill.isManuallyPaid ? (
                          <button type="button" disabled>Matched</button>
                        ) : (
                          <button
                            type="button"
                            className={bill.isManuallyPaid ? "" : "finance-pay-button"}
                            onClick={() => toggleBill(bill, !bill.isManuallyPaid)}
                            disabled={disabled || Boolean(saving)}
                          >
                            {bill.isManuallyPaid ? "Mark unpaid" : "Paid"}
                          </button>
                        )}
                        <button type="button" onClick={() => editBill(bill)}>Edit</button>
                        <button type="button" onClick={() => deleteBill(bill)}>Delete</button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </Panel>
        </main>
      ) : null}

      {activeTab === "profile" ? (
        <main className="finance-stack">
          <Panel
            title="Linked Accounts"
            action={(
              <div className="finance-button-row">
                <button type="button" onClick={connectPlaid} disabled={disabled || Boolean(saving)}>Plaid</button>
                <button type="button" onClick={connectBrankas} disabled={disabled || Boolean(saving)}>Brankas</button>
              </div>
            )}
          >
            {connections.length === 0 ? (
              <p className="finance-muted">No linked accounts yet.</p>
            ) : (
              <div className="finance-list">
                {connections.map((connection) => (
                  <article key={connection.id} className="finance-account-row">
                    <div>
                      <span style={{ background: colorForConnection(connection.provider) }} />
                      <strong>{connection.institutionName}</strong>
                      <small>{connection.provider} - {connection.status} - {formatRateTimestamp(connection.lastSyncedAt)}</small>
                    </div>
                    <button type="button" onClick={() => syncConnection(connection)} disabled={disabled || Boolean(saving)}>Sync</button>
                  </article>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Accounts">
            {snapshot.accounts.length === 0 ? (
              <p className="finance-muted">No accounts yet.</p>
            ) : (
              <div className="finance-list">
                {snapshot.accounts.map((account) => (
                  <article key={account.id} className="finance-account-row">
                    <div>
                      <span style={{ background: account.color }} />
                      <strong>{account.name}</strong>
                      <small>
                        {account.isLinked ? `${account.institutionName || account.provider} - ` : ""}
                        {account.type}
                        {account.isLinked && account.currency !== displayCurrency ? ` - ${money(account.nativeCurrentBalance, account.currency)}` : ""}
                      </small>
                    </div>
                    <b className={account.currentBalance >= 0 ? "finance-good" : "finance-bad"}>{showCurrency(account.currentBalance, "USD")}</b>
                    {account.isLinked ? null : (
                      <div className="finance-mini-actions">
                        <button type="button" onClick={() => editAccount(account)}>Edit</button>
                        <button type="button" onClick={() => archiveAccount(account)}>Archive</button>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}
          </Panel>

          <Panel title={accountForm.id ? "Edit Account" : "Add Account"}>
            <form className="finance-form" onSubmit={submitAccount}>
              <Field label="Name">
                <input value={accountForm.name} onChange={(event) => setAccountForm((form) => ({ ...form, name: event.target.value }))} required disabled={disabled} maxLength={80} />
              </Field>
              <div className="finance-form-grid">
                <Field label="Type">
                  <select value={accountForm.type} onChange={(event) => setAccountForm((form) => ({ ...form, type: event.target.value }))} disabled={disabled}>
                    {ACCOUNT_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                  </select>
                </Field>
                <Field label={`Opening ${displayCurrency}`}>
                  <input type="number" inputMode="decimal" step="0.01" value={accountForm.openingBalance} onChange={(event) => setAccountForm((form) => ({ ...form, openingBalance: event.target.value }))} disabled={disabled} />
                </Field>
              </div>
              <div className="finance-color-row">
                {COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    aria-label={`Use color ${color}`}
                    className={accountForm.color === color ? "finance-color-active" : ""}
                    style={{ background: color }}
                    onClick={() => setAccountForm((form) => ({ ...form, color }))}
                    disabled={disabled}
                  />
                ))}
              </div>
              <div className="finance-button-row">
                <button type="submit" className="finance-primary" disabled={disabled || Boolean(saving)}>{accountForm.id ? "Save" : "Add"}</button>
                {accountForm.id ? <button type="button" onClick={() => setAccountForm(defaultAccount())}>Cancel</button> : null}
              </div>
            </form>
          </Panel>

          <Panel title="Goals">
            {snapshot.goals.length === 0 ? (
              <p className="finance-muted">No goals yet.</p>
            ) : (
              <div className="finance-goal-grid">
                {snapshot.goals.map((goal) => (
                  <article key={goal.id} className="finance-goal-card">
                    <div>
                      <strong>{goal.name}</strong>
                      <span>{goal.category || "Goal"}</span>
                    </div>
                    <p>{showCurrency(goal.savedAmount, goal.currency)} of {showCurrency(goal.targetAmount, goal.currency)}</p>
                    <div className={progressClass(goal.percent)}>
                      <i style={{ width: `${Math.min(100, goal.percent)}%` }} />
                    </div>
                    <small>{goal.remaining > 0 ? `${showCurrency(goal.remaining, goal.currency)} left` : "Funded"}</small>
                    {goal.note ? <p className="finance-note">{goal.note}</p> : null}
                    <div className="finance-button-row">
                      <button type="button" onClick={() => editGoal(goal)}>Edit</button>
                      <button type="button" onClick={() => deleteGoal(goal)}>Delete</button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </Panel>

          <Panel title={goalForm.id ? "Edit Goal" : "Add Goal"}>
            <form className="finance-form" onSubmit={submitGoal}>
              <Field label="Name">
                <input value={goalForm.name} onChange={(event) => setGoalForm((form) => ({ ...form, name: event.target.value }))} required disabled={disabled} maxLength={120} />
              </Field>
              <div className="finance-form-grid">
                <Field label="Currency">
                  <select value={goalForm.currency} onChange={(event) => setGoalForm((form) => ({ ...form, currency: event.target.value }))} disabled={disabled}>
                    <option value="USD">USD</option>
                    <option value="PHP">PHP</option>
                  </select>
                </Field>
                <Field label="Category">
                  <input list="finance-categories" value={goalForm.category} onChange={(event) => setGoalForm((form) => ({ ...form, category: event.target.value }))} disabled={disabled} />
                </Field>
              </div>
              <div className="finance-form-grid">
                <Field label="Target">
                  <input type="number" inputMode="decimal" step="0.01" min="0" value={goalForm.targetAmount} onChange={(event) => setGoalForm((form) => ({ ...form, targetAmount: event.target.value }))} required disabled={disabled} />
                </Field>
                <Field label="Saved">
                  <input type="number" inputMode="decimal" step="0.01" min="0" value={goalForm.savedAmount} onChange={(event) => setGoalForm((form) => ({ ...form, savedAmount: event.target.value }))} disabled={disabled} />
                </Field>
              </div>
              <Field label="Note">
                <textarea value={goalForm.note} onChange={(event) => setGoalForm((form) => ({ ...form, note: event.target.value }))} disabled={disabled} maxLength={300} />
              </Field>
              <div className="finance-button-row">
                <button type="submit" className="finance-primary" disabled={disabled || Boolean(saving)}>{goalForm.id ? "Save" : "Add"}</button>
                {goalForm.id ? <button type="button" onClick={() => setGoalForm(defaultGoal(displayCurrency))}>Cancel</button> : null}
              </div>
            </form>
          </Panel>

          <Panel title="Six Month Trend">
            <div className="finance-trend-list">
              {snapshot.monthlySeries.map((item) => (
                <div key={item.month} className="finance-trend-row">
                  <span>{item.month}</span>
                  <div>
                    <i className="finance-trend-income" style={{ width: `${Math.max(4, (item.incomeUsd / maxTrend) * 100)}%` }} />
                    <i className="finance-trend-expense" style={{ width: `${Math.max(4, (item.expensesUsd / maxTrend) * 100)}%` }} />
                  </div>
                  <b className={item.netUsd >= 0 ? "finance-good" : "finance-bad"}>{showCurrency(item.netUsd, "USD")}</b>
                </div>
              ))}
            </div>
          </Panel>
        </main>
      ) : null}

      <datalist id="finance-categories">
        {snapshot.categories.map((category) => (
          <option key={category} value={category} />
        ))}
      </datalist>
    </div>
  );
}
