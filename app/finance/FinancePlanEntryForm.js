"use client";

import { useState } from "react";
import FinanceNumberInput from "./FinanceNumberInput";
import FinanceAccountSelect from "./FinanceAccountSelect";
import { convert, formatDate, localDate, money, salaryOccurrences } from "../lib/financePlanner.mjs";

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
  completed = false,
  today = localDate(),
}) {
  const [draft, setDraft] = useState(() => ({
    date: today < plan.startDate ? plan.startDate : today > plan.endDate ? plan.endDate : today,
    description: "",
    kind: "expense",
    amount: "",
    currency: "USD",
    ...entry,
    kind: entry?.kind === "transfer" && accounts.some((account) => Number(account.id) === Number(entry.toAccountId) && account.type === "credit")
      ? "cardPayment" : entry?.kind || "expense",
    recordNow: entry ? completed : false,
    recurrence: entry?.recurrence || "once",
    repeatUntil: entry?.repeatUntil || "",
  }));
  const set = (key, value) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const recurring = draft.recurrence !== "once";
  const cardPayment = draft.kind === "cardPayment";
  const transfer = draft.kind === "transfer" || cardPayment;
  const recording = !recurring && draft.recordNow;
  const liveCardBalance = cardPayment && !recording && draft.amountMode === "cardBalance";
  const card = accounts.find((account) => Number(account.id) === Number(draft.toAccountId));
  const currentDebt = card?.nativeCurrentBalance;
  const knownDebt = currentDebt !== null && currentDebt !== undefined && Number.isFinite(Number(currentDebt));
  const paymentAmount = liveCardBalance ? knownDebt ? Math.max(0, Number(currentDebt)) : "" : draft.amount;
  const [error, setError] = useState("");
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
        if (recording && draft.date > today) return setError("Record a transaction on today’s date or an earlier date. Future payments stay planned.");
        if (recording && ((transfer || draft.kind === "conversion")
          ? !draft.fromAccountId || !draft.toAccountId : !draft.accountId))
          return setError("Choose the account for this recorded transaction.");
        if (cardPayment && (!card || card.type !== "credit")) return setError("Choose the credit card receiving this payment.");
        if (liveCardBalance && !knownDebt) return setError("Refresh the card balance or enter a fixed payment amount.");
        const { recordNow, ...fields } = draft;
        setError("");
        onSave({
          ...fields,
          id: draft.id || globalThis.crypto.randomUUID(),
          kind: cardPayment ? "transfer" : draft.kind,
          description: draft.description.trim(),
          amount: Number(paymentAmount),
          ...(cardPayment || draft.amountMode ? { amountMode: liveCardBalance ? "cardBalance" : "fixed" } : {}),
          ...(!recurring ? { recordNow: Boolean(recordNow) } : {}),
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
          <select value={draft.kind} onChange={(event) => setDraft((current) => ({ ...current, kind: event.target.value,
            amountMode: event.target.value === "cardPayment" && !current.recordNow ? "cardBalance" : "fixed" }))}>
            <option value="expense">Expense / savings</option>
            <option value="income">Income</option>
            <option value="transfer">Transfer between accounts</option>
            <option value="cardPayment">Credit card payment</option>
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
      {!recurring && <Field label="Status" hint="Recorded rows update your accounts. Linked bank transactions replace matching records when they arrive.">
        <select value={recording ? "recorded" : "planned"} onChange={(event) => {
          set("recordNow", event.target.value === "recorded");
          setError("");
        }}>
          <option value="planned">Planned · future payment</option>
          <option value="recorded" disabled={draft.date > today}>Recorded · already happened</option>
        </select>
      </Field>}
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
      {cardPayment && !recording && <Field label="Payment amount">
        <select value={draft.amountMode || "fixed"} onChange={(event) => set("amountMode", event.target.value)}>
          <option value="cardBalance">Live remaining card balance</option>
          <option value="fixed">Fixed amount</option>
        </select>
      </Field>}
      <div className="fp-form-grid">
        <Field label={draft.kind === "conversion" ? "Amount to convert" : recurring ? "Amount per occurrence" : "Amount"}>
          <FinanceNumberInput
            required
            min={liveCardBalance ? "0" : "0.01"}
            max="999999999"
            step="0.01"
            value={paymentAmount}
            readOnly={liveCardBalance}
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
      {transfer || draft.kind === "conversion" ? (
        <div className="fp-form-grid">
          <Field label="From account">
            <FinanceAccountSelect
              accounts={cardPayment ? accounts.filter((account) => !["credit", "loan"].includes(account.type)) : accounts}
              currency={draft.currency}
              value={draft.fromAccountId}
              onChange={(value) => set("fromAccountId", value)}
              allowNone={!transfer && !recording}
              required={transfer || recording}
            />
          </Field>
          <Field label={cardPayment ? "Credit card" : "To account"}>
            <FinanceAccountSelect
              accounts={accounts.filter((account) => Number(account.id) !== Number(draft.fromAccountId) && (!cardPayment || account.type === "credit"))}
              currency={draft.kind === "conversion" ? draft.currency === "USD" ? "PHP" : "USD" : draft.currency}
              value={draft.toAccountId}
              onChange={(value) => set("toAccountId", value)}
              allowNone={!transfer && !recording}
              required={transfer || recording}
            />
          </Field>
        </div>
      ) : (
        <Field label={draft.kind === "income" ? "Receive into account" : "Pay from account"}>
          <FinanceAccountSelect
            accounts={accounts}
            currency={draft.currency}
            value={draft.accountId}
            required={recording}
            allowNone={!recording}
            onChange={(value) => set("accountId", value)}
          />
        </Field>
      )}
      {cardPayment && <p className="fp-inline-note">
        {recording ? "Recording reduces the funding account and the card balance owed."
          : liveCardBalance ? "This payment follows the card’s live remaining balance. Early payments reduce it and new card transactions update it."
            : "This schedules a fixed payment from the funding account to the credit card."}
        {" "}Record the actual amount after paying. No bank payment is sent.
      </p>}
      {draft.kind === "transfer" && (
        <p className="fp-inline-note">
          This planned transfer moves money between accounts and leaves your total funds unchanged.
          Moving linked savings into a spending account increases available funds; moving money into savings sets it aside.
          No bank transfer is initiated.
        </p>
      )}
      {error && <p className="fp-alert fp-alert-error" role="alert">{error}</p>}
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
