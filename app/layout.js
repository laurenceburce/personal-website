import { DM_Serif_Display, Manrope } from "next/font/google";
import "./globals.css";
import AuthSessionTracker from "./components/auth/AuthSessionTracker";
import AuthWelcome from "./components/auth/AuthWelcome";
import ChatWidget from "./components/chat/ChatWidget";

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-manrope"
});

const dmSerifDisplay = DM_Serif_Display({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-dm-serif-display"
});

export const metadata = {
  metadataBase: new URL("https://laurenceburce.com"),
  title: "Laurence Alec Burce | Software Engineer",
  description:
    "Portfolio of Laurence Alec Burce - software engineer with 3 years of experience in Oracle SaaS ERP systems, client web apps, AI automation, and Copilot Studio chatbots.",
  icons: {
    icon: [
      { url: "/logos/lab-favicon.svg", type: "image/svg+xml", sizes: "512x512" }
    ],
    shortcut: "/logos/lab-favicon.svg"
  },
  openGraph: {
    title: "Laurence Alec Burce | Software Engineer",
    description:
      "Enterprise software engineering, Oracle SaaS ERP, client web apps, AI automation, and Copilot Studio chatbot projects by Laurence Alec Burce.",
    url: "/",
    siteName: "Laurence Alec Burce",
    type: "website",
    images: [
      {
        url: "/logos/og-banner.svg",
        width: 1200,
        height: 630,
        alt: "Laurence Alec Burce - Software Engineer and AI Automation"
      }
    ]
  },
  twitter: {
    card: "summary_large_image",
    title: "Laurence Alec Burce | Software Engineer",
    description:
      "Enterprise software engineering, Oracle SaaS ERP, client web apps, AI automation, and Copilot Studio chatbot projects by Laurence Alec Burce.",
    images: ["/logos/og-banner.svg"]
  }
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={`${manrope.variable} ${dmSerifDisplay.variable}`}>
        <div style={{
          background: "#78716c",
          color: "#f5f5f4",
          textAlign: "center",
          padding: "8px 16px",
          fontSize: "13px",
          fontWeight: "500",
          letterSpacing: "0.02em"
        }}>
          This website is a work in progress — some things may be incomplete or change.
        </div>
        {children}
        <AuthSessionTracker />
        <AuthWelcome />
        <ChatWidget />
      </body>
    </html>
  );
}
