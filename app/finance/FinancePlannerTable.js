"use client";

import { useEffect, useRef, useState } from "react";
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

/** Keep chronological rows intact while locating the most relevant activity. */
export function selectCurrentPlannerRow(rows = [], today = localDate()) {
  const dated = rows.filter((row) => typeof row.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.date));
  const current = dated.filter((row) => row.date === today);
  if (current.length) return current.at(-1);
  const pastDate = dated.filter((row) => row.date < today).map((row) => row.date).sort().at(-1);
  if (pastDate) return dated.filter((row) => row.date === pastDate).at(-1);
  const nextDate = dated.map((row) => row.date).sort()[0];
  return dated.find((row) => row.date === nextDate) || null;
}

/** Scroll only the table's own viewport, leaving the surrounding page in place. */
function positionCurrentRow(scroller, row, behavior = "auto") {
  if (!scroller || !row) return false;
  const headerHeight = scroller.querySelector("thead")?.getBoundingClientRect().height || 0;
  const top = scroller.scrollTop + row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - headerHeight - 16;
  scroller.scrollTo({ top: Math.max(0, top), behavior });
  return true;
}

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
  viewKey,
  onEdit, onDelete, onEditOccurrence, onResetOccurrence, onToggleComplete, onRecord,
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [accountsExpanded, setAccountsExpanded] = useState(false);
  const [jumpRequest, setJumpRequest] = useState(0);
  const scrollerRef = useRef(null);
  const rowRefs = useRef(new Map());
  const positionedView = useRef(null);
  const handledJump = useRef(0);
  const columnAnchor = useRef(null);
  const current = selectCurrentPlannerRow(rows, today);
  const accountColumns = accounts.filter((account, index) => !account.isArchived && !account.is_archived &&
    !account.mergedIntoAccountId && !account.merged_into_account_id && ["USD", "PHP"].includes(account.currency) &&
    accounts.findIndex((item) => Number(item.id) === Number(account.id)) === index);
  const expanded = accountsExpanded && accountColumns.length > 0;
  const currentId = current == null ? null : String(current.id);
  const tableId = `planner-transactions-${encodeURIComponent(String(plan.id || "live"))}`;
  const windowKey = `${viewKey ?? `${plan.id}:${plan.startDate}:${plan.endDate}`}:${today}`;
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
  // Group only consecutive visible dates so filters keep valid row spans.
  const dateSpans = new Map();
  for (let index = 0; index < visible.length;) {
    let end = index + 1;
    while (end < visible.length && visible[end].date === visible[index].date) end++;
    dateSpans.set(index, end - index);
    index = end;
  }
  const filtered = query || status !== "all";
  const clear = () => { setSearch(""); setStatus("all"); };
  useEffect(() => {
    if (loading || currentId == null || positionedView.current === windowKey) return;
    if (positionCurrentRow(scrollerRef.current, rowRefs.current.get(currentId))) positionedView.current = windowKey;
  }, [windowKey, currentId, loading, rows.length]);
  useEffect(() => {
    if (!jumpRequest || handledJump.current === jumpRequest || loading || currentId == null) return;
    if (positionCurrentRow(scrollerRef.current, rowRefs.current.get(currentId))) handledJump.current = jumpRequest;
  }, [jumpRequest, loading, currentId, query, status]);
  useEffect(() => {
    const anchor = columnAnchor.current;
    const scroller = scrollerRef.current;
    const row = anchor && rowRefs.current.get(anchor.id);
    if (scroller && row) {
      const headerHeight = scroller.querySelector("thead")?.getBoundingClientRect().height || 0;
      scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + row.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top - headerHeight - anchor.offset), left: expanded ? scroller.scrollLeft : 0 });
    }
    columnAnchor.current = null;
  }, [expanded]);
  const toggleAccountColumns = () => {
    const scroller = scrollerRef.current;
    if (scroller) {
      const top = scroller.getBoundingClientRect().top + (scroller.querySelector("thead")?.getBoundingClientRect().height || 0);
      let firstVisible = null;
      for (const [id, row] of rowRefs.current) {
        const rect = row.getBoundingClientRect();
        if (rect.bottom <= top) continue;
        const anchor = { id, offset: rect.top - top };
        firstVisible ||= anchor;
        if (rect.top >= top) { columnAnchor.current = anchor; break; }
      }
      columnAnchor.current ||= firstVisible;
    }
    setAccountsExpanded((value) => !value);
  };
  const jumpToCurrent = () => { clear(); setJumpRequest((request) => request + 1); };
  return <section className={`fpt-planner-table${expanded ? " fpt-accounts-expanded" : ""}`} aria-label="Planner transactions" aria-busy={loading}>
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
      <button type="button" className="fpt-jump-current" disabled={loading || currentId == null}
        aria-controls={tableId} onClick={jumpToCurrent}>Jump to current</button>
      <button type="button" className="fpt-account-columns-toggle-mobile" disabled={loading || !accountColumns.length}
        aria-controls={tableId} aria-expanded={expanded} onClick={toggleAccountColumns}>
        {expanded ? "Collapse accounts" : "Expand accounts"}
      </button>
      <span className="fpt-count" aria-live="polite">{visible.length}{filtered ? ` of ${rows.length}` : ""} {visible.length === 1 ? "transaction" : "transactions"}</span>
    </div>
    {!visible.length ? <div className="fpt-empty" role="status">
      <strong>{loading ? "Loading transactions…" : filtered ? "No transactions match your filters" : "No transactions in this date range"}</strong>
      <p>{filtered ? "Try another search or show all statuses." : "Change the dates above or add a transaction to your planner."}</p>
      {filtered && <button type="button" className="fp-button fp-secondary" onClick={clear}>Clear filters</button>}
    </div> : <div className="fpt-table-wrap" id={tableId} ref={scrollerRef} role="region"
      aria-label="Scrollable transaction table" aria-describedby={`${tableId}-hint`} tabIndex={0}>
      <table className="fpt-table">
        <caption className="fp-sr-only">Recorded and planned transactions in date order. Expand the running balance column to show the account list beneath the totals.</caption>
        <colgroup><col style={{ width: "12%" }}/><col style={{ width: "24%" }}/><col style={{ width: "16%" }}/><col style={{ width: "16%" }}/><col style={{ width: "32%" }}/></colgroup>
        <thead><tr><th scope="col">Date</th><th scope="col">Description</th><th scope="col">USD</th><th scope="col">PHP</th>
          <th scope="col" className="fpt-projection-heading"><span>Running balance</span>
            <button type="button" className="fpt-account-columns-toggle" aria-expanded={expanded} aria-controls={tableId}
              disabled={loading || !accountColumns.length} onClick={toggleAccountColumns}>{expanded ? "Collapse accounts" : "Expand accounts"}</button>
          </th></tr></thead>
        <tbody>{visible.map((row, index) => {
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
          const currentRow = String(row.id) === currentId;
          const isToday = row.date === today;
          return <tr key={row.id} ref={(node) => {
            if (node) rowRefs.current.set(String(row.id), node); else rowRefs.current.delete(String(row.id));
          }} aria-current={currentRow ? "true" : undefined} data-row-id={row.id}
            className={`fpt-row fpt-category-${category.key}${dateSpans.has(index) ? " fpt-date-start" : ""}${recorded(row, today) ? " fpt-row-recorded" : ""}${isToday ? " fpt-row-today" : ""}${currentRow ? " fpt-row-current" : ""}`}>
            {dateSpans.has(index) && <td className="fpt-date" rowSpan={dateSpans.get(index)}>
              <time dateTime={row.date} title={formatDate(row.date, { year: "numeric" })}>{formatDate(row.date, { month: "short", day: "numeric" })}</time>
            </td>}
            <td className="fpt-transaction">
              <strong>{row.description}</strong>
              {(isToday || currentRow) && <span className="fpt-today-tag">{currentRow ? isToday ? "Latest today" : row.date < today ? "Latest activity" : "Next up" : "Today"}</span>}
              <div className="fpt-row-meta"><span className="fpt-category">{category.label}</span>{row.estimated && <span>Estimated</span>}
                {row.recurring && <span>Repeats</span>}
                <details className="fpt-details"><summary aria-label={`Details for ${row.description}`}>Details</summary>
                  <div className="fpt-detail-body"><SourceLabel row={row}/>
                    <div className="fpt-account" data-label="Account">{assigned.from || assigned.to ?
              <span className="fpt-account-pair"><span>{assigned.from}</span><small>to {assigned.to}</small></span> :
              <span>{assigned.names.slice(0, 2).join(" · ")}{assigned.names.length > 2 ? ` +${assigned.names.length - 2}` : ""}</span>}</div>
                    <NativeAmount row={row}/>
                    <div className="fpt-status-cell"><Status row={row} today={today}/>
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
            </div>
                    <dl className="fpt-extra-balances">
                      {[["Annual reserve · USD", row.reserveUsd, "USD"], ["Annual reserve · PHP", row.reservePhp, "PHP"],
                        ["Savings · USD", row.savingsUsd, "USD"], ["Savings · PHP", row.savingsPhp, "PHP"]].filter(([, value]) => Number.isFinite(value)).map(([label, value, currency]) =>
                          <div key={label}><dt>{label}</dt><dd>{money(value, currency)}</dd></div>)}
                    </dl>
                  </div>
                </details>
              </div>
            </td>
            {["USD", "PHP"].map((currency) => {
              const value = Number(currency === "USD" ? row.usd : row.php) || 0;
              return <td key={currency} className={`fpt-amount ${value < 0 ? "fpt-flow-out" : value > 0 ? "fpt-flow-in" : "fpt-flow-zero"}`}>{money(value, currency)}</td>;
            })}
            <td className="fpt-projection" data-label="Running balance">{inCurrentBalance ? <small>Included in current balance</small>
                : plan.continuous && row.date < today ? <small>Past due · review payment</small>
                  : <div className="fpt-money-stack">{[["USD", Object.hasOwn(row, "projectedBalanceUsd") ? row.projectedBalanceUsd : row.balanceUsd],
                    ["PHP", Object.hasOwn(row, "projectedBalancePhp") ? row.projectedBalancePhp : row.balancePhp]].map(([currency, value]) =>
                    <span key={currency} className={value < 0 ? "fpt-negative" : ""}><small>{currency}</small>{balance(value, currency)}</span>)}</div>}{expanded && <dl className="fpt-account-list" aria-label={`Account balances for ${row.description}`}>
                {accountColumns.map((account) => {
                  const snapshot = row.accountBalanceSnapshot?.find((item) => Number(item.accountId) === Number(account.id));
                  const value = row.accountBalanceSnapshotKind === "unavailable" ? null : snapshot?.balance;
                  return <div key={account.id} data-account-id={account.id} title={row.accountBalanceSnapshotNote}>
                    <dt>{accountName(account)}</dt><dd>{Number.isFinite(value) ? money(value, account.currency) : "\u2014"}
                    {Number.isFinite(value) && ["credit", "loan"].includes(account.type) && <small>{value < 0 ? "Credit balance" : "Balance owed"}</small>}</dd>
                  </div>;
                })}
              </dl>}</td>

          </tr>;
        })}</tbody>
      </table>
    </div>}
    <p className="fpt-footnote" id={`${tableId}-hint`}>{expanded
      ? "Account balances are listed beneath the totals. Unavailable history is shown as an em dash. Future balances are projected."
      : "Recorded activity is included in current balances. Expand accounts to see the account list. Rotate your phone for a wider landscape view."}</p>
  </section>;
}
