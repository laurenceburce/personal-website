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

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "Person",
  name: "Laurence Alec Burce",
  url: "https://laurenceburce.com",
  jobTitle: "Software Engineer",
  description:
    "Software engineer with experience in Oracle SaaS ERP systems, client web apps, AI automation, and Copilot Studio chatbots.",
  sameAs: [
    "https://github.com/laurenceburce",
    "https://www.linkedin.com/in/laurenceburce"
  ],
  knowsAbout: [
    "Java",
    "Python",
    "JavaScript",
    "TypeScript",
    "React",
    "Next.js",
    "Oracle SaaS ERP",
    "Spring Boot",
    "AI Automation",
    "Copilot Studio"
  ]
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body className={`${manrope.variable} ${dmSerifDisplay.variable}`}>
        {children}
        <AuthSessionTracker />
        <AuthWelcome />
        <ChatWidget />
      </body>
    </html>
  );
}
