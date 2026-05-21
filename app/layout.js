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
    "Portfolio of Laurence Alec Burce - software engineer focused on enterprise systems and AI automation.",
  openGraph: {
    title: "Laurence Alec Burce | Software Engineer",
    description:
      "Enterprise software engineering and AI automation projects by Laurence Alec Burce.",
    type: "website"
  }
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={`${manrope.variable} ${dmSerifDisplay.variable}`}>
        {children}
      </body>
    </html>
  );
}