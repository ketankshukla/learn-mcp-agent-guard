import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "mcp-agent-guard — the agent that asks first",
  description:
    "An MCP host that stops before it does something it can't undo: a notebook (Postgres), an are-you-sure (human-in-the-loop approval gates), and a report card (evals).",
};

/**
 * Typed explicitly rather than with Next's generated `LayoutProps<"/">`, so
 * `npx tsc --noEmit` works on a fresh clone before anything has been built.
 * The generated types live in `.next/types`, which does not exist yet.
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} antialiased`}
    >
      <body>{children}</body>
    </html>
  );
}
