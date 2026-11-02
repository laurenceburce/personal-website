"use client";

import { useState } from "react";
import FinanceNumberInput from "./FinanceNumberInput";
import FinanceAccountSelect, {
  financeAccountLabel,
} from "./FinanceAccountSelect";
import {
  annualSavingsTarget,
  addDays,
  billDueDays,
  convert,
  formatDate,
  getAnnualBillFunding,
  localDate,
  money,
  roundMoney,
  salaryOccurrences,
} from "../lib/financePlanner.mjs";
import "./finance-bills.css";

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
const validDay = (day) =>
  Number.isInteger(Number(day)) && Number(day) >= 1 && Number(day) <= 31;
const monthlyDays = (bill) => billDueDays(bill).slice(0, 2);

function Icon({ name, size = 16 }) {
  const paths = {
    plus: <path d="M12 5v14M5 12h14" />,
    check: <path d="m5 12 4 4L19 6" />,
    edit: <path d="m15 5 4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Z" />,
    trash: <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />,
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
      {paths[name]}
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
      {icon && <Icon name={icon} />}
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

function splitLabel(value, currency, count) {
  const cents = Math.round(Number(value || 0) * 100);
  const first = Math.floor(cents / count) / 100;
  const last = (Math.floor(cents / count) + (cents % count)) / 100;
  return first === last
    ? `${money(first, currency)} each`
    : `${money(first, currency)} + ${money(last, currency)}`;
}

function nextPayday(salary, asOf) {
  if (!salary) return null;
  const start = salary.firstPayDate > asOf ? salary.firstPayDate : asOf;
  return salaryOccurrences(salary, start, addDays(start, 370))[0]?.date;
}

function FundingDetails({ funding, currency }) {
  if (funding.fullyFunded)
    return (
      <small className="fb-funding-detail fb-target-met">Fully funded</small>
    );
  if (funding.immediateAmount > 0)
    return (
      <small className="fb-funding-detail fb-funding-urgent">
        Needed before next payday: {money(funding.immediateAmount, currency)}
      </small>
    );
  if (funding.estimated)
    return (
      <small className="fb-funding-detail">
        Estimate ·{" "}
        {funding.needsDate ? "Set a due date" : "Set your salary schedule"}
      </small>
    );
  if (funding.remainingForNextPayment === 0)
    return (
      <small className="fb-funding-detail fb-target-met">
        Next payment funded
      </small>
    );
  return (
    <>
      <small className="fb-funding-detail">
        {funding.paydaysRemaining} payday
        {funding.paydaysRemaining === 1 ? "" : "s"} through{" "}
        {formatDate(funding.nextDueDate, { year: "numeric" })}
      </small>
      <small className="fb-funding-detail">
        {money(funding.remainingForNextPayment, currency)} needed for next
        payment
      </small>
    </>
  );
}

export function DueLabel({ bill, salary, asOf = localDate() }) {
  if (bill.cadence === "payday") {
    const next = nextPayday(salary, asOf);
    return (
      <>
        <span>Every payday</span>
        <small>
          {next
            ? `Next: ${formatDate(next, { year: "numeric" })}`
            : "Follows your salary schedule"}
        </small>
      </>
    );
  }
  if (bill.cadence !== "annual") {
    const days = monthlyDays(bill);
    return days.length ? (
      <>
        {days.length > 1 ? "Days" : "Day"} {days.join(" & ")}
      </>
    ) : (
      <span className="fp-needs-date">Date not set</span>
    );
  }
  const months = [...new Set((bill.dueMonths || []).map(Number))]
    .filter((month) => Number.isInteger(month) && month >= 1 && month <= 12)
    .sort((a, b) => a - b);
  if (!validDay(bill.dueDay) || !months.length)
    return (
      <span className="fp-needs-date">
        Date not set
        {months.length
          ? ` · ${months.map((month) => MONTHS[month - 1]).join(", ")}`
          : ""}
      </span>
    );
  return (
    <>
      {months.map((month) => `${MONTHS[month - 1]} ${bill.dueDay}`).join(" · ")}
    </>
  );
}

export function BillForm({
  bill,
  accounts = [],
  cadence,
  rate,
  salary,
  asOf = localDate(),
  onSave,
  busy,
  disabled,
}) {
  const [draft, setDraft] = useState(() => {
    const days = monthlyDays(bill || {});
    return {
      name: "",
      amount: "",
      currency: "USD",
      cadence,
      dueDay: "",
      paymentMethod: "",
      isAutopay: false,
      ...bill,
      savedAmount: bill?.savedAmount ?? 0,
      accountId: bill?.accountId ?? null,
      reserveAccountId: bill?.reserveAccountId ?? null,
      sourceAccountId: bill?.sourceAccountId ?? null,
      dueMonths: bill?.dueMonths?.length
        ? [...bill.dueMonths]
        : [Number(localDate().slice(5, 7))],
      dueDays: days.length
        ? days.map(String)
        : [bill?.dueDay ? String(bill.dueDay) : ""],
      monthlyPayments: days.length === 2 ? "2" : "1",
    };
  });
  const [error, setError] = useState("");
  const set = (key, value) => {
    setError("");
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const annual = draft.cadence === "annual";
  const payday = draft.cadence === "payday";
  const next = payday ? nextPayday(salary, asOf) : null;
  const payPeriods = salary?.payFrequency === "biweekly" ? 26 : 24;
  const funding = getAnnualBillFunding(draft, payPeriods, { salary, asOf });
  const paymentCount = Number(draft.monthlyPayments);
  const hasMonthlyDate = draft.dueDays.some((day) => String(day).trim());
  const submit = (event) => {
    event.preventDefault();
    if (busy || disabled) return;
    const value = Number(draft.amount);
    const name = draft.name.trim();
    if (!name || name.length > 120)
      return setError("Enter a bill name of up to 120 characters.");
    if (
      !Number.isFinite(value) ||
      value < 0.01 ||
      value > 999999999 ||
      Math.abs(value * 100 - Math.round(value * 100)) > 0.00001
    )
      return setError(
        "Enter an amount from 0.01 to 999,999,999 with up to two decimal places.",
      );
    const savedAmount = annual ? Number(draft.savedAmount ?? 0) : 0;
    for (const [field, label] of [
      ["accountId", "payment account"],
      ...(annual
        ? [
            ["reserveAccountId", "annual savings account"],
            ["sourceAccountId", "reserve funding account"],
          ]
        : []),
    ]) {
      if (
        draft[field] !== null &&
        draft[field] !== undefined &&
        draft[field] !== ""
      ) {
        const selected = accounts.find(
          (account) => String(account.id) === String(draft[field]),
        );
        if (
          !selected ||
          selected.isArchived ||
          selected.is_archived ||
          selected.currency !== draft.currency
        )
          return setError(
            `Choose an available ${draft.currency} ${label}, or leave it unassigned.`,
          );
        if (
          field === "reserveAccountId" &&
          ["credit", "loan"].includes(selected.type)
        )
          return setError(
            "Choose a savings, checking, or cash account for annual reserves.",
          );
      }
    }
    if (
      annual &&
      (!Number.isFinite(savedAmount) ||
        savedAmount < 0 ||
        savedAmount > 999999999 ||
        Math.abs(savedAmount * 100 - Math.round(savedAmount * 100)) > 0.00001)
    )
      return setError(
        "Enter saved funds from 0 to 999,999,999 with up to two decimal places.",
      );
    const months = [...new Set(draft.dueMonths.map(Number))].sort(
      (a, b) => a - b,
    );
    if (
      annual &&
      (!months.length ||
        months.some(
          (month) => !Number.isInteger(month) || month < 1 || month > 12,
        ))
    )
      return setError("Choose at least one payment month.");
    let dueDay = null;
    let dueDays = [];
    if (annual) {
      if (
        draft.dueDay !== "" &&
        draft.dueDay !== null &&
        !validDay(draft.dueDay)
      )
        return setError("Choose a due day between 1 and 31.");
      dueDay =
        draft.dueDay === "" || draft.dueDay === null
          ? null
          : Number(draft.dueDay);
    } else if (!payday) {
      const rawDays = draft.dueDays
        .slice(0, paymentCount)
        .map((day) => String(day ?? "").trim());
      if (rawDays.some((day) => day && !validDay(day)))
        return setError("Choose due days between 1 and 31.");
      if (
        paymentCount === 2 &&
        (rawDays.length !== 2 ||
          rawDays.some((day) => !day) ||
          rawDays[0] === rawDays[1] ||
          Number(rawDays[0]) === Number(rawDays[1]))
      )
        return setError(
          "Choose two different due days for two monthly payments.",
        );
      dueDays = [...new Set(rawDays.filter(Boolean).map(Number))].sort(
        (a, b) => a - b,
      );
      dueDay = dueDays[0] ?? null;
    }
    onSave({
      id: draft.id || globalThis.crypto.randomUUID(),
      name,
      amount: roundMoney(value),
      savedAmount: roundMoney(savedAmount),
      accountId: draft.accountId ? Number(draft.accountId) : null,
      reserveAccountId:
        annual && draft.reserveAccountId
          ? Number(draft.reserveAccountId)
          : null,
      sourceAccountId:
        annual && draft.sourceAccountId ? Number(draft.sourceAccountId) : null,
      currency: draft.currency,
      cadence: draft.cadence,
      dueDay,
      dueDays,
      dueMonths: annual ? months : [],
      paymentMethod: draft.paymentMethod.trim(),
      isAutopay: Boolean(draft.isAutopay),
    });
  };
  return (
    <form className="fp-form fb-form" onSubmit={submit}>
      <Field label="Item">
        <input
          required
          autoFocus
          maxLength={120}
          placeholder="e.g. Google, rent, car insurance"
          value={draft.name}
          onChange={(event) => set("name", event.target.value)}
        />
      </Field>
      <div className="fp-form-grid">
        <Field
          label={
            annual
              ? "Total annual amount"
              : payday
                ? "Amount per payday"
                : "Total monthly amount"
          }
          hint={
            payday
              ? "The full amount you pay each payday. Enter one payment, not a monthly total."
              : !annual
                ? "The combined total of all payments in one month."
                : undefined
          }
        >
          <FinanceNumberInput
            required
            min="0.01"
            max="999999999"
            step="0.01"
            inputMode="decimal"
            value={draft.amount}
            onChange={(event) => set("amount", event.target.value)}
          />
        </Field>
        <Field label="Paid in">
          <select
            value={draft.currency}
            onChange={(event) => {
              setDraft((current) => ({
                ...current,
                currency: event.target.value,
                accountId: null,
                reserveAccountId: null,
                sourceAccountId: null,
              }));
              setError("");
            }}
          >
            <option value="USD">USD · US dollar</option>
            <option value="PHP">PHP · Philippine peso</option>
          </select>
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
          <>
            {" "}
            · Save {money(funding.perPeriodAmount, draft.currency)}/payday
            <br />
            Monthly equivalent: {money(funding.monthlyAmount, draft.currency)}
            {funding.amount > 0 &&
              !funding.fullyFunded &&
              ` · ${money(funding.remainingAmount, draft.currency)} still to fund`}
            <FundingDetails funding={funding} currency={draft.currency} />
          </>
        )}
        {payday && (
          <>
            <br />
            {money(draft.amount, draft.currency)} each payday
            {salary?.payFrequency === "biweekly"
              ? " · Every 2 weeks"
              : salary?.payFrequency === "semimonthly"
                ? " · Twice a month"
                : ""}
          </>
        )}
        {!annual && !payday && paymentCount === 2 && (
          <>
            <br />2 payments per month ·{" "}
            {splitLabel(draft.amount, draft.currency, 2)}
          </>
        )}
      </div>
      {annual && (
        <Field
          label={`Saved so far · ${draft.currency}`}
          hint="Enter the money already set aside for this bill in its payment currency. Funding amounts update automatically. Budget plans start with these earmarked funds; projected plans do not change this saved balance."
        >
          <FinanceNumberInput
            min="0"
            max="999999999"
            step="0.01"
            inputMode="decimal"
            value={draft.savedAmount}
            onChange={(event) => set("savedAmount", event.target.value)}
          />
        </Field>
      )}
      <div className="fp-form-grid">
        <Field label="Repeats">
          <select
            value={draft.cadence}
            onChange={(event) => {
              const next = event.target.value;
              setDraft((current) => ({
                ...current,
                cadence: next,
                dueDay:
                  next === "annual"
                    ? current.dueDays[0] || current.dueDay || ""
                    : current.dueDay,
                dueDays:
                  next === "monthly" && !current.dueDays.some(Boolean)
                    ? [current.dueDay || ""]
                    : current.dueDays,
              }));
              setError("");
            }}
          >
            <option value="monthly">Monthly</option>
            <option value="payday">Every payday</option>
            <option value="annual">Annually</option>
          </select>
        </Field>
        {annual ? (
          <Field label="Due day" hint="Shorter months use their last day.">
            <FinanceNumberInput
              min="1"
              max="31"
              step="1"
              inputMode="numeric"
              placeholder="1–31 (optional)"
              value={draft.dueDay ?? ""}
              onChange={(event) => set("dueDay", event.target.value)}
            />
          </Field>
        ) : !payday ? (
          <Field label="Payments per month">
            <select
              value={draft.monthlyPayments}
              onChange={(event) => {
                const count = event.target.value;
                setDraft((current) => ({
                  ...current,
                  monthlyPayments: count,
                  dueDays:
                    count === "2"
                      ? [current.dueDays[0] || "", current.dueDays[1] || ""]
                      : [current.dueDays[0] || ""],
                }));
                setError("");
              }}
            >
              <option value="1">Once a month</option>
              <option value="2">Twice a month</option>
            </select>
          </Field>
        ) : null}
      </div>
      {payday && (
        <p className="fp-inline-note fb-payday-note">
          Follows your salary schedule. Changing your first payday or pay
          frequency also updates this bill’s dates.
          {next
            ? ` Next payment: ${formatDate(next, { year: "numeric" })}.`
            : " Set your first payday under Salary & settings to add this bill to dated plans."}
        </p>
      )}
      {!annual && !payday && (
        <div className="fp-form-grid">
          {Array.from({ length: paymentCount }, (_, index) => (
            <Field
              key={index}
              label={
                paymentCount === 2
                  ? `${index === 0 ? "First" : "Second"} due day`
                  : "Due day"
              }
              hint={
                index === 0
                  ? "Shorter months use their last day."
                  : "The monthly total is split across both dates."
              }
            >
              <FinanceNumberInput
                required={paymentCount === 2}
                min="1"
                max="31"
                step="1"
                inputMode="numeric"
                placeholder={paymentCount === 2 ? "1–31" : "1–31 (optional)"}
                value={draft.dueDays[index] ?? ""}
                onChange={(event) => {
                  const days = [...draft.dueDays];
                  days[index] = event.target.value;
                  set("dueDays", days);
                }}
              />
            </Field>
          ))}
        </div>
      )}
      {annual && (
        <fieldset className="fp-month-field">
          <legend>Payment month{draft.dueMonths.length > 1 ? "s" : ""}</legend>
          <div>
            {MONTHS.map((name, index) => (
              <label key={name}>
                <input
                  type="checkbox"
                  checked={draft.dueMonths.includes(index + 1)}
                  onChange={(event) =>
                    set(
                      "dueMonths",
                      event.target.checked
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
      <Field
        label="Pay from account (optional)"
        hint="Used for scheduled bill payments and account forecasts."
      >
        <FinanceAccountSelect
          accounts={accounts}
          currency={draft.currency}
          value={draft.accountId}
          onChange={(value) => set("accountId", value)}
        />
      </Field>
      {annual && (
        <>
          <Field
            label="Annual savings account (optional)"
            hint="Where this bill’s saved funds and payday reserves are allocated. Choosing an account does not move money."
          >
            <FinanceAccountSelect
              accounts={accounts.filter(
                (account) => !["credit", "loan"].includes(account.type),
              )}
              currency={draft.currency}
              value={draft.reserveAccountId}
              onChange={(value) => set("reserveAccountId", value)}
            />
          </Field>
          <Field
            label="Fund reserve from (optional)"
            hint="Defaults to your salary receiving account. Currency conversion needs a separate planned conversion."
          >
            <FinanceAccountSelect
              accounts={accounts}
              currency={draft.currency}
              value={draft.sourceAccountId}
              emptyLabel="Salary receiving account"
              onChange={(value) => set("sourceAccountId", value)}
            />
          </Field>
        </>
      )}
      <Field label="Payment method (optional)">
        <input
          maxLength={80}
          placeholder="e.g. US Bank Credit, RCBC, cash"
          value={draft.paymentMethod}
          onChange={(event) => set("paymentMethod", event.target.value)}
        />
      </Field>
      <label className="fp-checkbox">
        <input
          type="checkbox"
          checked={draft.isAutopay}
          onChange={(event) => set("isAutopay", event.target.checked)}
        />
        Automatic payment is enabled
      </label>
      {!payday && (annual ? !draft.dueDay : !hasMonthlyDate) && (
        <p className="fp-inline-note">
          Add a due day to include this bill automatically in dated budget
          plans.
        </p>
      )}
      {error && (
        <p className="fb-error" role="alert">
          {error}
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

export function BillsTable({
  bills,
  accounts = [],
  cadence,
  summary,
  rate,
  salary,
  onAdd,
  onEdit,
  onDelete,
  asOf = localDate(),
}) {
  const annual = cadence === "annual";
  const payday = cadence === "payday";
  const hasPaydayBills =
    summary.paydayBillsUsd > 0 || summary.paydayBillsPhp > 0;
  const paydayTotalUsd = roundMoney(
    (summary.paydayBillsUsd || 0) +
      convert(summary.paydayBillsPhp || 0, "PHP", "USD", rate),
  );
  const paydayTotalPhp = roundMoney(
    (summary.paydayBillsPhp || 0) +
      convert(summary.paydayBillsUsd || 0, "USD", "PHP", rate),
  );
  const paydayMonthlyUsd = roundMoney(
    (summary.paydayMonthlyUsd || 0) +
      convert(summary.paydayMonthlyPhp || 0, "PHP", "USD", rate),
  );
  const paydayMonthlyPhp = roundMoney(
    (summary.paydayMonthlyPhp || 0) +
      convert(summary.paydayMonthlyUsd || 0, "USD", "PHP", rate),
  );
  if (
    !bills.length &&
    !(cadence === "monthly" && (summary.annualUsd > 0 || hasPaydayBills))
  )
    return (
      <div className="fp-empty">
        <span className="fp-empty-icon">
          <Icon name="receipt" size={27} />
        </span>
        <h3>Your {cadence} bills go here</h3>
        <p>
          Enter the amount in the currency you actually pay. We’ll handle the
          conversion.
        </p>
        <Button icon="plus" variant="primary" onClick={onAdd}>
          Add your first bill
        </Button>
      </div>
    );
  const targets = annual
    ? bills.map((bill) => annualSavingsTarget(bill, asOf))
    : [];
  const payPeriods = salary?.payFrequency === "biweekly" ? 26 : 24;
  const funding = annual
    ? bills.map((bill) =>
        getAnnualBillFunding(bill, payPeriods, { salary, asOf }),
      )
    : [];
  const nativeTargets = targets.reduce(
    (total, target) => {
      if (!target.needsDate)
        total[target.currency === "PHP" ? "PHP" : "USD"] += Number(
          target.target || 0,
        );
      return total;
    },
    { USD: 0, PHP: 0 },
  );
  const totalTargetUsd = roundMoney(
    nativeTargets.USD + convert(nativeTargets.PHP, "PHP", "USD", rate),
  );
  const totalTargetPhp = roundMoney(
    nativeTargets.PHP + convert(nativeTargets.USD, "USD", "PHP", rate),
  );
  const missingTargets = targets.filter((target) => target.needsDate).length;
  const nativeBalances = annual
    ? bills.reduce(
        (total, bill, index) => {
          const currency = bill.currency === "PHP" ? "PHP" : "USD";
          total.saved[currency] += funding[index].savedAmount;
          total.remaining[currency] += funding[index].remainingAmount;
          if (!targets[index].needsDate)
            total.targetGap[currency] += Math.max(
              0,
              targets[index].target - funding[index].savedAmount,
            );
          return total;
        },
        {
          saved: { USD: 0, PHP: 0 },
          remaining: { USD: 0, PHP: 0 },
          targetGap: { USD: 0, PHP: 0 },
        },
      )
    : null;
  const balanceTotal = (kind, currency) =>
    roundMoney(
      nativeBalances[kind][currency] +
        convert(
          nativeBalances[kind][currency === "USD" ? "PHP" : "USD"],
          currency === "USD" ? "PHP" : "USD",
          currency,
          rate,
        ),
    );
  return (
    <div className="fb-bills">
      <div className="fp-table-wrap">
        <table
          className={`fp-table fp-bills-table fb-bills-table${annual ? " fb-annual-table" : ""}`}
        >
          <caption className="fp-sr-only">
            {annual
              ? `Annual bills, saved balances, remaining funding, and suggested savings targets as of ${formatDate(asOf, { year: "numeric" })}`
              : payday
                ? "Bills due every payday, with amounts per payment and dates from your salary schedule"
                : "Monthly bill totals, payment dates, and annual bills reserve"}
          </caption>
          <thead>
            <tr>
              <th>Item</th>
              <th>
                Amount · USD
                {payday && <small>Per payday</small>}
              </th>
              <th>
                Amount · PHP
                {payday && <small>Per payday</small>}
              </th>
              {annual && (
                <>
                  <th>
                    Save / payday
                    <small>Until the next payment</small>
                  </th>
                  <th>
                    Saved so far
                    <small>Currently earmarked</small>
                  </th>
                  <th>
                    Still to fund
                    <small>Annual cost less savings</small>
                  </th>
                  <th>
                    Target saved by now
                    <small>As of {formatDate(asOf, { year: "numeric" })}</small>
                  </th>
                </>
              )}
              <th>Due date</th>
              <th>Auto payment</th>
              <th>
                <span className="fp-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {bills.map((bill, index) => {
              const days = monthlyDays(bill);
              const target = targets[index];
              const billFunding = funding[index];
              const saved = annual ? billFunding.savedAmount : 0;
              const remaining = annual ? billFunding.remainingAmount : 0;
              const targetGap =
                target && !target.needsDate
                  ? roundMoney(Math.max(0, target.target - saved))
                  : null;
              const targetBasis =
                target && !target.needsDate
                  ? `Target from ${formatDate(target.cycleStart, { year: "numeric" })} to ${formatDate(target.nextDueDate, { year: "numeric" })}; next payment ${money(target.installmentAmount, bill.currency)}.`
                  : undefined;
              return (
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
                          {payday ? " · Per payday" : ""}
                          {annual && bill.dueMonths.length > 1
                            ? ` · ${bill.dueMonths.length} installments`
                            : ""}
                        </small>
                        {!annual && !payday && days.length === 2 && (
                          <small className="fb-split-detail">
                            2 payments / month ·{" "}
                            {splitLabel(bill.amount, bill.currency, 2)}
                          </small>
                        )}
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
                  {annual && (
                    <>
                      <td data-label="Save / payday" className="fb-funding">
                        <strong>
                          {money(
                            convert(
                              billFunding.perPeriodAmount,
                              bill.currency,
                              "USD",
                              rate,
                            ),
                          )}
                        </strong>
                        <small>
                          {money(
                            convert(
                              billFunding.perPeriodAmount,
                              bill.currency,
                              "PHP",
                              rate,
                            ),
                            "PHP",
                          )}
                        </small>
                        <small>
                          Monthly equivalent:{" "}
                          {money(
                            convert(
                              billFunding.monthlyAmount,
                              bill.currency,
                              "USD",
                              rate,
                            ),
                          )}{" "}
                          ·{" "}
                          {money(
                            convert(
                              billFunding.monthlyAmount,
                              bill.currency,
                              "PHP",
                              rate,
                            ),
                            "PHP",
                          )}
                        </small>
                        <FundingDetails
                          funding={billFunding}
                          currency={bill.currency}
                        />
                      </td>
                      <td
                        data-label="Saved so far"
                        className="fb-balance fb-saved"
                      >
                        <strong
                          className={
                            bill.currency === "USD"
                              ? "fp-native fp-currency-usd"
                              : "fp-equivalent"
                          }
                        >
                          {money(convert(saved, bill.currency, "USD", rate))}
                        </strong>
                        <small
                          className={
                            bill.currency === "PHP"
                              ? "fp-native fp-currency-php"
                              : "fp-equivalent"
                          }
                        >
                          {money(
                            convert(saved, bill.currency, "PHP", rate),
                            "PHP",
                          )}
                        </small>
                      </td>
                      <td
                        data-label="Still to fund"
                        className="fb-balance fb-remaining"
                      >
                        <strong>
                          {money(
                            convert(remaining, bill.currency, "USD", rate),
                          )}
                        </strong>
                        <small>
                          {money(
                            convert(remaining, bill.currency, "PHP", rate),
                            "PHP",
                          )}
                        </small>
                      </td>
                      <td
                        data-label="Target saved by now"
                        className="fb-target"
                        title={targetBasis}
                      >
                        {target.needsDate ? (
                          <span className="fp-needs-date">Set due date</span>
                        ) : (
                          <>
                            <strong>
                              {money(
                                convert(
                                  target.target,
                                  bill.currency,
                                  "USD",
                                  rate,
                                ),
                              )}
                            </strong>
                            <small>
                              {money(
                                convert(
                                  target.target,
                                  bill.currency,
                                  "PHP",
                                  rate,
                                ),
                                "PHP",
                              )}
                            </small>
                            <small
                              className={`fb-funding-status ${targetGap > 0 ? "fb-behind-target" : "fb-target-met"}`}
                            >
                              {billFunding.fullyFunded
                                ? "Fully funded"
                                : targetGap > 0
                                  ? `${money(targetGap, bill.currency)} behind target`
                                  : "On track today"}
                            </small>
                            <small>
                              Next:{" "}
                              {formatDate(target.nextDueDate, {
                                year: "numeric",
                              })}
                            </small>
                            <span className="fp-sr-only">{targetBasis}</span>
                          </>
                        )}
                      </td>
                    </>
                  )}
                  <td data-label="Due date">
                    <DueLabel bill={bill} salary={salary} asOf={asOf} />
                  </td>
                  <td data-label="Auto payment">
                    <span>{bill.paymentMethod || "—"}</span>
                    <small>{bill.isAutopay ? "Automatic" : "Manual"}</small>
                    {bill.accountId && (
                      <small>
                        Pay from:{" "}
                        {financeAccountLabel(
                          accounts.find(
                            (account) =>
                              String(account.id) === String(bill.accountId),
                          ),
                        )}
                      </small>
                    )}
                    {annual && bill.reserveAccountId && (
                      <small>
                        Reserve:{" "}
                        {financeAccountLabel(
                          accounts.find(
                            (account) =>
                              String(account.id) ===
                              String(bill.reserveAccountId),
                          ),
                        )}
                      </small>
                    )}
                    {annual && bill.sourceAccountId && (
                      <small>
                        Reserve funding:{" "}
                        {financeAccountLabel(
                          accounts.find(
                            (account) =>
                              String(account.id) ===
                              String(bill.sourceAccountId),
                          ),
                        )}
                      </small>
                    )}
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
              );
            })}
            {!annual && !payday && hasPaydayBills && (
              <tr className="fp-reserve-row fb-payday-average-row">
                <td data-label="Item">
                  <strong>Payday bills · monthly average</strong>
                  <small>Annual cost divided by 12</small>
                </td>
                <td data-label="USD">
                  <strong>{money(paydayMonthlyUsd)}</strong>
                </td>
                <td data-label="PHP">
                  <strong>{money(paydayMonthlyPhp, "PHP")}</strong>
                </td>
                <td data-label="Due date">Every payday</td>
                <td data-label="Auto payment">See payday bills</td>
                <td />
              </tr>
            )}
            {!annual && !payday && (
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
                {annual
                  ? "Annual total"
                  : payday
                    ? "Total per payday"
                    : "Total monthly bills"}
              </td>
              <td>
                {money(
                  annual
                    ? summary.annualUsd
                    : payday
                      ? paydayTotalUsd
                      : summary.monthlyCommitmentsUsd,
                )}
              </td>
              <td>
                {money(
                  annual
                    ? summary.annualPhp
                    : payday
                      ? paydayTotalPhp
                      : summary.monthlyCommitmentsPhp,
                  "PHP",
                )}
              </td>
              {annual && (
                <>
                  <td>
                    {money(summary.annualPerPeriodUsd)}
                    <small>
                      {money(summary.annualPerPeriodPhp, "PHP")} / payday
                    </small>
                    <small>
                      Monthly equivalent: {money(summary.annualMonthlyUsd)} ·{" "}
                      {money(summary.annualMonthlyPhp, "PHP")}
                    </small>
                    {(summary.annualImmediateUsd > 0 ||
                      summary.annualImmediatePhp > 0) && (
                      <small className="fb-funding-urgent">
                        Needed before next payday:{" "}
                        {money(summary.annualImmediateUsd)} ·{" "}
                        {money(summary.annualImmediatePhp, "PHP")}
                      </small>
                    )}
                  </td>
                  <td className="fb-balance fb-saved">
                    <strong>{money(balanceTotal("saved", "USD"))}</strong>
                    <small>{money(balanceTotal("saved", "PHP"), "PHP")}</small>
                  </td>
                  <td className="fb-balance fb-remaining">
                    <strong>{money(balanceTotal("remaining", "USD"))}</strong>
                    <small>
                      {money(balanceTotal("remaining", "PHP"), "PHP")}
                    </small>
                  </td>
                  <td className="fb-target">
                    <strong>{money(totalTargetUsd)}</strong>
                    <small>{money(totalTargetPhp, "PHP")}</small>
                    {nativeBalances.targetGap.USD > 0 ||
                    nativeBalances.targetGap.PHP > 0 ? (
                      <small className="fb-funding-status fb-behind-target">
                        {money(balanceTotal("targetGap", "USD"))} ·{" "}
                        {money(balanceTotal("targetGap", "PHP"), "PHP")} behind
                        target
                      </small>
                    ) : missingTargets === 0 ? (
                      <small className="fb-funding-status fb-target-met">
                        All on track today
                      </small>
                    ) : null}
                    {missingTargets > 0 && (
                      <small>
                        {missingTargets} bill{missingTargets > 1 ? "s" : ""}{" "}
                        need{missingTargets === 1 ? "s" : ""} a due date
                      </small>
                    )}
                  </td>
                </>
              )}
              <td colSpan="3" />
            </tr>
          </tfoot>
        </table>
      </div>
      {payday && (
        <div className="fb-target-note">
          <p>
            Each amount is paid in full every payday, using your salary’s first
            payday and pay frequency. Monthly totals show the yearly cost
            averaged over 12 months; dated budget plans use the actual paydays.
          </p>
        </div>
      )}
      {annual && (
        <div className="fb-target-note">
          <p>
            Saved so far is the balance you enter for each bill. These funds are
            earmarked for that bill in budget plans; projections do not change
            your saved balance. Still to fund is the annual cost less that
            bill’s savings, with any extra savings kept for future payments.
            Save / payday divides the next payment’s shortfall across the salary
            paydays remaining through its due date, including a payday on the
            due date. Split bills use the next installment. Monthly equivalents
            use that contribution and your pay frequency. Funding pauses when
            the next payment is covered and resumes after payment. Estimates
            need a due date and salary schedule.
          </p>
          <p>
            Target builds up between payment dates; this is a suggested savings
            amount, not a bank balance. Your saved balance determines whether
            you are on track today. Future payday contributions still build
            savings for the upcoming payment. Targets use the next installment
            due and today’s reference exchange rate.{" "}
            {missingTargets > 0 &&
              "Bills without a due date are excluded from the target total."}
          </p>
        </div>
      )}
    </div>
  );
}
