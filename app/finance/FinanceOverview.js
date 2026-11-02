"use client";

import { useId, useMemo, useState } from "react";
import { formatDate, localDate, money } from "../lib/financePlanner.mjs";
import { getFinanceInsights } from "../lib/financeInsights.mjs";
import "./finance-overview.css";

const signed = (amount, currency) =>
  `${amount > 0 ? "+" : ""}${money(amount, currency)}`;
const monthLabel = (month, long = false) =>
  new Intl.DateTimeFormat("en-US", {
    month: long ? "long" : "short",
    year: long ? "numeric" : undefined,
    timeZone: "UTC",
  }).format(new Date(`${month}-01T12:00:00Z`));
const compactMoney = (value, currency) =>
  new Intl.NumberFormat(currency === "PHP" ? "en-PH" : "en-US", {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);

function Action({ children, onClick, primary = false }) {
  return (
    <button
      type="button"
      className={`fpi-action ${primary ? "fpi-action-primary" : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Metric({
  title,
  value,
  detail,
  glyph,
  accent = false,
  negative = false,
  children,
}) {
  return (
    <article className={`fpi-metric ${accent ? "fpi-metric-accent" : ""}`}>
      <div className="fpi-metric-label">
        <span>{title}</span>
        <span className="fpi-metric-icon" aria-hidden="true">
          {glyph}
        </span>
      </div>
      <strong className={negative ? "fpi-negative" : ""}>{value}</strong>
      <p>{detail}</p>
      {children}
    </article>
  );
}

function CashflowChart({ insights, currency, onAddTransaction }) {
  const [selectedMonth, setSelectedMonth] = useState("");
  const selected =
    insights.series.find((period) => period.month === selectedMonth) ||
    insights.series.at(-1);
  const maximum = Math.max(
    ...insights.series.flatMap((row) => [row.income, row.expenses]),
    1,
  );
  const magnitude = 10 ** Math.floor(Math.log10(maximum));
  const scale = Math.ceil(maximum / magnitude / 2) * magnitude * 2;
  const chartId = useId();
  return (
    <section
      className="fpi-card fpi-cashflow-card"
      aria-labelledby={`${chartId}-title`}
    >
      <header className="fpi-card-heading">
        <div>
          <h2 id={`${chartId}-title`}>Money in, money out</h2>
          <p>Your recorded activity over six months</p>
        </div>
        <span className="fpi-pill">Actual</span>
      </header>
      <div className="fpi-chart-topline">
        <span>{monthLabel(selected.month, true)}</span>
        <div>
          <span>
            <i className="fpi-key-income" />
            Income <strong>{money(selected.income, currency)}</strong>
          </span>
          <span>
            <i className="fpi-key-expense" />
            Spending <strong>{money(selected.expenses, currency)}</strong>
          </span>
        </div>
      </div>
      <div
        className="fpi-bar-chart"
        role="group"
        aria-label={`Six-month income and spending in ${currency}. Focus or select a month to inspect its values.`}
      >
        <div className="fpi-chart-scale" aria-hidden="true">
          {[4, 3, 2, 1, 0].map((step) => (
            <span key={step}>{compactMoney((scale * step) / 4, currency)}</span>
          ))}
        </div>
        <div className="fpi-chart-plot">
          <div className="fpi-chart-grid" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((step) => (
              <span key={step} />
            ))}
          </div>
          <div className="fpi-chart-columns">
            {insights.series.map((period) => (
              <div className="fpi-chart-month" key={period.month}>
                <button
                  className={`fpi-month-bars ${selected.month === period.month ? "fpi-month-selected" : ""}`}
                  type="button"
                  aria-label={`${monthLabel(period.month, true)}: income ${money(period.income, currency)}, spending ${money(period.expenses, currency)}, net cash flow ${money(period.net, currency)}`}
                  aria-pressed={selected.month === period.month}
                  onClick={() => setSelectedMonth(period.month)}
                  onFocus={() => setSelectedMonth(period.month)}
                  onMouseEnter={() => setSelectedMonth(period.month)}
                >
                  <span
                    className="fpi-income-bar"
                    style={{ height: `${(period.income / scale) * 100}%` }}
                  />
                  <span
                    className="fpi-expense-bar"
                    style={{ height: `${(period.expenses / scale) * 100}%` }}
                  />
                </button>
                <span className="fpi-month-label">
                  {monthLabel(period.month)}
                  <small>{period.month.slice(0, 4)}</small>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
      {!insights.hasHistory && (
        <div className="fpi-chart-empty">
          <strong>No posted income or spending in this period.</strong>
          <span>
            Add income or an expense, or connect a bank to import activity.
          </span>
          <Action onClick={onAddTransaction}>Add a transaction →</Action>
        </div>
      )}
      <details className="fpi-chart-data">
        <summary>View chart values</summary>
        <table>
          <caption>Recorded income and spending in {currency}</caption>
          <thead>
            <tr>
              <th>Month</th>
              <th>Income</th>
              <th>Spending</th>
              <th>Net</th>
            </tr>
          </thead>
          <tbody>
            {insights.series.map((period) => (
              <tr key={period.month}>
                <th>{monthLabel(period.month, true)}</th>
                <td>{money(period.income, currency)}</td>
                <td>{money(period.expenses, currency)}</td>
                <td>{signed(period.net, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

function AllocationChart({ insights, currency, onNavigate }) {
  const id = useId();
  const circumference = 2 * Math.PI * 52;
  let offset = 0;
  const segments = insights.allocationSegments.filter(
    (segment) => segment.value > 0,
  );
  return (
    <section
      className="fpi-card fpi-allocation-card"
      aria-labelledby={`${id}-title`}
    >
      <header className="fpi-card-heading">
        <div>
          <h2 id={`${id}-title`}>Where your salary goes</h2>
          <p>Your monthly plan, before actual spending</p>
        </div>
        <span className="fpi-pill fpi-pill-plan">Planned</span>
      </header>
      <div className="fpi-allocation-content">
        <div className="fpi-donut-wrap">
          <svg
            className="fpi-donut"
            viewBox="0 0 140 140"
            role="img"
            aria-labelledby={`${id}-chart-title ${id}-chart-desc`}
          >
            <title id={`${id}-chart-title`}>Planned monthly allocation</title>
            <desc id={`${id}-chart-desc`}>
              {segments.length
                ? segments
                    .map(
                      (segment) =>
                        `${segment.label}: ${money(segment.value, currency)}`,
                    )
                    .join(". ")
                : "No salary or commitments configured yet."}
            </desc>
            <circle
              cx="70"
              cy="70"
              r="52"
              fill="none"
              stroke="#edf2ee"
              strokeWidth="17"
            />
            {segments.map((segment) => {
              const length = insights.allocationTotal
                ? (segment.value / insights.allocationTotal) * circumference
                : 0;
              const position = offset;
              offset += length;
              return (
                <circle
                  key={segment.id}
                  cx="70"
                  cy="70"
                  r="52"
                  fill="none"
                  stroke={segment.color}
                  strokeWidth="17"
                  strokeDasharray={`${Math.max(0, length - Math.min(2, length / 3))} ${circumference}`}
                  strokeDashoffset={-position}
                  transform="rotate(-90 70 70)"
                />
              );
            })}
          </svg>
          <div className="fpi-donut-center">
            <strong
              className={insights.plannedRemaining < 0 ? "fpi-negative" : ""}
            >
              {compactMoney(insights.plannedRemaining, currency)}
            </strong>
            <span>
              {insights.plannedRemaining < 0 ? "over budget" : "left to plan"}
            </span>
          </div>
        </div>
        <ul className="fpi-allocation-legend">
          {insights.allocationSegments.map((segment) => (
            <li key={segment.id}>
              <span
                className="fpi-legend-dot"
                style={{ background: segment.color }}
              />
              <span>{segment.label}</span>
              <strong>{money(segment.value, currency)}</strong>
            </li>
          ))}
        </ul>
      </div>
      <p className="fpi-small-note">
        Annual reserves show the monthly equivalent of contributions needed
        across the paydays left before each next payment, after saved balances.
      </p>
      {(insights.annualImmediateUsd > 0 || insights.annualImmediatePhp > 0) && (
        <p className="fpi-notice" role="status">
          Annual bills need{" "}
          {insights.annualImmediate > 0
            ? money(insights.annualImmediate, currency)
            : currency === "USD"
              ? money(insights.annualImmediatePhp, "PHP")
              : money(insights.annualImmediateUsd)}{" "}
          before the next eligible payday, in addition to these monthly
          allocations.
        </p>
      )}
      {insights.annualEstimatedCount > 0 && (
        <p className="fpi-small-note">
          {insights.annualEstimatedCount} annual bill
          {insights.annualEstimatedCount === 1 ? " uses" : "s use"} an estimate.
          Add due dates and a salary schedule for payment-date calculations.
        </p>
      )}
      <div
        className={`fpi-plan-note ${insights.overBudget ? "fpi-plan-over" : ""}`}
      >
        <span>
          {insights.overBudget ? (
            `Your plan exceeds your salary by ${money(insights.overBudget, currency)}.`
          ) : (
            <>
              Based on a monthly salary of{" "}
              <strong>{money(insights.plannedIncome, currency)}</strong>.
            </>
          )}
        </span>
        <Action onClick={() => onNavigate("spending")}>Adjust plan →</Action>
      </div>
    </section>
  );
}

export default function FinanceOverview({
  document,
  activity = {},
  rate,
  month,
  currency = "USD",
  today = localDate(),
  onAddTransaction,
  onNavigate,
}) {
  const insights = useMemo(
    () =>
      getFinanceInsights({ document, activity, rate, month, currency, today }),
    [document, activity, rate, month, currency, today],
  );
  const dateLabel = monthLabel(insights.month, true);
  return (
    <div className="fpi-overview">
      {insights.partial && (
        <p className="fpi-notice" role="status">
          Activity totals and graphs are based on the latest 5,000 transactions
          in this period. Older transactions may be missing.
        </p>
      )}
      {insights.excludedUnsupportedCount > 0 && (
        <p className="fpi-notice" role="status">
          Transactions in currencies other than USD or PHP are excluded from
          these totals.
        </p>
      )}
      <section className="fpi-metrics" aria-label="Important finance metrics">
        <Metric
          title="Current net worth"
          value={
            insights.netWorth === null
              ? "—"
              : money(insights.netWorth, currency)
          }
          detail={
            insights.knownAccountCount
              ? `${insights.knownAccountCount} account${insights.knownAccountCount === 1 ? "" : "s"} · assets less credit & loans${insights.unavailableAccountCount ? ` · ${insights.unavailableAccountCount} balance unavailable` : ""}`
              : "Connect accounts to see your balances"
          }
          glyph="◎"
          negative={insights.netWorth !== null && insights.netWorth < 0}
        >
          {!insights.accountCount && (
            <Action onClick={() => onNavigate("accounts")}>
              Connect a bank →
            </Action>
          )}
        </Metric>
        <Metric
          title="Income received"
          value={money(insights.income, currency)}
          detail={`${dateLabel} · posted transactions`}
          glyph="↙"
        />
        <Metric
          title="Recorded spending"
          value={money(insights.expenses, currency)}
          detail={`${dateLabel} · posted transactions`}
          glyph="↗"
        />
        <Metric
          title="Net cash flow"
          value={signed(insights.net, currency)}
          detail={`${insights.transactionCount} posted transaction${insights.transactionCount === 1 ? "" : "s"} · income − spending`}
          glyph="↔"
          accent
          negative={insights.net < 0}
        />
      </section>
      {(insights.pendingCount > 0 || insights.scheduledCount > 0) && (
        <p className="fpi-actual-note">
          {insights.pendingCount > 0
            ? `${insights.pendingCount} pending transaction${insights.pendingCount === 1 ? "" : "s"}`
            : ""}
          {insights.pendingCount > 0 && insights.scheduledCount > 0
            ? " and "
            : ""}
          {insights.scheduledCount > 0
            ? `${insights.scheduledCount} future-dated transaction${insights.scheduledCount === 1 ? "" : "s"}`
            : ""}{" "}
          excluded from actual totals.
        </p>
      )}
      <div className="fpi-charts">
        <CashflowChart
          insights={insights}
          currency={currency}
          onAddTransaction={onAddTransaction}
        />
        <AllocationChart
          insights={insights}
          currency={currency}
          onNavigate={onNavigate}
        />
      </div>
      <div className="fpi-lower-grid">
        <section className="fpi-card">
          <header className="fpi-card-heading">
            <div>
              <h2>Bills this month</h2>
              <p>{dateLabel} · scheduled amounts</p>
            </div>
            <Action onClick={() => onNavigate("bills")}>All bills →</Action>
          </header>
          {insights.scheduledBills.length ? (
            <ul className="fpi-bill-list">
              {insights.scheduledBills.slice(0, 5).map((bill) => (
                <li key={`${bill.billId}-${bill.date}`}>
                  <time className="fpi-due-date" dateTime={bill.date}>
                    <strong>{Number(bill.date.slice(8))}</strong>
                    <span>{monthLabel(bill.date.slice(0, 7))}</span>
                  </time>
                  <div>
                    <strong>{bill.name}</strong>
                    <span>
                      {bill.cadence === "annual"
                        ? "Annual payment"
                        : bill.cadence === "payday"
                          ? "Every payday"
                          : "Monthly bill"}
                      {bill.isAutopay ? " · Auto payment" : ""}
                    </span>
                  </div>
                  <b>{money(bill.amount, bill.currency)}</b>
                </li>
              ))}
            </ul>
          ) : (
            <div className="fpi-list-empty">
              <strong>No dated bills for this month.</strong>
              <p>Add a bill and its due date to see it here.</p>
              <Action onClick={() => onNavigate("bills")}>
                Manage bills →
              </Action>
            </div>
          )}
          {insights.undatedBillCount > 0 && (
            <p className="fpi-small-note">
              {insights.undatedBillCount} bill
              {insights.undatedBillCount === 1 ? " needs" : "s need"} a due date
              to appear in the schedule.
            </p>
          )}
          {insights.scheduledBills.length > 5 && (
            <p className="fpi-small-note">
              Showing the first 5 of {insights.scheduledBills.length} scheduled
              payments.
            </p>
          )}
        </section>
        <section className="fpi-card">
          <header className="fpi-card-heading">
            <div>
              <h2>Recent activity</h2>
              <p>Bank imports and your one-time entries</p>
            </div>
            <Action onClick={() => onNavigate("transactions")}>
              View all →
            </Action>
          </header>
          {insights.recentTransactions.length ? (
            <ul className="fpi-recent-list">
              {insights.recentTransactions.map((transaction) => (
                <li key={transaction.id}>
                  <span
                    className={`fpi-transaction-glyph ${transaction.kind === "income" ? "fpi-transaction-income" : ""}`}
                    aria-hidden="true"
                  >
                    {transaction.kind === "income" ? "↙" : "↗"}
                  </span>
                  <div>
                    <strong>
                      {transaction.merchant ||
                        transaction.category ||
                        (transaction.kind === "income" ? "Income" : "Expense")}
                    </strong>
                    <span>
                      {formatDate(transaction.date)} ·{" "}
                      {transaction.provider
                        ? transaction.accountName || "Bank import"
                        : "One-time entry"}
                      {transaction.pending
                        ? " · Pending"
                        : transaction.scheduled
                          ? " · Scheduled"
                          : ""}
                    </span>
                  </div>
                  <div className="fpi-recent-amount">
                    <b
                      className={
                        transaction.kind === "income" ? "fpi-positive" : ""
                      }
                    >
                      {signed(
                        transaction.kind === "income"
                          ? transaction.displayAmount
                          : -transaction.displayAmount,
                        currency,
                      )}
                    </b>
                    {transaction.currency !== currency && (
                      <small>
                        {money(transaction.amount, transaction.currency)}
                      </small>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="fpi-list-empty">
              <strong>No transactions recorded this month.</strong>
              <p>
                A quick expense or income entry will update your metrics right
                away.
              </p>
              <Action primary onClick={onAddTransaction}>
                + Add a transaction
              </Action>
              <Action onClick={() => onNavigate("accounts")}>
                Or connect a bank →
              </Action>
            </div>
          )}
        </section>
      </div>
      <p className="fpi-overview-footnote">
        Actual totals use posted transactions through{" "}
        {formatDate(insights.asOf, { year: "numeric" })}; pending, future-dated,
        bank transfer, and loan-payment categories are excluded. Forecasts and
        salary allocations stay in your spending and budget plans. Net worth
        always uses the latest available account balances.
      </p>
    </div>
  );
}
