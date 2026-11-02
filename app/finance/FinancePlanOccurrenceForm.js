"use client";

import { useState } from "react";
import FinanceNumberInput from "./FinanceNumberInput";
import { formatDate, money } from "../lib/financePlanner.mjs";

function Field({ label, children, hint }) {
  return (
    <label className="fp-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

/** A dated exception belongs to this plan, never to its recurring source. */
export default function FinancePlanOccurrenceForm({
  row,
  plan,
  onSave,
  onReset,
  busy,
  disabled,
}) {
  const [draft, setDraft] = useState(() => ({
    date: row.date,
    description: row.description,
    amount: String(row.overrideRequestedAmount ?? row.grossAmount ?? row.amount ?? 0),
  }));
  const set = (field, value) =>
    setDraft((current) => ({ ...current, [field]: value }));
  return (
    <form
      className="fp-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || disabled) return;
        onSave({
          rowId: row.id,
          date: draft.date,
          description: draft.description.trim(),
          amount: Number(draft.amount),
        });
      }}
    >
      <p className="fp-inline-note">
        Changes apply only to this occurrence in {plan.name}. Your recurring
        salary, bills, and savings settings stay the same.
      </p>
      <Field label="Description">
        <input
          autoFocus
          required
          maxLength={160}
          value={draft.description}
          onChange={(event) => set("description", event.target.value)}
        />
      </Field>
      <div className="fp-form-grid">
        <Field label="Date">
          <input
            type="date"
            required
            min={plan.startDate}
            max={plan.endDate}
            value={draft.date}
            onChange={(event) => set("date", event.target.value)}
          />
        </Field>
        <Field
          label={`Amount · ${row.currency}`}
          hint={
            row.annualPayment
              ? "Full payment amount before using annual reserves."
              : "Enter 0 to skip the amount for this occurrence."
          }
        >
          <FinanceNumberInput
            required
            min="0"
            max="999999999"
            step="0.01"
            value={draft.amount}
            onChange={(event) => set("amount", event.target.value)}
          />
        </Field>
      </div>
      <p className="fp-inline-note">
        Recurring default: {row.originalDescription || row.description} ·{" "}
        {money(row.originalAmount ?? row.grossAmount ?? row.amount, row.currency)}{" "}
        on {formatDate(row.originalDate || row.date, { year: "numeric" })}.
        {row.source === "reserve" &&
          " This total is distributed across the annual bills being funded, up to their remaining funding need."}
      </p>
      <div className="fp-button-row">
        <button
          type="submit"
          className="fp-button fp-primary"
          disabled={busy || disabled}
        >
          {busy ? "Saving…" : "Save this occurrence"}
        </button>
        {row.isOverride && onReset && (
          <button
            type="button"
            className="fp-button fp-secondary"
            disabled={busy || disabled}
            onClick={() => onReset(row)}
          >
            Restore recurring default
          </button>
        )}
      </div>
    </form>
  );
}
