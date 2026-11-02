"use client";

import { money } from "../lib/financePlanner.mjs";
import { financeAccountLabel } from "./FinanceAccountSelect";
import "./finance-account-plan.css";

const balance = (value, currency) =>
  value === null || value === undefined ? "—" : money(value, currency);

export function AccountAllocationSummary({
  allocations = [],
  accounts = [],
  onNavigate,
}) {
  const assigned = allocations.filter((account) => account.roles?.length > 0);
  if (!assigned.length) return null;
  return (
    <section className="fap-section" aria-label="Account allocations">
      <header>
        <div>
          <h2>Your money by account</h2>
          <p>
            Saved reserves and planned payday movements alongside bank balances.
          </p>
        </div>
        {onNavigate && (
          <button
            type="button"
            className="fp-button fp-text"
            onClick={() => onNavigate("accounts")}
          >
            Manage accounts →
          </button>
        )}
      </header>
      <div className="fap-cards">
        {assigned.map((account) => (
          <article key={account.accountId} className="fap-card">
            <h3>
              {financeAccountLabel(
                accounts.find(
                  (item) => Number(item.id) === Number(account.accountId),
                ) || account,
              )}
            </h3>
            <dl>
              <div>
                <dt>Bank balance</dt>
                <dd>{balance(account.bankBalance, account.currency)}</dd>
              </div>
              {account.salaryPerPayday > 0 && (
                <div>
                  <dt>Salary received each payday</dt>
                  <dd>{money(account.salaryPerPayday, account.currency)}</dd>
                </div>
              )}
              {account.annualReserved > 0 && (
                <div>
                  <dt>Saved for annual bills</dt>
                  <dd>{money(account.annualReserved, account.currency)}</dd>
                </div>
              )}
              {account.annualPerPayday > 0 && (
                <div>
                  <dt>Annual funding each payday</dt>
                  <dd>{money(account.annualPerPayday, account.currency)}</dd>
                </div>
              )}
              {account.savingsPerPayday > 0 && (
                <div>
                  <dt>Savings each payday</dt>
                  <dd>{money(account.savingsPerPayday, account.currency)}</dd>
                </div>
              )}
              {account.annualReserved > 0 && (
                <div>
                  <dt>Balance outside annual reserves</dt>
                  <dd>
                    {balance(account.unallocatedBalance, account.currency)}
                  </dd>
                </div>
              )}
            </dl>
            {account.overassigned > 0 && (
              <p className="fap-warning" role="status">
                Annual reserves exceed this bank balance by{" "}
                {money(account.overassigned, account.currency)}. Review the
                saved amounts or account assignment.
              </p>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

export default function FinanceAccountPlanView({ projection }) {
  if (!projection?.accounts?.length && !projection?.warnings?.length)
    return null;
  return (
    <section className="fap-section" aria-label="Projected account balances">
      <header>
        <div>
          <h3>Projected balances by account</h3>
          <p>
            {projection.openingSource === "bank"
              ? "Starting from current synced balances. Set account starting balances when planning a different date."
              : "Uses the account starting balances set for this plan; other accounts use current synced balances."}{" "}
            These are forecasts.
          </p>
        </div>
      </header>
      {projection.warnings?.length > 0 && (
        <ul className="fap-warnings" role="status">
          {projection.warnings.map((warning, index) => (
            <li key={index}>
              {typeof warning === "string" ? warning : warning.message}
            </li>
          ))}
        </ul>
      )}
      <div className="fap-cards">
        {projection.accounts?.map((account) => (
          <article key={account.accountId} className="fap-card">
            <h4>
              {account.name}
              {account.mask ? ` · ••${account.mask}` : ""}
            </h4>
            <dl>
              <div>
                <dt>Starting balance</dt>
                <dd>{balance(account.openingBalance, account.currency)}</dd>
              </div>
              <div>
                <dt>
                  {["credit", "loan"].includes(account.type)
                    ? "Projected balance owed"
                    : "Projected ending balance"}
                </dt>
                <dd
                  className={
                    account.endingBalance < 0 &&
                    !["credit", "loan"].includes(account.type)
                      ? "fp-negative"
                      : ""
                  }
                >
                  {balance(account.endingBalance, account.currency)}
                </dd>
              </div>
              {account.endingAnnualReserved > 0 && (
                <div>
                  <dt>Projected annual reserves</dt>
                  <dd>
                    {money(account.endingAnnualReserved, account.currency)}
                  </dd>
                </div>
              )}
              {account.savingsAllocated > 0 && (
                <div>
                  <dt>Payday savings in this plan</dt>
                  <dd>{money(account.savingsAllocated, account.currency)}</dd>
                </div>
              )}
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}
