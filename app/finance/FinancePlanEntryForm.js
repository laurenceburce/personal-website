"use client";

import { useState } from "react";
import FinanceNumberInput from "./FinanceNumberInput";
import FinanceAccountSelect from "./FinanceAccountSelect";
import { convert, formatDate, money, salaryOccurrences } from "../lib/financePlanner.mjs";

function Field({ label, children, hint }) {
  return (
    <label className="fp-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export default function FinancePlanEntryForm({
  entry,
  plan,
  accounts = [],
  salary = {},
  onSave,
  busy,
  disabled,
  rate,
}) {
  const [draft, setDraft] = useState(() => ({
    date: plan.startDate,
    description: "",
    kind: "expense",
    amount: "",
    currency: "USD",
    ...entry,
    recurrence: entry?.recurrence || "once",
    repeatUntil: entry?.repeatUntil || "",
  }));
  const set = (key, value) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const recurring = draft.recurrence !== "once";
  const stopDate = recurring && draft.repeatUntil ? draft.repeatUntil : plan.endDate;
  const salaryReady = ["biweekly", "semimonthly"].includes(salary.payFrequency) &&
    formatDate(salary.firstPayDate) !== "—";
  const missingPaydaySchedule = draft.recurrence === "payday" && !salaryReady;
  const dateError = formatDate(draft.date) === "—" || draft.date < plan.startDate || draft.date > plan.endDate
    ? "Choose a start date within this plan."
    : recurring && (formatDate(stopDate) === "—" || stopDate < draft.date || stopDate > plan.endDate)
      ? "Repeat until must be on or after the start date and within this plan."
      : "";
  const paydays = draft.recurrence === "payday" && salaryReady && !dateError
    ? salaryOccurrences(salary, draft.date, stopDate) : [];
  return (
    <form
      className="fp-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || disabled || missingPaydaySchedule || dateError) return;
        onSave({
          ...draft,
          id: draft.id || globalThis.crypto.randomUUID(),
          description: draft.description.trim(),
          amount: Number(draft.amount),
          recurrence: draft.recurrence,
          repeatUntil: recurring ? draft.repeatUntil || null : null,
        });
      }}
    >
      <div className="fp-form-grid">
        <Field label={recurring ? "Starts on" : "Date"}>
          <input
            required
            type="date"
            min={plan.startDate}
            max={plan.endDate}
            value={draft.date}
            onChange={(event) => set("date", event.target.value)}
          />
        </Field>
        <Field label="Entry type">
          <select value={draft.kind} onChange={(event) => set("kind", event.target.value)}>
            <option value="expense">Expense / savings</option>
            <option value="income">Income</option>
            <option value="transfer">Transfer between accounts</option>
            <option value="conversion">Currency conversion</option>
          </select>
        </Field>
      </div>
      <Field label="Description">
        <input
          autoFocus
          required
          maxLength={120}
          placeholder="e.g. Lunch, monthly savings, convert to PHP"
          value={draft.description}
          onChange={(event) => set("description", event.target.value)}
        />
      </Field>
      <div className="fp-form-grid">
        <Field label="Repeat">
          <select value={draft.recurrence} onChange={(event) => set("recurrence", event.target.value)}>
            <option value="once">Does not repeat</option>
            <option value="daily">Daily</option>
            <option value="monthly">Monthly</option>
            <option value="payday">Every payday</option>
          </select>
        </Field>
        {recurring && (
          <Field label="Repeat until" hint={`Leave blank to repeat through ${formatDate(plan.endDate, { year: "numeric" })}.`}>
            <input
              type="date"
              min={draft.date || plan.startDate}
              max={plan.endDate}
              value={draft.repeatUntil}
              onChange={(event) => set("repeatUntil", event.target.value)}
            />
          </Field>
        )}
      </div>
      {recurring && (
        <p className="fp-inline-note">
          {draft.recurrence === "daily"
            ? "Adds this amount on each calendar day from the start date through the end date."
            : draft.recurrence === "monthly"
              ? "Repeats on the start date’s day each month. Shorter months use their last day."
              : "Dates follow your salary payday schedule, even when scheduled income is hidden in this plan."}
          {" "}Each occurrence appears as its own budget row.
        </p>
      )}
      {missingPaydaySchedule && (
        <p className="fp-alert fp-alert-warning" role="status">
          Set a valid payday frequency and first payday in Salary &amp; settings before adding an every-payday entry.
        </p>
      )}
      {draft.recurrence === "payday" && salaryReady && !dateError && (
        <p className="fp-inline-note">
          {paydays.length
            ? `Next occurrence: ${formatDate(paydays[0].date, { year: "numeric" })}.`
            : "No scheduled payday falls within these dates."}
        </p>
      )}
      {dateError && <p className="fp-alert fp-alert-warning" role="status">{dateError}</p>}
      <div className="fp-form-grid">
        <Field label={draft.kind === "conversion" ? "Amount to convert" : recurring ? "Amount per occurrence" : "Amount"}>
          <FinanceNumberInput
            required
            min="0.01"
            max="999999999"
            step="0.01"
            value={draft.amount}
            onChange={(event) => set("amount", event.target.value)}
          />
        </Field>
        <Field label={draft.kind === "conversion" ? "Convert from" : "Currency"}>
          <select
            value={draft.currency}
            onChange={(event) => setDraft((current) => ({
              ...current,
              currency: event.target.value,
              accountId: null,
              fromAccountId: null,
              toAccountId: null,
            }))}
          >
            <option value="USD">USD · US dollar</option>
            <option value="PHP">PHP · Philippine peso</option>
          </select>
        </Field>
      </div>
      {draft.kind === "transfer" || draft.kind === "conversion" ? (
        <div className="fp-form-grid">
          <Field label="From account">
            <FinanceAccountSelect
              accounts={accounts}
              currency={draft.currency}
              value={draft.fromAccountId}
              onChange={(value) => set("fromAccountId", value)}
              allowNone={draft.kind !== "transfer"}
              required={draft.kind === "transfer"}
            />
          </Field>
          <Field label="To account">
            <FinanceAccountSelect
              accounts={accounts.filter((account) => Number(account.id) !== Number(draft.fromAccountId))}
              currency={draft.kind === "conversion" ? draft.currency === "USD" ? "PHP" : "USD" : draft.currency}
              value={draft.toAccountId}
              onChange={(value) => set("toAccountId", value)}
              allowNone={draft.kind !== "transfer"}
              required={draft.kind === "transfer"}
            />
          </Field>
        </div>
      ) : (
        <Field label={draft.kind === "income" ? "Receive into account" : "Pay from account"}>
          <FinanceAccountSelect
            accounts={accounts}
            currency={draft.currency}
            value={draft.accountId}
            onChange={(value) => set("accountId", value)}
          />
        </Field>
      )}
      {draft.kind === "transfer" && (
        <p className="fp-inline-note">
          This planned transfer moves money between accounts and leaves your total funds unchanged.
          Moving linked savings into a spending account increases available funds; moving money into savings sets it aside.
          No bank transfer is initiated.
        </p>
      )}
      {draft.kind === "conversion" && (
        <p className="fp-conversion-note">
          Receive {money(convert(draft.amount, draft.currency, draft.currency === "USD" ? "PHP" : "USD", rate), draft.currency === "USD" ? "PHP" : "USD")}
          {" "}at the current reference rate. Fees aren’t included.
        </p>
      )}
      {entry && recurring && (
        <p className="fp-inline-note">
          Saving updates the recurring default. Individually edited occurrences keep their changes.
          Use the row’s occurrence editor to change just one date.
        </p>
      )}
      <button
        type="submit"
        className="fp-button fp-primary"
        disabled={Boolean(busy || disabled || missingPaydaySchedule || dateError)}
      >
        {busy ? "Saving…" : recurring ? entry ? "Save recurring entry" : "Add recurring entry" : entry ? "Save entry" : "Add entry"}
      </button>
    </form>
  );
}
