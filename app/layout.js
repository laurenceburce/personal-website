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
  applicationName: "Laurence Alec Burce",
  title: "Laurence Alec Burce | Software Engineer",
  description:
    "Portfolio of Laurence Alec Burce - software engineer with 3 years of experience in Oracle SaaS ERP systems, client web apps, AI automation, and Copilot Studio chatbots.",
  alternates: {
    canonical: "/"
  },
  icons: {
    icon: [
      { url: "/favicon-48x48.png", type: "image/png", sizes: "48x48" },
      { url: "/favicon-96x96.png", type: "image/png", sizes: "96x96" },
      { url: "/favicon-192x192.png", type: "image/png", sizes: "192x192" },
      { url: "/logos/lab-favicon.svg", type: "image/svg+xml", sizes: "any" }
    ],
    shortcut: "/favicon-48x48.png",
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }
    ]
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
  "@graph": [
    {
      "@type": "WebSite",
      "@id": "https://laurenceburce.com/#website",
      name: "Laurence Alec Burce",
      url: "https://laurenceburce.com",
      publisher: {
        "@id": "https://laurenceburce.com/#person"
      }
    },
    {
      "@type": "Person",
      "@id": "https://laurenceburce.com/#person",
      name: "Laurence Alec Burce",
      url: "https://laurenceburce.com",
      image: "https://laurenceburce.com/logo-512.png",
      jobTitle: "Software Engineer",
      description:
        "Software engineer with experience in Oracle SaaS ERP systems, client web apps, AI automation, and Copilot Studio chatbots.",
      sameAs: [
        "https://github.com/laurenceburce",
        "https://www.linkedin.com/in/laurence-burce"
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
    }
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
