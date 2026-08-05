"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";

const TABS = ["home", "bills", "transactions", "profile"];
const TAB_ALIASES = {
  overview: "home",
  add: "transactions",
  goals: "profile",
  accounts: "profile"
};
const ACCOUNT_TYPES = ["checking", "savings", "credit", "cash", "investment", "loan", "other"];
const COLORS = ["#34d399", "#22d3ee", "#fbbf24", "#fb7185", "#a78bfa", "#f97316"];

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD"
});

const phpFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "PHP",
  maximumFractionDigits: 0
});

function normalizeTab(tab) {
  const value = String(tab || "").toLowerCase();
  const normalized = TAB_ALIASES[value] || value;
  return TABS.includes(normalized) ? normalized : "home";
}

function loadPlaidScript() {
  if (typeof window === "undefined") return Promise.reject(new Error("Plaid Link is only available in the browser."));
  if (window.Plaid) return Promise.resolve(window.Plaid);

  return new Promise((resolve, reject) => {
    const existing = document.querySelector("script[data-plaid-link]");
    if (existing) {
      existing.addEventListener("load", () => resolve(window.Plaid));
      existing.addEventListener("error", () => reject(new Error("Plaid Link failed to load.")));
      return;
    }

    const script = document.createElement("script");
    script.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
    script.async = true;
    script.dataset.plaidLink = "true";
    script.onload = () => resolve(window.Plaid);
    script.onerror = () => reject(new Error("Plaid Link failed to load."));
    document.head.appendChild(script);
  });
}

function money(value, currency = "USD") {
  return currency === "PHP"
    ? phpFormatter.format(Number(value || 0))
    : usdFormatter.format(Number(value || 0));
}

function toMoneyValue(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
}

function convertAmount(value, fromCurrency, toCurrency, exchangeRate) {
  const amount = Number(value || 0);
  const rate = Number(exchangeRate || 1);

  if (fromCurrency === toCurrency) return toMoneyValue(amount);
  if (fromCurrency === "USD" && toCurrency === "PHP") return toMoneyValue(amount * rate);
  if (fromCurrency === "PHP" && toCurrency === "USD") return toMoneyValue(amount / rate);
  return toMoneyValue(amount);
}

function formatRateTimestamp(value) {
  if (!value) return "Not refreshed yet";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function colorForConnection(provider) {
  return provider === "finverse" ? "#fbbf24" : "#22d3ee";
}

function formatMonth(month) {
  return new Date(`${month}-01T12:00:00`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric"
  });
}

function todayForMonth(month) {
  const today = new Date().toISOString().slice(0, 10);
  return today.startsWith(month) ? today : `${month}-01`;
}

function defaultTransaction(month, accounts, displayCurrency = "USD") {
  return {
    date: todayForMonth(month),
    kind: "expense",
    amount: "",
    currency: displayCurrency,
    category: "Bills",
    accountId: accounts[0]?.id ? String(accounts[0].id) : "",
    merchant: "",
    note: ""
  };
}

function defaultBill(displayCurrency = "USD") {
  return {
    id: null,
    name: "",
    amount: "",
    currency: displayCurrency,
    dueLabel: "",
    paymentAccount: "",
    isPaid: false,
    isAutopay: false
  };
}

function defaultGoal(displayCurrency = "USD") {
  return {
    id: null,
    name: "",
    currency: displayCurrency,
    targetAmount: "",
    savedAmount: "",
    category: "PC Build",
    note: ""
  };
}

function defaultAccount() {
  return {
    id: null,
    name: "",
    type: "checking",
    openingBalance: "",
    color: COLORS[0]
  };
}

function progressClass(percent) {
  if (percent >= 100) return "finance-progress finance-progress-over";
  if (percent >= 80) return "finance-progress finance-progress-warn";
  return "finance-progress";
}

function Field({ label, children }) {
  return (
    <label className="finance-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Metric({ label, value, tone, detail }) {
  return (
    <article className="finance-metric">
      <span>{label}</span>
      <strong className={tone ? `finance-${tone}` : ""}>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </article>
  );
}

function Panel({ title, action, children, className = "" }) {
  return (
    <section className={`finance-panel ${className}`.trim()}>
      <header>
        <h2>{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

export default function FinanceAppClient({ snapshot, ownerEmail, initialTab }) {
  const router = useRouter();
  const displayCurrency = snapshot.plan.displayCurrency || "USD";
  const exchangeRate = Number(snapshot.plan.exchangeRate || 1);
  const showCurrency = (value, fromCurrency = "USD") => (
    money(convertAmount(value, fromCurrency, displayCurrency, exchangeRate), displayCurrency)
  );
  const toUsdFromDisplay = (value) => convertAmount(value, displayCurrency, "USD", exchangeRate);
  const toPhpFromDisplay = (value) => convertAmount(value, displayCurrency, "PHP", exchangeRate);
  const [activeTab, setActiveTab] = useState(() => normalizeTab(initialTab));
  const [saving, setSaving] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [installPrompt, setInstallPrompt] = useState(null);
  const [transactionEditId, setTransactionEditId] = useState(null);
  const [transactionForm, setTransactionForm] = useState(() => defaultTransaction(snapshot.month, snapshot.accounts, displayCurrency));
  const [planForm, setPlanForm] = useState(() => ({
    monthlyIncomeUsd: String(convertAmount(snapshot.plan.monthlyIncomeUsd, "USD", displayCurrency, exchangeRate)),
    biweeklyIncomeUsd: String(convertAmount(snapshot.plan.biweeklyIncomeUsd, "USD", displayCurrency, exchangeRate)),
    biweeklyBillsUsd: String(convertAmount(snapshot.plan.biweeklyBillsUsd, "USD", displayCurrency, exchangeRate)),
    biweeklySavingsUsd: String(convertAmount(snapshot.plan.biweeklySavingsUsd, "USD", displayCurrency, exchangeRate))
  }));
  const [billForm, setBillForm] = useState(() => defaultBill(displayCurrency));
  const [goalForm, setGoalForm] = useState(() => defaultGoal(displayCurrency));
  const [accountForm, setAccountForm] = useState(defaultAccount);

  const maxTrend = useMemo(() => {
    return Math.max(1, ...snapshot.monthlySeries.flatMap((item) => [item.incomeUsd, item.expensesUsd]));
  }, [snapshot.monthlySeries]);

  const connections = snapshot.connections || [];
  const recentTransactions = snapshot.transactions.slice(0, 8);
  const unpaidBills = snapshot.recurringBills.filter((bill) => !bill.isPaid);
  const connectionIssues = connections.filter((connection) => ["error", "needs_sync"].includes(connection.status));
  const attentionItems = [
    snapshot.summary.dueSoonBills > 0 ? `${snapshot.summary.dueSoonBills} bill${snapshot.summary.dueSoonBills === 1 ? "" : "s"} due soon.` : "",
    snapshot.summary.netUsd < 0 ? `This month is ${showCurrency(Math.abs(snapshot.summary.netUsd), "USD")} negative.` : "",
    snapshot.plan.recurringRemainingUsd < 0 ? `Recurring bills exceed monthly income by ${showCurrency(Math.abs(snapshot.plan.recurringRemainingUsd), "USD")}.` : "",
    connectionIssues.length > 0 ? `${connectionIssues.length} linked connection${connectionIssues.length === 1 ? "" : "s"} need attention.` : ""
  ].filter(Boolean);
  const disabled = !snapshot.configured;
  const status = saving ? "Saving..." : notice || error;

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }

    const handleBeforeInstallPrompt = (event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    return () => window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
  }, []);

  useEffect(() => {
    if (!transactionEditId) {
      setTransactionForm(defaultTransaction(snapshot.month, snapshot.accounts, displayCurrency));
    }

    setPlanForm({
      monthlyIncomeUsd: String(convertAmount(snapshot.plan.monthlyIncomeUsd, "USD", displayCurrency, exchangeRate)),
      biweeklyIncomeUsd: String(convertAmount(snapshot.plan.biweeklyIncomeUsd, "USD", displayCurrency, exchangeRate)),
      biweeklyBillsUsd: String(convertAmount(snapshot.plan.biweeklyBillsUsd, "USD", displayCurrency, exchangeRate)),
      biweeklySavingsUsd: String(convertAmount(snapshot.plan.biweeklySavingsUsd, "USD", displayCurrency, exchangeRate))
    });
  }, [snapshot.month, snapshot.accounts, snapshot.plan, transactionEditId, displayCurrency, exchangeRate]);

  function setTab(tab) {
    const normalized = normalizeTab(tab);
    setActiveTab(normalized);
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      params.set("tab", normalized);
      params.set("month", snapshot.month);
      window.history.replaceState(null, "", `/finance?${params.toString()}`);
    }
  }

  function goToMonth(value) {
    if (!value) return;
    router.push(`/finance?month=${value}&tab=${activeTab}`);
  }

  async function callFinanceAction(action, data) {
    const response = await fetch("/api/finance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, data })
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) throw new Error(payload.error || "Finance action failed.");
    return payload.result;
  }

  async function runAction(action, data, successMessage) {
    setSaving(action);
    setNotice("");
    setError("");

    try {
      await callFinanceAction(action, data);
      setNotice(successMessage);
      router.refresh();
      return true;
    } catch (err) {
      setError(err.message || "Finance action failed.");
      return false;
    } finally {
      setSaving("");
    }
  }

  async function installApp() {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => {});
    setInstallPrompt(null);
  }

  async function submitPlan(event) {
    event.preventDefault();
    await runAction(
      "updatePlan",
      {
        monthlyIncomeUsd: toUsdFromDisplay(planForm.monthlyIncomeUsd),
        biweeklyIncomeUsd: toUsdFromDisplay(planForm.biweeklyIncomeUsd),
        biweeklyBillsUsd: toUsdFromDisplay(planForm.biweeklyBillsUsd),
        biweeklySavingsUsd: toUsdFromDisplay(planForm.biweeklySavingsUsd)
      },
      "Plan saved."
    );
  }

  async function switchDisplayCurrency() {
    const nextCurrency = displayCurrency === "USD" ? "PHP" : "USD";
    await runAction(
      "updateDisplayCurrency",
      { currency: nextCurrency },
      `Showing ${nextCurrency}.`
    );
  }

  async function refreshExchangeRate() {
    await runAction("refreshExchangeRate", {}, "Exchange rate refreshed.");
  }

  async function connectPlaid() {
    setSaving("createPlaidLinkToken");
    setNotice("");
    setError("");

    try {
      const [{ linkToken }, Plaid] = await Promise.all([
        callFinanceAction("createPlaidLinkToken", {}),
        loadPlaidScript()
      ]);

      if (!linkToken || !Plaid?.create) throw new Error("Plaid Link did not initialize.");

      const handler = Plaid.create({
        token: linkToken,
        onSuccess: async (publicToken, metadata) => {
          setSaving("exchangePlaidPublicToken");
          setNotice("");
          setError("");

          try {
            await callFinanceAction("exchangePlaidPublicToken", { publicToken, metadata });
            setNotice("Plaid account linked.");
            router.refresh();
          } catch (err) {
            setError(err.message || "Plaid account link failed.");
          } finally {
            setSaving("");
          }
        },
        onExit: (err) => {
          if (err) setError(err.display_message || err.error_message || "Plaid Link was closed.");
        }
      });

      handler.open();
    } catch (err) {
      setError(err.message || "Plaid Link failed.");
    } finally {
      setSaving("");
    }
  }

  async function connectFinverse() {
    setSaving("createFinverseLink");
    setNotice("");
    setError("");

    try {
      const result = await callFinanceAction("createFinverseLink", {});
      if (!result?.url) throw new Error("Finverse did not return a link URL.");
      window.location.assign(result.url);
    } catch (err) {
      setError(err.message || "Finverse Link failed.");
      setSaving("");
    }
  }

  async function syncConnection(connection) {
    await runAction("syncConnection", { id: connection.id }, `${connection.institutionName} synced.`);
  }

  async function submitTransaction(event) {
    event.preventDefault();
    const action = transactionEditId ? "updateTransaction" : "createTransaction";
    const ok = await runAction(
      action,
      { ...transactionForm, id: transactionEditId },
      transactionEditId ? "Transaction updated." : "Transaction added."
    );

    if (ok) {
      setTransactionEditId(null);
      setTransactionForm(defaultTransaction(snapshot.month, snapshot.accounts, displayCurrency));
    }
  }

  function editTransaction(transaction) {
    setTab("transactions");
    setTransactionEditId(transaction.id);
    setTransactionForm({
      date: transaction.date,
      kind: transaction.kind,
      amount: String(transaction.amount),
      currency: transaction.currency,
      category: transaction.category,
      accountId: transaction.accountId ? String(transaction.accountId) : "",
      merchant: transaction.merchant,
      note: transaction.note
    });
  }

  async function deleteTransaction(transaction) {
    if (!window.confirm("Delete this transaction?")) return;
    const ok = await runAction("deleteTransaction", { id: transaction.id }, "Transaction deleted.");
    if (ok && transactionEditId === transaction.id) {
      setTransactionEditId(null);
      setTransactionForm(defaultTransaction(snapshot.month, snapshot.accounts, displayCurrency));
    }
  }

  async function submitBill(event) {
    event.preventDefault();
    const ok = await runAction(
      "upsertBill",
      {
        ...billForm,
        amountUsd: toUsdFromDisplay(billForm.amount),
        amountPhp: toPhpFromDisplay(billForm.amount)
      },
      billForm.id ? "Bill saved." : "Bill added."
    );
    if (ok) setBillForm(defaultBill(displayCurrency));
  }

  function editBill(bill) {
    setBillForm({
      id: bill.id,
      name: bill.name,
      amount: String(convertAmount(bill.amountUsd, "USD", displayCurrency, exchangeRate)),
      currency: displayCurrency,
      dueLabel: bill.dueLabel,
      paymentAccount: bill.paymentAccount,
      isPaid: bill.isPaid,
      isAutopay: bill.isAutopay
    });
  }

  async function deleteBill(bill) {
    if (!window.confirm(`Delete ${bill.name}?`)) return;
    const ok = await runAction("deleteBill", { id: bill.id }, "Bill deleted.");
    if (ok && billForm.id === bill.id) setBillForm(defaultBill(displayCurrency));
  }

  async function toggleBill(bill) {
    await runAction(
      "toggleBillPaid",
      { id: bill.id, isPaid: !bill.isPaid },
      !bill.isPaid ? "Bill marked paid." : "Bill marked unpaid."
    );
  }

  async function submitGoal(event) {
    event.preventDefault();
    const ok = await runAction("upsertGoal", goalForm, goalForm.id ? "Goal saved." : "Goal added.");
    if (ok) setGoalForm(defaultGoal(displayCurrency));
  }

  function editGoal(goal) {
    setGoalForm({
      id: goal.id,
      name: goal.name,
      currency: goal.currency,
      targetAmount: String(goal.targetAmount),
      savedAmount: String(goal.savedAmount),
      category: goal.category || "",
      note: goal.note || ""
    });
  }

  async function deleteGoal(goal) {
    if (!window.confirm(`Delete ${goal.name}?`)) return;
    const ok = await runAction("deleteGoal", { id: goal.id }, "Goal deleted.");
    if (ok && goalForm.id === goal.id) setGoalForm(defaultGoal(displayCurrency));
  }

  async function submitAccount(event) {
    event.preventDefault();
    const action = accountForm.id ? "updateAccount" : "createAccount";
    const ok = await runAction(
      action,
      {
        ...accountForm,
        openingBalance: toUsdFromDisplay(accountForm.openingBalance)
      },
      accountForm.id ? "Account saved." : "Account added."
    );
    if (ok) setAccountForm(defaultAccount());
  }

  function editAccount(account) {
    setAccountForm({
      id: account.id,
      name: account.name,
      type: account.type,
      openingBalance: String(convertAmount(account.openingBalance, "USD", displayCurrency, exchangeRate)),
      color: account.color
    });
  }

  async function archiveAccount(account) {
    if (!window.confirm(`Archive ${account.name}?`)) return;
    const ok = await runAction("archiveAccount", { id: account.id }, "Account archived.");
    if (ok && accountForm.id === account.id) setAccountForm(defaultAccount());
  }

  const seedStarter = () => runAction("seedStarter", {}, "Spreadsheet starter imported.");

  return (
    <main className="finance-app">
      <header className="finance-topbar">
        <div>
          <p className="finance-kicker">Private Finance</p>
          <h1>{formatMonth(snapshot.month)}</h1>
          <span>{ownerEmail}</span>
        </div>
        <div className="finance-top-actions">
          {installPrompt ? (
            <button type="button" onClick={installApp}>Install</button>
          ) : null}
          <button type="button" onClick={switchDisplayCurrency}>
            Show {displayCurrency === "USD" ? "PHP" : "USD"}
          </button>
          <button type="button" onClick={() => signOut({ callbackUrl: "/finance/login" })}>Sign out</button>
        </div>
      </header>

      <div className="finance-month-row">
        <label>
          <span>Month</span>
          <input type="month" value={snapshot.month} onChange={(event) => goToMonth(event.target.value)} />
        </label>
        <button type="button" onClick={() => setTab("transactions")}>Quick add</button>
      </div>

      {!snapshot.configured ? (
        <div className="finance-alert finance-alert-warn">
          FINANCE_DATABASE_URL, DATABASE_URL, or MYSQL_URL is required before records can be saved.
        </div>
      ) : null}

      {status ? (
        <div className={error ? "finance-alert finance-alert-error" : "finance-alert"}>
          {status}
        </div>
      ) : null}

      {activeTab === "home" ? (
        <div className="finance-stack">
          {snapshot.starterAvailable ? (
            <Panel
              title="Spreadsheet Starter"
              action={<button type="button" onClick={seedStarter} disabled={disabled || Boolean(saving)}>Import</button>}
            >
              <p className="finance-muted">
                Recurring bills, exchange rate, bi-weekly plan, and starter goals from the workbook.
              </p>
            </Panel>
          ) : null}

          <section className="finance-metric-grid">
            <Metric label="Net" value={showCurrency(snapshot.summary.netUsd, "USD")} tone={snapshot.summary.netUsd >= 0 ? "good" : "bad"} detail={`${snapshot.summary.savingsRate}% saved`} />
            <Metric label="Recurring" value={showCurrency(snapshot.plan.recurringUsd, "USD")} detail={`1 USD = ${money(snapshot.plan.exchangeRate, "PHP")}`} />
            <Metric label="Unpaid" value={snapshot.summary.unpaidBills} tone={snapshot.summary.unpaidBills ? "warn" : "good"} detail={`${snapshot.summary.dueSoonBills} due soon`} />
            <Metric label="Balance" value={showCurrency(snapshot.summary.totalBalanceUsd, "USD")} tone="info" detail={`${snapshot.accounts.length} accounts`} />
          </section>

          <Panel title="Bi-weekly Plan">
            <div className="finance-plan-grid">
              <Metric label="Income" value={showCurrency(snapshot.plan.biweeklyIncomeUsd, "USD")} />
              <Metric label="Bills" value={showCurrency(snapshot.plan.biweeklyBillsUsd, "USD")} />
              <Metric label="Savings" value={showCurrency(snapshot.plan.biweeklySavingsUsd, "USD")} />
              <Metric label="Left" value={showCurrency(snapshot.plan.biweeklyRemainingUsd, "USD")} tone={snapshot.plan.biweeklyRemainingUsd >= 0 ? "good" : "bad"} />
            </div>
          </Panel>

          <Panel title="Bills Left" action={<button type="button" onClick={() => setTab("bills")}>Open</button>}>
            {unpaidBills.length === 0 ? (
              <p className="finance-muted">No unpaid recurring bills.</p>
            ) : (
              <div className="finance-list">
                {unpaidBills.slice(0, 5).map((bill) => (
                  <button key={bill.id} type="button" className="finance-list-row" onClick={() => toggleBill(bill)}>
                    <span>
                      <strong>{bill.name}</strong>
                      <small>{bill.paymentAccount || "Manual"} - due {bill.dueLabel || "open"}</small>
                    </span>
                    <b>{showCurrency(bill.amountUsd, "USD")}</b>
                  </button>
                ))}
              </div>
            )}
          </Panel>

          {attentionItems.length > 0 ? (
            <Panel title="Needs Attention">
              <div className="finance-list">
                {attentionItems.map((item) => (
                  <div key={item} className="finance-attention-item">{item}</div>
                ))}
              </div>
            </Panel>
          ) : null}
        </div>
      ) : null}

      {activeTab === "transactions" ? (
        <div className="finance-stack">
          <Panel title={transactionEditId ? "Edit Transaction" : "Add Transaction"}>
            <form className="finance-form" onSubmit={submitTransaction}>
              <div className="finance-form-grid">
                <Field label="Date">
                  <input type="date" value={transactionForm.date} onChange={(event) => setTransactionForm((form) => ({ ...form, date: event.target.value }))} required disabled={disabled} />
                </Field>
                <Field label="Type">
                  <select value={transactionForm.kind} onChange={(event) => setTransactionForm((form) => ({ ...form, kind: event.target.value }))} disabled={disabled}>
                    <option value="expense">Expense</option>
                    <option value="income">Income</option>
                  </select>
                </Field>
              </div>

              <div className="finance-form-grid">
                <Field label="Amount">
                  <input type="number" inputMode="decimal" step="0.01" min="0" value={transactionForm.amount} onChange={(event) => setTransactionForm((form) => ({ ...form, amount: event.target.value }))} required disabled={disabled} />
                </Field>
                <Field label="Currency">
                  <select value={transactionForm.currency} onChange={(event) => setTransactionForm((form) => ({ ...form, currency: event.target.value }))} disabled={disabled}>
                    <option value="USD">USD</option>
                    <option value="PHP">PHP</option>
                  </select>
                </Field>
              </div>

              <Field label="Category">
                <input list="finance-categories" value={transactionForm.category} onChange={(event) => setTransactionForm((form) => ({ ...form, category: event.target.value }))} required disabled={disabled} />
              </Field>

              <Field label="Account">
                <select value={transactionForm.accountId} onChange={(event) => setTransactionForm((form) => ({ ...form, accountId: event.target.value }))} disabled={disabled}>
                  <option value="">Unassigned</option>
                  {snapshot.accounts.map((account) => (
                    <option key={account.id} value={account.id}>{account.name}</option>
                  ))}
                </select>
              </Field>

              <Field label="Merchant or payer">
                <input value={transactionForm.merchant} onChange={(event) => setTransactionForm((form) => ({ ...form, merchant: event.target.value }))} disabled={disabled} maxLength={120} />
              </Field>

              <Field label="Note">
                <textarea value={transactionForm.note} onChange={(event) => setTransactionForm((form) => ({ ...form, note: event.target.value }))} disabled={disabled} maxLength={300} />
              </Field>

              <div className="finance-button-row">
                <button type="submit" className="finance-primary" disabled={disabled || Boolean(saving)}>
                  {transactionEditId ? "Save" : "Add"}
                </button>
                {transactionEditId ? (
                  <button type="button" onClick={() => { setTransactionEditId(null); setTransactionForm(defaultTransaction(snapshot.month, snapshot.accounts, displayCurrency)); }}>
                    Cancel
                  </button>
                ) : null}
              </div>
            </form>
          </Panel>

          <Panel title="Recent">
            {recentTransactions.length === 0 ? (
              <p className="finance-muted">No transactions for this month.</p>
            ) : (
              <div className="finance-list">
                {recentTransactions.map((transaction) => (
                  <div key={transaction.id} className="finance-transaction-row">
                    <button type="button" onClick={() => editTransaction(transaction)}>
                      <span>
                        <strong>{transaction.merchant || transaction.category}</strong>
                        <small>{transaction.date} - {transaction.accountName || "Unassigned"}</small>
                      </span>
                      <b className={transaction.kind === "income" ? "finance-good" : "finance-bad"}>
                        {showCurrency(transaction.amount, transaction.currency)}
                      </b>
                    </button>
                    <button type="button" onClick={() => deleteTransaction(transaction)} aria-label={`Delete ${transaction.merchant || transaction.category}`}>Delete</button>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
      ) : null}

      {activeTab === "bills" ? (
        <div className="finance-stack">
          <Panel
            title="Exchange Rate"
            action={<button type="button" onClick={refreshExchangeRate} disabled={Boolean(saving)}>Refresh</button>}
          >
            <div className="finance-plan-grid">
              <Metric label="USD to PHP" value={money(snapshot.plan.exchangeRate, "PHP")} detail={snapshot.plan.exchangeRateSource || "Frankfurter"} />
              <Metric label="Updated" value={snapshot.plan.exchangeRateDate || "Latest"} detail={formatRateTimestamp(snapshot.plan.exchangeRateUpdatedAt)} />
            </div>
          </Panel>

          <Panel title="Plan">
            <form className="finance-form" onSubmit={submitPlan}>
              <Field label={`Monthly income ${displayCurrency}`}>
                  <input type="number" inputMode="decimal" step="0.01" min="0" value={planForm.monthlyIncomeUsd} onChange={(event) => setPlanForm((form) => ({ ...form, monthlyIncomeUsd: event.target.value }))} disabled={disabled} />
              </Field>
              <div className="finance-form-grid">
                <Field label={`Bi-weekly income ${displayCurrency}`}>
                  <input type="number" inputMode="decimal" step="0.01" min="0" value={planForm.biweeklyIncomeUsd} onChange={(event) => setPlanForm((form) => ({ ...form, biweeklyIncomeUsd: event.target.value }))} disabled={disabled} />
                </Field>
                <Field label={`Bills set aside ${displayCurrency}`}>
                  <input type="number" inputMode="decimal" step="0.01" min="0" value={planForm.biweeklyBillsUsd} onChange={(event) => setPlanForm((form) => ({ ...form, biweeklyBillsUsd: event.target.value }))} disabled={disabled} />
                </Field>
              </div>
              <Field label={`Savings set aside ${displayCurrency}`}>
                <input type="number" inputMode="decimal" step="0.01" min="0" value={planForm.biweeklySavingsUsd} onChange={(event) => setPlanForm((form) => ({ ...form, biweeklySavingsUsd: event.target.value }))} disabled={disabled} />
              </Field>
              <button type="submit" className="finance-primary" disabled={disabled || Boolean(saving)}>Save Plan</button>
            </form>
          </Panel>

          <Panel title={billForm.id ? "Edit Bill" : "Add Bill"}>
            <form className="finance-form" onSubmit={submitBill}>
              <Field label="Name">
                <input value={billForm.name} onChange={(event) => setBillForm((form) => ({ ...form, name: event.target.value }))} required disabled={disabled} maxLength={120} />
              </Field>
              <div className="finance-form-grid">
                <Field label={`Amount ${displayCurrency}`}>
                  <input type="number" inputMode="decimal" step="0.01" min="0" value={billForm.amount} onChange={(event) => setBillForm((form) => ({ ...form, amount: event.target.value, currency: displayCurrency }))} disabled={disabled} />
                </Field>
              </div>
              <div className="finance-form-grid">
                <Field label="Due">
                  <input value={billForm.dueLabel} onChange={(event) => setBillForm((form) => ({ ...form, dueLabel: event.target.value }))} disabled={disabled} maxLength={40} />
                </Field>
                <Field label="Payment source">
                  <input value={billForm.paymentAccount} onChange={(event) => setBillForm((form) => ({ ...form, paymentAccount: event.target.value }))} disabled={disabled} maxLength={80} />
                </Field>
              </div>
              <div className="finance-toggle-grid">
                <label><input type="checkbox" checked={billForm.isPaid} onChange={(event) => setBillForm((form) => ({ ...form, isPaid: event.target.checked }))} disabled={disabled} /> Paid</label>
                <label><input type="checkbox" checked={billForm.isAutopay} onChange={(event) => setBillForm((form) => ({ ...form, isAutopay: event.target.checked }))} disabled={disabled} /> Auto</label>
              </div>
              <div className="finance-button-row">
                <button type="submit" className="finance-primary" disabled={disabled || Boolean(saving)}>
                  {billForm.id ? "Save" : "Add"}
                </button>
                {billForm.id ? <button type="button" onClick={() => setBillForm(defaultBill(displayCurrency))}>Cancel</button> : null}
              </div>
            </form>
          </Panel>

          <Panel title="Recurring Bills">
            {snapshot.recurringBills.length === 0 ? (
              <p className="finance-muted">No recurring bills yet.</p>
            ) : (
              <div className="finance-bill-list">
                {snapshot.recurringBills.map((bill) => (
                  <article key={bill.id} className={bill.isPaid ? "finance-bill finance-bill-paid" : "finance-bill"}>
                    <button type="button" className="finance-bill-check" onClick={() => toggleBill(bill)} aria-label={bill.isPaid ? `Mark ${bill.name} unpaid` : `Mark ${bill.name} paid`}>
                      {bill.isPaid ? "Paid" : "Open"}
                    </button>
                    <div>
                      <strong>{bill.name}</strong>
                      <span>{bill.paymentAccount || "Manual"} - due {bill.dueLabel || "open"}</span>
                    </div>
                    <b>{showCurrency(bill.amountUsd, "USD")}</b>
                    <div className="finance-mini-actions">
                      <button type="button" onClick={() => editBill(bill)}>Edit</button>
                      <button type="button" onClick={() => deleteBill(bill)}>Delete</button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </Panel>
        </div>
      ) : null}

      {activeTab === "profile" ? (
        <div className="finance-stack">
          <Panel
            title="Linked Accounts"
            action={(
              <div className="finance-button-row">
                <button type="button" onClick={connectPlaid} disabled={disabled || Boolean(saving)}>Plaid</button>
                <button type="button" onClick={connectFinverse} disabled={disabled || Boolean(saving)}>Finverse</button>
              </div>
            )}
          >
            {connections.length === 0 ? (
              <p className="finance-muted">No linked accounts yet.</p>
            ) : (
              <div className="finance-list">
                {connections.map((connection) => (
                  <article key={connection.id} className="finance-account-row">
                    <div>
                      <span style={{ background: colorForConnection(connection.provider) }} />
                      <strong>{connection.institutionName}</strong>
                      <small>{connection.provider} - {connection.status} - {formatRateTimestamp(connection.lastSyncedAt)}</small>
                    </div>
                    <button type="button" onClick={() => syncConnection(connection)} disabled={disabled || Boolean(saving)}>Sync</button>
                  </article>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Accounts">
            {snapshot.accounts.length === 0 ? (
              <p className="finance-muted">No accounts yet.</p>
            ) : (
              <div className="finance-list">
                {snapshot.accounts.map((account) => (
                  <article key={account.id} className="finance-account-row">
                    <div>
                      <span style={{ background: account.color }} />
                      <strong>{account.name}</strong>
                      <small>
                        {account.isLinked ? `${account.institutionName || account.provider} - ` : ""}
                        {account.type}
                        {account.isLinked && account.currency !== displayCurrency ? ` - ${money(account.nativeCurrentBalance, account.currency)}` : ""}
                      </small>
                    </div>
                    <b className={account.currentBalance >= 0 ? "finance-good" : "finance-bad"}>{showCurrency(account.currentBalance, "USD")}</b>
                    {account.isLinked ? null : (
                      <div className="finance-mini-actions">
                        <button type="button" onClick={() => editAccount(account)}>Edit</button>
                        <button type="button" onClick={() => archiveAccount(account)}>Archive</button>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}
          </Panel>

          <Panel title={accountForm.id ? "Edit Account" : "Add Account"}>
            <form className="finance-form" onSubmit={submitAccount}>
              <Field label="Name">
                <input value={accountForm.name} onChange={(event) => setAccountForm((form) => ({ ...form, name: event.target.value }))} required disabled={disabled} maxLength={80} />
              </Field>
              <div className="finance-form-grid">
                <Field label="Type">
                  <select value={accountForm.type} onChange={(event) => setAccountForm((form) => ({ ...form, type: event.target.value }))} disabled={disabled}>
                    {ACCOUNT_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                  </select>
                </Field>
                <Field label={`Opening ${displayCurrency}`}>
                  <input type="number" inputMode="decimal" step="0.01" value={accountForm.openingBalance} onChange={(event) => setAccountForm((form) => ({ ...form, openingBalance: event.target.value }))} disabled={disabled} />
                </Field>
              </div>
              <div className="finance-color-row">
                {COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    aria-label={`Use color ${color}`}
                    className={accountForm.color === color ? "finance-color-active" : ""}
                    style={{ background: color }}
                    onClick={() => setAccountForm((form) => ({ ...form, color }))}
                    disabled={disabled}
                  />
                ))}
              </div>
              <div className="finance-button-row">
                <button type="submit" className="finance-primary" disabled={disabled || Boolean(saving)}>{accountForm.id ? "Save" : "Add"}</button>
                {accountForm.id ? <button type="button" onClick={() => setAccountForm(defaultAccount())}>Cancel</button> : null}
              </div>
            </form>
          </Panel>

          <Panel title="Goals">
            {snapshot.goals.length === 0 ? (
              <p className="finance-muted">No goals yet.</p>
            ) : (
              <div className="finance-goal-grid">
                {snapshot.goals.map((goal) => (
                  <article key={goal.id} className="finance-goal-card">
                    <div>
                      <strong>{goal.name}</strong>
                      <span>{goal.category || "Goal"}</span>
                    </div>
                    <p>{showCurrency(goal.savedAmount, goal.currency)} of {showCurrency(goal.targetAmount, goal.currency)}</p>
                    <div className={progressClass(goal.percent)}>
                      <i style={{ width: `${Math.min(100, goal.percent)}%` }} />
                    </div>
                    <small>{goal.remaining > 0 ? `${showCurrency(goal.remaining, goal.currency)} left` : "Funded"}</small>
                    {goal.note ? <p className="finance-note">{goal.note}</p> : null}
                    <div className="finance-button-row">
                      <button type="button" onClick={() => editGoal(goal)}>Edit</button>
                      <button type="button" onClick={() => deleteGoal(goal)}>Delete</button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </Panel>

          <Panel title={goalForm.id ? "Edit Goal" : "Add Goal"}>
            <form className="finance-form" onSubmit={submitGoal}>
              <Field label="Name">
                <input value={goalForm.name} onChange={(event) => setGoalForm((form) => ({ ...form, name: event.target.value }))} required disabled={disabled} maxLength={120} />
              </Field>
              <div className="finance-form-grid">
                <Field label="Currency">
                  <select value={goalForm.currency} onChange={(event) => setGoalForm((form) => ({ ...form, currency: event.target.value }))} disabled={disabled}>
                    <option value="USD">USD</option>
                    <option value="PHP">PHP</option>
                  </select>
                </Field>
                <Field label="Category">
                  <input list="finance-categories" value={goalForm.category} onChange={(event) => setGoalForm((form) => ({ ...form, category: event.target.value }))} disabled={disabled} />
                </Field>
              </div>
              <div className="finance-form-grid">
                <Field label="Target">
                  <input type="number" inputMode="decimal" step="0.01" min="0" value={goalForm.targetAmount} onChange={(event) => setGoalForm((form) => ({ ...form, targetAmount: event.target.value }))} required disabled={disabled} />
                </Field>
                <Field label="Saved">
                  <input type="number" inputMode="decimal" step="0.01" min="0" value={goalForm.savedAmount} onChange={(event) => setGoalForm((form) => ({ ...form, savedAmount: event.target.value }))} disabled={disabled} />
                </Field>
              </div>
              <Field label="Note">
                <textarea value={goalForm.note} onChange={(event) => setGoalForm((form) => ({ ...form, note: event.target.value }))} disabled={disabled} maxLength={300} />
              </Field>
              <div className="finance-button-row">
                <button type="submit" className="finance-primary" disabled={disabled || Boolean(saving)}>{goalForm.id ? "Save" : "Add"}</button>
                {goalForm.id ? <button type="button" onClick={() => setGoalForm(defaultGoal(displayCurrency))}>Cancel</button> : null}
              </div>
            </form>
          </Panel>

          <Panel title="Six Month Trend">
            <div className="finance-trend-list">
              {snapshot.monthlySeries.map((item) => (
                <div key={item.month} className="finance-trend-row">
                  <span>{item.month}</span>
                  <div>
                    <i className="finance-trend-income" style={{ width: `${Math.max(4, (item.incomeUsd / maxTrend) * 100)}%` }} />
                    <i className="finance-trend-expense" style={{ width: `${Math.max(4, (item.expensesUsd / maxTrend) * 100)}%` }} />
                  </div>
                  <b className={item.netUsd >= 0 ? "finance-good" : "finance-bad"}>{showCurrency(item.netUsd, "USD")}</b>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      ) : null}

      <nav className="finance-bottom-nav" aria-label="Finance sections">
        {[
          ["home", "Home"],
          ["bills", "Bills"],
          ["transactions", "Transactions"],
          ["profile", "Profile"]
        ].map(([tab, label]) => (
          <button
            key={tab}
            type="button"
            className={activeTab === tab ? "active" : ""}
            aria-current={activeTab === tab ? "page" : undefined}
            onClick={() => setTab(tab)}
          >
            {label}
          </button>
        ))}
      </nav>

      <datalist id="finance-categories">
        {snapshot.categories.map((category) => (
          <option key={category} value={category} />
        ))}
      </datalist>
    </main>
  );
}
