"use client";

import { formatDate, money } from "../lib/financePlanner.mjs";
import "./finance-planner-analytics.css";

const balance = (value, currency) => value == null ? "—" : money(value, currency);
const changeText = (value, currency) => value == null ? "Balance unavailable" : `${value > 0 ? "+" : ""}${money(value, currency)}`;

function BalanceTrend({ points, currency, endDate }) {
  const values = points.map((point) => point[currency]);
  if (points.length < 2 || values.some((value) => value == null)) return null;
  const first = Date.parse(`${points[0].date}T00:00:00Z`);
  const last = Date.parse(`${endDate}T00:00:00Z`);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low || Math.max(Math.abs(high) * 0.1, 1);
  const x = (date) => 6 + ((Date.parse(`${date}T00:00:00Z`) - first) / Math.max(last - first, 1)) * 308;
  const y = (value) => 67 - ((value - low) / span) * 48;
  const line = points.map((point, index) => `${index ? "L" : "M"}${x(point.date).toFixed(2)},${y(point[currency]).toFixed(2)}`).join(" ");
  const improving = values.at(-1) >= values[0];
  return <div className={`fpla-trend ${improving ? "fpla-trend-up" : "fpla-trend-down"}`}>
    <svg viewBox="0 0 320 82" role="img" aria-label={`${currency} account balance projection from ${formatDate(points[0].date)} through ${formatDate(endDate)}`}>
      <path d={`${line} L${x(points.at(-1).date)},78 L6,78 Z`} className="fpla-trend-area" />
      <path d={line} className="fpla-trend-line" />
      <circle cx={x(points.at(-1).date)} cy={y(values.at(-1))} r="3.5" />
    </svg>
    <div><span>Now</span><span>{formatDate(endDate)}</span></div>
  </div>;
}

export default function FinancePlannerAnalytics({ analytics, loading = false, onReviewAccounts }) {
  if (!analytics) return null;
  const { assets, debt, range, hasProjection, cashflow, accounts } = analytics;
  const hasDebt = accounts.some((account) => account.isDebt);
  const value = (amount, currency) => loading ? "—" : balance(amount, currency);
  return <section className="fpla-analytics" aria-label="Current and projected balances" aria-busy={loading}>
    <div className="fpla-balance-cards">
      {["USD", "PHP"].map((currency) => <article className="fpla-balance-card" key={currency}>
        <header><span className="fpla-currency">{currency}</span><span>Account balances</span></header>
        <dl className={`fpla-comparison${[assets[currency].current, assets[currency].projected].some((amount) => balance(amount, currency).length > 13) ? " fpla-comparison-long" : ""}`}>
          <div><dt>Current balance</dt><dd>{balance(assets[currency].current, currency)}<small>Live across your accounts</small></dd></div>
          <div><dt>Projected balance</dt><dd className={assets[currency].projected < 0 ? "fpla-negative" : ""}>{hasProjection ? value(assets[currency].projected, currency) : "—"}<small>{hasProjection ? `By ${formatDate(range.endDate, { year: "numeric" })}` : "Choose a future date to project"}</small></dd></div>
        </dl>
        {hasProjection && <div className={`fpla-change ${assets[currency].change < 0 ? "fpla-change-down" : ""}`}>
          <span>Projected change</span><strong>{loading ? "—" : changeText(assets[currency].change, currency)}</strong>
        </div>}
        {!loading && hasProjection && <BalanceTrend points={analytics.points} currency={currency} endDate={range.endDate} />}
        {hasDebt && <div className="fpla-debt"><span>Card &amp; loan balances</span>
          <strong>{balance(debt[currency].current, currency)}{hasProjection && <> <span aria-hidden="true">→</span> {value(debt[currency].projected, currency)}</>}</strong>
          <small>{hasProjection ? "Current → projected" : "Current debt or credit balance"}</small>
        </div>}
      </article>)}
    </div>
    <div className="fpla-range-summary">
      <div><span>{hasProjection ? "Upcoming in this range" : "Viewing past transactions"}</span><strong>{hasProjection ? loading ? "Updating projection…" : `${analytics.upcomingCount} ${analytics.upcomingCount === 1 ? "planned row" : "planned rows"}` : `${formatDate(range.startDate)} – ${formatDate(range.endDate)}`}</strong></div>
      {hasProjection && ["USD", "PHP"].map((currency) => <dl key={currency}>
        <div><dt>Income · {currency}</dt><dd>{value(cashflow[currency].income, currency)}</dd></div>
        <div><dt>Payments · {currency}</dt><dd>{value(cashflow[currency].payments, currency)}</dd></div>
      </dl>)}
      {onReviewAccounts && <button type="button" className="fp-button fp-text" onClick={onReviewAccounts}>Review accounts →</button>}
    </div>
    {analytics.unassignedCount > 0 && <p className="fpla-note" role="status">{analytics.unassignedCount} upcoming {analytics.unassignedCount === 1 ? "row needs an account" : "rows need accounts"} before {analytics.unassignedCount === 1 ? "it can" : "they can"} update projected balances.</p>}
    {analytics.awaitingBankSyncCount > 0 && <p className="fpla-note">Current balances include recorded payments awaiting a bank match.</p>}
    {hasProjection && analytics.overdueCount > 0 && <p className="fpla-note">Past planned rows remain in the table for review. Projections start from today’s live balances.</p>}
    {!hasProjection && <p className="fpla-note">Current balances remain live. This date range contains past activity, so it has no future balance projection.</p>}
    {!!accounts.length && <details className="fpla-account-details"><summary>Balances by account <span>{accounts.length}</span></summary>
      <div className="fpla-account-list">{accounts.map((account) => <article key={account.id}>
        <div><strong>{account.name}{account.mask ? ` · •${account.mask}` : ""}</strong><small>{account.isDebt ? "Balance owed" : "Account balance"} · {account.currency}</small></div>
        <dl><div><dt>Current</dt><dd>{balance(account.current, account.currency)}</dd></div><div><dt>Projected</dt><dd>{hasProjection ? value(account.projected, account.currency) : "—"}</dd></div></dl>
      </article>)}</div>
    </details>}
  </section>;
}
