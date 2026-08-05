import { redirect } from "next/navigation";
import FinanceAppClient from "./FinanceAppClient";
import { getFinanceAccess } from "../lib/financeAuth";
import { getCurrentMonth, getFinanceDashboard } from "../lib/financeStore";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Finance",
  robots: {
    index: false,
    follow: false
  }
};

function cleanCallback(month, tab) {
  const params = new URLSearchParams();
  if (month) params.set("month", month);
  if (tab) params.set("tab", tab);
  const query = params.toString();
  return query ? `/finance?${query}` : "/finance";
}

export default async function FinancePage({ searchParams }) {
  const params = await searchParams;
  const month = typeof params?.month === "string" ? params.month : getCurrentMonth();
  const tab = typeof params?.tab === "string" ? params.tab : "home";
  const access = await getFinanceAccess();

  if (!access.session) {
    redirect(`/finance/login?callbackUrl=${encodeURIComponent(cleanCallback(month, tab))}`);
  }

  if (!access.authorized) {
    return (
      <main className="finance-private-page">
        <section className="finance-auth-card">
          <p className="finance-kicker">Private Finance</p>
          <h1>Access restricted</h1>
          <p>
            This tracker is only available to the owner account.
          </p>
          <a href="/finance/login" className="finance-link-button">Use another account</a>
        </section>
      </main>
    );
  }

  const snapshot = await getFinanceDashboard({ month });

  return (
    <FinanceAppClient
      snapshot={snapshot}
      ownerEmail={access.email}
      initialTab={tab}
    />
  );
}
