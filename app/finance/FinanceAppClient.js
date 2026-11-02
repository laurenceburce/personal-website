"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { signOut } from "next-auth/react";
import {
  buildPlanRows,
  convert,
  formatDate,
  getSummary,
  getAnnualReserveOpening,
  localDate,
  addDays,
  money,
  salaryOccurrences,
} from "../lib/financePlanner.mjs";
import FinanceInstall from "./FinanceInstall";
import FinanceOverview from "./FinanceOverview";
import Ledger from "./FinancePlanLedger";
import { BillForm, BillsTable } from "./FinanceBills";
import {
  QuickTransactionForm,
  TransactionsPanel,
  BankAccountsPanel,
} from "./FinanceActivity";
import "./finance.css";
import "./finance-workspace.css";

const NAV = [
  { id: "home", label: "Overview", icon: "grid" },
  { id: "bills", label: "Bills", icon: "receipt" },
  { id: "spending", label: "Spending plan", icon: "chart" },
  { id: "plans", label: "Budget plans", icon: "calendar" },
  { id: "transactions", label: "Transactions", icon: "exchange" },
  { id: "accounts", label: "Bank accounts", icon: "bank" },
  { id: "settings", label: "Salary & settings", icon: "settings" },
];
const TAB_ALIASES = {
  profile: "accounts",
  budget: "plans",
  add: "transactions",
};
const MONTH_PATTERN = /^(19\d{2}|20\d{2}|21\d{2}|2200)-(0[1-9]|1[0-2])$/;
const normalizeTab = (value) => {
  const tab = TAB_ALIASES[value] || value;
  return NAV.some((item) => item.id === tab) ? tab : "home";
};
const PAGE_COPY = {
  home: [
    "Your financial overview",
    "See what came in, what went out, and where your plan stands.",
  ],
  bills: [
    "Everything that’s due.",
    "Monthly essentials and annual commitments, all accounted for.",
  ],
  spending: [
    "Give every payday a plan.",
    "Know what to set aside and what’s yours to spend.",
  ],
  plans: [
    "A plan for what’s ahead.",
    "Try out dates, expenses, and currency moves before they happen.",
  ],
  transactions: [
    "Your money in motion",
    "Quickly record one-time income and expenses, alongside your bank activity.",
  ],
  accounts: [
    "Your connected accounts",
    "Bring your bank balances and transactions into one place.",
  ],
  settings: [
    "Make the plan yours",
    "Update your salary, payday schedule, and conversion settings.",
  ],
};
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const uid = () => globalThis.crypto.randomUUID();
const amount = (value) => Number(value || 0);
const signed = (value, currency) =>
  `${value > 0 ? "+" : ""}${money(value, currency)}`;
const rateMoney = (value) =>
  new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);

function Icon({ name, size = 20 }) {
  const paths = {
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    receipt: (
      <>
        <path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" />
        <path d="M9 7h6M9 11h6M9 15h3" />
      </>
    ),
    chart: <path d="M4 20V10m8 10V4m8 16v-7M2 21h20" />,
    calendar: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="3" />
        <path d="M7 3v4m10-4v4M3 11h18M8 15h2m4 0h2" />
      </>
    ),
    wallet: (
      <>
        <path d="M20 8V5a2 2 0 0 0-2-2L5 6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h15V8H5" />
        <path d="M20 12h-5v5h5M17 14.5h.01" />
      </>
    ),
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    plus: <path d="M12 5v14M5 12h14" />,
    edit: (
      <>
        <path d="m15 5 4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Z" />
      </>
    ),
    trash: <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" />
      </>
    ),
    exit: <path d="M9 4H4v16h5m6-13 5 5-5 5M8 12h12" />,
    globe: (
      <>
        <circle cx="12" cy="12" r="9" />
        <ellipse cx="12" cy="12" rx="4" ry="9" />
        <path d="M3 12h18" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    coin: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M15 8h-4a2 2 0 0 0 0 4h2a2 2 0 0 1 0 4H9m3-10v12" />
      </>
    ),
    exchange: <path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4" />,
    bank: (
      <>
        <path d="m3 8 9-5 9 5H3Zm0 13h18M5 11v7m7-7v7m7-7v7" />
      </>
    ),
    settings: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="3" fill="currentColor" />
        <circle cx="15" cy="17" r="3" fill="currentColor" />
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
      {paths[name] || paths.wallet}
    </svg>
  );
}

function Button({
  children,
  icon,
  variant = "secondary",
  className = "",
  ...props
}) {
  return (
    <button
      type="button"
      className={`fp-button fp-${variant} ${className}`}
      {...props}
    >
      {icon && <Icon name={icon} size={16} />}
      {children}
    </button>
  );
}
function Field({ label, children, hint }) {
  return (
    <label className="fp-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function CurrencySelect({ value, onChange }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="USD">USD · US dollar</option>
      <option value="PHP">PHP · Philippine peso</option>
    </select>
  );
}
function Modal({ title, children, onClose, busy }) {
  const dialog = useRef(null);
  useEffect(() => {
    const previous = window.document.activeElement;
    const element = dialog.current;
    element.showModal();
    return () => {
      element.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      aria-labelledby="fp-dialog-title"
      className="fp-modal"
      ref={dialog}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        if (e.target === dialog.current && !busy) onClose();
      }}
    >
      <header>
        <div>
          <p className="fp-eyebrow">PERSONAL FINANCE</p>
          <h2 id="fp-dialog-title">{title}</h2>
        </div>
        <Button
          icon="close"
          className="fp-icon-button"
          aria-label="Close dialog"
          onClick={onClose}
          disabled={busy}
        />
      </header>
      {children}
    </dialog>
  );
}
function Empty({ icon = "receipt", title, children, action }) {
  return (
    <div className="fp-empty">
      <span className="fp-empty-icon">
        <Icon name={icon} size={27} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
function SpendingTable({
  document,
  summary,
  rate,
  onAdd,
  onEdit,
  onDelete,
  compact = false,
}) {
  const rows = [
    [
      "Income",
      summary.incomePerPeriodUsd,
      "Your salary per pay period",
      "income",
    ],
    [
      "Bills in USD",
      -summary.billsUsdPerPeriod,
      "Monthly USD bills, set aside per period",
      "usd",
    ],
    [
      "Bills in PHP",
      -summary.billsPhpPerPeriodUsd,
      `${money(summary.billsPhpPerPeriod, "PHP")} per period`,
      "php",
    ],
    [
      "Annual bills",
      -summary.annualPerPeriodUsd,
      "A little now, ready when it’s due",
      "annual",
    ],
  ];
  return (
    <div className="fp-spending-table">
      {rows.map(([label, value, detail, color]) => (
        <div className={`fp-spending-row fp-spending-${color}`} key={label}>
          <span className={`fp-dot fp-dot-${color}`} />
          <div>
            <strong>{label}</strong>
            {!compact && <small>{detail}</small>}
          </div>
          <b className={value > 0 ? "fp-positive" : ""}>
            {signed(value, "USD")}
          </b>
        </div>
      ))}
      <div className="fp-spending-subtotal">
        <span>Remaining after bills</span>
        <b className={summary.remainingPerPeriodUsd < 0 ? "fp-negative" : ""}>
          {money(summary.remainingPerPeriodUsd)}
        </b>
      </div>
      {document.allocations.map((row) => (
        <div className="fp-spending-row fp-allocation" key={row.id}>
          <span
            className={`fp-dot fp-dot-${row.kind === "savings" ? "annual" : "php"}`}
          />
          <div>
            <strong>{row.name}</strong>
            {!compact && (
              <small>
                {row.kind === "savings" ? "Savings" : "Expense"} ·{" "}
                {money(row.amount, row.currency)} per period
              </small>
            )}
          </div>
          <b>−{money(convert(row.amount, row.currency, "USD", rate))}</b>
          {!compact && (
            <div className="fp-row-actions">
              <Button
                icon="edit"
                className="fp-icon-button"
                aria-label={`Edit ${row.name}`}
                onClick={() => onEdit(row)}
              />
              <Button
                icon="trash"
                className="fp-icon-button"
                aria-label={`Delete ${row.name}`}
                onClick={() => onDelete(row)}
              />
            </div>
          )}
        </div>
      ))}
      <div
        className={`fp-spending-total ${summary.unallocatedPerPeriodUsd < 0 ? "fp-total-negative" : ""}`}
      >
        <div>
          <span>Left to spend</span>
          <small>After bills & your allocations</small>
        </div>
        <strong>{money(summary.unallocatedPerPeriodUsd)}</strong>
      </div>
      {!compact && (
        <Button icon="plus" variant="text" onClick={onAdd}>
          Add savings or expense
        </Button>
      )}
    </div>
  );
}

function SalaryEditor({ salary, rate, onSave, busy, configured }) {
  const [draft, setDraft] = useState(salary);
  useEffect(() => setDraft(salary), [salary]);
  const changed = JSON.stringify(draft) !== JSON.stringify(salary);
  const set = (key, value) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const previewStart =
    draft.firstPayDate > localDate() ? draft.firstPayDate : localDate();
  const upcomingPaydays = salaryOccurrences(
    draft,
    previewStart,
    addDays(previewStart, 75),
  ).slice(0, 4);
  return (
    <form
      className="fp-salary-editor"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ ...draft, amount: amount(draft.amount) });
      }}
    >
      <div className="fp-salary-inputs">
        <Field label="Monthly salary">
          <div className="fp-money-input">
            <span>{draft.currency === "PHP" ? "₱" : "$"}</span>
            <input
              aria-label="Monthly salary"
              inputMode="decimal"
              type="number"
              min="0"
              max="999999999"
              step="0.01"
              required
              value={draft.amount}
              onChange={(e) => set("amount", e.target.value)}
            />
          </div>
        </Field>
        <Field label="Paid in">
          <CurrencySelect
            value={draft.currency}
            onChange={(value) => set("currency", value)}
          />
        </Field>
      </div>
      <div className="fp-salary-converted">
        <Icon name="refresh" size={16} />
        <span>
          That’s{" "}
          <strong>
            {money(
              convert(
                draft.amount,
                draft.currency,
                draft.currency === "USD" ? "PHP" : "USD",
                rate,
              ),
              draft.currency === "USD" ? "PHP" : "USD",
            )}
          </strong>{" "}
          per month
        </span>
      </div>
      <div className="fp-form-grid">
        <Field label="Pay frequency">
          <select
            value={draft.payFrequency}
            onChange={(e) => set("payFrequency", e.target.value)}
          >
            <option value="biweekly">Every 2 weeks · 14 days apart</option>
            <option value="semimonthly">Twice a month · fixed dates</option>
          </select>
        </Field>
        <Field
          label="First payday / schedule anchor"
          hint="Every-two-weeks schedules repeat exactly 14 days from this date."
        >
          <input
            type="date"
            required
            value={draft.firstPayDate}
            onChange={(e) => set("firstPayDate", e.target.value)}
          />
        </Field>
      </div>
      <div className="fp-payday-preview" aria-live="polite">
        <strong>Next paydays</strong>
        <div>
          {upcomingPaydays.map((payday) => (
            <span key={payday.date}>
              {formatDate(payday.date, { year: "numeric" })}
              <small>{money(payday.amount, payday.currency)}</small>
            </span>
          ))}
        </div>
        {changed && (
          <small>
            Save your salary and schedule to apply these dates to every budget
            plan.
          </small>
        )}
      </div>
      <div className="fp-form-footer">
        <small>
          {draft.payFrequency === "biweekly"
            ? "Per-pay income = monthly salary × 12 ÷ 26."
            : "Per-pay income = monthly salary ÷ 2. Two fixed paydays per month, 15 days apart."}
        </small>
        <Button
          variant="primary"
          type="submit"
          icon="check"
          disabled={busy || !changed || !configured}
        >
          {busy ? "Saving…" : "Save salary"}
        </Button>
      </div>
    </form>
  );
}

function AllocationForm({ row, onSave, busy, disabled }) {
  const [draft, setDraft] = useState(
    row || { name: "", amount: "", currency: "USD", kind: "savings" },
  );
  const set = (key, value) =>
    setDraft((current) => ({ ...current, [key]: value }));
  return (
    <form
      className="fp-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          ...draft,
          id: draft.id || uid(),
          amount: amount(draft.amount),
        });
      }}
    >
      <Field label="Name">
        <input
          autoFocus
          required
          maxLength={120}
          placeholder="e.g. Emergency fund, groceries"
          value={draft.name}
          onChange={(e) => set("name", e.target.value)}
        />
      </Field>
      <div className="fp-form-grid">
        <Field label="Amount per pay period">
          <input
            required
            type="number"
            min="0.01"
            step="0.01"
            max="999999999"
            value={draft.amount}
            onChange={(e) => set("amount", e.target.value)}
          />
        </Field>
        <Field label="Currency">
          <CurrencySelect
            value={draft.currency}
            onChange={(value) => set("currency", value)}
          />
        </Field>
      </div>
      <Field label="Type">
        <select
          value={draft.kind}
          onChange={(e) => set("kind", e.target.value)}
        >
          <option value="savings">Savings</option>
          <option value="expense">Expense</option>
        </select>
      </Field>
      <p className="fp-inline-note">
        This allocation is deducted from each pay period’s remaining funds.
        Budget plans use their own dated entries.
      </p>
      <Button type="submit" variant="primary" disabled={busy || disabled}>
        {busy ? "Saving…" : "Save allocation"}
      </Button>
    </form>
  );
}

function PlanForm({ plan, document, onSave, busy, disabled }) {
  const today = localDate();
  const [draft, setDraft] = useState({
    name: "",
    startDate: today,
    endDate: addDays(today, 30),
    openingUsd: 0,
    openingPhp: 0,
    includeIncome: true,
    includeTransactions: true,
    includeAllocations: true,
    includeAnnualReserve: true,
    openingReserveUsd: 0,
    openingReservePhp: 0,
    entries: [],
    ...plan,
  });
  const set = (key, value) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const reserveOpening = getAnnualReserveOpening(draft, document);
  return (
    <form
      className="fp-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          ...draft,
          id: draft.id || uid(),
          openingUsd: amount(draft.openingUsd),
          openingPhp: amount(draft.openingPhp),
          openingReserveUsd: amount(draft.openingReserveUsd),
          openingReservePhp: amount(draft.openingReservePhp),
        });
      }}
    >
      <Field label="Plan name">
        <input
          autoFocus
          required
          maxLength={120}
          placeholder="e.g. November essentials"
          value={draft.name}
          onChange={(e) => set("name", e.target.value)}
        />
      </Field>
      <div className="fp-form-grid">
        <Field label="From">
          <input
            required
            type="date"
            value={draft.startDate}
            onChange={(e) => set("startDate", e.target.value)}
          />
        </Field>
        <Field label="Through">
          <input
            required
            type="date"
            min={draft.startDate}
            max={addDays(draft.startDate, 730)}
            value={draft.endDate}
            onChange={(e) => set("endDate", e.target.value)}
          />
        </Field>
      </div>
      <div className="fp-form-grid">
        <Field label="Starting available balance · USD">
          <input
            required
            type="number"
            step="0.01"
            min="-999999999"
            max="999999999"
            value={draft.openingUsd}
            onChange={(e) => set("openingUsd", e.target.value)}
          />
        </Field>
        <Field label="Starting available balance · PHP">
          <input
            required
            type="number"
            step="0.01"
            min="-999999999"
            max="999999999"
            value={draft.openingPhp}
            onChange={(e) => set("openingPhp", e.target.value)}
          />
        </Field>
      </div>
      <div className="fp-form-grid">
        <Field label="Total starting annual reserve · USD (optional)">
          <input
            required
            type="number"
            min="0"
            max="999999999"
            step="0.01"
            value={draft.openingReserveUsd}
            onChange={(event) => set("openingReserveUsd", event.target.value)}
          />
        </Field>
        <Field label="Total starting annual reserve · PHP (optional)">
          <input
            required
            type="number"
            min="0"
            max="999999999"
            step="0.01"
            value={draft.openingReservePhp}
            onChange={(event) => set("openingReservePhp", event.target.value)}
          />
        </Field>
      </div>
      <div className="fp-bill-savings-summary">
        <strong>Saved on your annual bills</strong>
        <span>
          {money(reserveOpening.billSavingsUsd)} ·{" "}
          {money(reserveOpening.billSavingsPhp, "PHP")}
        </span>
        <small>
          These item balances are included automatically. Enter a total above
          them only if you also have unassigned annual reserves.
        </small>
        <span>
          Starting reserve used in this plan:{" "}
          <b>
            {money(reserveOpening.usd)} · {money(reserveOpening.php, "PHP")}
          </b>
        </span>
      </div>
      <p className="fp-inline-note">
        Enter balances at the start of the first date, before that day’s flows.
        Available balances exclude money already reserved for annual bills.
        Amounts entered as “Saved so far” on annual bills are included once and
        stay earmarked for those bills. Suggested savings targets are not
        treated as actual funds.
      </p>
      <label className="fp-checkbox">
        <input
          type="checkbox"
          checked={draft.includeIncome}
          onChange={(e) => set("includeIncome", e.target.checked)}
        />
        Include scheduled salary payments
      </label>
      <label className="fp-checkbox">
        <input
          type="checkbox"
          checked={draft.includeTransactions}
          onChange={(event) => set("includeTransactions", event.target.checked)}
        />
        Include recorded and scheduled one-time transactions
      </label>
      <label className="fp-checkbox">
        <input
          type="checkbox"
          checked={draft.includeAllocations}
          onChange={(event) => set("includeAllocations", event.target.checked)}
        />
        Include savings and expense allocations each payday
      </label>
      <label className="fp-checkbox">
        <input
          type="checkbox"
          checked={draft.includeAnnualReserve}
          onChange={(event) =>
            set("includeAnnualReserve", event.target.checked)
          }
        />
        Set aside money for annual bills each payday
      </label>
      <p className="fp-inline-note">
        Bills with due dates appear automatically. Annual set-asides reduce
        available funds and increase your reserve. When an annual bill is paid,
        the bill row shows only the additional available money needed after
        using its savings. Matched recorded payments replace scheduled flows.
        Plans do not move money or record bank payments.
      </p>
      <Button type="submit" variant="primary" disabled={busy || disabled}>
        {busy ? "Saving…" : plan ? "Save plan" : "Create plan"}
      </Button>
    </form>
  );
}

function EntryForm({ entry, plan, onSave, busy, disabled, rate }) {
  const [draft, setDraft] = useState(
    entry || {
      date: plan.startDate,
      description: "",
      kind: "expense",
      amount: "",
      currency: "USD",
    },
  );
  const set = (key, value) =>
    setDraft((current) => ({ ...current, [key]: value }));
  return (
    <form
      className="fp-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          ...draft,
          id: draft.id || uid(),
          amount: amount(draft.amount),
        });
      }}
    >
      <div className="fp-form-grid">
        <Field label="Date">
          <input
            required
            type="date"
            min={plan.startDate}
            max={plan.endDate}
            value={draft.date}
            onChange={(e) => set("date", e.target.value)}
          />
        </Field>
        <Field label="Entry type">
          <select
            value={draft.kind}
            onChange={(e) => set("kind", e.target.value)}
          >
            <option value="expense">Expense / savings</option>
            <option value="income">Income</option>
            <option value="conversion">Currency conversion</option>
          </select>
        </Field>
      </div>
      <Field label="Description">
        <input
          autoFocus
          required
          maxLength={120}
          placeholder="e.g. Insurance, savings, convert to PHP"
          value={draft.description}
          onChange={(e) => set("description", e.target.value)}
        />
      </Field>
      <div className="fp-form-grid">
        <Field
          label={draft.kind === "conversion" ? "Amount to convert" : "Amount"}
        >
          <input
            required
            type="number"
            min="0.01"
            max="999999999"
            step="0.01"
            value={draft.amount}
            onChange={(e) => set("amount", e.target.value)}
          />
        </Field>
        <Field
          label={draft.kind === "conversion" ? "Convert from" : "Currency"}
        >
          <CurrencySelect
            value={draft.currency}
            onChange={(value) => set("currency", value)}
          />
        </Field>
      </div>
      {draft.kind === "conversion" && (
        <p className="fp-conversion-note">
          Receive{" "}
          {money(
            convert(
              draft.amount,
              draft.currency,
              draft.currency === "USD" ? "PHP" : "USD",
              rate,
            ),
            draft.currency === "USD" ? "PHP" : "USD",
          )}{" "}
          at the current reference rate. Fees aren’t included.
        </p>
      )}
      <Button type="submit" variant="primary" disabled={busy || disabled}>
        {busy ? "Saving…" : entry ? "Save entry" : "Add entry"}
      </Button>
    </form>
  );
}

export default function FinanceAppClient({
  snapshot,
  initialTab,
  initialActivity,
  initialPlanActivity = null,
}) {
  const [state, setState] = useState(snapshot);
  const [tab, setTab] = useState(normalizeTab(initialTab));
  const [activity, setActivity] = useState(initialActivity);
  const [selectedMonth, setSelectedMonth] = useState(initialActivity.month);
  const [displayCurrency, setDisplayCurrency] = useState("USD");
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState("");
  const [planActivity, setPlanActivity] = useState(initialPlanActivity);
  const [planActivityLoading, setPlanActivityLoading] = useState(false);
  const [planActivityError, setPlanActivityError] = useState("");
  const [recordRefreshVersion, setRecordRefreshVersion] = useState(0);
  const [cadence, setCadence] = useState("monthly");
  const [modal, setModal] = useState(null);
  const [selectedPlanId, setSelectedPlanId] = useState(
    snapshot.document.plans[0]?.id || "",
  );
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const document = state.document;
  const rate = state.exchangeRate.rate;
  const summary = useMemo(() => getSummary(document, rate), [document, rate]);
  const plan =
    document.plans.find((item) => item.id === selectedPlanId) ||
    document.plans[0];
  const planOpeningReserve = useMemo(
    () => getAnnualReserveOpening(plan, document),
    [plan, document],
  );
  const planRows = useMemo(
    () =>
      plan
        ? buildPlanRows(plan, document, rate, {
            transactions:
              planActivity?.from === plan.startDate &&
              planActivity?.to === plan.endDate
                ? planActivity.transactions
                : [],
          })
        : [],
    [plan, document, rate, planActivity],
  );
  const planRecordsMatch = Boolean(
    plan &&
    planActivity?.from === plan.startDate &&
    planActivity?.to === plan.endDate,
  );
  const planWaitingForRecords = Boolean(
    plan &&
    plan.includeTransactions !== false &&
    !planRecordsMatch &&
    !planActivityError,
  );
  const isBiweekly = document.salary.payFrequency === "biweekly";
  const activeNav = NAV.find((item) => item.id === tab);
  const undated = document.bills.filter((bill) => !bill.dueDay);
  const saveLock = useRef(false);
  const activityRequest = useRef(0);
  const planActivityRequest = useRef(0);
  const selectedMonthRef = useRef(selectedMonth);
  const pageCopy = PAGE_COPY[tab];
  useEffect(() => {
    if (tab !== "plans" || !plan || plan.includeTransactions === false) return;
    if (
      recordRefreshVersion === 0 &&
      planActivity?.configured &&
      planActivity.from === plan.startDate &&
      planActivity.to === plan.endDate
    )
      return;
    loadPlanActivity(plan);
  }, [
    tab,
    plan?.id,
    plan?.startDate,
    plan?.endDate,
    plan?.includeTransactions,
    recordRefreshVersion,
  ]);

  useEffect(() => {
    const onPop = () => {
      const params = new URL(window.location.href).searchParams;
      setTab(normalizeTab(params.get("tab")));
      const month = params.get("month") || localDate().slice(0, 7);
      if (MONTH_PATTERN.test(month) && month !== selectedMonthRef.current) {
        selectedMonthRef.current = month;
        setSelectedMonth(month);
        loadActivity(month);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (
      url.searchParams.get("quick") === "1" &&
      !url.searchParams.has("oauth_state_id") &&
      initialActivity.configured
    ) {
      setModal({ type: "transaction" });
      url.searchParams.delete("quick");
      window.history.replaceState({}, "", url);
    }
  }, [initialActivity.configured]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const timer = setInterval(
      () => {
        if (window.document.visibilityState === "visible") refreshRate(true);
      },
      60 * 60 * 1000,
    );
    return () => clearInterval(timer);
  }, []);

  function navigate(next) {
    setTab(normalizeTab(next));
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.pushState({}, "", url);
    setError("");
  }
  function open(next) {
    setError("");
    setModal(next);
  }
  async function loadActivity(month = selectedMonthRef.current) {
    const requestId = ++activityRequest.current;
    setActivityLoading(true);
    setActivityError("");
    try {
      const response = await fetch(
        `/api/finance/activity?month=${encodeURIComponent(month)}`,
        { cache: "no-store" },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          result.error || "Could not refresh your transactions and accounts.",
        );
      if (requestId === activityRequest.current) {
        setActivity(result);
        setRecordRefreshVersion((version) => version + 1);
      }
      return true;
    } catch (err) {
      if (requestId === activityRequest.current) setActivityError(err.message);
      return false;
    } finally {
      if (requestId === activityRequest.current) setActivityLoading(false);
    }
  }
  async function loadPlanActivity(targetPlan = plan) {
    if (!targetPlan || targetPlan.includeTransactions === false) return true;
    const requestId = ++planActivityRequest.current;
    setPlanActivityLoading(true);
    setPlanActivityError("");
    try {
      const query = new URLSearchParams({
        start: targetPlan.startDate,
        end: targetPlan.endDate,
      });
      const response = await fetch(`/api/finance/plan-activity?${query}`, {
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          result.error ||
            "Recorded money flows could not be loaded for these dates.",
        );
      if (requestId === planActivityRequest.current) {
        setPlanActivity(result);
        if (!result.configured)
          setPlanActivityError(
            result.warning ||
              "Recorded money flows are unavailable. The plan currently contains scheduled flows and your plan entries only.",
          );
      }
      return result.configured;
    } catch (err) {
      if (requestId === planActivityRequest.current)
        setPlanActivityError(err.message);
      return false;
    } finally {
      if (requestId === planActivityRequest.current)
        setPlanActivityLoading(false);
    }
  }
  function changeMonth(month) {
    if (!MONTH_PATTERN.test(month)) return;
    setSelectedMonth(month);
    selectedMonthRef.current = month;
    const url = new URL(window.location.href);
    url.searchParams.set("month", month);
    window.history.pushState({}, "", url);
    loadActivity(month);
  }
  async function performAction(action, data = {}) {
    const response = await fetch("/api/finance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, data }),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(
        result.error || "The finance action could not be completed.",
      );
    return result.result;
  }
  async function saveTransaction(transaction) {
    if (saveLock.current || !activity.configured) return;
    saveLock.current = true;
    setBusy(true);
    setError("");
    try {
      await performAction(
        transaction.id ? "updateTransaction" : "createTransaction",
        transaction,
      );
      setModal(null);
      setNotice(
        transaction.id ? "Transaction updated." : "Transaction recorded.",
      );
      const month = transaction.date.slice(0, 7);
      if (month !== selectedMonthRef.current) {
        selectedMonthRef.current = month;
        setSelectedMonth(month);
        const url = new URL(window.location.href);
        url.searchParams.set("month", month);
        window.history.replaceState({}, "", url);
      }
      await loadActivity(month);
    } catch (err) {
      setError(err.message);
    } finally {
      saveLock.current = false;
      setBusy(false);
    }
  }
  async function deleteTransaction(transaction) {
    if (saveLock.current) return;
    saveLock.current = true;
    setBusy(true);
    setError("");
    try {
      await performAction("deleteTransaction", { id: transaction.id });
      setModal(null);
      setNotice("Transaction deleted.");
      await loadActivity();
    } catch (err) {
      setError(err.message);
    } finally {
      saveLock.current = false;
      setBusy(false);
    }
  }
  async function refreshRate(quiet = false) {
    setRefreshing(true);
    try {
      const response = await fetch("/api/finance/planner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refreshRate" }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Could not refresh the exchange rate.");
      setState((current) => ({
        ...current,
        exchangeRate: result.exchangeRate,
      }));
      if (!quiet)
        setNotice(
          result.exchangeRate.stale
            ? "The rate provider is unavailable. Using the last reference rate."
            : "Exchange rate is up to date.",
        );
    } catch (err) {
      if (!quiet) setError(err.message);
    } finally {
      setRefreshing(false);
    }
  }
  async function save(next, message = "Changes saved.") {
    if (saveLock.current || !state.configured) return false;
    saveLock.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/finance/planner", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document: next, revision: state.revision }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? "This planner changed on another device. Reload the page before saving again; your current edits are still open."
            : result.error || "Could not save your changes.",
        );
      setState(result);
      setNotice(message);
      setModal(null);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      saveLock.current = false;
      setBusy(false);
    }
  }
  const upsert = (list, row) =>
    list.some((item) => item.id === row.id)
      ? list.map((item) => (item.id === row.id ? row : item))
      : [...list, row];
  const saveBill = (row) =>
    save(
      { ...document, bills: upsert(document.bills, row) },
      "Bill saved. Your plans have been updated.",
    );
  const saveAllocation = (row) =>
    save({ ...document, allocations: upsert(document.allocations, row) });
  async function savePlan(row) {
    if (
      await save(
        { ...document, plans: upsert(document.plans, row) },
        "Budget plan saved.",
      )
    )
      setSelectedPlanId(row.id);
  }
  const saveEntry = (row) =>
    savePlan({ ...plan, entries: upsert(plan.entries, row) });

  async function loadExample() {
    const monthly = [
      ["Google", 2, "USD", 18, "US Bank Credit"],
      ["Discord", 10, "USD", 6, "US Bank Credit"],
      ["ChatGPT", 20, "USD", 29, "US Bank Credit"],
      ["Railway (webapp)", 30, "USD", 4, "US Bank Credit"],
      ["Spotify", 169, "PHP", 28, "RCBC Gold Flex"],
      ["Globe", 1500, "PHP", 11, "RCBC Gold Flex"],
      ["Converge", 2500, "PHP", 28, "Cash"],
      ["House", 37800, "PHP", null, "Cash"],
    ].map(([name, value, currency, dueDay, paymentMethod]) => ({
      id: uid(),
      name,
      amount: value,
      currency,
      cadence: "monthly",
      dueDay,
      dueMonths: [],
      paymentMethod,
      isAutopay: paymentMethod !== "Cash",
    }));
    const annual = [
      ["Microsoft", 100, "USD", 9, [9], "US Bank Credit"],
      ["Namecheap (Domain)", 20, "USD", 4, [6], "US Bank Credit"],
      ["Car", 31500, "PHP", null, [3, 9], "Cash"],
      ["Venture X", 395, "USD", null, [11], "Venture X"],
    ].map(([name, value, currency, dueDay, dueMonths, paymentMethod]) => ({
      id: uid(),
      name,
      amount: value,
      currency,
      cadence: "annual",
      dueDay,
      dueMonths,
      paymentMethod,
      isAutopay: paymentMethod !== "Cash",
    }));
    await save(
      {
        ...document,
        bills: [...monthly, ...annual],
        allocations: [
          ...document.allocations,
          {
            id: uid(),
            name: "Savings",
            amount: 500,
            currency: "USD",
            kind: "savings",
          },
        ],
      },
      "Example bills added. You can edit every amount and date.",
    );
  }

  return (
    <div className="fp-app">
      <aside className="fp-sidebar">
        <a
          className="fp-brand"
          href="/finance"
          aria-label="Personal Finance overview"
        >
          <span>
            <Icon name="wallet" size={24} />
          </span>
          <div>
            personal<span>FINANCE</span>
          </div>
        </a>
        <p className="fp-nav-label">YOUR WORKSPACE</p>
        <nav aria-label="Finance navigation">
          {NAV.map((item) => (
            <button
              key={item.id}
              aria-current={tab === item.id ? "page" : undefined}
              className={tab === item.id ? "active" : ""}
              onClick={() => navigate(item.id)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {tab === item.id && <i />}
            </button>
          ))}
        </nav>
        <div className="fp-sidebar-bottom">
          <FinanceInstall />
          <div className="fp-private">
            <Icon name="lock" size={15} />
            <span>Just for you. Always private.</span>
          </div>
          <div className="fp-owner">
            <span className="fp-avatar">LB</span>
            <div>
              <strong>Personal workspace</strong>
              <small>Owner access only</small>
            </div>
            <Button
              icon="exit"
              className="fp-icon-button"
              aria-label="Sign out"
              onClick={() => signOut({ callbackUrl: "/finance/login" })}
            />
          </div>
          <a className="fp-back-link" href="/">
            ← Back to portfolio
          </a>
        </div>
      </aside>
      <div className="fp-main">
        <header className="fp-topbar">
          <span>
            <span className="fp-breadcrumb-prefix">My workspace /</span>{" "}
            <strong>{activeNav.label}</strong>
          </span>
          <div>
            <Button
              icon="plus"
              variant="primary"
              className="fp-quick-add"
              onClick={() => open({ type: "transaction" })}
              disabled={!activity.configured}
            >
              <span className="fp-quick-label-desktop">Add transaction</span>
              <span className="fp-quick-label-mobile">Quick add</span>
            </Button>
            <span className="fp-private-badge">
              <Icon name="lock" size={12} /> Private
            </span>
            <Button
              icon="exit"
              className="fp-icon-button fp-mobile-signout"
              aria-label="Sign out"
              onClick={() => signOut({ callbackUrl: "/finance/login" })}
            />
            <span className="fp-topbar-date">
              {formatDate(localDate(), {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
          </div>
        </header>
        <main className="fp-content" id="finance-main">
          <div className="fp-page-heading">
            <div>
              <p className="fp-eyebrow">PERSONAL FINANCE</p>
              <h1>{pageCopy[0]}</h1>
              <p>{pageCopy[1]}</p>
            </div>
            {tab === "bills" ? (
              <Button
                icon="plus"
                variant="primary"
                onClick={() => open({ type: "bill" })}
              >
                Add bill
              </Button>
            ) : tab === "plans" ? (
              <Button
                icon="plus"
                variant="primary"
                onClick={() => open({ type: "plan" })}
              >
                New plan
              </Button>
            ) : (
              <span className="fp-heading-icon">
                <Icon name={activeNav.icon} size={28} />
              </span>
            )}
          </div>
          {!state.configured && (
            <div className="fp-alert fp-alert-warning" role="status">
              <strong>Storage isn’t connected yet.</strong>{" "}
              {state.warning ||
                "Connect your finance MySQL database to save across devices."}{" "}
              Saving needs the database.
            </div>
          )}
          {error && !modal && (
            <div className="fp-alert fp-alert-error" role="alert">
              {error}
              <Button variant="text" onClick={() => window.location.reload()}>
                Reload data
              </Button>
            </div>
          )}
          <div className="fp-rate-bar">
            <div>
              <span
                className={`fp-live-dot ${state.exchangeRate.stale ? "fp-stale" : ""}`}
              />
              <strong>1 USD = {rateMoney(rate)}</strong>
              <span>
                {state.exchangeRate.stale
                  ? "Fallback reference rate"
                  : "Latest reference rate"}
                {state.exchangeRate.date
                  ? ` · ${formatDate(state.exchangeRate.date)}`
                  : ""}
              </span>
            </div>
            <Button
              variant="text"
              icon="refresh"
              disabled={refreshing}
              onClick={() => refreshRate()}
            >
              {refreshing ? "Refreshing…" : "Refresh rate"}
            </Button>
          </div>
          {state.exchangeRate.stale && (
            <p className="fp-rate-warning">
              {state.exchangeRate.error ||
                "The rate provider is unavailable. Conversions use the last available rate."}
            </p>
          )}

          {["home", "transactions", "accounts"].includes(tab) && (
            <>
              <div className="fp-workspace-toolbar">
                <div className="fp-data-controls">
                  {tab !== "accounts" && (
                    <Field label="Month">
                      <input
                        type="month"
                        min="1900-01"
                        max="2200-12"
                        value={selectedMonth}
                        onChange={(event) => changeMonth(event.target.value)}
                      />
                    </Field>
                  )}
                  <div
                    className="fp-display-currency"
                    role="group"
                    aria-label="Display currency"
                  >
                    {["USD", "PHP"].map((currency) => (
                      <button
                        key={currency}
                        type="button"
                        aria-pressed={displayCurrency === currency}
                        onClick={() => setDisplayCurrency(currency)}
                      >
                        {currency}
                      </button>
                    ))}
                  </div>
                </div>
                <Button
                  icon="refresh"
                  onClick={() => loadActivity()}
                  disabled={activityLoading}
                >
                  {activityLoading ? "Refreshing…" : "Refresh activity"}
                </Button>
              </div>
              {activity.warning && (
                <div className="fp-alert fp-alert-warning" role="status">
                  {activity.warning}
                </div>
              )}
              {activityError && (
                <div className="fp-alert fp-alert-error" role="alert">
                  {activityError}
                  <Button variant="text" onClick={() => loadActivity()}>
                    Try again
                  </Button>
                </div>
              )}
            </>
          )}
          {tab === "home" && (
            <div aria-busy={activityLoading}>
              {selectedMonth !== activity.month ? (
                <div className="fp-card fp-loading-state" role="status">
                  {activityLoading
                    ? "Loading your overview…"
                    : "Your overview could not be refreshed. Try again above."}
                </div>
              ) : (
                <FinanceOverview
                  document={document}
                  activity={activity}
                  rate={rate}
                  month={selectedMonth}
                  currency={displayCurrency}
                  onAddTransaction={() => open({ type: "transaction" })}
                  onNavigate={navigate}
                />
              )}
            </div>
          )}
          {tab === "transactions" && (
            <div aria-busy={activityLoading}>
              {selectedMonth !== activity.month ? (
                <div className="fp-card fp-loading-state" role="status">
                  {activityLoading
                    ? "Loading transactions…"
                    : "Your transactions could not be refreshed. Try again above."}
                </div>
              ) : (
                <TransactionsPanel
                  activity={activity}
                  month={selectedMonth}
                  currency={displayCurrency}
                  rate={rate}
                  onAdd={() => open({ type: "transaction" })}
                  onEdit={(transaction) =>
                    open({ type: "transaction", transaction })
                  }
                  onDelete={(row) => open({ type: "deleteTransaction", row })}
                />
              )}
            </div>
          )}
          {tab === "accounts" && (
            <BankAccountsPanel
              activity={activity}
              rate={rate}
              currency={displayCurrency}
              busy={busy}
              onAction={performAction}
              onRefresh={async () => {
                if (!(await loadActivity()))
                  throw new Error(
                    "Your connection was saved, but account data could not be refreshed. Use Refresh activity to try again.",
                  );
              }}
              onNotice={setNotice}
              onError={setError}
            />
          )}
          {tab === "settings" && (
            <div className="fp-settings-grid">
              <section className="fp-card fp-salary-card">
                <div className="fp-card-heading">
                  <div>
                    <span className="fp-section-number">01</span>
                    <h2>Your monthly salary</h2>
                  </div>
                  <span className="fp-label-pill">USD ⇄ PHP</span>
                </div>
                <p className="fp-card-intro">
                  Your salary drives spending plans and budget forecasts.
                  Recorded income on the overview comes from transactions.
                </p>
                <SalaryEditor
                  salary={document.salary}
                  rate={rate}
                  busy={busy}
                  configured={state.configured}
                  onSave={(salary) =>
                    save(
                      { ...document, salary },
                      "Salary and forecast settings updated.",
                    )
                  }
                />
              </section>
              <section className="fp-card fp-settings-notes">
                <h2>One place to plan. One place to track.</h2>
                <p>
                  Bills, spending allocations, and budget plans describe what
                  you expect. One-time transactions and bank imports show what
                  actually happened.
                </p>
                <p>
                  Reference rates update automatically. USD and PHP totals use
                  the same rate so your charts and plans stay consistent.
                </p>
                <Button icon="bank" onClick={() => navigate("accounts")}>
                  Manage bank connections
                </Button>
                {!document.bills.length && (
                  <div className="fp-settings-example">
                    <h3>Start with your workbook</h3>
                    <p>
                      Add editable bills from your original workbook, then
                      adjust the details to your current needs.
                    </p>
                    <Button onClick={() => open({ type: "example" })}>
                      Use workbook example
                    </Button>
                  </div>
                )}
              </section>
            </div>
          )}

          {tab === "bills" && (
            <>
              <section className="fp-card">
                <div className="fp-card-heading fp-bill-heading">
                  <div className="fp-segmented" aria-label="Bill frequency">
                    {["monthly", "annual"].map((item) => (
                      <button
                        key={item}
                        className={cadence === item ? "active" : ""}
                        aria-pressed={cadence === item}
                        onClick={() => setCadence(item)}
                      >
                        {item === "monthly" ? "Monthly bills" : "Annual bills"}
                        <span>
                          {
                            document.bills.filter(
                              (bill) => bill.cadence === item,
                            ).length
                          }
                        </span>
                      </button>
                    ))}
                  </div>
                  <div className="fp-currency-legend">
                    <span>
                      <i className="fp-dot fp-dot-usd" /> Paid in USD
                    </span>
                    <span>
                      <i className="fp-dot fp-dot-php" /> Paid in PHP
                    </span>
                  </div>
                </div>
                <BillsTable
                  bills={document.bills.filter(
                    (bill) => bill.cadence === cadence,
                  )}
                  cadence={cadence}
                  summary={summary}
                  rate={rate}
                  onAdd={() => open({ type: "bill" })}
                  onEdit={(bill) => open({ type: "bill", bill })}
                  onDelete={(row) =>
                    open({ type: "delete", collection: "bills", row })
                  }
                />
              </section>
              <div className="fp-bills-bottom">
                <div className="fp-info-card">
                  <span>
                    <Icon name="calendar" />
                  </span>
                  <div>
                    <h3>A head start on annual bills</h3>
                    <p>
                      Save <strong>{money(summary.annualMonthlyUsd)}</strong>{" "}
                      each month toward your{" "}
                      <strong>{money(summary.annualUsd)}</strong> annual total.
                      This reserve is already included in your monthly bills.
                    </p>
                  </div>
                </div>
                <div className="fp-bill-remaining">
                  <span>Monthly salary − all monthly commitments</span>
                  <strong
                    className={
                      summary.monthlyRemainingUsd < 0 ? "fp-negative" : ""
                    }
                  >
                    {money(summary.monthlyRemainingUsd)}
                  </strong>
                  <small>
                    {money(summary.monthlyRemainingPhp, "PHP")} remaining
                  </small>
                </div>
              </div>
            </>
          )}

          {tab === "spending" && (
            <div className="fp-spending-layout">
              <section className="fp-card fp-spending-card">
                <div className="fp-card-heading">
                  <div>
                    <span className="fp-section-number">01</span>
                    <h2>
                      {isBiweekly ? "Biweekly" : "Twice-monthly"} spending plan
                    </h2>
                  </div>
                  <span className="fp-label-pill">All totals in USD</span>
                </div>
                <SpendingTable
                  document={document}
                  summary={summary}
                  rate={rate}
                  onAdd={() => open({ type: "allocation" })}
                  onEdit={(row) => open({ type: "allocation", row })}
                  onDelete={(row) =>
                    open({ type: "delete", collection: "allocations", row })
                  }
                />
              </section>
              <aside className="fp-spending-notes">
                <div className="fp-info-card">
                  <span>
                    <Icon name="chart" />
                  </span>
                  <div>
                    <h3>Built around your payday</h3>
                    <p>
                      {isBiweekly
                        ? "Your monthly salary and bills are annualized, then divided across 26 pay periods."
                        : "Your monthly salary and bills are split across 2 pay periods each month (24 per year)."}
                    </p>
                    <Button variant="text" onClick={() => navigate("settings")}>
                      Change pay frequency <Icon name="arrow" size={15} />
                    </Button>
                  </div>
                </div>
                <div className="fp-info-card">
                  <span>
                    <Icon name="globe" />
                  </span>
                  <div>
                    <h3>Two currencies, one clear total</h3>
                    <p>
                      PHP bills are converted at {rateMoney(rate)} per dollar.
                      Annual bills are set aside gradually, so they’re ready
                      when due.
                    </p>
                  </div>
                </div>
                <div className="fp-mini-summary">
                  <span>Allocated each payday</span>
                  <strong>
                    {money(
                      summary.incomePerPeriodUsd -
                        summary.unallocatedPerPeriodUsd,
                    )}
                  </strong>
                  <div className="fp-progress">
                    <span
                      style={{
                        width: `${Math.max(0, Math.min(100, summary.incomePerPeriodUsd ? ((summary.incomePerPeriodUsd - summary.unallocatedPerPeriodUsd) / summary.incomePerPeriodUsd) * 100 : 0))}%`,
                      }}
                    />
                  </div>
                  <small>
                    {summary.unallocatedPerPeriodUsd < 0
                      ? "Your plan exceeds your income. Adjust bills or allocations."
                      : `${money(summary.unallocatedPerPeriodUsd)} available for everything else.`}
                  </small>
                </div>
              </aside>
            </div>
          )}

          {tab === "plans" && (
            <>
              {!document.plans.length ? (
                <section className="fp-card">
                  <Empty
                    icon="calendar"
                    title="Make room for what’s next"
                    action={
                      <Button
                        icon="plus"
                        variant="primary"
                        onClick={() => open({ type: "plan" })}
                      >
                        Create a budget plan
                      </Button>
                    }
                  >
                    Choose your dates and starting balances. Your bills and
                    paydays will fill themselves in.
                  </Empty>
                </section>
              ) : (
                <>
                  <div className="fp-plan-selector">
                    {document.plans.map((item) => (
                      <button
                        key={item.id}
                        className={plan.id === item.id ? "active" : ""}
                        onClick={() => {
                          setPlanActivityError("");
                          setSelectedPlanId(item.id);
                        }}
                      >
                        <Icon name="calendar" size={17} />
                        <span>
                          {item.name}
                          <small>
                            {formatDate(item.startDate)} –{" "}
                            {formatDate(item.endDate)}
                          </small>
                        </span>
                      </button>
                    ))}
                  </div>
                  <section className="fp-card">
                    <div className="fp-card-heading">
                      <div>
                        <h2>{plan.name}</h2>
                        <span className="fp-label-pill">Money flow</span>
                      </div>
                      <div className="fp-button-row">
                        {plan.includeTransactions !== false && (
                          <Button
                            icon="refresh"
                            disabled={planActivityLoading}
                            onClick={() => loadPlanActivity(plan)}
                          >
                            {planActivityLoading
                              ? "Refreshing flows…"
                              : "Refresh flows"}
                          </Button>
                        )}
                        <Button
                          icon="edit"
                          onClick={() => open({ type: "plan", plan })}
                        >
                          Edit plan
                        </Button>
                        <Button
                          icon="trash"
                          className="fp-icon-button"
                          aria-label={`Delete ${plan.name}`}
                          onClick={() =>
                            open({
                              type: "delete",
                              collection: "plans",
                              row: plan,
                            })
                          }
                        />
                        <Button
                          icon="plus"
                          variant="primary"
                          onClick={() => open({ type: "entry" })}
                        >
                          Add entry
                        </Button>
                      </div>
                    </div>
                    <p className="fp-plan-date-range">
                      {formatDate(plan.startDate, { year: "numeric" })} –{" "}
                      {formatDate(plan.endDate, { year: "numeric" })} · Balances
                      begin before the first day’s flows.
                    </p>
                    <div className="fp-plan-summary fp-plan-flow-summary">
                      <div>
                        <span>Available funds · USD</span>
                        <strong
                          className={
                            (planRows.at(-1)?.balanceUsd ?? plan.openingUsd) < 0
                              ? "fp-negative"
                              : "fp-positive"
                          }
                        >
                          {planWaitingForRecords
                            ? "—"
                            : money(
                                planRows.at(-1)?.balanceUsd ?? plan.openingUsd,
                              )}
                        </strong>
                      </div>
                      <div>
                        <span>Available funds · PHP</span>
                        <strong
                          className={
                            (planRows.at(-1)?.balancePhp ?? plan.openingPhp) < 0
                              ? "fp-negative"
                              : ""
                          }
                        >
                          {planWaitingForRecords
                            ? "—"
                            : money(
                                planRows.at(-1)?.balancePhp ?? plan.openingPhp,
                                "PHP",
                              )}
                        </strong>
                      </div>
                      <div>
                        <span>Annual reserve · USD</span>
                        <strong>
                          {planWaitingForRecords
                            ? "—"
                            : money(
                                planRows.at(-1)?.reserveUsd ??
                                  planOpeningReserve.usd,
                              )}
                        </strong>
                      </div>
                      <div>
                        <span>Annual reserve · PHP</span>
                        <strong>
                          {planWaitingForRecords
                            ? "—"
                            : money(
                                planRows.at(-1)?.reservePhp ??
                                  planOpeningReserve.php,
                                "PHP",
                              )}
                        </strong>
                      </div>
                    </div>
                    {plan.includeTransactions !== false &&
                      planActivityError && (
                        <div
                          className="fp-alert fp-alert-warning"
                          role="status"
                        >
                          {planActivityError}{" "}
                          {planRecordsMatch
                            ? "Review the loaded records before relying on the ending balances."
                            : "Scheduled flows and your plan entries are shown without recorded transactions."}
                          <Button
                            variant="text"
                            onClick={() => loadPlanActivity(plan)}
                          >
                            Retry recorded flows
                          </Button>
                        </div>
                      )}
                    {plan.includeTransactions !== false &&
                      planRecordsMatch &&
                      planActivity?.warning &&
                      !planActivityError && (
                        <div
                          className="fp-alert fp-alert-warning"
                          role="status"
                        >
                          {planActivity.warning}
                        </div>
                      )}
                    {plan.includeTransactions !== false &&
                      planRecordsMatch &&
                      planActivity?.transactions.some(
                        (transaction) => transaction.pending,
                      ) && (
                        <p className="fp-plan-flow-note">
                          Pending bank entries are not deducted until posted.
                          Scheduled bill payments remain in the plan until a
                          matching recorded payment replaces them.
                        </p>
                      )}
                    {undated.length > 0 && (
                      <p className="fp-plan-warning">
                        {undated.map((bill) => bill.name).join(", ")}{" "}
                        {undated.length === 1
                          ? "needs a due date"
                          : "need due dates"}{" "}
                        to appear in this forecast.{" "}
                        <button onClick={() => navigate("bills")}>
                          Edit bills
                        </button>
                      </p>
                    )}
                    {planWaitingForRecords ? (
                      <div className="fp-card fp-loading-state" role="status">
                        Loading recorded money flows for these dates…
                      </div>
                    ) : (
                      <Ledger
                        plan={plan}
                        rows={planRows}
                        openingReserve={planOpeningReserve}
                        onEdit={(entry) => open({ type: "entry", entry })}
                        onDelete={(row) => open({ type: "deleteEntry", row })}
                      />
                    )}
                    <p className="fp-plan-flow-note">
                      This plan includes dated bills and your plan entries
                      {plan.includeIncome ? ", scheduled salary" : ""}
                      {plan.includeAllocations !== false
                        ? ", payday savings and expense allocations"
                        : ""}
                      {plan.includeAnnualReserve !== false
                        ? ", annual-bill set-asides"
                        : ""}
                      {plan.includeTransactions !== false
                        ? ", and recorded transactions across the full date range (including transfers)"
                        : ""}
                      . Matching posted flows replace their scheduled rows. Add
                      currency-conversion entries when one currency needs
                      funding.
                    </p>
                  </section>
                </>
              )}
            </>
          )}
          <footer className="fp-footer">
            <a className="fp-mobile-back" href="/">
              ← Back to portfolio
            </a>
            <span>
              <Icon name="lock" size={12} /> Your personal finance space
            </span>
            <span>
              USD & PHP · Reference rates{" "}
              {state.exchangeRate.source
                ? `via ${state.exchangeRate.source}`
                : "pending"}
            </span>
          </footer>
        </main>
      </div>
      {notice && (
        <div className="fp-toast" role="status">
          <Icon name="check" size={17} />
          {notice}
        </div>
      )}
      {modal && (
        <Modal
          title={
            modal.type === "transaction"
              ? modal.transaction
                ? "Edit transaction"
                : "Quick add transaction"
              : modal.type === "deleteTransaction"
                ? "Delete this transaction?"
                : modal.type === "bill"
                  ? modal.bill
                    ? "Edit bill"
                    : `Add ${cadence} bill`
                  : modal.type === "allocation"
                    ? modal.row
                      ? "Edit allocation"
                      : "Add an allocation"
                    : modal.type === "plan"
                      ? modal.plan
                        ? "Edit budget plan"
                        : "Create a budget plan"
                      : modal.type === "entry"
                        ? modal.entry
                          ? "Edit entry"
                          : "Add a plan entry"
                        : modal.type === "example"
                          ? "Start with your workbook"
                          : "Delete this item?"
          }
          onClose={() => setModal(null)}
          busy={busy}
        >
          {error && (
            <div className="fp-alert fp-alert-error" role="alert">
              {error}
            </div>
          )}
          {modal.type === "transaction" && (
            <QuickTransactionForm
              transaction={modal.transaction}
              accounts={activity.accounts}
              categories={activity.categories}
              rate={rate}
              onSave={saveTransaction}
              busy={busy}
              disabled={!activity.configured}
            />
          )}
          {modal.type === "deleteTransaction" && (
            <div className="fp-form">
              <p>
                Delete{" "}
                <strong>{modal.row.merchant || modal.row.category}</strong> for{" "}
                <strong>{money(modal.row.amount, modal.row.currency)}</strong>?
                Your recorded totals and any manually tracked account balance
                will update. This cannot be undone.
              </p>
              <div className="fp-button-row">
                <Button onClick={() => setModal(null)}>Keep it</Button>
                <Button
                  variant="danger"
                  disabled={busy || !activity.configured}
                  onClick={() => deleteTransaction(modal.row)}
                >
                  {busy ? "Deleting…" : "Delete transaction"}
                </Button>
              </div>
            </div>
          )}
          {!(
            modal.type === "transaction" || modal.type === "deleteTransaction"
          ) &&
            !state.configured && (
              <div className="fp-alert fp-alert-warning">
                Database storage is required to save changes. Connect MySQL
                using the setup in README.md.
              </div>
            )}
          {modal.type === "bill" && (
            <BillForm
              bill={modal.bill}
              cadence={cadence}
              rate={rate}
              onSave={saveBill}
              busy={busy}
              disabled={!state.configured}
            />
          )}
          {modal.type === "allocation" && (
            <AllocationForm
              row={modal.row}
              onSave={saveAllocation}
              busy={busy}
              disabled={!state.configured}
            />
          )}
          {modal.type === "plan" && (
            <PlanForm
              plan={modal.plan}
              document={document}
              onSave={savePlan}
              busy={busy}
              disabled={!state.configured}
            />
          )}
          {modal.type === "entry" && (
            <EntryForm
              entry={modal.entry}
              plan={plan}
              onSave={saveEntry}
              busy={busy}
              disabled={!state.configured}
              rate={rate}
            />
          )}
          {(modal.type === "delete" || modal.type === "deleteEntry") && (
            <div className="fp-form">
              <p>
                Remove{" "}
                <strong>{modal.row?.name || modal.row?.description}</strong>?{" "}
                {modal.collection === "bills"
                  ? "It will also be removed from every budget forecast."
                  : "This cannot be undone."}
              </p>
              <div className="fp-button-row">
                <Button onClick={() => setModal(null)}>Keep it</Button>
                <Button
                  variant="danger"
                  disabled={busy || !state.configured}
                  onClick={() =>
                    modal.type === "deleteEntry"
                      ? savePlan({
                          ...plan,
                          entries: plan.entries.filter(
                            (item) => item.id !== modal.row.id,
                          ),
                        })
                      : save(
                          {
                            ...document,
                            [modal.collection]: document[
                              modal.collection
                            ].filter((item) => item.id !== modal.row.id),
                          },
                          "Item deleted.",
                        )
                  }
                >
                  {busy ? "Deleting…" : "Delete"}
                </Button>
              </div>
            </div>
          )}
          {modal.type === "example" && (
            <div className="fp-form">
              <p>
                Add the monthly and annual bills from your screenshots, plus a
                $500 savings allocation. Amounts will use the current exchange
                rate.
              </p>
              <p className="fp-inline-note">
                House, Car, and Venture X need a specific due day before they
                can appear in dated budget plans. You can edit every example
                after adding it.
              </p>
              <Button
                variant="primary"
                disabled={
                  busy || !state.configured || document.bills.length > 0
                }
                onClick={loadExample}
              >
                {busy ? "Adding…" : "Add example bills"}
              </Button>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
