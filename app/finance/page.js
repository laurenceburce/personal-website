import { redirect } from "next/navigation";
import FinanceAppClient from "./FinanceAppClient";
import { getFinanceAccess } from "../lib/financeAuth";
import { getFinancePlanner } from "../lib/financePlannerStore";
import {
  getFinanceActivity,
  getFinancePlanActivity,
} from "../lib/financeStore";
import { localDate } from "../lib/financePlanner.mjs";

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

function cleanCallback(month, tab, quick = false) {
  const params = new URLSearchParams();
  if (month) params.set("month", month);
  if (tab) params.set("tab", tab);
  if (quick) params.set("quick", "1");
  const query = params.toString();
  return query ? `/finance?${query}` : "/finance";
}

export default async function FinancePage({ searchParams }) {
  const params = await searchParams;
  const month =
    typeof params?.month === "string" &&
    /^(19\d{2}|20\d{2}|21\d{2}|2200)-(0[1-9]|1[0-2])$/.test(params.month)
      ? params.month
      : localDate().slice(0, 7);
  const isBankRedirect = typeof params?.oauth_state_id === "string";
  const tab = isBankRedirect
    ? "accounts"
    : typeof params?.tab === "string"
      ? params.tab
      : "home";
  const access = await getFinanceAccess();

  if (!access.session) {
    const callback = isBankRedirect
      ? `/finance?${new URLSearchParams(Object.entries(params).filter(([, value]) => typeof value === "string")).toString()}`
      : cleanCallback(month, tab, params?.quick === "1");
    redirect(`/finance/login?callbackUrl=${encodeURIComponent(callback)}`);
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

  const [snapshot, activity] = await Promise.all([
    getFinancePlanner(),
    getFinanceActivity({ month }),
  ]);
  const firstPlan = snapshot.document.plans[0];
  const planActivity =
    ["plans", "budget"].includes(tab) && firstPlan
      ? await getFinancePlanActivity({
          startDate: firstPlan.startDate,
          endDate: firstPlan.endDate,
        })
      : null;

  return (
    <FinanceAppClient
      snapshot={snapshot}
      initialActivity={activity}
      initialPlanActivity={planActivity}
      initialTab={tab}
    />
  );
}
