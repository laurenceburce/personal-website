import { formatDate, localDate, money } from "../lib/financePlanner.mjs";
import { getPlannerAccountLabel } from "../lib/financePlanPresentation.mjs";

export default function FinanceCreditCardDuesNotice({
  accounts = [],
  obligations = [],
  plan,
  onReviewAccounts,
  onEditPlan,
  onChangeRange,
  paymentHistoryWarning,
}) {
  const cards = accounts.filter(
    (account) => (account.type || account.account_type) === "credit" &&
      !account.isArchived && !account.is_archived && !account.isSyncExcluded && !account.is_sync_excluded &&
      !account.mergedIntoAccountId && !account.merged_into_account_id,
  );
  if (!cards.length) return null;
  const estimates = obligations.filter((row) => row.estimated && row.amount > 0);
  const estimatedAccountIds = new Set(estimates.map((row) => String(row.creditAccountId)));
  const missing = cards.filter((account) => {
    const due = account.creditCardDue;
    return due?.statementBalance == null || !Number.isFinite(Number(due.statementBalance)) ||
      formatDate(due.dueDate) === "—";
  });
  const missingWithEstimate = missing.filter((account) => account.isLinked && estimatedAccountIds.has(String(account.id)));
  const missingWithoutEstimate = missing.filter((account) => account.isLinked && !estimatedAccountIds.has(String(account.id)));
  const manualMissing = missing.filter((account) => !account.isLinked && !(plan?.entries || []).some((entry) =>
    entry.kind === "transfer" && Number(entry.toAccountId) === Number(account.id) && entry.date >= localDate()));
  const unplannedBalances = cards.filter((account) => {
    if (!account.isLinked && missing.includes(account)) return false;
    const balance = Object.hasOwn(account, "nativeCurrentBalance")
      ? account.nativeCurrentBalance : account.currentBalance;
    return Number.isFinite(Number(balance)) && Number(balance) > 0 &&
      !obligations.some((row) => String(row.creditAccountId) === String(account.id) &&
        (row.amount > 0 || row.committedPaymentAmount > 0) && formatDate(row.date) !== "—");
  });
  const afterPlan = plan?.endDate
    ? estimates.filter((row) => row.date > plan.endDate)
    : [];
  const beforePlan = plan?.startDate
    ? obligations.filter((row) => row.autopayEnabled && row.amount > 0 && row.date < plan.startDate &&
      (!plan.restart?.date || row.date >= plan.restart.date))
    : [];
  const stale = cards.filter(
    (account) => account.isLinked && account.creditCardDueStatus === "stale" &&
      (!missing.includes(account) || estimatedAccountIds.has(String(account.id))),
  );
  const names = (items) => items.map((account) => getPlannerAccountLabel(account, cards)).join(", ");
  const showPayments = () => onChangeRange?.({
    startDate: [plan.startDate, ...beforePlan.map((row) => row.date)].sort()[0],
    endDate: [plan.endDate, ...afterPlan.map((row) => row.date)].sort().at(-1),
  });
  return (
    <div className="fp-credit-card-dues-notice">
      <p className="fp-plan-flow-note">
        Issued statements keep their reported due date and saved payment schedule. Recorded payments reduce the remaining amount.
        Future monthly payments use known billing-cycle dates and planned card activity, and are labeled as estimates.
        Missing statement details stay unavailable until supplied by the bank or entered manually.
      </p>
      {beforePlan.length > 0 && (
        <div className="fp-plan-warning" role="status">
          <p>
            These automatic payments fall before {plan.continuous ? "the visible range" : "this plan starts"} on {formatDate(plan.startDate, { year: "numeric" })}. Check their recorded payment status.
          </p>
          <ul>
            {beforePlan.map((row) => (
              <li key={row.id}>
                <strong>{row.accountName || "Credit card"}</strong>: {money(row.amount, row.currency)}{row.estimated ? " estimated" : " remaining"}, scheduled {formatDate(row.date, { year: "numeric" })}.
                {" "}{row.estimated && !row.estimateDateIsReported ? "Estimated due" : "Due"} {formatDate(row.dueDate, { year: "numeric" })}.
              </li>
            ))}
          </ul>
          {plan.continuous && onChangeRange ? <button onClick={showPayments}>Show payment dates</button>
            : onEditPlan && <button onClick={onEditPlan}>Edit plan</button>}
        </div>
      )}
      {afterPlan.length > 0 && (
        <div className="fp-plan-warning" role="status">
          <p>
            These estimates from current unbilled balances fall after {plan.continuous ? "the visible range ends" : "this plan ends"} on {formatDate(plan.endDate, { year: "numeric" })} and are not included in {plan.continuous ? "this projection" : "its available funds"}.
            {" "}Planned payments are not deducted from these amounts:
          </p>
          <ul>
            {afterPlan.map((row) => (
              <li key={row.id}>
                <strong>{row.accountName || "Credit card"}</strong>: {money(row.amount, row.currency)} estimated for {formatDate(row.date, { year: "numeric" })}.
                {" "}{row.autopayEnabled
                  ? <>Automatic payment · {row.estimateDateIsReported ? "Due" : "Estimated due"} {formatDate(row.dueDate, { year: "numeric" })}.</>
                  : row.estimateDateIsReported ? row.manualStatement ? "Entered payment due date." : "Bank-reported payment date." : "Estimated payment date."}
              </li>
            ))}
          </ul>
          <p>
            {plan.continuous ? "Change the date range to include these payments." : "Extend the plan’s end date to include these payments."}
            {plan.continuous && onChangeRange ? <> <button onClick={showPayments}>Show payment dates</button></>
              : onEditPlan && <>{" "}<button onClick={onEditPlan}>Edit plan</button></>}
          </p>
        </div>
      )}
      {missingWithEstimate.length > 0 && (
        <p className="fp-plan-warning" role="status">
          Statement balances are unavailable for {names(missingWithEstimate)}.
          {" "}Using their current balances as estimates until the bank reports a statement.
        </p>
      )}
      {missingWithoutEstimate.length > 0 && (
        <p className="fp-plan-warning" role="status">
          Statement balances or due dates are unavailable for {names(missingWithoutEstimate)}.
          {" "}These cards need statement or cycle details before dues can appear in this plan.
          {onReviewAccounts && <>{" "}<button onClick={onReviewAccounts}>Review Bank accounts</button></>}
        </p>
      )}
      {manualMissing.length > 0 && (
        <p className="fp-plan-warning" role="status">
          Enter a statement balance and payment due date for {names(manualMissing)} under Bank accounts → Payment details to include the card payment in this plan.
          {onReviewAccounts && <>{" "}<button onClick={onReviewAccounts}>Enter payment details</button></>}
        </p>
      )}
      {unplannedBalances.length > 0 && (
        <p className="fp-plan-warning" role="status">
          A payment date could not be determined for the current balances on {names(unplannedBalances)}.
          {" "}No unbilled estimate is included for these cards.
          {onReviewAccounts && !missingWithoutEstimate.length && <>{" "}<button onClick={onReviewAccounts}>Review Bank accounts</button></>}
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
