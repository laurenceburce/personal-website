"use client";

import { useEffect, useRef, useState } from "react";
import { formatDate, localDate, money, roundMoney } from "../lib/financePlanner.mjs";
import { getPlanRowCategory } from "../lib/financePlanPresentation.mjs";
import { SourceLabel } from "./FinancePlanLedger";
import "./finance-planner-table.css";

const recorded = (row, today) => Boolean(row.completed || row.recordedInAccounts ||
  (row.source === "transaction" && !row.scheduled && row.date <= today));
const accountRecorded = (row, today) => Boolean(row.recordedInAccounts ||
  ["plan", "transaction"].includes(row.completionSource) ||
  (row.source === "transaction" && !row.scheduled && row.date <= today));
const signed = (amount, currency) => `${amount > 0 ? "+" : ""}${money(amount, currency)}`;
const balance = (value, currency) => Number.isFinite(value) ? money(value, currency) : "Unavailable";
const accountName = (account) => account
  ? `${account.name || "Account"}${account.mask ? ` · ••${account.mask}` : ""}` : "Choose an account";
const accountTypeOrder = (account) => ({ checking: 0, savings: 1, credit: 2 }[account.type || account.account_type] ?? 3);
const ACCOUNT_COLUMN_TYPES = [["checking", "Checking"], ["savings", "Savings"], ["credit", "Credit cards"]];
const ACCOUNT_COLUMN_STORAGE_KEY = "finance:planner:account-columns:v1";
const defaultAccountColumns = () => ({ checking: true, savings: true, credit: true });

function creditCardBalances(row, accounts) {
  const snapshots = new Map((row.accountBalanceSnapshot || []).map((item) => [Number(item.accountId), item]));
  return ["USD", "PHP"].map((currency) => {
    const cards = accounts.filter((account) => account.currency === currency);
    if (!cards.length) return [currency, 0];
    if (!["recorded", "projected"].includes(row.accountBalanceSnapshotKind)) return [currency, null];
    const balances = cards.map((account) => snapshots.get(Number(account.id)));
    if (balances.some((item) => !Number.isFinite(item?.balance) || (item.currency && item.currency !== currency)))
      return [currency, null];
    return [currency, roundMoney(balances.reduce((total, item) => total + item.balance, 0))];
  });
}

function RunningTotals({ values, label, debt = false }) {
  return <dl className="fpt-running-totals" aria-label={label}>
    {values.map(([currency, value]) => <div key={currency}><dt>{currency}</dt>
      <dd className={debt ? value > 0 ? "fpt-negative" : value < 0 ? "fpt-positive" : "" : value < 0 ? "fpt-negative" : ""}
        title={debt && Number.isFinite(value) ? value < 0 ? "Credit balance" : "Balance owed" : undefined}>
        {balance(value, currency)}
      </dd></div>)}
  </dl>;
}

function transactionAmount(row, currency) {
  const amount = row.grossAmount ?? row.amount;
  // Show the full transaction even when cards or reserves cover its cash impact.
  if (["income", "expense"].includes(row.kind) &&
      ["USD", "PHP"].includes(row.currency) && Number.isFinite(amount)) {
    return row.currency === currency && amount !== 0 ? amount * (row.kind === "income" ? 1 : -1) : 0;
  }
  return Number(currency === "USD" ? row.usd : row.php) || 0;
}

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
  scroller.scrollTo({ top: Math.max(0, top), left: 0, behavior });
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

const validAccountId = (id) => id != null && Number.isFinite(Number(id)) && Number(id) > 0;
const sameAccount = (id, account) => validAccountId(id) && Number(id) === Number(account.id);
const normalizedName = (name) => String(name || "").trim().toLowerCase().replace(/•+/g, "•");

function legacyAccountMatch(name, account, accounts) {
  if (!name) return false;
  const normalized = normalizedName(name);
  const matches = accounts.filter((item) => normalized === normalizedName(item.name) ||
    normalized === normalizedName(accountName(item)));
  return new Set(matches.map((item) => Number(item.id))).size === 1 &&
    matches.some((item) => sameAccount(item.id, account));
}

function activityInAccount(activity, account, accounts) {
  return validAccountId(activity.accountId) ? sameAccount(activity.accountId, account)
    : legacyAccountMatch(activity.accountName, account, accounts);
}

function accountInvolved(row, account, accounts, plan) {
  const ids = [row.accountId, row.fromAccountId, row.toAccountId, row.creditAccountId,
    row.sourceAccountId, row.fundingAccountId, row.reserveAccountId, row.creditCardPaymentFor,
    ...(row.reserveAllocations || []).flatMap((item) => [item.sourceAccountId, item.reserveAccountId]),
    ...(row.accountMovements || []).map((move) => move.accountId),
    ...(row.recordedTransactions || []).map((item) => item.accountId)].filter(validAccountId);
  if (ids.some((id) => sameAccount(id, account))) return true;
  if ([...(row.accountMovements || []), ...(row.recordedTransactions || [])]
    .some((item) => activityInAccount(item, account, accounts))) return true;
  if (ids.length) return false;
  const assigned = rowAccounts(row, accounts, plan);
  return [assigned.from, assigned.to, ...(assigned.names || [])]
    .some((name) => legacyAccountMatch(name, account, accounts));
}

function fallbackAccountAmount(row, account) {
  const amount = row.grossAmount ?? row.amount;
  if (!Number.isFinite(amount)) return null;
  if (row.kind === "transfer" || row.kind === "conversion") {
    if (sameAccount(row.fromAccountId, account)) return row.currency === account.currency ? -amount : null;
    if (sameAccount(row.toAccountId || row.creditAccountId, account)) {
      if (row.currency === account.currency) return amount;
      const converted = account.currency === "USD" ? row.usd : row.php;
      return Number.isFinite(converted) ? converted : null;
    }
    return null;
  }
  // Secondary reserve/funding accounts may own only part of the native total.
  // When their posted legs are absent, do not invent a movement for them.
  if (validAccountId(row.accountId) && !sameAccount(row.accountId, account)) return null;
  if (!validAccountId(row.accountId) && (row.reserveAllocations?.length ||
    [row.sourceAccountId, row.reserveAccountId, row.fundingAccountId].some(validAccountId))) return null;
  return row.currency === account.currency ? (row.kind === "income" ? amount : -amount) : null;
}

function AccountChangeTag({ amount, balanceDelta, currency, debt, note }) {
  if (!Number.isFinite(amount)) return null;
  const delta = Number.isFinite(balanceDelta) ? balanceDelta : debt ? -amount : amount;
  const positive = debt ? delta < 0 : delta > 0;
  const change = `${delta > 0 ? "+" : ""}${(delta || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
  return <span className={`fpt-info-tag fpt-change-tag${delta ? positive ? " fpt-change-positive" : " fpt-change-negative" : ""}`}
    title={[note, debt ? `Transaction ${signed(amount, currency)}` : null].filter(Boolean).join(" · ")}>
    {change}
  </span>;
}

function AccountCell({ row, account, accounts, plan }) {
  const snapshot = row.accountBalanceSnapshot?.find((item) => Number(item.accountId) === Number(account.id));
  const value = row.accountBalanceSnapshotKind === "unavailable" ? null : snapshot?.balance;
  const involved = accountInvolved(row, account, accounts, plan);
  const moves = (row.accountMovements || []).filter((move) => activityInAccount(move, account, accounts));
  const receipts = (row.recordedTransactions || []).filter((item) => activityInAccount(item, account, accounts));
  const extraReceipts = receipts.filter((item) => !moves.some((move) => move.transactionId != null &&
    String(move.transactionId) === String(item.transactionId ?? item.id)));
  const fallbackAmount = fallbackAccountAmount(row, account);
  const debt = ["credit", "loan"].includes(account.type || account.account_type);
  const negative = Number.isFinite(value) && (debt ? value > 0 : value < 0);
  return <td className={`fpt-account-balance${negative ? " fpt-negative" : ""}`} data-account-id={account.id}
    title={row.accountBalanceSnapshotNote || "Account balance after this transaction"}>
    <span>{Number.isFinite(value) ? money(value, account.currency) : "\u2014"}</span>
    {Number.isFinite(value) && debt && <small>{value < 0 ? "Credit balance" : "Balance owed"}</small>}
    {involved && <div className="fpt-account-tags" aria-label={`Activity in ${accountName(account)} for ${row.description}`}>
      {moves.map((move, index) => <AccountChangeTag key={`move-${index}`} amount={move.amount}
        balanceDelta={move.balanceDelta} currency={move.currency || account.currency} debt={debt}
        note={move.label || row.description}/>)}
      {!moves.length && !receipts.length && fallbackAmount != null &&
        <AccountChangeTag amount={fallbackAmount} currency={account.currency} debt={debt} note={row.description}/>}
      {row.awaitingBankSync && <span className="fpt-info-tag">Awaiting bank match</span>}
      {extraReceipts.map((item, index) => <AccountChangeTag key={`receipt-${index}`}
        amount={(item.kind === "income" ? 1 : -1) * item.amount} currency={item.currency || account.currency} debt={debt}
        note={`${item.description || item.merchant || "Bank transaction"} · ${formatDate(item.date || row.date)}`}/>)}
    </div>}
  </td>;
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
  const [visibleAccountTypes, setVisibleAccountTypes] = useState(defaultAccountColumns);
  const [jumpRequest, setJumpRequest] = useState(0);
  const scrollerRef = useRef(null);
  const rowRefs = useRef(new Map());
  const positionedView = useRef(null);
  const handledJump = useRef(0);
  const columnAnchor = useRef(null);
  const current = selectCurrentPlannerRow(rows, today);
  const allAccountColumns = accounts.filter((account, index) => !account.isArchived && !account.is_archived &&
    !account.isSyncExcluded && !account.is_sync_excluded &&
    !account.mergedIntoAccountId && !account.merged_into_account_id && ["USD", "PHP"].includes(account.currency) &&
    accounts.findIndex((item) => Number(item.id) === Number(account.id)) === index)
    .sort((a, b) => ["USD", "PHP"].indexOf(a.currency) - ["USD", "PHP"].indexOf(b.currency) ||
      accountTypeOrder(a) - accountTypeOrder(b));
  const creditAccounts = allAccountColumns.filter((account) => (account.type || account.account_type) === "credit");
  const accountColumns = allAccountColumns.filter((account) => visibleAccountTypes[account.type || account.account_type] !== false);
  const expanded = accountsExpanded && allAccountColumns.length > 0;
  const hasAccountColumns = expanded && accountColumns.length > 0;
  const columnLayout = expanded ? accountColumns.map((account) => account.id).join(":") : "compact";
  const accountGroups = ["USD", "PHP"].map((currency) => ({
    currency, accounts: accountColumns.filter((account) => account.currency === currency),
  })).filter((group) => group.accounts.length);
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
  const transactionCount = visible.filter((row) => !row.isOpeningBalance).length;
  const totalTransactionCount = rows.filter((row) => !row.isOpeningBalance).length;
  const clear = () => { setSearch(""); setStatus("all"); };
  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(ACCOUNT_COLUMN_STORAGE_KEY));
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
      setVisibleAccountTypes(Object.fromEntries(ACCOUNT_COLUMN_TYPES.map(([type]) =>
        [type, typeof saved[type] === "boolean" ? saved[type] : true])));
    } catch { /* Storage is optional; every account type remains visible by default. */ }
  }, []);
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
        scroller.getBoundingClientRect().top - headerHeight - anchor.offset), left: hasAccountColumns ? scroller.scrollLeft : 0 });
    }
    columnAnchor.current = null;
  }, [expanded, columnLayout]);
  const captureColumnAnchor = () => {
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
  };
  const toggleAccountColumns = () => {
    captureColumnAnchor();
    setAccountsExpanded((value) => !value);
  };
  const changeAccountTypeVisibility = (type, checked) => {
    captureColumnAnchor();
    const next = { ...visibleAccountTypes, [type]: checked };
    setVisibleAccountTypes(next);
    try { window.localStorage.setItem(ACCOUNT_COLUMN_STORAGE_KEY, JSON.stringify(next)); }
    catch { /* Keep the selected columns usable when browser storage is unavailable. */ }
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
      {expanded && <button type="button" className="fpt-account-columns-toggle" disabled={loading || !allAccountColumns.length}
        aria-controls={tableId} aria-expanded={expanded} onClick={toggleAccountColumns}>
        {expanded ? "Collapse accounts" : "Expand accounts"}
      </button>}
      <span className="fpt-count" aria-live="polite">{transactionCount}{filtered ? ` of ${totalTransactionCount}` : ""} {transactionCount === 1 ? "transaction" : "transactions"}</span>
    </div>
    {expanded && <fieldset className="fpt-account-visibility" disabled={loading}>
      <legend>Account columns</legend>
      <div className="fpt-account-visibility-options">{ACCOUNT_COLUMN_TYPES.map(([type, label]) =>
        <label key={type}><input type="checkbox" checked={visibleAccountTypes[type]} aria-controls={tableId}
          onChange={(event) => changeAccountTypeVisibility(type, event.target.checked)}/><span>{label}</span></label>)}
        <span className="fpt-account-visibility-note">Running totals include all accounts.</span>
      </div>
      {!accountColumns.length && <p role="status">All account columns are hidden. Select an account type to show it.</p>}
    </fieldset>}
    {!visible.length ? <div className="fpt-empty" role="status">
      <strong>{loading ? "Loading transactions…" : filtered ? "No transactions match your filters" : "No transactions in this date range"}</strong>
      <p>{filtered ? "Try another search or show all statuses." : "Change the dates above or add a transaction to your planner."}</p>
      {filtered && <button type="button" className="fp-button fp-secondary" onClick={clear}>Clear filters</button>}
    </div> : <div className="fpt-table-wrap" id={tableId} ref={scrollerRef} role="region"
      aria-label="Scrollable transaction table" aria-describedby={`${tableId}-hint`} tabIndex={0}>
      <table className="fpt-table" style={expanded ? { width: `${970 + accountColumns.length * 190}px`, minWidth: "100%" } : undefined}>
        <caption className="fp-sr-only">Opening balances and recorded and planned transactions in date order. Running balances show account funds and credit cards side by side in USD and PHP. Expand to show individual account columns grouped by currency to the right.</caption>
        <colgroup><col style={{ width: expanded ? "90px" : "7%" }}/><col style={{ width: expanded ? "240px" : "27%" }}/>
          <col style={{ width: expanded ? "120px" : "10%" }}/><col style={{ width: expanded ? "120px" : "10%" }}/>
          <col style={{ width: expanded ? "400px" : "46%" }}/></colgroup>
        {expanded && accountGroups.map((group) => <colgroup key={group.currency}>
          {group.accounts.map((account) => <col key={account.id} style={{ width: "190px" }}/>)}</colgroup>)}
        <thead><tr><th scope="col" rowSpan={hasAccountColumns ? 2 : undefined}>Date</th>
          <th scope="col" rowSpan={hasAccountColumns ? 2 : undefined}>Description</th>
          <th scope="col" rowSpan={hasAccountColumns ? 2 : undefined}>USD</th><th scope="col" rowSpan={hasAccountColumns ? 2 : undefined}>PHP</th>
          <th scope="col" rowSpan={hasAccountColumns ? 2 : undefined} className="fpt-projection-heading"><span>Running balance</span>
            <button type="button" className="fpt-balance-expand" disabled={loading || !allAccountColumns.length}
              aria-controls={tableId} aria-expanded={expanded} onClick={toggleAccountColumns}>
              {expanded ? "Collapse accounts" : "Expand accounts"}
            </button>
            <div className="fpt-balance-sections"><span>Account funds</span><span title="Positive balances are owed; negative balances are credit. Loans are shown in individual account columns.">Credit cards</span></div>
          </th>
          {expanded && accountGroups.map((group) => <th key={group.currency} scope="colgroup"
            className="fpt-currency-heading" colSpan={group.accounts.length} data-currency={group.currency}>{group.currency}</th>)}
        </tr>{hasAccountColumns && <tr>{accountColumns.map((account) => <th key={account.id} scope="col" className="fpt-account-balance-heading" data-account-id={account.id}>
          <strong>{accountName(account)}</strong><small>{({ checking: "Checking", savings: "Savings", credit: "Credit card", loan: "Loan", cash: "Cash" })[account.type || account.account_type] || "Account"}</small>
        </th>)}</tr>}</thead>
        <tbody>{visible.map((row, index) => {
          const category = getPlanRowCategory(row);
          const manualEntry = (row.source === "manual" || row.planGenerated) && plan.entries?.find((entry) => entry.id === row.entryId);
          const editableOccurrence = row.editable && (["salary", "bill", "allocation", "reserve"].includes(row.source) || (row.source === "manual" && row.recurring));
          const canRecord = !recorded(row, today) && onRecord && (['salary', 'bill', 'creditCardDue'].includes(row.source) ||
            (row.source === "manual" && row.kind === "transfer" && row.amountMode === "cardBalance"));
          const canToggle = onToggleComplete && row.completionSource !== "transaction" &&
            !(row.manualPlannerSource && recorded(row, today));
          const canEdit = manualEntry || editableOccurrence;
          const actions = canEdit || canToggle || (row.isOverride && onResetOccurrence);
          const inCurrentBalance = plan.balanceMode !== "snapshot" && accountRecorded(row, today) && row.date <= today;
          const hasRowBalances = ["recorded", "projected"].includes(row.accountBalanceSnapshotKind) &&
            Object.hasOwn(row, "projectedBalanceUsd") && Object.hasOwn(row, "projectedBalancePhp");
          const currentRow = String(row.id) === currentId;
          const isToday = row.date === today;
          const done = recorded(row, today);
          const overdue = !done && row.date < today;
          return <tr key={row.id} ref={(node) => {
            if (node) rowRefs.current.set(String(row.id), node); else rowRefs.current.delete(String(row.id));
          }} aria-current={currentRow ? "true" : undefined} data-row-id={row.id}
            className={`fpt-row fpt-category-${category.key}${dateSpans.has(index) ? " fpt-date-start" : ""}${recorded(row, today) ? " fpt-row-recorded" : ""}${overdue ? " fpt-row-overdue" : ""}${isToday ? " fpt-row-today" : ""}${currentRow ? " fpt-row-current" : ""}`}>
            {dateSpans.has(index) && <td className="fpt-date" rowSpan={dateSpans.get(index)}>
              <time dateTime={row.date} title={formatDate(row.date, { year: "numeric" })}>{formatDate(row.date, { month: "short", day: "numeric" })}</time>
            </td>}
            <td className="fpt-transaction">
              <div className="fpt-description-line"><div className="fpt-description-title"><strong>{row.description}</strong>
                {(actions || canRecord) && <details className="fpt-action-menu"><summary aria-label={`Actions for ${row.description}`}>•••</summary><div
                  onClick={(event) => { if (event.target.closest("button")) event.currentTarget.parentElement.open = false; }}>
                {canRecord && <button type="button" className="fpt-record" disabled={busy}
                  aria-label={`Record ${row.kind === "income" ? "receipt" : "payment"}: ${row.description}`} onClick={() => !busy && onRecord(row)}>
                  {row.kind === "income" ? "Record receipt" : "Record payment"}</button>}
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
                {row.isOpeningBalance ? <span className="fpt-status-pill">Start</span>
                  : done ? <span className="fpt-status-pill fpt-status-done">Done</span>
                  : overdue ? <span className="fpt-status-pill fpt-status-overdue">Past due</span>
                    : <span className="fpt-status-pill">Planned</span>}
              </div>
              {!row.isOpeningBalance && (isToday || currentRow) && <span className="fpt-today-tag">{currentRow ? isToday ? "Latest today" : row.date < today ? "Latest activity" : "Next up" : "Today"}</span>}
            </td>
            {["USD", "PHP"].map((currency) => {
              const value = transactionAmount(row, currency);
              return <td key={currency} className={`fpt-amount ${value < 0 ? "fpt-flow-out" : value > 0 ? "fpt-flow-in" : "fpt-flow-zero"}`}>{row.isOpeningBalance ? "—" : money(value, currency)}</td>;
            })}
            <td className="fpt-projection" data-label="Running balance" title={row.accountBalanceSnapshotNote}><div className="fpt-running-sections"><div>{!hasRowBalances && inCurrentBalance ? <small className="fpt-balance-note">Included in current balance</small>
                : !hasRowBalances && plan.continuous && row.date < today ? <small className="fpt-balance-note">{done ? "Marked done · no account record" : "Past due · review payment"}</small>
                  : <RunningTotals label="Account funds" values={[["USD", Object.hasOwn(row, "projectedBalanceUsd") ? row.projectedBalanceUsd : row.balanceUsd],
                    ["PHP", Object.hasOwn(row, "projectedBalancePhp") ? row.projectedBalancePhp : row.balancePhp]]}/>}
              </div><RunningTotals label="Credit cards" values={creditCardBalances(row, creditAccounts)} debt/></div>
            </td>
            {expanded && accountColumns.map((account) => <AccountCell key={account.id} row={row} account={account}
              accounts={accounts} plan={plan} today={today}/>)}

          </tr>;
        })}</tbody>
      </table>
    </div>}
    <p className="fpt-footnote" id={`${tableId}-hint`}>{expanded
      ? "Scroll sideways to view each account balance and activity tags. Unavailable history is shown as an em dash. Future balances are projected."
      : "Account funds and credit cards are separate totals in USD and PHP. Positive card balances are owed; negative balances are credit. Scroll sideways on smaller screens, or expand accounts for individual balances and activity."}</p>
    {visible.length > 0 && <details className="fpt-notes">
      <summary>Reserves &amp; planning notes</summary>
      <div className="fpt-notes-list">{visible.map((row) => <article key={row.id} data-notes-for={row.id}>
        <header><time dateTime={row.date}>{formatDate(row.date, { year: "numeric" })}</time><strong>{row.description}</strong></header>
        <dl className="fpt-note-balances">
          {[["Annual reserve", row.reserveUsd, "USD"], ["Annual reserve", row.reservePhp, "PHP"],
            ["Savings", row.savingsUsd, "USD"], ["Savings", row.savingsPhp, "PHP"]]
            .filter(([, value]) => Number.isFinite(value)).map(([label, value, currency]) =>
              <div key={`${label}-${currency}`}><dt>{label} · {currency}</dt><dd>{money(value, currency)}</dd></div>)}
        </dl>
        <div className="fpt-note-content"><SourceLabel row={row}/>{row.notes && <p>{row.notes}</p>}</div>
      </article>)}</div>
    </details>}
  </section>;
}
