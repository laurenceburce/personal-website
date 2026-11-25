import FinanceOrientation from "./FinanceOrientation";

export const metadata = {
  applicationName: "Personal Finance",
  manifest: "/finance/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Finance", statusBarStyle: "default" },
  icons: {
    icon: "/finance-icon.svg",
    apple: [{ url: "/finance-apple-touch.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport = {
  themeColor: "#16765b",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function FinanceLayout({ children }) {
  return <><FinanceOrientation />{children}</>;
}
