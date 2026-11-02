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

export default function Ledger({
  plan,
  rows,
  openingReserve,
  onEdit,
  onDelete,
}) {
  return (
    <>
      <div
        className="fp-table-wrap fp-ledger-wrap fpl-scroll"
        role="region"
        aria-label="Budget money flows, available balances, and annual reserves; scroll horizontally for all columns"
        tabIndex={0}
      >
        <table className="fp-table fp-ledger fpl-table">
          <caption className="fp-sr-only">
            Money flows between{" "}
            {formatDate(plan.startDate, { year: "numeric" })} and{" "}
            {formatDate(plan.endDate, { year: "numeric" })}. Available funds and
            annual reserves are separate balances.
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
                <small>Available funds + money already reserved</small>
              </td>
              <td className="fp-zero">—</td>
              <td className="fp-zero">—</td>
              <td className={`fp-running ${balanceClass(plan.openingUsd)}`}>
                {money(plan.openingUsd)}
              </td>
              <td className={`fp-running ${balanceClass(plan.openingPhp)}`}>
                {money(plan.openingPhp, "PHP")}
              </td>
              <ReserveBalance
                value={openingReserve?.usd ?? plan.openingReserveUsd ?? 0}
                currency="USD"
              />
              <ReserveBalance
                value={openingReserve?.php ?? plan.openingReservePhp ?? 0}
                currency="PHP"
              />
              <td />
            </tr>
            {rows.map((row) => {
              const manualEntry =
                row.source === "manual"
                  ? plan.entries.find((entry) => entry.id === row.entryId)
                  : null;
              return (
                <tr key={row.id} className={`fpl-row fpl-row-${row.source}`}>
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
                    delta={row.reserveDeltaUsd ?? 0}
                    currency="USD"
                  />
                  <ReserveBalance
                    value={row.reservePhp ?? 0}
                    delta={row.reserveDeltaPhp ?? 0}
                    currency="PHP"
                  />
                  <td>
                    {manualEntry && (
                      <div className="fp-row-actions">
                        <button
                          type="button"
                          className="fp-button fp-secondary fp-icon-button"
                          aria-label={`Edit ${row.description}`}
                          onClick={() => onEdit(manualEntry)}
                        >
                          <ActionIcon kind="edit" />
                        </button>
                        <button
                          type="button"
                          className="fp-button fp-secondary fp-icon-button"
                          aria-label={`Delete ${row.description}`}
                          onClick={() => onDelete(manualEntry)}
                        >
                          <ActionIcon kind="delete" />
                        </button>
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
        annual bill.
      </p>
    </>
  );
}
