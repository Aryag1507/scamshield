import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "ScamShield: is this message a scam?",
  description:
    "Paste a text, email, or chat message and find out in seconds whether it's a scam, with the warning signs explained.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

const GITHUB_URL = "https://github.com/Aryag1507/scamshield";

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`}>
        <header className="mx-auto flex max-w-3xl items-center justify-between px-4 py-5">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <ShieldIcon />
            ScamShield
          </Link>
          <nav className="flex items-center gap-5 text-sm text-muted">
            <Link href="/#how-it-works" className="hover:text-foreground">How it works</Link>
            <a href={GITHUB_URL} className="hover:text-foreground">GitHub</a>
          </nav>
        </header>
        <main className="mx-auto max-w-3xl px-4">{children}</main>
        <footer className="mx-auto mt-24 max-w-3xl border-t border-border px-4 py-8 text-sm text-muted">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>ScamShield flags warning signs. It can be wrong, so when in doubt, contact the company directly.</span>
            <Link href="/privacy" className="hover:text-foreground">Privacy</Link>
          </div>
        </footer>
      </body>
    </html>
  );
}

function ShieldIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 2.5 4 5.5v6.2c0 4.7 3.3 8.6 8 9.8 4.7-1.2 8-5.1 8-9.8V5.5l-8-3Z" fill="var(--accent)" />
      <path d="m8.5 12 2.5 2.5 4.5-5" stroke="var(--surface)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
