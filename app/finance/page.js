import { redirect } from "next/navigation";
import FinanceAppClient from "./FinanceAppClient";
import { getFinanceAccess } from "../lib/financeAuth";
import { getFinancePlanner } from "../lib/financePlannerStore";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Personal Finance",
  description: "Your private USD and PHP salary, bills, and budget planner.",
  applicationName: "Personal Finance",
  manifest: "/finance/manifest.webmanifest",
  alternates: { canonical: "/finance" },
  appleWebApp: { capable: true, title: "Finance", statusBarStyle: "default" },
  icons: {
    icon: "/finance-icon.svg",
    apple: [
      { url: "/finance-apple-touch.png", sizes: "180x180", type: "image/png" },
    ],
  },
  robots: {
    index: false,
    follow: false,
  },
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
  const month = typeof params?.month === "string" ? params.month : "";
  const tab = typeof params?.tab === "string" ? params.tab : "home";
  const access = await getFinanceAccess();

  if (!access.session) {
    redirect(
      `/finance/login?callbackUrl=${encodeURIComponent(cleanCallback(month, tab))}`,
    );
  }

  if (!access.authorized) {
    return (
      <main className="finance-private-page">
        <section className="finance-auth-card">
          <p className="finance-kicker">Private Finance</p>
          <h1>Access restricted</h1>
          <p>This tracker is only available to the owner account.</p>
          <a href="/finance/login" className="finance-link-button">
            Use another account
          </a>
        </section>
      </main>
    );
  }

  const snapshot = await getFinancePlanner();

  return <FinanceAppClient snapshot={snapshot} initialTab={tab} />;
}
