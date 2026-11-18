"use client";

import { useState } from "react";
import { formatDate, localDate, money } from "../lib/financePlanner.mjs";
import { getPlanRowCategory } from "../lib/financePlanPresentation.mjs";
import { SourceLabel } from "./FinancePlanLedger";
import "./finance-planner-table.css";

const recorded = (row, today) => Boolean(row.completed ||
  (row.source === "transaction" && !row.scheduled && row.date <= today));
const accountRecorded = (row, today) => Boolean(row.recordedInAccounts ||
  ["plan", "transaction"].includes(row.completionSource) ||
  (row.source === "transaction" && !row.scheduled && row.date <= today));
const signed = (amount, currency) => `${amount > 0 ? "+" : ""}${money(amount, currency)}`;
const balance = (value, currency) => Number.isFinite(value) ? money(value, currency) : "Unavailable";
const accountName = (account) => account
  ? `${account.name || "Account"}${account.mask ? ` · ••${account.mask}` : ""}` : "Choose an account";

function rowAccounts(row, accounts, plan) {
  const byId = (id) => accounts.find((account) => Number(account.id) === Number(id));
  const from = row.fromAccountId || (row.source === "creditCardDue"
    ? row.sourceAccountId || plan.accountLinks?.[`available${row.currency === "PHP" ? "Php" : "Usd"}AccountId`] : null);
  const to = row.toAccountId || row.creditAccountId;
  if (from || to) return { from: accountName(byId(from)), to: accountName(byId(to)) };
  if (row.accountId) return { names: [accountName(byId(row.accountId))] };
  const names = row.accountNames?.length ? row.accountNames
    : [...new Set((row.accountMovements || []).map((move) => move.accountName || accountName(byId(move.accountId))))];
  return { names: names.length ? names : [row.accountName || "Not assigned"] };
}

function NativeAmount({ row }) {
  if (row.kind === "conversion") return <div className="fpt-money-stack">
    {[['USD', row.usd], ['PHP', row.php]].map(([currency, value]) => <span key={currency}
      className={value < 0 ? "fpt-negative" : "fpt-positive"}>{signed(Number(value) || 0, currency)}</span>)}
  </div>;
  const hasNative = ["USD", "PHP"].includes(row.currency) && Number.isFinite(row.grossAmount ?? row.amount);
  if (hasNative) {
    const amount = row.grossAmount ?? row.amount;
    const internal = row.kind === "transfer" && !row.creditCardPaymentFor;
    const value = internal ? amount : (row.kind === "income" ? 1 : -1) * amount;
    return <div className="fpt-money-stack">
      <span className={internal ? "" : value < 0 ? "fpt-negative" : "fpt-positive"}>
        {internal ? money(value, row.currency) : signed(value, row.currency)}
      </span>
      {row.cardCreditActivity ? <small>Card balance</small> : row.kind === "transfer" ? <small>{row.creditCardPaymentFor ? "Card payment" : "Transfer"}</small> : null}
    </div>;
  }
  const flows = [["USD", row.usd], ["PHP", row.php]].filter(([, value]) => Number.isFinite(value) && value !== 0);
  return <div className="fpt-money-stack">{flows.length ? flows.map(([currency, value]) =>
    <span key={currency} className={value < 0 ? "fpt-negative" : "fpt-positive"}>{signed(value, currency)}</span>) : <span>—</span>}</div>;
}

function Status({ row, today }) {
  const done = recorded(row, today);
  const label = done ? row.recordedInAccounts || row.source === "transaction" || row.completionSource === "transaction" ? "Recorded" : "Done"
    : row.date < today ? "Overdue" : "Planned";
  return <div className="fpt-status"><span className={`fpt-status-pill fpt-status-${label.toLowerCase()}`}>{label}</span>
    {row.awaitingBankSync && <small>Awaiting bank match</small>}
    {done && row.completionSource === "transaction" && (row.matchedForecast || row.recordedTransactions?.length > 0) && <small>Matched to account</small>}
  </div>;
}

/** Display filters never alter stored entries, row order, or projected balances. */
export default function FinancePlannerTable({
  plan, rows = [], accounts = [], today = localDate(), busy = false, loading = false,
  onEdit, onDelete, onEditOccurrence, onResetOccurrence, onToggleComplete, onRecord,
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const query = search.trim().toLowerCase();
  const visible = rows.filter((row) => {
    const done = recorded(row, today);
    if ((status === "recorded" && !accountRecorded(row, today)) || (status === "upcoming" && (done || row.date < today)) ||
        (status === "overdue" && (done || row.date >= today))) return false;
    if (!query) return true;
    const assigned = rowAccounts(row, accounts, plan);
    return [row.description, row.category, getPlanRowCategory(row).label,
      assigned.from, assigned.to, ...(assigned.names || [])].filter(Boolean).join(" ").toLowerCase().includes(query);
  });
  const filtered = query || status !== "all";
  const clear = () => { setSearch(""); setStatus("all"); };
  return <section className="fpt-planner-table" aria-label="Planner transactions" aria-busy={loading}>
    <div className="fpt-toolbar">
      <label className="fpt-search"><span className="fp-sr-only">Search transactions</span>
        <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
        <input type="search" placeholder="Search transactions or accounts" value={search} disabled={loading}
          onChange={(event) => setSearch(event.target.value)} />
      </label>
      <div className="fpt-filter-tabs" role="group" aria-label="Transaction status">
        {[["all", "All"], ["upcoming", "Upcoming"], ["recorded", "Recorded"], ["overdue", "Overdue"]].map(([value, label]) =>
          <button key={value} type="button" aria-pressed={status === value} disabled={loading} onClick={() => setStatus(value)}>{label}</button>)}
      </div>
      <span className="fpt-count" aria-live="polite">{visible.length}{filtered ? ` of ${rows.length}` : ""} {visible.length === 1 ? "transaction" : "transactions"}</span>
    </div>
    {!visible.length ? <div className="fpt-empty" role="status">
      <strong>{loading ? "Loading transactions…" : filtered ? "No transactions match your filters" : "No transactions in this date range"}</strong>
      <p>{filtered ? "Try another search or show all statuses." : "Change the dates above or add a transaction to your planner."}</p>
      {filtered && <button type="button" className="fp-button fp-secondary" onClick={clear}>Clear filters</button>}
    </div> : <div className="fpt-table-wrap">
      <table className="fpt-table">
        <caption className="fp-sr-only">Recorded and planned transactions in date order. Projected balance shows account funds after each upcoming transaction, with card debt separate in the summary.</caption>
        <thead><tr><th scope="col">Date</th><th scope="col">Transaction</th><th scope="col">Account</th><th scope="col">Amount</th><th scope="col">Projected balance</th><th scope="col">Status</th></tr></thead>
        <tbody>{visible.map((row) => {
          const category = getPlanRowCategory(row);
          const assigned = rowAccounts(row, accounts, plan);
          const manualEntry = (row.source === "manual" || row.planGenerated) && plan.entries?.find((entry) => entry.id === row.entryId);
          const editableOccurrence = row.editable && (["salary", "bill", "allocation", "reserve"].includes(row.source) || (row.source === "manual" && row.recurring));
          const canRecord = !recorded(row, today) && onRecord && (['salary', 'bill', 'creditCardDue'].includes(row.source) ||
            (row.source === "manual" && row.kind === "transfer" && row.amountMode === "cardBalance"));
          const canToggle = onToggleComplete && row.completionSource !== "transaction";
          const canEdit = manualEntry || editableOccurrence;
          const actions = canEdit || canToggle || (row.isOverride && onResetOccurrence);
          const inCurrentBalance = plan.balanceMode !== "snapshot" && accountRecorded(row, today) && row.date <= today;
          return <tr key={row.id} className={`fpt-row fpt-category-${category.key}${recorded(row, today) ? " fpt-row-recorded" : ""}`}>
            <td className="fpt-date"><time dateTime={row.date}>{formatDate(row.date, { year: "numeric" })}</time></td>
            <td className="fpt-transaction">
              <strong>{row.description}</strong>
              <div className="fpt-row-meta"><span className="fpt-category">{category.label}</span>{row.estimated && <span>Estimated</span>}
                {row.recurring && <span>Repeats</span>}
                <details className="fpt-details"><summary aria-label={`Details for ${row.description}`}>Details</summary>
                  <div className="fpt-detail-body"><SourceLabel row={row}/>
                    <dl className="fpt-extra-balances">
                      {[["Annual reserve · USD", row.reserveUsd, "USD"], ["Annual reserve · PHP", row.reservePhp, "PHP"],
                        ["Savings · USD", row.savingsUsd, "USD"], ["Savings · PHP", row.savingsPhp, "PHP"]].filter(([, value]) => Number.isFinite(value)).map(([label, value, currency]) =>
                          <div key={label}><dt>{label}</dt><dd>{money(value, currency)}</dd></div>)}
                    </dl>
                  </div>
                </details>
              </div>
            </td>
            <td className="fpt-account" data-label="Account">{assigned.from || assigned.to ?
              <span className="fpt-account-pair"><span>{assigned.from}</span><small>to {assigned.to}</small></span> :
              <span>{assigned.names.slice(0, 2).join(" · ")}{assigned.names.length > 2 ? ` +${assigned.names.length - 2}` : ""}</span>}</td>
            <td className="fpt-amount" data-label="Amount"><NativeAmount row={row}/></td>
            <td className="fpt-projection" data-label="Projected balance">{inCurrentBalance ? <small>Included in current balance</small> : plan.continuous && row.date < today ? <small>Past due · review payment</small> :
              <div className="fpt-money-stack">{[["USD", Object.hasOwn(row, "projectedBalanceUsd") ? row.projectedBalanceUsd : row.balanceUsd], ["PHP", Object.hasOwn(row, "projectedBalancePhp") ? row.projectedBalancePhp : row.balancePhp]].map(([currency, value]) =>
                <span key={currency} className={value < 0 ? "fpt-negative" : ""}><small>{currency}</small>{balance(value, currency)}</span>)}</div>}</td>
            <td className="fpt-status-cell"><Status row={row} today={today}/>
              <div className="fpt-actions">
                {canRecord && <button type="button" className="fpt-record" disabled={busy}
                  aria-label={`Record ${row.kind === "income" ? "receipt" : "payment"}: ${row.description}`} onClick={() => !busy && onRecord(row)}>
                  {row.kind === "income" ? "Record receipt" : "Record payment"}</button>}
                {actions && <details className="fpt-action-menu"><summary aria-label={`Actions for ${row.description}`}>•••</summary><div>
                  {canEdit && <button type="button" disabled={busy || !(editableOccurrence ? onEditOccurrence : onEdit)}
                    aria-label={editableOccurrence ? `Edit this occurrence: ${row.description}` : `Edit ${row.description}`}
                    onClick={() => { if (!busy) editableOccurrence ? onEditOccurrence?.(row) : onEdit?.(manualEntry); }}>Edit</button>}
                  {manualEntry && row.recurring && <button type="button" disabled={busy || !onEdit} onClick={() => !busy && onEdit?.(manualEntry)}>Edit recurring entry</button>}
                  {canToggle && <button type="button" disabled={busy}
                    aria-label={`${recorded(row, today) ? "Reopen" : "Mark done:"} ${row.description}`}
                    onClick={() => !busy && onToggleComplete(row)}>{recorded(row, today) ? "Reopen" : "Mark done"}</button>}
                  {row.isOverride && onResetOccurrence && <button type="button" disabled={busy} onClick={() => !busy && onResetOccurrence(row)}>Restore default</button>}
                  {manualEntry && <button type="button" className="fpt-delete" disabled={busy || !onDelete}
                    aria-label={`Delete ${row.description}`} onClick={() => !busy && onDelete?.(manualEntry)}>Delete{row.recurring ? " recurring entry" : ""}</button>}
                </div></details>}
              </div>
            </td>
          </tr>;
        })}</tbody>
      </table>
    </div>}
    <p className="fpt-footnote">Recorded activity is included in current balances. Upcoming unpaid transactions change the projection; table filters do not change it.</p>
  </section>;
}
