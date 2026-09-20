import type {Metadata} from "next";
import type {ReactNode} from "react";

import {Nav} from "@/components/Nav";

import {Providers} from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "TrueSend",
  description:
    "A revocable on-chain hold and a fingerprint a person can check, against address poisoning.",
};

export default function RootLayout({children}: {children: ReactNode}) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <Providers>
          <Nav />
          <main className="mx-auto max-w-5xl px-5 py-8">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
