import { DM_Serif_Display, Manrope } from "next/font/google";
import "./globals.css";

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
  title: "Laurence Alec Burce | Software Engineer",
  description:
    "Portfolio of Laurence Alec Burce - software engineer with 3 years of experience in Oracle SaaS ERP systems, client web apps, AI automation, and Copilot Studio chatbots.",
  openGraph: {
    title: "Laurence Alec Burce | Software Engineer",
    description:
      "Enterprise software engineering, Oracle SaaS ERP, client web apps, AI automation, and Copilot Studio chatbot projects by Laurence Alec Burce.",
    type: "website",
    images: [{ url: "/opengraph-image", width: 1200, height: 630 }]
  },
  twitter: {
    card: "summary_large_image",
    title: "Laurence Alec Burce | Software Engineer",
    description:
      "Enterprise software engineering, Oracle SaaS ERP, client web apps, AI automation, and Copilot Studio chatbot projects by Laurence Alec Burce.",
    images: ["/opengraph-image"]
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
      </body>
    </html>
  );
}
