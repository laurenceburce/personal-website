"use client";

import { formatDate, localDate, money } from "../lib/financePlanner.mjs";
import "./finance-plan-ledger.css";

const signed = (value, currency) =>
  `${value > 0 ? "+" : ""}${money(value, currency)}`;
const balanceClass = (value) => (value < 0 ? "fp-negative" : "");
const balanceText = (value, currency = "USD") => Number.isFinite(value) ? money(value, currency) : "—";

function ColumnAccount({ accountId, accounts }) {
  if (accountId == null) return null;
  const account = accounts.find((item) => Number(item.id) === Number(accountId));
  return <small className="fpl-column-account">{account?.name || "Unavailable account"}{account?.mask ? ` · •${account.mask}` : ""}</small>;
}

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
      data-column={`flow-${currency.toLowerCase()}`}
      data-label={`Flow · ${currency}`}
      className={
        value < 0 ? "fp-negative" : value > 0 ? "fp-positive" : "fp-zero"
      }
    >
      {value || showZero ? signed(value, currency) : "—"}
    </td>
  );
}

function ReserveBalance({ value = 0, delta = 0, currency, unusedOnPhone = false }) {
  return (
    <td data-column={`reserve-${currency.toLowerCase()}`} data-label={`Annual reserve · ${currency}`} className={`fpl-reserve-balance ${balanceClass(value)}${unusedOnPhone ? " fpl-unused-on-phone" : ""}`}>
      <span>{balanceText(value, currency)}</span>
      {Number.isFinite(delta) && delta !== 0 && (
        <small className="fpl-reserve-change">
          {signed(delta, currency)} {delta > 0 ? "set aside" : "used"}
        </small>
      )}
    </td>
  );
}

function SavingsBalance({ value = 0, currency, unusedOnPhone = false }) {
  const available = Number.isFinite(value);
  return (
    <td
      data-column={`savings-${currency.toLowerCase()}`}
      data-label={`Savings · ${currency}`}
      className={`fpl-savings-balance ${available ? balanceClass(value) : "fp-zero"}${unusedOnPhone ? " fpl-unused-on-phone" : ""}`}
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
    creditCardDue: "Credit card statement due",
    transaction: "Recorded transaction",
    allocation: "Payday allocation",
    reserve: "Annual bills set-aside",
    reserveRelease: "Use annual reserve",
  };
  const label =
    row.source === "manual"
      ? row.recurring
        ? `${({ daily: "Daily", monthly: "Monthly", payday: "Every payday" })[row.recurrence] || "Recurring"} plan entry`
        : row.kind === "conversion"
        ? "Planned currency conversion"
        : row.kind === "transfer"
          ? row.creditCardPaymentFor ? "Planned credit card payment" : "Planned account transfer"
          : "Plan entry"
      : row.source === "creditCardDue" && row.estimated
        ? "Estimated next card payment"
        : labels[row.source] || "Plan flow";
  const matched = row.scheduledSource || row.matchedForecast?.source;
  const matchedLabel =
    matched === "salary"
      ? "scheduled income"
      : matched === "bill"
        ? "scheduled bill"
        : matched === "creditCardDue"
          ? "credit card statement payment"
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
      {row.actualTransferAmount && Number.isFinite(row.plannedAmount) && (
        <small className="fpl-match-note">
          Bank transfer {money(row.amount, row.currency)} · Planned {money(row.plannedAmount, row.currency)}
        </small>
      )}
      {row.source === "creditCardDue" && !row.estimated && (
        <small className="fpl-credit-card-due-detail">
          Statement balance {money(row.statementBalance, row.currency)}
          {row.paidAmount > 0 && <>{" "}· Paid {money(row.paidAmount, row.currency)}</>}
          {row.plannedPaymentAmount > 0 && <>
            {" "}· Planned payments {money(row.plannedPaymentAmount, row.currency)}
          </>}
          {(row.paidAmount > 0 || row.plannedPaymentAmount > 0) && <>
            {" "}· Remaining {money(row.amount, row.currency)}
          </>}
        </small>
      )}
      {row.source === "creditCardDue" && row.estimated && (
        <>
          <small className="fpl-credit-card-due-detail">
            Unbilled balance {money(row.estimatedBalance ?? row.amount, row.currency)}
            {row.plannedPaymentAmount > 0 && <>
              {" "}· Planned payments {money(row.plannedPaymentAmount, row.currency)}
              {" "}· Remaining {money(row.amount, row.currency)}
            </>}
          </small>
          <small className="fpl-reconciliation-note">
            {row.estimateDateIsReported
              ? "Uses the bank’s next payment date."
              : "Payment date estimated from the monthly billing cycle."}
            {" "}The amount can change with purchases, payments, refunds, and interest.
          </small>
        </>
      )}
      {row.cardCreditActivity && (
        <small className="fpl-account-label">
          Changes the card balance. Cash payments are shown with statement dues.
        </small>
      )}
      {row.source === "manual" && row.kind === "transfer" &&
        Boolean(row.usd || row.php) && (
          <small className="fpl-account-label">
            {row.creditCardPaymentFor
              ? "Pays the card from available funds."
              : row.usd > 0 || row.php > 0
              ? "Moved from savings to available funds."
              : "Moved from available funds to savings."}
          </small>
        )}
      {row.source === "transaction" &&
        (row.matchedForecast || row.scheduledSource) && (
          <small className="fpl-match-note">
            {matched === "creditCardDue" ? "Recorded against" : "Replaces"} {matchedLabel}
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
          {row.recordedTransactions?.length ? "Matched bank movement included here once" : "Cash movement shown in matched recorded transactions"}
        </small>
      )}
      {row.recordedTransactions?.length > 0 && (
        <details className="fpl-account-movements">
          <summary>Matched bank records · {row.recordedTransactions.length}</summary>
          <ul>
            {row.recordedTransactions.map((transaction) => (
              <li key={transaction.id}>
                {transaction.description || transaction.merchant || "Bank transaction"} · {formatDate(transaction.date)}
                {" "}· {signed((transaction.kind === "income" ? 1 : -1) * transaction.amount, transaction.currency)}
                {transaction.accountName && <small>{transaction.accountName}</small>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {reserveAlreadyIncluded && (
        <small className="fpl-reconciliation-note">
          Historical reserve movement is already included in current earmarks.
        </small>
      )}
      {sameAccountReserve && (
        <small className="fpl-account-label">
          Earmarked within the same account; bank balance stays unchanged.
        </small>
      )}
      {(row.accountMovements?.length > 0 || row.accountNames?.length > 0) && (
        <details className="fpl-account-movements">
          <summary>{row.accountMovements?.length > 0 ? "Account movements" : "Linked accounts"}</summary>
          {row.accountNames?.length > 0 && (
            <small className="fpl-account-label">
              Accounts: {row.accountNames.join(" · ")}
            </small>
          )}
          {row.accountMovements?.length > 0 && <ul>
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
          </ul>}
        </details>
      )}
    </>
  );
}

function CompletionStatus({ row, onToggleComplete, busy }) {
  const completed = Boolean(row.completed);
  const automatic = completed && row.completionSource === "transaction";
  const bankReportedPayment = automatic && row.source === "creditCardDue" && !row.estimated && !row.matchedTransactionIds?.length;
  const matched =
    row.source !== "transaction" ||
    Boolean(row.matchedForecast || row.scheduledSource);
  const label = automatic
    ? bankReportedPayment
      ? "Done · bank payment reported"
      : matched
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
  accounts = [],
  openingReserve,
  openingBalances,
  openingSavings,
  onEdit,
  onDelete,
  onEditOccurrence,
  onResetOccurrence,
  onToggleComplete,
  busy = false,
  today = localDate(),
}) {
  const ledgerId = `budget-ledger-${String(plan.id || `${plan.startDate}-${plan.endDate}`).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const upcomingIndex = rows.findIndex((row) => row.date >= today && !row.completed);
  const columns = [
    { key: "flow", label: "Flow", visible: true },
    { key: "available", label: "Available balances", visible: true },
    { key: "reserves", label: "Annual reserves", visible: false },
    { key: "savings", label: "Savings", visible: false },
    { key: "status", label: "Status", visible: false },
    { key: "actions", label: "Actions", visible: true },
  ];
  const scrollColumns = (event, direction) => {
    const scroller = event.currentTarget.closest(".fpl-ledger")?.querySelector(".fpl-scroll");
    scroller?.scrollBy({
      left: direction * Math.max(160, scroller.clientWidth * 0.75),
      behavior: "smooth",
    });
  };
  const openingUsd = openingBalances?.usd !== undefined ? openingBalances.usd : plan.openingUsd ?? 0;
  const openingPhp = openingBalances?.php !== undefined ? openingBalances.php : plan.openingPhp ?? 0;
  // Retain currency availability metadata without omitting any financial values.
  const unusedCurrency = (opening, key) =>
    [opening, ...rows.map((row) => row[key])].every(
      (value) => value === 0 || value === undefined,
    );
  const unusedReserveUsd = unusedCurrency(
    openingReserve?.usd !== undefined ? openingReserve.usd : plan.openingReserveUsd ?? 0,
    "reserveUsd",
  );
  const unusedReservePhp = unusedCurrency(
    openingReserve?.php !== undefined ? openingReserve.php : plan.openingReservePhp ?? 0,
    "reservePhp",
  );
  const unusedSavingsUsd = unusedCurrency(openingSavings?.usd, "savingsUsd");
  const unusedSavingsPhp = unusedCurrency(openingSavings?.php, "savingsPhp");
  return (
    <div className="fpl-ledger">
      <div className="fpl-mobile-toolbar">
        <form className="fpl-display-controls" onSubmit={(event) => event.preventDefault()}>
          <details className="fpl-column-options">
            <summary>Columns</summary>
            <div className="fpl-column-panel">
              <fieldset>
                <legend>Show columns</legend>
                {columns.map((column) => (
                  <label key={column.key}>
                    <input
                      type="checkbox"
                      className={`fpl-show-${column.key}`}
                      defaultChecked={column.visible}
                    />
                    {column.label}
                  </label>
                ))}
              </fieldset>
              <fieldset className="fpl-currency-options">
                <legend>Currency</legend>
                {[
                  ["both", "Both currencies"],
                  ["usd", "USD"],
                  ["php", "PHP"],
                ].map(([value, label]) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name={`${ledgerId}-currency`}
                      value={value}
                      className={`fpl-currency-${value}`}
                      defaultChecked={value === "both"}
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
              <button type="reset" className="fp-button fp-secondary fpl-reset-columns">
                Reset columns
              </button>
            </div>
          </details>
        </form>
        <span className="fpl-row-count">{rows.length} {rows.length === 1 ? "row" : "rows"}</span>
        {upcomingIndex >= 0 && (
          <a className="fpl-upcoming-link" href={`#${ledgerId}-row-${upcomingIndex}`}>
            Upcoming
          </a>
        )}
        <div className="fpl-scroll-buttons">
          <button type="button" aria-label="Scroll budget columns left" aria-controls={ledgerId} onClick={(event) => scrollColumns(event, -1)}>←</button>
          <button type="button" aria-label="Scroll budget columns right" aria-controls={ledgerId} onClick={(event) => scrollColumns(event, 1)}>→</button>
        </div>
      </div>
      <p className="fpl-mobile-hint" id={`${ledgerId}-hint`}>
        Swipe sideways for more columns. Tap ⋯ for row details.
      </p>
      <div
        id={ledgerId}
        className="fp-table-wrap fp-ledger-wrap fpl-scroll"
        role="region"
        aria-label="Budget money flows, available balances, annual reserves, and savings"
        aria-describedby={`${ledgerId}-hint`}
        tabIndex={0}
      >
        <table className="fp-table fp-ledger fpl-table" role="table">
          <caption className="fp-sr-only">
            Money flows between{" "}
            {formatDate(plan.startDate, { year: "numeric" })} and{" "}
            {formatDate(plan.endDate, { year: "numeric" })}. Available funds and
            annual reserves and savings are separate balances. Completion tracks
            progress without changing money flows.
          </caption>
          <thead>
            <tr>
              <th scope="col" data-column="date">Date</th>
              <th scope="col" data-column="description"><span className="fpl-desktop-column-label">Description</span><span className="fpl-mobile-column-label">Item / date</span></th>
              <th scope="col" data-column="flow-usd">Flow · USD</th>
              <th scope="col" data-column="flow-php">Flow · PHP</th>
              <th scope="col" data-column="available-usd" className="fp-running">
                Available · USD
                <ColumnAccount accountId={plan.accountLinks?.availableUsdAccountId} accounts={accounts} />
              </th>
              <th scope="col" data-column="available-php" className="fp-running">
                Available · PHP
                <ColumnAccount accountId={plan.accountLinks?.availablePhpAccountId} accounts={accounts} />
              </th>
              <th scope="col" data-column="reserve-usd" className="fpl-reserve-balance">
                Annual reserve · USD
                <ColumnAccount accountId={plan.accountLinks?.annualReserveUsdAccountId} accounts={accounts} />
              </th>
              <th scope="col" data-column="reserve-php" className="fpl-reserve-balance">
                Annual reserve · PHP
                <ColumnAccount accountId={plan.accountLinks?.annualReservePhpAccountId} accounts={accounts} />
              </th>
              <th scope="col" data-column="savings-usd" className="fpl-savings-balance">
                Savings · USD
                <ColumnAccount accountId={plan.accountLinks?.savingsUsdAccountId} accounts={accounts} />
              </th>
              <th scope="col" data-column="savings-php" className="fpl-savings-balance">
                Savings · PHP
                <ColumnAccount accountId={plan.accountLinks?.savingsPhpAccountId} accounts={accounts} />
              </th>
              <th scope="col" data-column="status">Status</th>
              <th scope="col" data-column="actions">
                <span className="fp-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="fp-opening-row fpl-opening-row">
              <td data-column="date" className="fpl-date-cell">{formatDate(plan.startDate, { year: "numeric" })}</td>
              <td data-column="description" className="fpl-description-cell">
                <time className="fpl-mobile-date" dateTime={plan.startDate}>{formatDate(plan.startDate, { year: "2-digit" })}</time>
                <strong>Starting balances</strong>
                <small>Available funds, annual reserves, and savings</small>
                {plan.accountLinks
                  ? <small>Linked account balances; posted bank movements are already included.</small>
                  : <OpeningDetails openingBalances={openingBalances} />}
              </td>
              <td data-column="flow-usd" data-label="Flow · USD" className="fp-zero fpl-opening-flow">—</td>
              <td data-column="flow-php" data-label="Flow · PHP" className="fp-zero fpl-opening-flow">—</td>
              <td data-column="available-usd" data-label="Available · USD" className={`fp-running ${balanceClass(openingUsd)}`}>
                {balanceText(openingUsd)}
              </td>
              <td data-column="available-php" data-label="Available · PHP" className={`fp-running ${balanceClass(openingPhp)}`}>
                {balanceText(openingPhp, "PHP")}
              </td>
              <ReserveBalance
                value={openingReserve?.usd !== undefined ? openingReserve.usd : plan.openingReserveUsd ?? 0}
                currency="USD"
                unusedOnPhone={unusedReserveUsd}
              />
              <ReserveBalance
                value={openingReserve?.php !== undefined ? openingReserve.php : plan.openingReservePhp ?? 0}
                currency="PHP"
                unusedOnPhone={unusedReservePhp}
              />
              <SavingsBalance value={openingSavings?.usd} currency="USD" unusedOnPhone={unusedSavingsUsd} />
              <SavingsBalance value={openingSavings?.php} currency="PHP" unusedOnPhone={unusedSavingsPhp} />
              <td data-column="status" className="fp-zero fpl-opening-status">—</td>
              <td data-column="actions" className="fpl-actions-cell" />
            </tr>
            {rows.map((row, rowIndex) => {
              const manualEntry =
                row.source === "manual"
                  ? plan.entries.find((entry) => entry.id === row.entryId)
                  : null;
              const editableOccurrence =
                row.editable &&
                (["salary", "bill", "allocation", "reserve"].includes(row.source) ||
                  (row.source === "manual" && row.recurring));
              const recurringEntry = manualEntry && row.recurring;
              return (
                <tr
                  id={`${ledgerId}-row-${rowIndex}`}
                  key={row.id}
                  className={`fpl-row fpl-row-${row.source}${row.completed ? " fpl-row-completed" : ""}`}
                >
                  <td data-column="date" className="fpl-date-cell">{formatDate(row.date, { year: "numeric" })}</td>
                  <td data-column="description" className="fpl-description-cell">
                    <time className="fpl-mobile-date" dateTime={row.date}>{formatDate(row.date, { year: "2-digit" })}</time>
                    <strong title={row.description}>{row.description}</strong>
                    {row.estimated && <span className="fpl-estimate-tag">Estimated</span>}
                    <details className="fpl-row-details">
                      <summary aria-label={`Details for ${row.description}`}>
                        <span className="fpl-details-text">Details</span>
                        <span className="fpl-details-icon" aria-hidden="true">⋯</span>
                      </summary>
                      <div className="fpl-row-notes">
                        <span className="fpl-detail-title">{row.description}</span>
                        <SourceLabel row={row} />
                      </div>
                    </details>
                  </td>
                  <FlowAmount
                    value={row.usd}
                    currency="USD"
                    showZero={(row.annualPayment || row.source === "creditCardDue") && row.currency === "USD"}
                  />
                  <FlowAmount
                    value={row.php}
                    currency="PHP"
                    showZero={(row.annualPayment || row.source === "creditCardDue") && row.currency === "PHP"}
                  />
                  <td data-column="available-usd" data-label="Available · USD" className={`fp-running ${balanceClass(row.balanceUsd)}`}>
                    {balanceText(row.balanceUsd)}
                  </td>
                  <td data-column="available-php" data-label="Available · PHP" className={`fp-running ${balanceClass(row.balancePhp)}`}>
                    {balanceText(row.balancePhp, "PHP")}
                  </td>
                  <ReserveBalance
                    value={row.reserveUsd !== undefined ? row.reserveUsd : 0}
                    delta={row.reserveAppliedUsd ?? row.reserveDeltaUsd ?? 0}
                    currency="USD"
                    unusedOnPhone={unusedReserveUsd}
                  />
                  <ReserveBalance
                    value={row.reservePhp !== undefined ? row.reservePhp : 0}
                    delta={row.reserveAppliedPhp ?? row.reserveDeltaPhp ?? 0}
                    currency="PHP"
                    unusedOnPhone={unusedReservePhp}
                  />
                  <SavingsBalance value={row.savingsUsd} currency="USD" unusedOnPhone={unusedSavingsUsd} />
                  <SavingsBalance value={row.savingsPhp} currency="PHP" unusedOnPhone={unusedSavingsPhp} />
                  <td data-column="status" className="fpl-status-cell">
                    <CompletionStatus
                      row={row}
                      onToggleComplete={onToggleComplete}
                      busy={busy}
                    />
                  </td>
                  <td data-column="actions" className="fpl-actions-cell">
                    {(manualEntry || editableOccurrence) && (
                      <div className="fp-row-actions">
                        <button
                          type="button"
                          className="fp-button fp-secondary fp-icon-button"
                          aria-label={
                            editableOccurrence
                              ? `Edit this occurrence: ${row.description}`
                              : `Edit ${row.description}`
                          }
                          disabled={
                            busy || !(editableOccurrence ? onEditOccurrence : onEdit)
                          }
                          onClick={() => {
                            if (busy) return;
                            if (editableOccurrence) onEditOccurrence?.(row);
                            else if (manualEntry) onEdit?.(manualEntry);
                          }}
                        >
                          <ActionIcon kind="edit" />
                        </button>
                        {recurringEntry && (
                          <button
                            type="button"
                            className="fp-button fp-secondary fpl-edit-series"
                            aria-label={`Edit recurring entry: ${manualEntry.description}`}
                            disabled={busy || !onEdit}
                            onClick={() => {
                              if (!busy) onEdit?.(manualEntry);
                            }}
                          >
                            Series
                          </button>
                        )}
                        {manualEntry && (
                          <button
                            type="button"
                            className="fp-button fp-secondary fp-icon-button"
                            aria-label={recurringEntry ? `Delete recurring entry: ${manualEntry.description}` : `Delete ${row.description}`}
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
      <details className="fpl-legend">
        <summary>How balances work</summary>
        <p>
        Annual payments show only additional available funds needed; remaining
        payment is covered by reserves. Saved amounts are earmarked for each
        annual bill. Marking a row done tracks progress; it does not create a
        transaction or change its planned amount. Posted transaction matches are
        marked done automatically. Savings balances reflect linked savings
        accounts and planned movements, excluding annual reserves. Unassigned
        savings accumulate separately. Editing a scheduled row changes only that
        date in this plan; Reset restores the recurring value.
        </p>
      </details>
    </div>
  );
}
