"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import FinanceNumberInput from "./FinanceNumberInput";
import {
  convert,
  formatDate,
  localDate,
  money,
} from "../lib/financePlanner.mjs";
import { getFinanceInsights } from "../lib/financeInsights.mjs";
import FinanceAccountSelect, {
  financeAccountLabel,
} from "./FinanceAccountSelect";
import "./finance-activity.css";

const PLAID_SCRIPT = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
const PLAID_SESSION_KEY = "finance:plaid-link-session";
const LINK_MAX_AGE = 4 * 60 * 60 * 1000;
const PAGE_SIZE = 25;
let plaidScriptPromise;

function ActivityIcon({ name, size = 19 }) {
  const paths = {
    plus: <path d="M12 5v14M5 12h14" />,
    bank: (
      <>
        <path d="m3 9 9-6 9 6H3Zm0 12h18M5 11v7m5-7v7m4-7v7m5-7v7" />
      </>
    ),
    card: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="3" />
        <path d="M3 10h18M7 15h4" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2" />
      </>
    ),
    edit: (
      <>
        <path d="m15 5 4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Z" />
      </>
    ),
    trash: <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />,
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 5 5" />
      </>
    ),
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" />
      </>
    ),
    income: <path d="M5 17 17 5M6 5h11v11" />,
    expense: <path d="M5 5 17 17M6 17h11V6" />,
    receipt: (
      <>
        <path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" />
        <path d="M9 7h6M9 11h6M9 15h3" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.bank}
    </svg>
  );
}

function ActionButton({ children, icon, primary, className = "", ...props }) {
  return (
    <button
      type="button"
      className={`fa-button ${primary ? "fa-primary" : ""} ${className}`}
      {...props}
    >
      {icon && <ActivityIcon name={icon} size={16} />}
      {children}
    </button>
  );
}

function NativeMoney({ value, currency }) {
  if (value === null || value === undefined || !Number.isFinite(Number(value)))
    return <>Unavailable</>;
  if (["USD", "PHP"].includes(currency)) return <>{money(value, currency)}</>;
  try {
    return (
      <>
        {new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
          value,
        )}
      </>
    );
  } catch {
    return (
      <>
        {Number(value).toFixed(2)} {currency}
      </>
    );
  }
}

function signedMoney(transaction) {
  return `${transaction.kind === "income" ? "+" : "−"}${money(transaction.amount, transaction.currency)}`;
}

function providerName(provider) {
  return provider === "plaid"
    ? "Plaid"
    : provider === "brankas"
      ? "Brankas"
      : provider || "Manual";
}

function syncTimestamp(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return "Not synced yet";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function QuickTransactionForm({
  transaction,
  accounts = [],
  categories = [],
  rate,
  busy = false,
  disabled = false,
  onSave,
}) {
  const [draft, setDraft] = useState(() => ({
    date: transaction?.date || localDate(),
    kind: transaction?.kind || "expense",
    amount: transaction?.amount ?? "",
    currency: transaction?.currency || "USD",
    merchant: transaction?.merchant || "",
    category:
      transaction?.category ||
      (transaction?.kind === "income" ? "Income" : "Other"),
    note: transaction?.note || "",
    accountId: transaction?.accountId ?? null,
  }));
  const [formError, setFormError] = useState("");
  const supportedAccounts = accounts.filter(
    (account) =>
      ["USD", "PHP"].includes(account.currency) &&
      !account.isArchived &&
      !account.is_archived,
  );
  const selectedAccount = supportedAccounts.find(
    (account) => String(account.id) === String(draft.accountId),
  );
  const categoryOptions = [
    ...new Set(
      ["Other", "Income", ...categories, draft.category].filter(Boolean),
    ),
  ].sort();
  const set = (key, value) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setFormError("");
  };
  const changeKind = (kind) =>
    setDraft((current) => ({
      ...current,
      kind,
      category:
        kind === "income" && current.category === "Other"
          ? "Income"
          : kind === "expense" && current.category === "Income"
            ? "Other"
            : current.category,
    }));

  if (transaction?.provider)
    return (
      <p className="fa-info">
        This transaction came from {providerName(transaction.provider)}. Its
        details update when the bank syncs.
      </p>
    );

  function submit(event) {
    event.preventDefault();
    if (busy || disabled) return;
    const parsedAmount = Number(draft.amount);
    if (
      !Number.isFinite(parsedAmount) ||
      parsedAmount <= 0 ||
      parsedAmount > 999999999 ||
      Math.abs(parsedAmount * 100 - Math.round(parsedAmount * 100)) > 0.00001
    ) {
      setFormError(
        "Enter an amount greater than zero and below one billion, with up to two decimal places.",
      );
      return;
    }
    if (!draft.merchant.trim()) {
      setFormError(
        "Add a short description so you can recognize this transaction.",
      );
      return;
    }
    if (selectedAccount && draft.currency !== selectedAccount.currency) {
      setFormError("Use the account’s currency, or choose Unassigned / cash.");
      return;
    }
    if (draft.accountId && !selectedAccount) {
      setFormError(
        "Choose an available account, or leave this transaction unassigned.",
      );
      return;
    }
    onSave({
      ...draft,
      ...(transaction?.id ? { id: transaction.id } : {}),
      amount: parsedAmount,
      merchant: draft.merchant.trim(),
      note: draft.note.trim(),
      accountId: draft.accountId ? Number(draft.accountId) : null,
    });
  }

  return (
    <form
      className="fa-quick-form"
      onSubmit={submit}
      onInvalid={(event) => {
        const details = event.target.closest("details");
        if (details) details.open = true;
      }}
    >
      <fieldset className="fa-form-fields" disabled={busy || disabled}>
        <legend className="fa-sr-only">Transaction details</legend>
        <div
          className="fa-kind-picker"
          role="group"
          aria-label="Transaction type"
        >
          <button
            type="button"
            className={draft.kind === "expense" ? "active" : ""}
            aria-pressed={draft.kind === "expense"}
            onClick={() => changeKind("expense")}
          >
            <ActivityIcon name="expense" size={16} /> Expense
          </button>
          <button
            type="button"
            className={draft.kind === "income" ? "active" : ""}
            aria-pressed={draft.kind === "income"}
            onClick={() => changeKind("income")}
          >
            <ActivityIcon name="income" size={16} /> Income
          </button>
        </div>
        <div className="fa-amount-row">
          <label className="fa-field">
            <span>Amount</span>
            <div className="fa-quick-amount">
              <span aria-hidden="true">
                {draft.currency === "PHP" ? "₱" : "$"}
              </span>
              <FinanceNumberInput
                autoFocus
                aria-label="Transaction amount"
                inputMode="decimal"
                required
                min="0.01"
                max="999999999"
                step="0.01"
                placeholder="0.00"
                value={draft.amount}
                onChange={(event) => set("amount", event.target.value)}
              />
            </div>
          </label>
          <label className="fa-field">
            <span>Currency</span>
            <select
              value={draft.currency}
              disabled={Boolean(selectedAccount)}
              onChange={(event) => set("currency", event.target.value)}
            >
              <option value="USD">USD · US dollar</option>
              <option value="PHP">PHP · Peso</option>
            </select>
          </label>
        </div>
        <label className="fa-field">
          <span>Description</span>
          <input
            required
            maxLength={120}
            placeholder={
              draft.kind === "income"
                ? "e.g. Freelance payment, refund"
                : "e.g. Lunch, groceries, a new keyboard"
            }
            value={draft.merchant}
            onChange={(event) => set("merchant", event.target.value)}
            autoComplete="off"
          />
        </label>
        {Number(draft.amount) > 0 && (
          <p className="fa-conversion">
            About{" "}
            {money(
              convert(
                draft.amount,
                draft.currency,
                draft.currency === "USD" ? "PHP" : "USD",
                rate,
              ),
              draft.currency === "USD" ? "PHP" : "USD",
            )}{" "}
            at your reference rate.
          </p>
        )}
        <details
          className="fa-more-details"
          open={transaction ? true : undefined}
        >
          <summary>
            Date, account & more{" "}
            <span>
              {formatDate(draft.date)} · {selectedAccount?.name || "Unassigned"}
            </span>
          </summary>
          <div className="fa-details-grid">
            <label className="fa-field">
              <span>Date</span>
              <input
                type="date"
                min="1900-01-01"
                max="2200-12-31"
                required
                value={draft.date}
                onChange={(event) => set("date", event.target.value)}
              />
            </label>
            <label className="fa-field">
              <span>Category</span>
              <select
                value={draft.category}
                onChange={(event) => set("category", event.target.value)}
              >
                {categoryOptions.map((category) => (
                  <option key={category}>{category}</option>
                ))}
              </select>
            </label>
            <label className="fa-field fa-wide">
              <span>Account (optional)</span>
              <FinanceAccountSelect
                accounts={accounts.filter((account) =>
                  ["USD", "PHP"].includes(account.currency),
                )}
                emptyLabel="Unassigned / cash"
                value={draft.accountId}
                onChange={(accountId) => {
                  const account = supportedAccounts.find(
                    (item) => item.id === accountId,
                  );
                  setDraft((current) => ({
                    ...current,
                    accountId,
                    currency: account?.currency || current.currency,
                  }));
                  setFormError("");
                }}
              />
              <small>
                {selectedAccount?.isLinked
                  ? "Record only transactions not already imported from your bank. Manual entries affect spending totals; bank-reported balances update through sync."
                  : selectedAccount
                    ? "This entry updates the tracked balance in the account’s currency."
                    : "This entry affects your activity totals without changing a tracked bank balance."}
              </small>
            </label>
            <label className="fa-field fa-wide">
              <span>Note (optional)</span>
              <textarea
                rows={2}
                maxLength={300}
                placeholder="Anything else you want to remember"
                value={draft.note}
                onChange={(event) => set("note", event.target.value)}
              />
            </label>
          </div>
        </details>
        <p className="fa-quick-note">
          Records a one-time transaction. It won’t create a recurring bill or
          move money.
        </p>
        {formError && (
          <p className="fa-form-error" role="alert">
            {formError}
          </p>
        )}
        <ActionButton
          primary
          icon="plus"
          type="submit"
          disabled={busy || disabled}
        >
          {busy
            ? "Saving…"
            : transaction
              ? "Save transaction"
              : "Add transaction"}
        </ActionButton>
      </fieldset>
    </form>
  );
}

export function TransactionsPanel({
  activity,
  month,
  currency = "USD",
  rate,
  onAdd,
  onEdit,
  onDelete,
}) {
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("all");
  const [category, setCategory] = useState("all");
  const [status, setStatus] = useState("all");
  const [accountFilter, setAccountFilter] = useState("all");
  const [page, setPage] = useState(1);
  const selectedMonth = month || activity.month || localDate().slice(0, 7);
  const today = localDate();
  const knownAccounts = [
    ...(activity.accounts || []),
    ...(activity.archivedAccounts || []),
  ];
  const accountFor = (row) =>
    knownAccounts.find(
      (account) => String(account.id) === String(row.accountId),
    );
  const monthRows = useMemo(
    () =>
      (activity.transactions || [])
        .filter((row) => row.date?.startsWith(selectedMonth))
        .sort(
          (first, second) =>
            second.date.localeCompare(first.date) ||
            Number(second.id) - Number(first.id),
        ),
    [activity.transactions, selectedMonth],
  );
  const rows = useMemo(
    () =>
      monthRows.filter((row) => {
        if (kind !== "all" && row.kind !== kind) return false;
        if (category !== "all" && row.category !== category) return false;
        if (accountFilter === "unassigned" && row.accountId) return false;
        if (
          !["all", "unassigned"].includes(accountFilter) &&
          String(row.accountId) !== accountFilter
        )
          return false;
        if (status === "pending" && !row.pending) return false;
        if (status === "posted" && (row.pending || row.date > today))
          return false;
        if (status === "scheduled" && (row.pending || row.date <= today))
          return false;
        if (status === "manual" && row.provider) return false;
        if (status === "bank" && !row.provider) return false;
        const text = [
          row.merchant,
          row.category,
          row.note,
          row.accountName,
          accountFor(row)?.mask,
          row.institutionName,
          row.provider,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return !search.trim() || text.includes(search.trim().toLowerCase());
      }),
    [
      monthRows,
      search,
      kind,
      category,
      status,
      accountFilter,
      today,
      activity.accounts,
      activity.archivedAccounts,
    ],
  );
  const categories = [
    ...new Set([
      ...monthRows.map((row) => row.category || "Uncategorized"),
      ...(category !== "all" ? [category] : []),
    ]),
  ].sort();
  const accountOptions = new Map(
    knownAccounts.map((account) => [String(account.id), account]),
  );
  for (const row of monthRows) {
    if (row.accountId && !accountOptions.has(String(row.accountId)))
      accountOptions.set(String(row.accountId), {
        id: row.accountId,
        name: row.accountName || "Account",
        currency: row.currency,
      });
  }
  const totals = useMemo(
    () =>
      getFinanceInsights({
        activity,
        rate,
        month: selectedMonth,
        currency,
        today,
      }),
    [activity, rate, selectedMonth, currency, today],
  );
  useEffect(
    () => setPage(1),
    [selectedMonth, search, kind, category, status, accountFilter],
  );
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visibleRows = rows.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );
  const hasFilters = Boolean(
    search ||
    kind !== "all" ||
    category !== "all" ||
    status !== "all" ||
    accountFilter !== "all",
  );
  const clearFilters = () => {
    setSearch("");
    setKind("all");
    setCategory("all");
    setStatus("all");
    setAccountFilter("all");
  };

  return (
    <section className="fa-activity-section">
      <div
        className="fa-activity-summary"
        aria-label="Recorded transactions this month"
      >
        <div>
          <span>Posted income</span>
          <strong className="fa-positive">
            {money(totals.income, currency)}
          </strong>
        </div>
        <div>
          <span>Posted spending</span>
          <strong>{money(totals.expenses, currency)}</strong>
        </div>
        <div>
          <span>Recorded transactions</span>
          <strong>{monthRows.length.toLocaleString()}</strong>
        </div>
      </div>
      <div className="fa-card">
        <header className="fa-section-header">
          <div>
            <h2>Transaction history</h2>
            <p>One-time entries and bank imports, in one place.</p>
          </div>
          <ActionButton
            primary
            icon="plus"
            onClick={onAdd}
            disabled={!activity.configured}
          >
            Add transaction
          </ActionButton>
        </header>
        <div className="fa-transaction-filters">
          <label className="fa-search">
            <span className="fa-sr-only">Search transactions</span>
            <ActivityIcon name="search" size={16} />
            <input
              type="search"
              placeholder="Search transactions"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <label className="fa-filter">
            <span className="fa-sr-only">Account filter</span>
            <select
              value={accountFilter}
              onChange={(event) => setAccountFilter(event.target.value)}
            >
              <option value="all">All accounts</option>
              <option value="unassigned">Unassigned / cash</option>
              {[...accountOptions.values()].map((account) => (
                <option key={account.id} value={account.id}>
                  {financeAccountLabel(account)}
                  {account.isArchived ? " · Removed" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="fa-filter">
            <span className="fa-sr-only">Transaction type</span>
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value)}
            >
              <option value="all">All types</option>
              <option value="expense">Expenses</option>
              <option value="income">Income</option>
            </select>
          </label>
          <label className="fa-filter">
            <span className="fa-sr-only">Category</span>
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            >
              <option value="all">All categories</option>
              {categories.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label className="fa-filter">
            <span className="fa-sr-only">Transaction status or source</span>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="all">All entries</option>
              <option value="posted">Posted</option>
              <option value="pending">Pending</option>
              <option value="scheduled">Scheduled</option>
              <option value="manual">One-time entries</option>
              <option value="bank">Bank imports</option>
            </select>
          </label>
        </div>
        <div className="fa-history-note">
          <span>Original currencies shown · totals in {currency}</span>
          {hasFilters && (
            <button type="button" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>
        {activity.limitHit && (
          <p className="fa-info fa-history-limit">
            This view includes the latest 5,000 transactions in the selected
            six-month history. Totals may be incomplete.
          </p>
        )}
        {!visibleRows.length ? (
          <div className="fa-empty">
            <span>
              <ActivityIcon name="receipt" size={27} />
            </span>
            <h3>
              {hasFilters
                ? "No matching transactions"
                : "A clearer picture starts here"}
            </h3>
            <p>
              {hasFilters
                ? "Try another search or reset your filters."
                : "Add a one-time expense or income, or connect a bank to bring in your activity."}
            </p>
            <ActionButton
              onClick={hasFilters ? clearFilters : onAdd}
              primary={!hasFilters}
              disabled={!hasFilters && !activity.configured}
            >
              {hasFilters ? "Clear filters" : "Add your first transaction"}
            </ActionButton>
          </div>
        ) : (
          <>
            <div className="fa-transactions-wrap">
              <table className="fa-transactions">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Transaction</th>
                    <th>Account / source</th>
                    <th>Amount</th>
                    <th>
                      <span className="fa-sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => (
                    <tr key={row.id}>
                      <td data-label="Date">
                        <span>{formatDate(row.date, { year: "numeric" })}</span>
                      </td>
                      <td data-label="Transaction">
                        <div className="fa-transaction-title">
                          <span className={`fa-direction fa-${row.kind}`}>
                            <ActivityIcon
                              name={
                                row.kind === "income" ? "income" : "expense"
                              }
                              size={15}
                            />
                          </span>
                          <div>
                            <strong>
                              {row.merchant || row.category || "Transaction"}
                            </strong>
                            <small>
                              {row.category || "Uncategorized"}
                              {row.note ? ` · ${row.note}` : ""}
                            </small>
                            <div className="fa-tags">
                              <span>
                                {row.provider ? "Bank import" : "One-time"}
                              </span>
                              {row.pending ? (
                                <span className="fa-tag-pending">Pending</span>
                              ) : row.date > today ? (
                                <span className="fa-tag-pending">
                                  Scheduled
                                </span>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td data-label="Account / source">
                        <span>
                          {row.accountName ||
                            accountFor(row)?.name ||
                            (row.provider
                              ? "Bank account"
                              : "Unassigned / cash")}
                          {accountFor(row)?.mask
                            ? ` · ••${accountFor(row).mask}`
                            : ""}
                        </span>
                        <small>
                          {row.institutionName ||
                            (row.provider
                              ? providerName(row.provider)
                              : "Manual entry")}
                        </small>
                      </td>
                      <td
                        data-label="Amount"
                        className={`fa-transaction-amount ${row.kind === "income" ? "fa-positive" : ""}`}
                      >
                        <strong>{signedMoney(row)}</strong>
                        {row.currency !== currency && (
                          <small>
                            ≈ {row.kind === "income" ? "+" : "−"}
                            {money(
                              convert(row.amount, row.currency, currency, rate),
                              currency,
                            )}
                          </small>
                        )}
                      </td>
                      <td data-label="Actions">
                        <div className="fa-row-actions">
                          {!row.provider ? (
                            <>
                              <ActionButton
                                icon="edit"
                                className="fa-icon-button"
                                aria-label={`Edit ${row.merchant || row.category || "transaction"}`}
                                onClick={() => onEdit(row)}
                              />
                              <ActionButton
                                icon="trash"
                                className="fa-icon-button fa-delete"
                                aria-label={`Delete ${row.merchant || row.category || "transaction"}`}
                                onClick={() => onDelete(row)}
                              />
                            </>
                          ) : (
                            <span
                              className="fa-import-lock"
                              title="Bank imports update through sync"
                            >
                              <ActivityIcon name="lock" size={14} />
                              <span className="fa-sr-only">
                                Bank import, read only
                              </span>
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="fa-pagination">
              <span>
                Showing {(currentPage - 1) * PAGE_SIZE + 1}–
                {Math.min(currentPage * PAGE_SIZE, rows.length)} of{" "}
                {rows.length.toLocaleString()}
              </span>
              <div>
                <ActionButton
                  disabled={currentPage <= 1}
                  onClick={() => setPage(currentPage - 1)}
                >
                  Previous
                </ActionButton>
                <span>
                  {currentPage} / {pageCount}
                </span>
                <ActionButton
                  disabled={currentPage >= pageCount}
                  onClick={() => setPage(currentPage + 1)}
                >
                  Next
                </ActionButton>
              </div>
            </div>
          </>
        )}
      </div>
      <p className="fa-footnote">
        Posted totals exclude pending entries, future dates, transfers, and loan
        payments. These entries still appear in history. Manual entries don’t
        automatically match or replace bank imports.
      </p>
    </section>
  );
}

function loadPlaidScript() {
  if (typeof window === "undefined")
    return Promise.reject(
      new Error("Bank connections are available in your browser."),
    );
  if (typeof window.Plaid?.create === "function")
    return Promise.resolve(window.Plaid);
  if (plaidScriptPromise) return plaidScriptPromise;
  plaidScriptPromise = new Promise((resolve, reject) => {
    let script = window.document.querySelector(`script[src="${PLAID_SCRIPT}"]`);
    if (!script) {
      script = window.document.createElement("script");
      script.src = PLAID_SCRIPT;
      script.async = true;
      script.dataset.financePlaid = "true";
    }
    const cleanup = () => {
      clearTimeout(timeout);
      script.removeEventListener("load", loaded);
      script.removeEventListener("error", failed);
    };
    const failed = () => {
      cleanup();
      script.remove();
      reject(
        new Error(
          "The secure bank connection window could not load. Check your connection and try again.",
        ),
      );
    };
    const loaded = () => {
      cleanup();
      if (typeof window.Plaid?.create === "function") resolve(window.Plaid);
      else {
        script.remove();
        reject(
          new Error(
            "The bank connection service didn’t initialize. Please try again.",
          ),
        );
      }
    };
    const timeout = setTimeout(failed, 20000);
    script.addEventListener("load", loaded, { once: true });
    script.addEventListener("error", failed, { once: true });
    if (!script.isConnected) window.document.head.appendChild(script);
  }).catch((error) => {
    plaidScriptPromise = null;
    throw error;
  });
  return plaidScriptPromise;
}

function readLinkSession() {
  try {
    const session = JSON.parse(
      window.sessionStorage.getItem(PLAID_SESSION_KEY) || "null",
    );
    if (
      typeof session?.token === "string" &&
      session.token.length > 0 &&
      Number.isFinite(session.expiresAt) &&
      session.expiresAt > Date.now() &&
      session.expiresAt <= Date.now() + LINK_MAX_AGE
    )
      return session;
  } catch {
    /* A browser can disable session storage without blocking normal Plaid Link. */
  }
  clearLinkSession();
  return null;
}

function clearLinkSession() {
  try {
    window.sessionStorage.removeItem(PLAID_SESSION_KEY);
  } catch {
    /* Storage is optional. */
  }
}

function saveLinkSession(result, connectionId = null) {
  const providerExpiry = Date.parse(result.expiration || "");
  const expiresAt = Math.min(
    Number.isFinite(providerExpiry)
      ? providerExpiry
      : Date.now() + LINK_MAX_AGE,
    Date.now() + LINK_MAX_AGE,
  );
  try {
    window.sessionStorage.setItem(
      PLAID_SESSION_KEY,
      JSON.stringify({ token: result.linkToken, expiresAt, connectionId }),
    );
  } catch {
    /* Link still works without redirect resumption. */
  }
}

function clearOAuthQuery() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("oauth_state_id")) return;
  url.searchParams.delete("oauth_state_id");
  url.searchParams.set("tab", "accounts");
  window.history.replaceState(window.history.state, "", url);
}

export function BankAccountsPanel({
  activity,
  accountAllocations = [],
  rate,
  currency = "USD",
  busy = false,
  onAction,
  onRefresh,
  onNotice,
  onError,
}) {
  const [pending, setPending] = useState("");
  const [linkStatus, setLinkStatus] = useState("");
  const [confirmation, setConfirmation] = useState(null);
  const [repairPreview, setRepairPreview] = useState(null);
  const [manualAccountOpen, setManualAccountOpen] = useState(false);
  const [manualAccount, setManualAccount] = useState({
    name: "",
    type: "cash",
    currency: "USD",
    openingBalance: "0",
  });
  const [manualAccountError, setManualAccountError] = useState("");
  const handlerRef = useRef(null);
  const lockRef = useRef(false);
  const mountedRef = useRef(true);
  const resumeAttempted = useRef(false);
  const callbacks = useRef({ onAction, onRefresh, onNotice, onError });
  callbacks.current = { onAction, onRefresh, onNotice, onError };
  const plaid = activity.providers?.plaid || {
    configured: false,
    environment: "sandbox",
  };
  const brankas = activity.providers?.brankas || {
    configured: false,
    syncSupported: false,
  };
  const unavailable = !activity.configured;
  const working = busy || Boolean(pending);
  const sandbox = plaid.environment !== "production";

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      handlerRef.current?.destroy();
      handlerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (resumeAttempted.current || !activity.configured || !plaid.configured)
      return;
    if (!new URL(window.location.href).searchParams.has("oauth_state_id"))
      return;
    resumeAttempted.current = true;
    const saved = readLinkSession();
    if (!saved) {
      callbacks.current.onError?.(
        "This bank connection session expired or opened in another browser. Connect your bank again to continue.",
      );
      clearOAuthQuery();
      return;
    }
    startPlaid(saved.token, window.location.href, saved.connectionId || null);
    // Resume once per mounted bank view, preserving Plaid's full redirect URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity.configured, plaid.configured]);

  function finishLink() {
    clearLinkSession();
    clearOAuthQuery();
    handlerRef.current?.destroy();
    handlerRef.current = null;
    lockRef.current = false;
    if (mountedRef.current) {
      setPending("");
      setLinkStatus("");
    }
  }

  async function startPlaid(
    token = null,
    receivedRedirectUri = null,
    connectionId = null,
  ) {
    if (lockRef.current || busy) return;
    lockRef.current = true;
    setPending("link");
    setLinkStatus(
      receivedRedirectUri
        ? "Resuming your secure bank connection…"
        : "Opening the secure bank connection window…",
    );
    try {
      const result = token
        ? { linkToken: token, connectionId }
        : await callbacks.current.onAction(
            "createPlaidLinkToken",
            connectionId ? { connectionId } : {},
          );
      const updatingConnectionId =
        Number(result?.connectionId || connectionId) || null;
      if (!result?.linkToken)
        throw new Error(
          "The bank connection service did not return a usable session. Please try again.",
        );
      if (!token) saveLinkSession(result, updatingConnectionId);
      const sdk = await loadPlaidScript();
      if (!mountedRef.current) {
        clearLinkSession();
        lockRef.current = false;
        return;
      }
      handlerRef.current?.destroy();
      handlerRef.current = sdk.create({
        token: result.linkToken,
        ...(receivedRedirectUri ? { receivedRedirectUri } : {}),
        onLoad: () => {
          if (mountedRef.current)
            setLinkStatus("Finish connecting in the secure Plaid window.");
        },
        onSuccess: async (publicToken, metadata) => {
          if (mountedRef.current) {
            setPending("exchange");
            setLinkStatus(
              "Your bank is connected. Importing balances and transactions…",
            );
          }
          let exchanged = false;
          try {
            if (updatingConnectionId) {
              await callbacks.current.onAction("syncConnection", {
                id: updatingConnectionId,
              });
            } else {
              if (!publicToken)
                throw new Error(
                  "The bank did not return a usable authorization. Please connect again.",
                );
              await callbacks.current.onAction("exchangePlaidPublicToken", {
                publicToken,
                metadata: { institution: metadata?.institution || null },
              });
            }
            exchanged = true;
            await callbacks.current.onRefresh();
            callbacks.current.onNotice?.(
              updatingConnectionId
                ? "Bank accounts updated on the existing connection."
                : "Bank connected. Your balances and transactions are up to date.",
            );
          } catch (error) {
            if (!exchanged) await callbacks.current.onRefresh().catch(() => {});
            callbacks.current.onError?.(
              exchanged
                ? "Your bank was connected, but the account list could not refresh. Use Refresh view to load it."
                : error.message ||
                    "Your bank connection could not be completed. Please try again.",
            );
          } finally {
            finishLink();
          }
        },
        onExit: (error) => {
          if (error)
            callbacks.current.onError?.(
              error.display_message ||
                "The bank connection was interrupted. Please try again.",
            );
          finishLink();
        },
      });
      handlerRef.current.open();
    } catch (error) {
      finishLink();
      callbacks.current.onError?.(
        error.message || "Could not open the bank connection window.",
      );
    }
  }

  async function runAction(key, action) {
    if (lockRef.current || busy) return;
    lockRef.current = true;
    setPending(key);
    try {
      await action();
    } catch (error) {
      callbacks.current.onError?.(
        error.message || "The bank action could not be completed.",
      );
    } finally {
      lockRef.current = false;
      if (mountedRef.current) setPending("");
    }
  }

  async function syncConnection(connection) {
    await runAction(`sync:${connection.id}`, async () => {
      try {
        await callbacks.current.onAction("syncConnection", {
          id: connection.id,
        });
      } catch (error) {
        await callbacks.current.onRefresh().catch(() => {});
        throw error;
      }
      await callbacks.current.onRefresh();
      callbacks.current.onNotice?.(
        `${connection.institutionName || "Bank"} synced.`,
      );
    });
  }

  async function linkBrankas() {
    await runAction("brankas", async () => {
      const result = await callbacks.current.onAction("createBrankasLink", {});
      let url;
      try {
        url = new URL(result?.url);
      } catch {
        throw new Error(
          "The Philippine bank connection URL isn’t valid. Check its setup before trying again.",
        );
      }
      if (url.protocol !== "https:")
        throw new Error(
          "The Philippine bank connection must use a secure HTTPS URL. Update its setup before continuing.",
        );
      window.location.assign(url.toString());
    });
  }

  function removeSelected() {
    const selection = confirmation;
    if (!selection) return;
    return runAction(`${selection.kind}:${selection.id}`, async () => {
      await callbacks.current.onAction(
        selection.kind === "account" ? "removeAccount" : "unlinkConnection",
        { id: selection.id },
      );
      setConfirmation(null);
      await callbacks.current.onRefresh();
      callbacks.current.onNotice?.(
        selection.kind === "account"
          ? "Account removed from the active view. Transaction history is retained."
          : "Bank connection unlinked. Transaction history is retained.",
      );
    });
  }

  function removalConfirmation(kind, id) {
    if (confirmation?.kind !== kind || confirmation.id !== id) return null;
    return (
      <div className="fa-removal-confirmation" role="alert">
        <p>
          {kind === "account"
            ? "Remove this account from active tracking? Its transactions and saved assignments remain in history, and syncing will not add it back."
            : "Unlink this bank connection? Syncing stops and its accounts leave the active view. Existing transactions and saved assignments remain in history."}
        </p>
        <div className="fa-button-row">
          <ActionButton
            className="fa-danger"
            disabled={working}
            onClick={removeSelected}
          >
            {kind === "account" ? "Remove account" : "Unlink connection"}
          </ActionButton>
          <ActionButton
            disabled={working}
            onClick={() => setConfirmation(null)}
          >
            Keep it
          </ActionButton>
        </div>
      </div>
    );
  }

  function addManualAccount(event) {
    event.preventDefault();
    if (working || unavailable) return;
    const name = manualAccount.name.trim();
    const openingBalance = Number(manualAccount.openingBalance);
    if (!name || name.length > 80)
      return setManualAccountError(
        "Enter an account name of up to 80 characters.",
      );
    if (
      !Number.isFinite(openingBalance) ||
      Math.abs(openingBalance) > 999999999 ||
      Math.abs(openingBalance * 100 - Math.round(openingBalance * 100)) >
        0.00001
    )
      return setManualAccountError(
        "Enter a valid opening balance below one billion with up to two decimal places.",
      );
    return runAction("create-account", async () => {
      await callbacks.current.onAction("createAccount", {
        name,
        type: manualAccount.type,
        currency: manualAccount.currency,
        openingBalance,
        color: "#548564",
      });
      setManualAccountOpen(false);
      setManualAccount({
        name: "",
        type: "cash",
        currency: "USD",
        openingBalance: "0",
      });
      setManualAccountError("");
      callbacks.current.onNotice?.(
        "Manual account added. You can now assign bills, transactions, and savings to it.",
      );
      await callbacks.current.onRefresh();
    });
  }

  return (
    <section className="fa-bank-section">
      <div className="fa-bank-intro">
        <div>
          <h2>Your accounts, connected.</h2>
          <p>
            Bring balances and transactions into the same view as your spending
            plan.
          </p>
        </div>
        <div className="fa-button-row">
          <ActionButton
            icon="plus"
            disabled={working || unavailable}
            onClick={() => {
              setManualAccountOpen((open) => !open);
              setManualAccountError("");
            }}
          >
            Add manual account
          </ActionButton>
          <ActionButton
            icon="refresh"
            disabled={working || unavailable}
            onClick={() =>
              runAction("refresh", async () => {
                await callbacks.current.onRefresh();
                callbacks.current.onNotice?.("Account view refreshed.");
              })
            }
          >
            {pending === "refresh" ? "Refreshing…" : "Refresh view"}
          </ActionButton>
          <ActionButton
            icon="refresh"
            disabled={working || unavailable || !plaid.configured}
            onClick={() =>
              runAction("repair-preview", async () => {
                const result = await callbacks.current.onAction(
                  "repairDuplicateAccounts",
                  { preview: true },
                );
                setRepairPreview(result);
              })
            }
          >
            {pending === "repair-preview"
              ? "Checking…"
              : "Find duplicate accounts"}
          </ActionButton>
        </div>
      </div>
      {manualAccountOpen && (
        <form
          className="fa-card fa-manual-account-form"
          onSubmit={addManualAccount}
        >
          <h3>Add a manually tracked account</h3>
          <p>
            Track an existing cash or bank account in this app, including PHP
            accounts. This does not open a bank account or connect to a bank.
          </p>
          <fieldset disabled={working || unavailable}>
            <legend className="fa-sr-only">Manual account details</legend>
            <div className="fa-details-grid">
              <label className="fa-field fa-wide">
                <span>Account name</span>
                <input
                  required
                  maxLength={80}
                  autoFocus
                  value={manualAccount.name}
                  placeholder="e.g. PHP cash, RCBC checking"
                  onChange={(event) => {
                    setManualAccount((current) => ({
                      ...current,
                      name: event.target.value,
                    }));
                    setManualAccountError("");
                  }}
                />
              </label>
              <label className="fa-field">
                <span>Account type</span>
                <select
                  value={manualAccount.type}
                  onChange={(event) =>
                    setManualAccount((current) => ({
                      ...current,
                      type: event.target.value,
                    }))
                  }
                >
                  <option value="cash">Cash</option>
                  <option value="checking">Checking</option>
                  <option value="savings">Savings</option>
                  <option value="credit">Credit card</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label className="fa-field">
                <span>Account currency</span>
                <select
                  value={manualAccount.currency}
                  onChange={(event) =>
                    setManualAccount((current) => ({
                      ...current,
                      currency: event.target.value,
                    }))
                  }
                >
                  <option value="USD">USD · US dollar</option>
                  <option value="PHP">PHP · Peso</option>
                </select>
              </label>
              <label className="fa-field fa-wide">
                <span>Opening balance · {manualAccount.currency}</span>
                <FinanceNumberInput
                  required
                  step="0.01"
                  min="-999999999"
                  max="999999999"
                  inputMode="decimal"
                  value={manualAccount.openingBalance}
                  onChange={(event) => {
                    setManualAccount((current) => ({
                      ...current,
                      openingBalance: event.target.value,
                    }));
                    setManualAccountError("");
                  }}
                />
                <small>
                  Use the account’s native currency. Manual transactions update
                  this tracked balance; credit accounts use a positive amount
                  for money owed.
                </small>
              </label>
            </div>
            {manualAccountError && (
              <p className="fa-negative" role="alert">
                {manualAccountError}
              </p>
            )}
            <div className="fa-button-row">
              <button type="submit" className="fa-button fa-primary">
                {pending === "create-account"
                  ? "Adding…"
                  : "Add tracked account"}
              </button>
              <ActionButton
                onClick={() => {
                  setManualAccountOpen(false);
                  setManualAccountError("");
                }}
              >
                Cancel
              </ActionButton>
            </div>
          </fieldset>
        </form>
      )}
      {repairPreview && (
        <div className="fa-card fa-repair-preview" role="status">
          <h3>
            {repairPreview.duplicateAccounts > 0
              ? `${repairPreview.duplicateAccounts} duplicate account${repairPreview.duplicateAccounts === 1 ? "" : "s"} found`
              : "No confirmed duplicates found"}
          </h3>
          <p>
            Matches use bank-provided account identity. Distinct savings
            accounts stay separate. Transaction history and account assignments
            are retained.
          </p>
          {repairPreview.groups?.length > 0 && (
            <ul>
              {repairPreview.groups.map((group) => (
                <li key={group.canonicalId}>
                  {group.name || "Account"}
                  {group.mask ? ` · ••${group.mask}` : ""} · {group.currency} ·{" "}
                  {group.duplicateIds.length} duplicate
                  {group.duplicateIds.length === 1 ? "" : "s"}
                </li>
              ))}
            </ul>
          )}
          {repairPreview.warnings?.map((warning, index) => (
            <p key={index}>{warning}</p>
          ))}
          <div className="fa-button-row">
            {repairPreview.duplicateAccounts > 0 && (
              <ActionButton
                primary
                disabled={working}
                onClick={() =>
                  runAction("repair", async () => {
                    const result = await callbacks.current.onAction(
                      "repairDuplicateAccounts",
                      { preview: false },
                    );
                    setRepairPreview(null);
                    await callbacks.current.onRefresh();
                    callbacks.current.onNotice?.(
                      `${result.mergedAccounts || 0} duplicate accounts merged. History and assignments were preserved.`,
                    );
                  })
                }
              >
                {pending === "repair"
                  ? "Merging…"
                  : "Merge confirmed duplicates"}
              </ActionButton>
            )}
            <ActionButton
              disabled={working}
              onClick={() => setRepairPreview(null)}
            >
              Close
            </ActionButton>
          </div>
        </div>
      )}
      <div className="fa-bank-providers">
        <article className="fa-provider-card">
          <div className="fa-provider-heading">
            <span className="fa-provider-icon">
              <ActivityIcon name="bank" size={23} />
            </span>
            <div>
              <h3>US bank accounts</h3>
              <span>Connected through Plaid</span>
            </div>
            {sandbox && (
              <span className="fa-sandbox-badge">
                {plaid.environment === "sandbox"
                  ? "Sandbox"
                  : "Test environment"}
              </span>
            )}
          </div>
          <p>
            Connect supported checking, savings, and credit accounts to import
            balances and transaction history.
          </p>
          {sandbox && plaid.configured && (
            <p className="fa-provider-warning">
              Test mode connects sample bank accounts. Live accounts require
              production access.
            </p>
          )}
          <ActionButton
            primary
            icon="plus"
            disabled={working || unavailable || !plaid.configured}
            onClick={() => startPlaid()}
          >
            {pending === "link" || pending === "exchange"
              ? "Connecting…"
              : "Connect US bank"}
          </ActionButton>
          {!plaid.configured && (
            <small className="fa-provider-setup">
              Plaid isn’t enabled for this app yet. Complete the provider setup
              to connect a bank.
            </small>
          )}
        </article>
        <article className="fa-provider-card fa-brankas-card">
          <div className="fa-provider-heading">
            <span className="fa-provider-icon fa-peso-icon">₱</span>
            <div>
              <h3>Philippine bank accounts</h3>
              <span>Authorization through Brankas</span>
            </div>
            <span className="fa-authorization-badge">Authorization only</span>
          </div>
          <p>
            Save a bank authorization through the existing Brankas connection
            flow.
          </p>
          <p className="fa-provider-warning">
            Balance and transaction imports aren’t available for this connection
            yet.
          </p>
          <ActionButton
            icon="arrow"
            disabled={working || unavailable || !brankas.configured}
            onClick={linkBrankas}
          >
            {pending === "brankas" ? "Opening…" : "Link Philippine bank"}
          </ActionButton>
          {!brankas.configured && (
            <small className="fa-provider-setup">
              Brankas isn’t enabled for this app yet.
            </small>
          )}
        </article>
      </div>
      {linkStatus && (
        <p className="fa-link-status" role="status">
          <span className="fa-busy-dot" />
          {linkStatus}
        </p>
      )}
      <div className="fa-card">
        <header className="fa-section-header">
          <div>
            <h2>Accounts</h2>
            <p>
              {activity.accounts?.length
                ? "Balances stay in their original currency."
                : "Your connected accounts will appear here."}
            </p>
          </div>
          <span className="fa-count">{activity.accounts?.length || 0}</span>
        </header>
        {!activity.accounts?.length ? (
          <div className="fa-empty fa-bank-empty">
            <span>
              <ActivityIcon name="card" size={27} />
            </span>
            <h3>No accounts connected yet</h3>
            <p>
              Connect a supported US bank above. You can also record one-time
              transactions without a bank connection.
            </p>
          </div>
        ) : (
          <div className="fa-accounts-grid">
            {activity.accounts.map((account) => {
              const allocation = accountAllocations.find(
                (item) => String(item.accountId) === String(account.id),
              );
              const liability = ["credit", "loan"].includes(account.type);
              const balance = account.nativeCurrentBalance;
              const hasBalance =
                balance !== null &&
                balance !== undefined &&
                Number.isFinite(Number(balance));
              const creditBalance =
                liability && hasBalance && Number(balance) < 0;
              const nativeDisplay = creditBalance
                ? Math.abs(Number(balance))
                : balance;
              const label = !hasBalance
                ? "Current balance"
                : liability
                  ? creditBalance
                    ? "Credit balance"
                    : "Balance owed"
                  : Number(balance) < 0
                    ? "Overdrawn balance"
                    : "Current balance";
              const supported = ["USD", "PHP"].includes(account.currency);
              return (
                <article className="fa-account-card" key={account.id}>
                  <div className="fa-account-heading">
                    <span
                      className={`fa-account-icon ${liability ? "fa-liability-icon" : ""}`}
                    >
                      <ActivityIcon
                        name={liability ? "card" : "bank"}
                        size={19}
                      />
                    </span>
                    <div>
                      <h3>{account.name}</h3>
                      {account.mask && (
                        <small className="fa-account-mask">
                          Account ending {account.mask}
                        </small>
                      )}
                      <p>
                        {account.institutionName ||
                          (account.isLinked
                            ? providerName(account.provider)
                            : "Manually tracked")}{" "}
                        ·{" "}
                        {String(account.type || "account").replaceAll("_", " ")}
                      </p>
                    </div>
                    <span className="fa-account-currency">
                      {account.currency}
                    </span>
                  </div>
                  <div className="fa-account-balance">
                    <span>{label}</span>
                    <strong
                      className={
                        hasBalance &&
                        ((liability && !creditBalance && balance > 0) ||
                          (!liability && balance < 0))
                          ? "fa-negative"
                          : ""
                      }
                    >
                      <NativeMoney
                        value={nativeDisplay}
                        currency={account.currency}
                      />
                    </strong>
                    {hasBalance &&
                      supported &&
                      account.currency !== currency && (
                        <small>
                          ≈{" "}
                          {money(
                            convert(
                              nativeDisplay,
                              account.currency,
                              currency,
                              rate,
                            ),
                            currency,
                          )}{" "}
                          {creditBalance
                            ? "credit"
                            : liability
                              ? "owed"
                              : "equivalent"}
                        </small>
                      )}
                  </div>
                  {allocation &&
                    (allocation.roles?.length > 0 ||
                      allocation.annualReserved > 0) && (
                      <div className="fa-account-allocations">
                        {allocation.annualReserved > 0 && (
                          <div>
                            <span>Allocated to annual bills</span>
                            <b>
                              {money(
                                allocation.annualReserved,
                                account.currency,
                              )}
                            </b>
                          </div>
                        )}
                        {allocation.annualPerPayday > 0 && (
                          <div>
                            <span>Annual bills each payday</span>
                            <b>
                              {money(
                                allocation.annualPerPayday,
                                account.currency,
                              )}
                            </b>
                          </div>
                        )}
                        {allocation.savingsPerPayday > 0 && (
                          <div>
                            <span>Savings each payday</span>
                            <b>
                              {money(
                                allocation.savingsPerPayday,
                                account.currency,
                              )}
                            </b>
                          </div>
                        )}
                        {allocation.salaryPerPayday > 0 && (
                          <div>
                            <span>Receives salary each payday</span>
                            <b>
                              {money(
                                allocation.salaryPerPayday,
                                account.currency,
                              )}
                            </b>
                          </div>
                        )}
                        {allocation.bankBalance !== null &&
                          allocation.bankBalance !== undefined &&
                          allocation.annualReserved > 0 && (
                            <div>
                              <span>Balance outside annual reserves</span>
                              <b>
                                {money(
                                  allocation.unallocatedBalance,
                                  account.currency,
                                )}
                              </b>
                            </div>
                          )}
                        {allocation.overassigned > 0 && (
                          <p className="fa-negative">
                            Annual allocations exceed this bank balance by{" "}
                            {money(allocation.overassigned, account.currency)}.
                            Update saved balances or account assignments.
                          </p>
                        )}
                        {allocation.roles?.length > 0 && (
                          <small>
                            {[
                              ...new Set(
                                allocation.roles
                                  .map((role) => role.name)
                                  .filter(Boolean),
                              ),
                            ].join(" · ")}
                          </small>
                        )}
                      </div>
                    )}
                  <footer>
                    <span
                      className={`fa-account-source ${account.isLinked ? "fa-is-linked" : ""}`}
                    >
                      {account.isLinked ? "Bank synced" : "Manual account"}
                    </span>
                    {account.nativeAvailableBalance !== null &&
                      account.nativeAvailableBalance !== undefined && (
                        <small>
                          {liability ? "Available credit" : "Available"}{" "}
                          <NativeMoney
                            value={account.nativeAvailableBalance}
                            currency={account.currency}
                          />
                        </small>
                      )}
                  </footer>
                  <div className="fa-account-controls">
                    <ActionButton
                      icon="trash"
                      disabled={working || unavailable}
                      onClick={() =>
                        setConfirmation({ kind: "account", id: account.id })
                      }
                      aria-label={`Remove ${financeAccountLabel(account)}`}
                    >
                      Remove
                    </ActionButton>
                  </div>
                  {removalConfirmation("account", account.id)}
                </article>
              );
            })}
          </div>
        )}
      </div>
      {activity.connections?.length > 0 && (
        <div className="fa-card">
          <header className="fa-section-header">
            <div>
              <h2>Bank connections</h2>
              <p>Sync when you want the latest activity from your bank.</p>
            </div>
          </header>
          <div className="fa-connections">
            {activity.connections.map((connection) => (
              <div className="fa-connection" key={connection.id}>
                <span className="fa-connection-mark">
                  <ActivityIcon name="lock" size={17} />
                </span>
                <div className="fa-connection-copy">
                  <strong>
                    {connection.institutionName ||
                      providerName(connection.provider)}
                  </strong>
                  <small>
                    {providerName(connection.provider)} ·{" "}
                    {connection.provider === "brankas"
                      ? "Authorization saved; imports unavailable"
                      : `Last sync: ${syncTimestamp(connection.lastSyncedAt)}`}
                  </small>
                  <small>
                    {
                      (activity.accounts || []).filter(
                        (account) =>
                          String(account.connectionId) ===
                          String(connection.id),
                      ).length
                    }{" "}
                    active accounts
                  </small>
                  <span
                    className={`fa-connection-status ${connection.status !== "active" ? "fa-status-attention" : ""}`}
                  >
                    {connection.provider === "brankas"
                      ? "Authorization only"
                      : connection.status === "active"
                        ? "Connected"
                        : connection.status === "needs_sync"
                          ? "Sync needed"
                          : String(
                              connection.status || "Needs attention",
                            ).replaceAll("_", " ")}
                  </span>
                </div>
                <div className="fa-connection-actions">
                  {connection.provider === "plaid" &&
                    !["disconnected", "superseded", "removed"].includes(
                      connection.status,
                    ) && (
                      <>
                        <ActionButton
                          icon="plus"
                          disabled={working || unavailable || !plaid.configured}
                          onClick={() => startPlaid(null, null, connection.id)}
                        >
                          Update accounts
                        </ActionButton>
                        <ActionButton
                          icon="refresh"
                          disabled={working || unavailable || !plaid.configured}
                          onClick={() => syncConnection(connection)}
                        >
                          {pending === `sync:${connection.id}`
                            ? "Syncing…"
                            : "Sync now"}
                        </ActionButton>
                      </>
                    )}
                  {!["disconnected", "superseded", "removed"].includes(
                    connection.status,
                  ) && (
                    <ActionButton
                      icon="trash"
                      disabled={working || unavailable}
                      onClick={() =>
                        setConfirmation({
                          kind: "connection",
                          id: connection.id,
                        })
                      }
                      aria-label={`Unlink ${connection.institutionName || providerName(connection.provider)} connection`}
                    >
                      Unlink
                    </ActionButton>
                  )}
                </div>
                {removalConfirmation("connection", connection.id)}
              </div>
            ))}
          </div>
        </div>
      )}
      <p className="fa-footnote">
        <ActivityIcon name="lock" size={13} />
        Bank sign-in takes place in the provider’s connection window. This app
        does not ask for your bank password.
      </p>
    </section>
  );
}
