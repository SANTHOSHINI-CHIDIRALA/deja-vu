import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Déjà Vu — the on-call agent that remembers every outage",
  description: "Incident console powered by Hindsight memory: recalls how similar outages were diagnosed and fixed, and learns from every resolution.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0a0d12" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="sticky top-0 z-30 border-b border-ink-700 bg-ink-950/90 backdrop-blur">
          <div className="mx-auto flex max-w-[1600px] items-center gap-3 px-4 py-3 sm:px-6">
            <Link href="/" className="flex items-center gap-2">
              <span aria-hidden className="grid h-8 w-8 place-items-center rounded-md bg-accent font-mono text-sm font-black text-ink-950">
                DV
              </span>
              <span className="text-lg font-semibold tracking-tight">Déjà Vu</span>
            </Link>
            <span className="hidden text-sm text-ink-400 md:inline">The on-call agent that remembers every outage.</span>
            <nav className="ml-auto flex gap-1 text-sm">
              <Link href="/" className="rounded-md px-3 py-1.5 text-ink-300 hover:bg-ink-800 hover:text-ink-100">
                Console
              </Link>
              <Link href="/learning" className="rounded-md px-3 py-1.5 text-ink-300 hover:bg-ink-800 hover:text-ink-100">
                Learning curve
              </Link>
            </nav>
          </div>
          <p className="px-4 pb-2 text-xs text-ink-400 md:hidden">The on-call agent that remembers every outage.</p>
        </header>
        <main className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6">{children}</main>
      </body>
    </html>
  );
}
