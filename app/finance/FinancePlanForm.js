"use client";

import { useState } from "react";
import FinanceNumberInput from "./FinanceNumberInput";
import FinanceAccountSelect, {
  financeAccountLabel,
} from "./FinanceAccountSelect";
import {
  addDays,
  getAnnualReserveOpening,
  getPlanOpening,
  localDate,
  money,
} from "../lib/financePlanner.mjs";

function Field({ label, children, hint }) {
  return (
    <label className="fp-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
const key = () => globalThis.crypto.randomUUID();

export default function FinancePlanForm({
  plan,
  document,
  accounts = [],
  onSave,
  busy,
  disabled,
  refreshingAccounts,
  accountRefreshError,
  onRefreshAccounts,
}) {
  const today = localDate();
  const [draft, setDraft] = useState(() => ({
    name: "",
    startDate: today,
    endDate: addDays(today, 30),
    openingUsd: "0",
    openingPhp: "0",
    openingReserveUsd: "0",
    openingReservePhp: "0",
    includeIncome: true,
    includeTransactions: true,
    includeAllocations: true,
    includeAnnualReserve: true,
    entries: [],
    completedRows: [],
    rowOverrides: [],
    ...plan,
    startingAccounts: (plan?.startingAccounts || []).map((row) => ({
      ...row,
      _key: key(),
    })),
  }));
  const set = (field, value) =>
    setDraft((current) => ({ ...current, [field]: value }));
  const updateAccount = (rowKey, changes) =>
    setDraft((current) => ({
      ...current,
      startingAccounts: current.startingAccounts.map((row) =>
        row._key === rowKey ? { ...row, ...changes } : row,
      ),
    }));
  const opening = getPlanOpening(draft, accounts, document);
  const reserve = getAnnualReserveOpening(draft, document);
  const assetAccounts = accounts.filter(
    (account) =>
      !account.isArchived &&
      !account.is_archived &&
      !["credit", "loan"].includes(account.type) &&
      ["USD", "PHP"].includes(account.currency),
  );
  return (
    <form
      className="fp-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || disabled) return;
        onSave({
          ...draft,
          id: draft.id || key(),
          openingUsd: Number(draft.openingUsd),
          openingPhp: Number(draft.openingPhp),
          openingReserveUsd: Number(draft.openingReserveUsd),
          openingReservePhp: Number(draft.openingReservePhp),
          startingAccounts: draft.startingAccounts.map((row) => ({
            accountId: Number(row.accountId),
            percentage: Number(row.percentage),
          })),
          accountOpeningBalances: [],
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
          onChange={(event) => set("name", event.target.value)}
        />
      </Field>
      <div className="fp-form-grid">
        <Field label="From">
          <input
            type="date"
            required
            value={draft.startDate}
            onChange={(event) => set("startDate", event.target.value)}
          />
        </Field>
        <Field label="Through">
          <input
            type="date"
            required
            min={draft.startDate}
            max={addDays(draft.startDate, 730)}
            value={draft.endDate}
            onChange={(event) => set("endDate", event.target.value)}
          />
        </Field>
      </div>
      <section
        className="fp-plan-live-start"
        aria-label="Live starting balance accounts"
      >
        <div className="fp-plan-live-heading">
          <div>
            <h3>Live bank balances</h3>
            <p>
              Include a percentage of each account’s current actual balance,
              plus the flat amounts below.
            </p>
          </div>
          {onRefreshAccounts && (
            <button
              type="button"
              className="fp-button fp-text"
              disabled={refreshingAccounts || busy}
              onClick={onRefreshAccounts}
            >
              {refreshingAccounts ? "Refreshing…" : "Refresh bank balances"}
            </button>
          )}
        </div>
        {accountRefreshError && (
          <p className="fp-alert fp-alert-warning" role="status">
            {accountRefreshError} Showing the last available balances.
          </p>
        )}
        {draft.startingAccounts.map((row) => {
          const contribution = opening.contributions.find(
            (item) => item.accountId === Number(row.accountId),
          );
          return (
            <div className="fp-plan-live-account" key={row._key}>
              <Field label="Include account">
                <FinanceAccountSelect
                  accounts={assetAccounts.filter(
                    (account) =>
                      Number(account.id) === Number(row.accountId) ||
                      !draft.startingAccounts.some(
                        (other) =>
                          Number(other.accountId) === Number(account.id),
                      ),
                  )}
                  value={row.accountId}
                  allowNone={false}
                  required
                  onChange={(accountId) =>
                    updateAccount(row._key, { accountId })
                  }
                />
              </Field>
              <Field label="Percentage">
                <div className="fp-percent-input">
                  <FinanceNumberInput
                    required
                    min="0"
                    max="100"
                    step="0.01"
                    value={row.percentage}
                    onChange={(event) =>
                      updateAccount(row._key, {
                        percentage: event.target.value,
                      })
                    }
                  />
                  <span>%</span>
                </div>
              </Field>
              <button
                type="button"
                className="fp-button fp-text"
                disabled={busy}
                aria-label={`Remove starting account ${row.accountId ? financeAccountLabel(accounts.find((account) => Number(account.id) === Number(row.accountId))) : "selection"}`}
                onClick={() =>
                  set(
                    "startingAccounts",
                    draft.startingAccounts.filter(
                      (item) => item._key !== row._key,
                    ),
                  )
                }
              >
                Remove
              </button>
              {contribution && (
                <p className="fp-inline-note fp-live-account-preview">
                  {money(contribution.balance, contribution.currency)} current
                  balance × {contribution.percentage}% ={" "}
                  <strong>
                    {money(contribution.amount, contribution.currency)}
                  </strong>
                </p>
              )}
            </div>
          );
        })}
        <button
          type="button"
          className="fp-button fp-text"
          disabled={
            busy || draft.startingAccounts.length >= assetAccounts.length
          }
          onClick={() =>
            set("startingAccounts", [
              ...draft.startingAccounts,
              { _key: key(), accountId: null, percentage: "100" },
            ])
          }
        >
          + Include bank account
        </button>
        {!assetAccounts.length && (
          <p className="fp-inline-note">
            Connect a bank or add a manual account under Bank accounts to
            include its balance.
          </p>
        )}
      </section>
      <div className="fp-form-grid">
        <Field
          label="Flat starting amount · USD"
          hint="Extra funds added to the selected live bank balances."
        >
          <FinanceNumberInput
            required
            min="-999999999"
            max="999999999"
            step="0.01"
            value={draft.openingUsd}
            onChange={(event) => set("openingUsd", event.target.value)}
          />
        </Field>
        <Field label="Flat starting amount · PHP">
          <FinanceNumberInput
            required
            min="-999999999"
            max="999999999"
            step="0.01"
            value={draft.openingPhp}
            onChange={(event) => set("openingPhp", event.target.value)}
          />
        </Field>
      </div>
      <div className="fp-bill-savings-summary" aria-live="polite">
        <strong>Starting balance preview</strong>
        <span>
          Flat amounts: {money(opening.flatUsd)} ·{" "}
          {money(opening.flatPhp, "PHP")}
        </span>
        <span>
          Selected live balances: {money(opening.accountUsd)} ·{" "}
          {money(opening.accountPhp, "PHP")}
        </span>
        {(opening.reserveExcludedUsd > 0 || opening.reserveExcludedPhp > 0) && (
          <small>
            Already reserved for annual bills: −
            {money(opening.reserveExcludedUsd)} · −
            {money(opening.reserveExcludedPhp, "PHP")}. These funds appear once
            in the annual reserve.
          </small>
        )}
        <span>
          Available starting balance:{" "}
          <b>
            {money(opening.usd)} · {money(opening.php, "PHP")}
          </b>
        </span>
        <small>
          Account amounts are recalculated from the latest actual balances
          whenever the plan loads or bank data refreshes.
        </small>
        {opening.warnings.map((warning, index) => (
          <small key={index} className="fp-negative" role="status">
            {warning}
          </small>
        ))}
      </div>
      <div className="fp-form-grid">
        <Field label="Total starting annual reserve · USD (optional)">
          <FinanceNumberInput
            required
            min="0"
            max="999999999"
            step="0.01"
            value={draft.openingReserveUsd}
            onChange={(event) => set("openingReserveUsd", event.target.value)}
          />
        </Field>
        <Field label="Total starting annual reserve · PHP (optional)">
          <FinanceNumberInput
            required
            min="0"
            max="999999999"
            step="0.01"
            value={draft.openingReservePhp}
            onChange={(event) => set("openingReservePhp", event.target.value)}
          />
        </Field>
      </div>
      <p className="fp-inline-note">
        Saved annual bill funds are included once: {money(reserve.usd)} ·{" "}
        {money(reserve.php, "PHP")}. Enter a larger total above only for
        additional unassigned reserves. Suggested savings targets are not bank
        balances.
      </p>
      {[
        ["includeIncome", "Include scheduled salary payments"],
        [
          "includeTransactions",
          "Include recorded and scheduled one-time transactions",
        ],
        [
          "includeAllocations",
          "Include savings and expense allocations each payday",
        ],
        [
          "includeAnnualReserve",
          "Set aside money for annual bills each payday",
        ],
      ].map(([field, label]) => (
        <label className="fp-checkbox" key={field}>
          <input
            type="checkbox"
            checked={draft[field]}
            onChange={(event) => set(field, event.target.checked)}
          />
          {label}
        </label>
      ))}
      <p className="fp-inline-note">
        Bills and payday allocations fill in automatically. Matching posted
        transactions mark rows done. You can also mark rows done manually; this
        records progress without creating a payment or moving bank funds.
      </p>
      <button
        type="submit"
        className="fp-button fp-primary"
        disabled={busy || disabled}
      >
        {busy ? "Saving…" : plan ? "Save plan" : "Create plan"}
      </button>
    </form>
  );
}
