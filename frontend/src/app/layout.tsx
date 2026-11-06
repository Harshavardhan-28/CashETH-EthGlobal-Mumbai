import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
  display: "swap",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "CashETH - Invoices your agents can spend",
  description:
    "A seller agent turns a buyer-signed receivable into USDC working capital. Worker agents spend it through x402. Lenders are repaid first, automatically.",
  icons: { icon: "/CashETH.png" },
};

// Runs before first paint so the saved theme never flashes.
const themeInit = `(function(){var t='dark';try{t=localStorage.getItem('casheth-theme')||'dark'}catch(e){}document.documentElement.setAttribute('data-theme',t)})();`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      data-theme="dark"
      suppressHydrationWarning
      className={`${geist.variable} ${geistMono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
