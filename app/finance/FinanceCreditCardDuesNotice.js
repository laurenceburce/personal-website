import { financeAccountLabel } from "./FinanceAccountSelect";

export default function FinanceCreditCardDuesNotice({ accounts = [], onReviewAccounts, paymentHistoryWarning }) {
  const cards = accounts.filter(
    (account) => account.isLinked && account.type === "credit" &&
      !account.isArchived && !account.mergedIntoAccountId,
  );
  if (!cards.length) return null;
  const missing = cards.filter((account) => {
    const due = account.creditCardDue;
    return due?.statementBalance == null || !Number.isFinite(Number(due.statementBalance)) ||
      !due.dueDate;
  });
  const stale = cards.filter(
    (account) => account.creditCardDueStatus === "stale" && !missing.includes(account),
  );
  const names = (items) => items.map(financeAccountLabel).join(", ");
  return (
    <div className="fp-credit-card-dues-notice">
      <p className="fp-plan-flow-note">
        Credit card statement balances are included automatically on their reported
        due dates. Future statements appear after the bank provides them.
      </p>
      {missing.length > 0 && (
        <p className="fp-plan-warning" role="status">
          Statement balances or due dates are unavailable for {names(missing)}.
          {" "}These cards need statement details before dues can appear in this plan.
          {onReviewAccounts && <>{" "}<button onClick={onReviewAccounts}>Review Bank accounts</button></>}
        </p>
      )}
      {stale.length > 0 && (
        <p className="fp-plan-warning" role="status">
          Using last known statement details for {names(stale)}. Refresh bank data
          to check for updated amounts and dates.
        </p>
      )}
      {paymentHistoryWarning && (
        <p className="fp-plan-warning" role="status">{paymentHistoryWarning}</p>
      )}
    </div>
  );
}
