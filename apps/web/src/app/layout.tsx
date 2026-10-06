import type {Metadata} from "next";
import localFont from "next/font/local";
import type {ReactNode} from "react";

import {Backdrop} from "@/components/Backdrop";
import {Nav} from "@/components/Nav";

import {Providers} from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "TrueSend",
  description:
    "A revocable on-chain hold and a fingerprint a person can check, against address poisoning.",
};

/*
 * Geist, shipped with the app rather than fetched at build time (fonts/Geist-OFL.txt is its SIL
 * Open Font License). A build that needs Google Fonts reachable is a build that fails on some
 * networks, and the font is the one part of a page that never changes.
 */
const sans = localFont({
  src: "./fonts/Geist-Variable.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
  display: "swap",
});

const mono = localFont({
  src: "./fonts/GeistMono-Variable.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
});

export default function RootLayout({children}: {children: ReactNode}) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen">
        <Backdrop />
        <Providers>
          <Nav />
          <main className="mx-auto max-w-5xl px-5 py-10">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
