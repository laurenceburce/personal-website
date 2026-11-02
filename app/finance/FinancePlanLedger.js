"use client";

import { formatDate, money } from "../lib/financePlanner.mjs";
import "./finance-plan-ledger.css";

const signed = (value, currency) =>
  `${value > 0 ? "+" : ""}${money(value, currency)}`;
const balanceClass = (value) => (value < 0 ? "fp-negative" : "");

function ActionIcon({ kind }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "edit" ? (
        <path d="m15 5 4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Z" />
      ) : (
        <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />
      )}
    </svg>
  );
}

function FlowAmount({ value, currency, showZero = false }) {
  return (
    <td
      className={
        value < 0 ? "fp-negative" : value > 0 ? "fp-positive" : "fp-zero"
      }
    >
      {value || showZero ? signed(value, currency) : "—"}
    </td>
  );
}

function ReserveBalance({ value = 0, delta = 0, currency }) {
  return (
    <td className={`fpl-reserve-balance ${balanceClass(value)}`}>
      <span>{money(value, currency)}</span>
      {delta !== 0 && (
        <small className="fpl-reserve-change">
          {signed(delta, currency)} {delta > 0 ? "set aside" : "used"}
        </small>
      )}
    </td>
  );
}

function SavingsBalance({ value = 0, currency }) {
  const available = Number.isFinite(value);
  return (
    <td
      className={`fpl-savings-balance ${available ? balanceClass(value) : "fp-zero"}`}
    >
      {available ? (
        money(value, currency)
      ) : (
        <span aria-label={`Savings balance unavailable in ${currency}`}>—</span>
      )}
    </td>
  );
}

function SourceLabel({ row }) {
  const labels = {
    salary: "Scheduled income",
    bill: "Scheduled bill",
    transaction: "Recorded transaction",
    allocation: "Payday allocation",
    reserve: "Annual bills set-aside",
    reserveRelease: "Use annual reserve",
  };
  const label =
    row.source === "manual"
      ? row.kind === "conversion"
        ? "Planned currency conversion"
        : row.kind === "transfer"
          ? "Planned account transfer"
          : "Plan entry"
      : labels[row.source] || "Plan flow";
  const matched = row.scheduledSource || row.matchedForecast?.source;
  const matchedLabel =
    matched === "salary"
      ? "scheduled income"
      : matched === "bill"
        ? "scheduled bill"
        : "plan entry";
  const shortfallCurrency = row.currency || (row.php ? "PHP" : "USD");
  const grossAmount = row.grossAmount ?? row.amount;
  const annualPayment = row.annualPayment && Number.isFinite(grossAmount);
  const reflectedNativeFlows = row.reflectedInRecordedTransactions
    ? []
    : [
        ["USD", row.usd, row.balanceAppliedUsd],
        ["PHP", row.php, row.balanceAppliedPhp],
      ].filter(
        ([, amount, applied]) =>
          Number.isFinite(amount) &&
          Number.isFinite(applied) &&
          amount !== applied,
      );
  const reserveAlreadyIncluded =
    (row.reserveAppliedUsd ?? row.reserveDeltaUsd ?? 0) !==
      (row.reserveDeltaUsd ?? 0) ||
    (row.reserveAppliedPhp ?? row.reserveDeltaPhp ?? 0) !==
      (row.reserveDeltaPhp ?? 0);
  const sameAccountReserve =
    row.source === "reserve" &&
    row.reserveAllocations?.length > 0 &&
    row.reserveAllocations.every(
      (allocation) =>
        allocation.sourceAccountId &&
        allocation.reserveAccountId &&
        Number(allocation.sourceAccountId) ===
          Number(allocation.reserveAccountId),
    );
  return (
    <>
      <small className="fpl-source-label">
        {label}
        {row.source === "transaction" && row.scheduled ? " · future date" : ""}
      </small>
      {row.isOverride && (
        <small className="fpl-override-note">Edited for this plan</small>
      )}
      {row.source === "manual" && row.kind === "transfer" &&
        Boolean(row.usd || row.php) && (
          <small className="fpl-account-label">
            {row.usd > 0 || row.php > 0
              ? "Moved from savings to available funds."
              : "Moved from available funds to savings."}
          </small>
        )}
      {row.source === "transaction" &&
        (row.matchedForecast || row.scheduledSource) && (
          <small className="fpl-match-note">
            Replaces {matchedLabel}
            {row.scheduledDate ? ` · ${formatDate(row.scheduledDate)}` : ""}
          </small>
        )}
      {annualPayment && (
        <small className="fpl-annual-payment-detail">
          Total bill {money(grossAmount, shortfallCurrency)} ·{" "}
          {money(row.reserveUsed ?? 0, shortfallCurrency)} from reserves ·{" "}
          {money(row.reserveShortfall ?? grossAmount, shortfallCurrency)}{" "}
          additional cash
        </small>
      )}
      {!annualPayment && row.reserveShortfall > 0 && (
        <small className="fpl-shortfall">
          Reserve shortfall: {money(row.reserveShortfall, shortfallCurrency)}
        </small>
      )}
      {row.reflectedInStartingBalance && (
        <small className="fpl-reconciliation-note">
          Already included in the live starting balance
          {reflectedNativeFlows
            .map(
              ([currency, amount, applied]) =>
                ` · ${currency} ${signed(amount - applied, currency)}`,
            )
            .join("")}
        </small>
      )}
      {row.reflectedInRecordedTransactions && (
        <small className="fpl-reconciliation-note">
          Cash movement shown in matched recorded transactions
        </small>
      )}
      {reserveAlreadyIncluded && (
        <small className="fpl-reconciliation-note">
          Historical reserve movement is already included in current earmarks.
        </small>
      )}
      {row.accountNames?.length > 0 && (
        <small className="fpl-account-label">
          Accounts: {row.accountNames.join(" · ")}
        </small>
      )}
      {sameAccountReserve && (
        <small className="fpl-account-label">
          Earmarked within the same account; bank balance stays unchanged.
        </small>
      )}
      {row.accountMovements?.length > 0 && (
        <details className="fpl-account-movements">
          <summary>Account movements</summary>
          <ul>
            {row.accountMovements.map((movement, index) => (
              <li key={`${movement.accountId}-${index}`}>
                {movement.accountName || "Assigned account"}:{" "}
                {signed(movement.amount, movement.currency)}
                {Number.isFinite(movement.balanceDelta) &&
                  movement.balanceDelta !== movement.amount && (
                    <>
                      {" "}
                      · balance owed{" "}
                      {signed(movement.balanceDelta, movement.currency)}
                    </>
                  )}
                {movement.label && movement.label !== row.description && (
                  <small>{movement.label}</small>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function CompletionStatus({ row, onToggleComplete, busy }) {
  const completed = Boolean(row.completed);
  const automatic = completed && row.completionSource === "transaction";
  const matched =
    row.source !== "transaction" ||
    Boolean(row.matchedForecast || row.scheduledSource);
  const label = automatic
    ? matched
      ? "Done · matched transaction"
      : "Done · recorded transaction"
    : completed
      ? "Done"
      : "To do";
  const disabled = Boolean(busy || automatic || !onToggleComplete);
  return (
    <label
      className={`fpl-completion${completed ? " fpl-completion-done" : ""}`}
    >
      <input
        type="checkbox"
        checked={completed}
        disabled={disabled}
        aria-label={
          automatic
            ? `${label}: ${row.description}`
            : `${completed ? "Reopen" : "Mark done:"} ${row.description}`
        }
        onChange={() => {
          if (!disabled) onToggleComplete(row);
        }}
      />
      <span>
        {label}
        {completed && !automatic && <small>Marked manually</small>}
      </span>
    </label>
  );
}

function OpeningDetails({ openingBalances }) {
  if (!openingBalances) return null;
  const contributions = openingBalances.contributions || [];
  const warnings = openingBalances.warnings || [];
  if (!contributions.length && !warnings.length) return null;
  return (
    <>
      <details className="fpl-opening-details">
        <summary>Live starting balance breakdown</summary>
        <ul>
          <li>
            Flat starting balance: {money(openingBalances.flatUsd ?? 0)} ·{" "}
            {money(openingBalances.flatPhp ?? 0, "PHP")}
          </li>
          {contributions.map((account) => (
            <li key={account.accountId}>
              {account.percentage}% of {account.name || "Account"}
              {account.mask ? ` · ••${account.mask}` : ""}:{" "}
              {money(account.amount, account.currency)}
              <small>
                Current balance {money(account.balance, account.currency)}
              </small>
              {account.reserveExcluded > 0 && (
                <small>
                  {money(account.reserveExcluded, account.currency)} already
                  reserved · {money(account.availableAmount, account.currency)}{" "}
                  available
                </small>
              )}
            </li>
          ))}
        </ul>
      </details>
      {warnings.length > 0 && (
        <ul className="fpl-opening-warnings" role="status">
          {warnings.map((warning, index) => (
            <li key={index}>
              {typeof warning === "string" ? warning : warning.message}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export default function Ledger({
  plan,
  rows,
  openingReserve,
  openingBalances,
  openingSavings,
  onEdit,
  onDelete,
  onEditOccurrence,
  onResetOccurrence,
  onToggleComplete,
  busy = false,
}) {
  const openingUsd = openingBalances?.usd ?? plan.openingUsd ?? 0;
  const openingPhp = openingBalances?.php ?? plan.openingPhp ?? 0;
  return (
    <>
      <div
        className="fp-table-wrap fp-ledger-wrap fpl-scroll"
        role="region"
        aria-label="Budget money flows, available balances, annual reserves, and savings; scroll horizontally for all columns"
        tabIndex={0}
      >
        <table className="fp-table fp-ledger fpl-table">
          <caption className="fp-sr-only">
            Money flows between{" "}
            {formatDate(plan.startDate, { year: "numeric" })} and{" "}
            {formatDate(plan.endDate, { year: "numeric" })}. Available funds and
            annual reserves and savings are separate balances. Completion tracks
            progress without changing money flows.
          </caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Description</th>
              <th scope="col">Flow · USD</th>
              <th scope="col">Flow · PHP</th>
              <th scope="col" className="fp-running">
                Available · USD
              </th>
              <th scope="col" className="fp-running">
                Available · PHP
              </th>
              <th scope="col" className="fpl-reserve-balance">
                Annual reserve · USD
              </th>
              <th scope="col" className="fpl-reserve-balance">
                Annual reserve · PHP
              </th>
              <th scope="col" className="fpl-savings-balance">
                Savings · USD
              </th>
              <th scope="col" className="fpl-savings-balance">
                Savings · PHP
              </th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="fp-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="fp-opening-row fpl-opening-row">
              <td>{formatDate(plan.startDate, { year: "numeric" })}</td>
              <td>
                <strong>Starting balances</strong>
                <small>Available funds, annual reserves, and savings</small>
                <OpeningDetails openingBalances={openingBalances} />
              </td>
              <td className="fp-zero">—</td>
              <td className="fp-zero">—</td>
              <td className={`fp-running ${balanceClass(openingUsd)}`}>
                {money(openingUsd)}
              </td>
              <td className={`fp-running ${balanceClass(openingPhp)}`}>
                {money(openingPhp, "PHP")}
              </td>
              <ReserveBalance
                value={openingReserve?.usd ?? plan.openingReserveUsd ?? 0}
                currency="USD"
              />
              <ReserveBalance
                value={openingReserve?.php ?? plan.openingReservePhp ?? 0}
                currency="PHP"
              />
              <SavingsBalance value={openingSavings?.usd} currency="USD" />
              <SavingsBalance value={openingSavings?.php} currency="PHP" />
              <td className="fp-zero">—</td>
              <td />
            </tr>
            {rows.map((row) => {
              const manualEntry =
                row.source === "manual"
                  ? plan.entries.find((entry) => entry.id === row.entryId)
                  : null;
              const editableOccurrence =
                row.editable &&
                ["salary", "bill", "allocation", "reserve"].includes(row.source);
              return (
                <tr
                  key={row.id}
                  className={`fpl-row fpl-row-${row.source}${row.completed ? " fpl-row-completed" : ""}`}
                >
                  <td>{formatDate(row.date, { year: "numeric" })}</td>
                  <td>
                    <strong>{row.description}</strong>
                    <SourceLabel row={row} />
                  </td>
                  <FlowAmount
                    value={row.usd}
                    currency="USD"
                    showZero={row.annualPayment && row.currency === "USD"}
                  />
                  <FlowAmount
                    value={row.php}
                    currency="PHP"
                    showZero={row.annualPayment && row.currency === "PHP"}
                  />
                  <td className={`fp-running ${balanceClass(row.balanceUsd)}`}>
                    {money(row.balanceUsd)}
                  </td>
                  <td className={`fp-running ${balanceClass(row.balancePhp)}`}>
                    {money(row.balancePhp, "PHP")}
                  </td>
                  <ReserveBalance
                    value={row.reserveUsd ?? 0}
                    delta={row.reserveAppliedUsd ?? row.reserveDeltaUsd ?? 0}
                    currency="USD"
                  />
                  <ReserveBalance
                    value={row.reservePhp ?? 0}
                    delta={row.reserveAppliedPhp ?? row.reserveDeltaPhp ?? 0}
                    currency="PHP"
                  />
                  <SavingsBalance value={row.savingsUsd} currency="USD" />
                  <SavingsBalance value={row.savingsPhp} currency="PHP" />
                  <td className="fpl-status-cell">
                    <CompletionStatus
                      row={row}
                      onToggleComplete={onToggleComplete}
                      busy={busy}
                    />
                  </td>
                  <td>
                    {(manualEntry || editableOccurrence) && (
                      <div className="fp-row-actions">
                        <button
                          type="button"
                          className="fp-button fp-secondary fp-icon-button"
                          aria-label={
                            manualEntry
                              ? `Edit ${row.description}`
                              : `Edit this occurrence: ${row.description}`
                          }
                          disabled={
                            busy || !(manualEntry ? onEdit : onEditOccurrence)
                          }
                          onClick={() => {
                            if (busy) return;
                            if (manualEntry) onEdit?.(manualEntry);
                            else onEditOccurrence?.(row);
                          }}
                        >
                          <ActionIcon kind="edit" />
                        </button>
                        {manualEntry && (
                          <button
                            type="button"
                            className="fp-button fp-secondary fp-icon-button"
                            aria-label={`Delete ${row.description}`}
                            disabled={busy || !onDelete}
                            onClick={() => {
                              if (!busy) onDelete?.(manualEntry);
                            }}
                          >
                            <ActionIcon kind="delete" />
                          </button>
                        )}
                        {editableOccurrence && row.isOverride && (
                          <button
                            type="button"
                            className="fp-button fp-secondary fpl-reset-occurrence"
                            aria-label={`Reset this occurrence: ${row.description}`}
                            disabled={busy || !onResetOccurrence}
                            onClick={() => {
                              if (!busy) onResetOccurrence?.(row);
                            }}
                          >
                            Reset
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="fpl-legend">
        Annual payments show only additional available funds needed; remaining
        payment is covered by reserves. Saved amounts are earmarked for each
        annual bill. Marking a row done tracks progress; it does not create a
        transaction or change its planned amount. Posted transaction matches are
        marked done automatically. Savings balances reflect linked savings
        accounts and planned movements, excluding annual reserves. Unassigned
        savings accumulate separately. Editing a scheduled row changes only that
        date in this plan; Reset restores the recurring value.
      </p>
    </>
  );
}
