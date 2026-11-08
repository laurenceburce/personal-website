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
const columnLinks = [
  ["availableUsdAccountId", "Available · USD", "USD"],
  ["availablePhpAccountId", "Available · PHP", "PHP"],
  ["annualReserveUsdAccountId", "Annual reserve · USD", "USD"],
  ["annualReservePhpAccountId", "Annual reserve · PHP", "PHP"],
  ["savingsUsdAccountId", "Savings · USD", "USD"],
  ["savingsPhpAccountId", "Savings · PHP", "PHP"],
];
function suggestedLinks(document, accounts, plan) {
  const unique = (ids) => {
    const selected = [...new Set(ids.filter((id) => id != null).map(Number))];
    return selected.length === 1 ? selected[0] : null;
  };
  const used = new Set();
  return Object.fromEntries(columnLinks.map(([field, , currency]) => {
    let accountId = field.startsWith("available")
      ? document.salary?.currency === currency ? document.salary.accountId
        : unique((plan.startingAccounts || []).filter((row) => Number(row.percentage) > 0 && accounts.some((account) => Number(account.id) === Number(row.accountId) && account.currency === currency)).map((row) => row.accountId))
      : field.startsWith("annualReserve")
        ? unique((document.bills || []).filter((bill) => bill.cadence === "annual" && bill.currency === currency).map((bill) => bill.reserveAccountId))
        : unique((document.allocations || []).filter((allocation) => allocation.kind === "savings" && allocation.currency === currency).map((allocation) => allocation.accountId));
    const account = accounts.find((item) => Number(item.id) === Number(accountId));
    if (!account || account.currency !== currency || account.isArchived || account.is_archived ||
        ["credit", "loan"].includes(account.type) || used.has(Number(accountId))) accountId = null;
    if (accountId != null) used.add(Number(accountId));
    return [field, accountId == null ? null : Number(accountId)];
  }));
}

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
    accountOpeningBalances: [],
    ...plan,
    startingAccounts: (plan?.startingAccounts || []).map((row) => ({
      ...row,
      _key: key(),
    })),
  }));
  const set = (field, value) =>
    setDraft((current) => ({ ...current, [field]: value }));
  const updateAccount = (rowKey, changes) =>
    setDraft((current) => {
      const previous = current.startingAccounts.find((row) => row._key === rowKey);
      return {
        ...current,
        startingAccounts: current.startingAccounts.map((row) =>
          row._key === rowKey ? { ...row, ...changes } : row,
        ),
        accountOpeningBalances: changes.accountId !== undefined && Number(changes.accountId) !== Number(previous?.accountId)
          ? current.accountOpeningBalances.filter((row) => Number(row.accountId) !== Number(previous?.accountId))
          : current.accountOpeningBalances,
      };
    });
  const setOpeningBalance = (accountId, balance) =>
    setDraft((current) => ({
      ...current,
      accountOpeningBalances: [
        ...current.accountOpeningBalances.filter((row) => Number(row.accountId) !== Number(accountId)),
        ...(balance === "" ? [] : [{ accountId: Number(accountId), balance }]),
      ],
    }));
  const startingBalanceField = (accountId, currency, label = "Starting balance") => {
    if (!accountId) return null;
    const saved = draft.accountOpeningBalances.find((row) => Number(row.accountId) === Number(accountId));
    const captured = plan?.accountOpeningBalances?.some((row) => Number(row.accountId) === Number(accountId));
    return (
      <Field label={label} hint={`Balance before the plan’s first day (${currency}). ${captured ? "Change this amount to correct the plan’s opening funds." : "Leave blank to calculate it from bank records when saved."}`}>
        <FinanceNumberInput
          aria-label={`${label} for account ${accountId}`}
          required={Boolean(captured)}
          min="-999999999"
          max="999999999"
          step="0.01"
          value={saved?.balance ?? ""}
          placeholder="Calculated when saved"
          onChange={(event) => setOpeningBalance(accountId, event.target.value)}
        />
      </Field>
    );
  };
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
        const { accountLinks, ...fields } = draft;
        const linked = Boolean(accountLinks);
        onSave({
          ...fields,
          ...(linked ? { accountLinks } : {}),
          id: draft.id || key(),
          openingUsd: linked ? 0 : Number(draft.openingUsd),
          openingPhp: linked ? 0 : Number(draft.openingPhp),
          openingReserveUsd: Number(draft.openingReserveUsd),
          openingReservePhp: Number(draft.openingReservePhp),
          startingAccounts: linked ? [accountLinks.availableUsdAccountId, accountLinks.availablePhpAccountId]
            .filter((id) => id != null).map((accountId) => ({ accountId: Number(accountId), percentage: 100 }))
            : draft.startingAccounts.map((row) => ({
            accountId: Number(row.accountId),
            percentage: Number(row.percentage),
          })),
          accountOpeningBalances: draft.accountOpeningBalances.map((row) => ({
            accountId: Number(row.accountId),
            balance: Number(row.balance),
          })),
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
      <label className="fp-checkbox">
        <input
          type="checkbox"
          checked={Boolean(draft.accountLinks)}
          onChange={(event) => set("accountLinks", event.target.checked ? suggestedLinks(document, accounts, draft) : undefined)}
        />
        Link balance columns to bank accounts
      </label>
      {draft.accountLinks && (
        <section className="fp-plan-live-start" aria-label="Budget column account links">
          <div className="fp-plan-live-heading">
            <div>
              <h3>Column accounts</h3>
              <p>Each column uses a saved starting balance. Posted bank movements are included once; future entries project changes to that account.</p>
            </div>
            {onRefreshAccounts && (
              <button type="button" className="fp-button fp-text" disabled={refreshingAccounts || busy} onClick={onRefreshAccounts}>
                {refreshingAccounts ? "Refreshing…" : "Refresh bank balances"}
              </button>
            )}
          </div>
          {accountRefreshError && <p className="fp-alert fp-alert-warning" role="status">{accountRefreshError} Showing the last available balances.</p>}
          <div className="fp-form-grid">
            {columnLinks.map(([field, label, currency]) => {
              const accountId = draft.accountLinks[field];
              const selected = accounts.find((account) => Number(account.id) === Number(accountId));
              const value = selected && (Object.hasOwn(selected, "nativeCurrentBalance") ? selected.nativeCurrentBalance : selected.currentBalance);
              const known = value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
              return (
                <div key={field} className="fp-form">
                  <Field label={label} hint={selected ? known ? `Current balance: ${money(Number(value), currency)}` : "Current balance unavailable." : "No account linked to this column."}>
                    <FinanceAccountSelect
                      aria-label={`${label} account`}
                      accounts={assetAccounts.filter((account) => Number(account.id) === Number(accountId) || !Object.values(draft.accountLinks).includes(Number(account.id)))}
                      currency={currency}
                      value={accountId}
                      onChange={(value) => setDraft((current) => ({
                        ...current,
                        accountLinks: { ...current.accountLinks, [field]: value },
                        accountOpeningBalances: Number(value) === Number(accountId) ? current.accountOpeningBalances
                          : current.accountOpeningBalances.filter((row) => Number(row.accountId) !== Number(accountId)),
                      }))}
                      emptyLabel="No linked account"
                    />
                  </Field>
                  {startingBalanceField(accountId, currency, `${label} starting balance`)}
                </div>
              );
            })}
          </div>
          <p className="fp-inline-note">Transfers move money between the linked columns. A matching bank transfer replaces its planned movement. Use a separate account for each column.</p>
        </section>
      )}
      {!draft.accountLinks && <>
      <section
        className="fp-plan-live-start"
        aria-label="Starting balance accounts"
      >
        <div className="fp-plan-live-heading">
          <div>
            <h3>Account starting balances</h3>
            <p>
              Include a percentage of each account’s saved starting balance,
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
          const selected = accounts.find((account) => Number(account.id) === Number(row.accountId));
          const currentValue = selected && (Object.hasOwn(selected, "nativeCurrentBalance") ? selected.nativeCurrentBalance : selected.currentBalance);
          const currentKnown = currentValue !== null && currentValue !== undefined && currentValue !== "" && Number.isFinite(Number(currentValue));
          return (
            <div className="fp-plan-live-account" key={row._key}>
              <Field label="Include account" hint={selected ? currentKnown ? `Current balance: ${money(Number(currentValue), selected.currency)}` : "Current balance unavailable." : undefined}>
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
                onClick={() => setDraft((current) => ({
                  ...current,
                  startingAccounts: current.startingAccounts.filter((item) => item._key !== row._key),
                  accountOpeningBalances: current.accountOpeningBalances.filter((item) => Number(item.accountId) !== Number(row.accountId)),
                }))}
              >
                Remove
              </button>
              {row.accountId && <div className="fp-live-account-preview">
                {startingBalanceField(row.accountId, selected?.currency || contribution?.currency || "USD")}
              </div>}
              {contribution && (
                <p className="fp-inline-note fp-live-account-preview">
                  {money(contribution.balance, contribution.currency)} {contribution.isSnapshot ? "saved starting balance" : "current balance preview"} × {contribution.percentage}% ={" "}
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
          hint="Extra funds added to the selected account starting balances."
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
          Selected account balances: {money(opening.accountUsd)} ·{" "}
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
          Starting balances are saved with the plan. Bank refreshes do not change them.
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
      </>}
      {draft.accountLinks && <p className="fp-inline-note">Starting balances are saved with the plan. Bank refreshes do not change them.</p>}
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
