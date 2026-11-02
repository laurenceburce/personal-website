"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { signOut } from "next-auth/react";
import {
  buildPlanRows,
  convert,
  formatDate,
  getSummary,
  localDate,
  addDays,
  money,
} from "../lib/financePlanner.mjs";
import FinanceInstall from "./FinanceInstall";
import "./finance.css";

const NAV = [
  { id: "home", label: "Overview", icon: "grid" },
  { id: "bills", label: "Bills", icon: "receipt" },
  { id: "spending", label: "Spending plan", icon: "chart" },
  { id: "plans", label: "Budget plans", icon: "calendar" },
];
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
function DueLabel({ bill }) {
  if (!bill.dueDay)
    return (
      <span className="fp-needs-date">
        Date not set
        {bill.cadence === "annual"
          ? ` · ${bill.dueMonths.map((month) => MONTHS[month - 1]).join(", ")}`
          : ""}
      </span>
    );
  return bill.cadence === "annual" ? (
    <>
      {bill.dueMonths
        .map((month) => `${MONTHS[month - 1]} ${bill.dueDay}`)
        .join(" · ")}
    </>
  ) : (
    <>Day {bill.dueDay}</>
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
function Metric({ label, value, detail, icon, accent }) {
  return (
    <article className={`fp-metric ${accent ? "fp-metric-accent" : ""}`}>
      <div className="fp-metric-label">
        {label}
        <Icon name={icon} size={18} />
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
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
            <option value="semimonthly">Twice a month · 24/year</option>
            <option value="biweekly">Every 2 weeks · 26/year</option>
          </select>
        </Field>
        <Field
          label="First payday"
          hint="Used to schedule income in budget plans."
        >
          <input
            type="date"
            required
            value={draft.firstPayDate}
            onChange={(e) => set("firstPayDate", e.target.value)}
          />
        </Field>
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

function BillForm({ bill, cadence, rate, onSave, busy, disabled }) {
  const [draft, setDraft] = useState(
    bill || {
      name: "",
      amount: "",
      currency: "USD",
      cadence,
      dueDay: "",
      dueMonths: [Number(localDate().slice(5, 7))],
      paymentMethod: "",
      isAutopay: false,
    },
  );
  const set = (key, value) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const annual = draft.cadence === "annual";
  return (
    <form
      className="fp-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          ...draft,
          id: draft.id || uid(),
          amount: amount(draft.amount),
          dueDay: draft.dueDay ? Number(draft.dueDay) : null,
        });
      }}
    >
      <Field label="Item">
        <input
          required
          autoFocus
          maxLength={120}
          placeholder="e.g. Google, rent, car insurance"
          value={draft.name}
          onChange={(e) => set("name", e.target.value)}
        />
      </Field>
      <div className="fp-form-grid">
        <Field label={annual ? "Total annual amount" : "Monthly amount"}>
          <input
            required
            type="number"
            min="0.01"
            max="999999999"
            step="0.01"
            inputMode="decimal"
            value={draft.amount}
            onChange={(e) => set("amount", e.target.value)}
          />
        </Field>
        <Field label="Paid in">
          <CurrencySelect
            value={draft.currency}
            onChange={(value) => set("currency", value)}
          />
        </Field>
      </div>
      <div
        className={`fp-conversion-note fp-currency-${draft.currency.toLowerCase()}`}
      >
        {money(
          convert(
            draft.amount,
            draft.currency,
            draft.currency === "USD" ? "PHP" : "USD",
            rate,
          ),
          draft.currency === "USD" ? "PHP" : "USD",
        )}{" "}
        equivalent
        {annual && (
          <> · Save {money(amount(draft.amount) / 12, draft.currency)}/month</>
        )}
      </div>
      <div className="fp-form-grid">
        <Field label="Repeats">
          <select
            value={draft.cadence}
            onChange={(e) => set("cadence", e.target.value)}
          >
            <option value="monthly">Monthly</option>
            <option value="annual">Annually</option>
          </select>
        </Field>
        <Field label="Due day" hint="Shorter months use their last day.">
          <input
            type="number"
            min="1"
            max="31"
            step="1"
            placeholder="1–31 (optional)"
            value={draft.dueDay ?? ""}
            onChange={(e) => set("dueDay", e.target.value)}
          />
        </Field>
      </div>
      {annual && (
        <fieldset className="fp-month-field">
          <legend>Payment month{draft.dueMonths.length > 1 ? "s" : ""}</legend>
          <div>
            {MONTHS.map((name, index) => (
              <label key={name}>
                <input
                  type="checkbox"
                  checked={draft.dueMonths.includes(index + 1)}
                  onChange={(e) =>
                    set(
                      "dueMonths",
                      e.target.checked
                        ? [...draft.dueMonths, index + 1].sort((a, b) => a - b)
                        : draft.dueMonths.filter(
                            (month) => month !== index + 1,
                          ),
                    )
                  }
                />
                {name}
              </label>
            ))}
          </div>
          <small>
            Select multiple months to split the annual total into equal
            installments.
          </small>
        </fieldset>
      )}
      <Field label="Payment method (optional)">
        <input
          maxLength={80}
          placeholder="e.g. US Bank Credit, RCBC, cash"
          value={draft.paymentMethod}
          onChange={(e) => set("paymentMethod", e.target.value)}
        />
      </Field>
      <label className="fp-checkbox">
        <input
          type="checkbox"
          checked={draft.isAutopay}
          onChange={(e) => set("isAutopay", e.target.checked)}
        />
        Automatic payment is enabled
      </label>
      {!draft.dueDay && (
        <p className="fp-inline-note">
          Add a due day to include this bill automatically in dated budget
          plans.
        </p>
      )}
      <Button
        type="submit"
        variant="primary"
        icon="check"
        disabled={busy || disabled || (annual && !draft.dueMonths.length)}
      >
        {busy ? "Saving…" : bill ? "Save changes" : "Add bill"}
      </Button>
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

function PlanForm({ plan, onSave, busy, disabled }) {
  const today = localDate();
  const [draft, setDraft] = useState(
    plan || {
      name: "",
      startDate: today,
      endDate: addDays(today, 30),
      openingUsd: 0,
      openingPhp: 0,
      includeIncome: true,
      entries: [],
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
          openingUsd: amount(draft.openingUsd),
          openingPhp: amount(draft.openingPhp),
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
        <Field label="Starting balance · USD">
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
        <Field label="Starting balance · PHP">
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
      <label className="fp-checkbox">
        <input
          type="checkbox"
          checked={draft.includeIncome}
          onChange={(e) => set("includeIncome", e.target.checked)}
        />
        Include scheduled salary payments
      </label>
      <p className="fp-inline-note">
        Bills with due dates appear automatically. Each plan is a forecast; it
        doesn’t record real payments. Changes to salary, bills, or the exchange
        rate update every forecast.
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

function BillsTable({
  bills,
  cadence,
  summary,
  rate,
  onAdd,
  onEdit,
  onDelete,
}) {
  if (!bills.length && !(cadence === "monthly" && summary.annualUsd > 0))
    return (
      <Empty
        title={`Your ${cadence} bills go here`}
        action={
          <Button icon="plus" variant="primary" onClick={onAdd}>
            Add your first bill
          </Button>
        }
      >
        Enter the amount in the currency you actually pay. We’ll handle the
        conversion.
      </Empty>
    );
  return (
    <div className="fp-table-wrap">
      <table className="fp-table fp-bills-table">
        <thead>
          <tr>
            <th>Item</th>
            <th>Amount · USD</th>
            <th>Amount · PHP</th>
            {cadence === "annual" && <th>Save / month</th>}
            <th>Due date</th>
            <th>Auto payment</th>
            <th>
              <span className="fp-sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {bills.map((bill) => (
            <tr key={bill.id}>
              <td data-label="Item">
                <span className="fp-bill-name">
                  <span
                    className={`fp-bill-monogram fp-currency-${bill.currency.toLowerCase()}`}
                  >
                    {bill.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span>
                    <strong>{bill.name}</strong>
                    <small>
                      Paid in {bill.currency}
                      {cadence === "annual" && bill.dueMonths.length > 1
                        ? ` · ${bill.dueMonths.length} installments`
                        : ""}
                    </small>
                  </span>
                </span>
              </td>
              <td data-label="USD">
                <span
                  className={
                    bill.currency === "USD"
                      ? "fp-native fp-currency-usd"
                      : "fp-equivalent"
                  }
                >
                  {money(convert(bill.amount, bill.currency, "USD", rate))}
                </span>
              </td>
              <td data-label="PHP">
                <span
                  className={
                    bill.currency === "PHP"
                      ? "fp-native fp-currency-php"
                      : "fp-equivalent"
                  }
                >
                  {money(
                    convert(bill.amount, bill.currency, "PHP", rate),
                    "PHP",
                  )}
                </span>
              </td>
              {cadence === "annual" && (
                <td data-label="Save / month">
                  <strong>
                    {money(
                      convert(bill.amount / 12, bill.currency, "USD", rate),
                    )}
                  </strong>
                  <small>
                    {money(
                      convert(bill.amount / 12, bill.currency, "PHP", rate),
                      "PHP",
                    )}
                  </small>
                </td>
              )}
              <td data-label="Due date">
                <DueLabel bill={bill} />
              </td>
              <td data-label="Auto payment">
                <span>{bill.paymentMethod || "—"}</span>
                <small>{bill.isAutopay ? "Automatic" : "Manual"}</small>
              </td>
              <td data-label="Actions">
                <div className="fp-row-actions">
                  <Button
                    icon="edit"
                    className="fp-icon-button"
                    aria-label={`Edit ${bill.name}`}
                    onClick={() => onEdit(bill)}
                  />
                  <Button
                    icon="trash"
                    className="fp-icon-button"
                    aria-label={`Delete ${bill.name}`}
                    onClick={() => onDelete(bill)}
                  />
                </div>
              </td>
            </tr>
          ))}
          {cadence === "monthly" && (
            <tr className="fp-reserve-row">
              <td data-label="Item">
                <strong>Annual bills reserve</strong>
                <small>Set aside each month</small>
              </td>
              <td data-label="USD">
                <strong>{money(summary.annualMonthlyUsd)}</strong>
              </td>
              <td data-label="PHP">
                <strong>{money(summary.annualMonthlyPhp, "PHP")}</strong>
              </td>
              <td data-label="Due date">Monthly savings</td>
              <td data-label="Auto payment">For your annual bills</td>
              <td />
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <td>
              {cadence === "annual" ? "Annual total" : "Total monthly bills"}
            </td>
            <td>
              {money(
                cadence === "annual"
                  ? summary.annualUsd
                  : summary.monthlyCommitmentsUsd,
              )}
            </td>
            <td>
              {money(
                cadence === "annual"
                  ? summary.annualPhp
                  : summary.monthlyCommitmentsPhp,
                "PHP",
              )}
            </td>
            {cadence === "annual" && (
              <td>
                {money(summary.annualMonthlyUsd)}
                <small>per month</small>
              </td>
            )}
            <td colSpan="3" />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function Ledger({ plan, rows, onEdit, onDelete }) {
  return (
    <div
      className="fp-table-wrap fp-ledger-wrap"
      role="region"
      aria-label="Budget running balance, scroll horizontally on small screens"
      tabIndex={0}
    >
      <table className="fp-table fp-ledger">
        <thead>
          <tr>
            <th>Date</th>
            <th>Description</th>
            <th>USD</th>
            <th>PHP</th>
            <th className="fp-running">Balance · USD</th>
            <th className="fp-running">Balance · PHP</th>
            <th>
              <span className="fp-sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr className="fp-opening-row">
            <td>{formatDate(plan.startDate)}</td>
            <td>
              <strong>Starting balance</strong>
            </td>
            <td>—</td>
            <td>—</td>
            <td className="fp-running">{money(plan.openingUsd)}</td>
            <td className="fp-running">{money(plan.openingPhp, "PHP")}</td>
            <td />
          </tr>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{formatDate(row.date)}</td>
              <td>
                <strong>{row.description}</strong>
                <small>
                  {row.source === "salary"
                    ? "Scheduled income"
                    : row.source === "bill"
                      ? "Automatic bill"
                      : row.kind === "conversion"
                        ? "Currency conversion"
                        : "Your entry"}
                </small>
              </td>
              <td
                className={
                  row.usd < 0
                    ? "fp-negative"
                    : row.usd > 0
                      ? "fp-positive"
                      : "fp-zero"
                }
              >
                {row.usd ? signed(row.usd, "USD") : "—"}
              </td>
              <td
                className={
                  row.php < 0
                    ? "fp-negative"
                    : row.php > 0
                      ? "fp-positive"
                      : "fp-zero"
                }
              >
                {row.php ? signed(row.php, "PHP") : "—"}
              </td>
              <td
                className={`fp-running ${row.balanceUsd < 0 ? "fp-negative" : ""}`}
              >
                {money(row.balanceUsd)}
              </td>
              <td
                className={`fp-running ${row.balancePhp < 0 ? "fp-negative" : ""}`}
              >
                {money(row.balancePhp, "PHP")}
              </td>
              <td>
                {row.source === "manual" && (
                  <div className="fp-row-actions">
                    <Button
                      icon="edit"
                      className="fp-icon-button"
                      aria-label={`Edit ${row.description}`}
                      onClick={() =>
                        onEdit(
                          plan.entries.find((item) => item.id === row.entryId),
                        )
                      }
                    />
                    <Button
                      icon="trash"
                      className="fp-icon-button"
                      aria-label={`Delete ${row.description}`}
                      onClick={() =>
                        onDelete(
                          plan.entries.find((item) => item.id === row.entryId),
                        )
                      }
                    />
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function FinanceAppClient({ snapshot, initialTab }) {
  const [state, setState] = useState(snapshot);
  const [tab, setTab] = useState(
    NAV.some((item) => item.id === initialTab) ? initialTab : "home",
  );
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
  const planRows = useMemo(
    () => (plan ? buildPlanRows(plan, document, rate) : []),
    [plan, document, rate],
  );
  const isBiweekly = document.salary.payFrequency === "biweekly";
  const activeNav = NAV.find((item) => item.id === tab);
  const undated = document.bills.filter((bill) => !bill.dueDay);
  const saveLock = useRef(false);

  useEffect(() => {
    const onPop = () => {
      const next = new URL(window.location.href).searchParams.get("tab");
      setTab(NAV.some((item) => item.id === next) ? next : "home");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
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
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.pushState({}, "", url);
    setError("");
  }
  function open(next) {
    setError("");
    setModal(next);
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
            My workspace <span>/</span> <strong>{activeNav.label}</strong>
          </span>
          <div>
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
              <p className="fp-eyebrow">A LITTLE CLARITY, EVERY PAYDAY</p>
              <h1>
                {tab === "home"
                  ? "Your money, at a glance."
                  : tab === "bills"
                    ? "Everything that’s due."
                    : tab === "spending"
                      ? "Give every payday a plan."
                      : "A plan for what’s ahead."}
              </h1>
              <p>
                {tab === "home"
                  ? "One place for your dollars, pesos, and peace of mind."
                  : tab === "bills"
                    ? "Monthly essentials and annual commitments, all accounted for."
                    : tab === "spending"
                      ? "Know what to set aside and what’s yours to spend."
                      : "Try out dates, expenses, and currency moves before they happen."}
              </p>
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

          {tab === "home" && (
            <>
              <section className="fp-metrics" aria-label="Monthly summary">
                <Metric
                  label="Monthly income"
                  value={money(summary.monthlyUsd)}
                  detail={`${money(summary.monthlyPhp, "PHP")} equivalent`}
                  icon="coin"
                />
                <Metric
                  label="Monthly bills"
                  value={money(summary.monthlyCommitmentsUsd)}
                  detail="Includes your annual bills reserve"
                  icon="receipt"
                />
                <Metric
                  label="Annual reserve / month"
                  value={money(summary.annualMonthlyUsd)}
                  detail={`${money(summary.annualUsd)} in annual commitments`}
                  icon="calendar"
                />
                <Metric
                  label="After monthly bills"
                  value={money(summary.monthlyRemainingUsd)}
                  detail="Before savings & everyday spending"
                  icon="wallet"
                  accent
                />
              </section>
              <div className="fp-overview-grid">
                <section className="fp-card fp-salary-card">
                  <div className="fp-card-heading">
                    <div>
                      <span className="fp-section-number">01</span>
                      <h2>Your monthly salary</h2>
                    </div>
                    <span className="fp-label-pill">USD ⇄ PHP</span>
                  </div>
                  <p className="fp-card-intro">
                    Start with what comes in. The rest falls into place.
                  </p>
                  <SalaryEditor
                    salary={document.salary}
                    rate={rate}
                    busy={busy}
                    configured={state.configured}
                    onSave={(salary) =>
                      save(
                        { ...document, salary },
                        "Salary updated. All calculations are up to date.",
                      )
                    }
                  />
                </section>
                <section className="fp-card">
                  <div className="fp-card-heading">
                    <div>
                      <span className="fp-section-number">02</span>
                      <h2>Your payday breakdown</h2>
                    </div>
                    <span className="fp-label-pill">
                      {isBiweekly ? "Every 2 weeks" : "Twice a month"}
                    </span>
                  </div>
                  <p className="fp-card-intro">
                    Your spending plan, per pay period.
                  </p>
                  <SpendingTable
                    document={document}
                    summary={summary}
                    rate={rate}
                    compact
                  />
                  <Button
                    variant="text"
                    icon="arrow"
                    onClick={() => navigate("spending")}
                  >
                    Open spending plan
                  </Button>
                </section>
              </div>
              <section className="fp-card">
                <div className="fp-card-heading">
                  <div>
                    <span className="fp-section-number">03</span>
                    <h2>Your commitments</h2>
                    <span className="fp-count">{document.bills.length}</span>
                  </div>
                  <Button
                    variant="text"
                    icon="arrow"
                    onClick={() => navigate("bills")}
                  >
                    View all bills
                  </Button>
                </div>
                {document.bills.length ? (
                  <div className="fp-commitments">
                    {document.bills.slice(0, 6).map((bill) => (
                      <button
                        className="fp-commitment"
                        key={bill.id}
                        onClick={() => {
                          setCadence(bill.cadence);
                          navigate("bills");
                        }}
                      >
                        <span
                          className={`fp-bill-monogram fp-currency-${bill.currency.toLowerCase()}`}
                        >
                          {bill.name.slice(0, 1)}
                        </span>
                        <span>
                          <strong>{bill.name}</strong>
                          <small>
                            <DueLabel bill={bill} /> · {bill.cadence}
                          </small>
                        </span>
                        <b>{money(bill.amount, bill.currency)}</b>
                      </button>
                    ))}
                  </div>
                ) : (
                  <Empty
                    title="Let’s get your bills in order"
                    action={
                      <div className="fp-button-row">
                        <Button
                          icon="plus"
                          variant="primary"
                          onClick={() => open({ type: "bill" })}
                        >
                          Add a bill
                        </Button>
                        <Button onClick={() => open({ type: "example" })}>
                          Use your workbook example
                        </Button>
                      </div>
                    }
                  >
                    Add your own bills, or start with the examples from your
                    workbook.
                  </Empty>
                )}
              </section>
            </>
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
                    <Button variant="text" onClick={() => navigate("home")}>
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
                        onClick={() => setSelectedPlanId(item.id)}
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
                        <span className="fp-label-pill">Forecast</span>
                      </div>
                      <div className="fp-button-row">
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
                    <div className="fp-plan-summary">
                      <div>
                        <span>Date range</span>
                        <strong>
                          {formatDate(plan.startDate)} –{" "}
                          {formatDate(plan.endDate)}
                        </strong>
                      </div>
                      <div>
                        <span>Ending balance · USD</span>
                        <strong
                          className={
                            (planRows.at(-1)?.balanceUsd ?? plan.openingUsd) < 0
                              ? "fp-negative"
                              : "fp-positive"
                          }
                        >
                          {money(
                            planRows.at(-1)?.balanceUsd ?? plan.openingUsd,
                          )}
                        </strong>
                      </div>
                      <div>
                        <span>Ending balance · PHP</span>
                        <strong
                          className={
                            (planRows.at(-1)?.balancePhp ?? plan.openingPhp) < 0
                              ? "fp-negative"
                              : ""
                          }
                        >
                          {money(
                            planRows.at(-1)?.balancePhp ?? plan.openingPhp,
                            "PHP",
                          )}
                        </strong>
                      </div>
                    </div>
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
                    <Ledger
                      plan={plan}
                      rows={planRows}
                      onEdit={(entry) => open({ type: "entry", entry })}
                      onDelete={(row) => open({ type: "deleteEntry", row })}
                    />
                    <div className="fp-ledger-note">
                      <Icon name="refresh" size={14} />
                      Bills, salary, and conversions update with your current
                      settings. Annual reserves aren’t deducted here; actual
                      annual bills appear on their due dates.
                    </div>
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
            modal.type === "bill"
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
          {!state.configured && (
            <div className="fp-alert fp-alert-warning">
              Database storage is required to save changes. Connect MySQL using
              the setup in README.md.
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
