"use client";

import Link from "next/link";
import {usePathname} from "next/navigation";
import {useAccount, useConnect, useDisconnect} from "wagmi";

import {fingerprint} from "@truesend/engine";

import {Identicon} from "./Fingerprint";

const TABS = [
  {href: "/", label: "Scan"},
  {href: "/send", label: "Send"},
  {href: "/pending", label: "Pending"},
  {href: "/report", label: "Report"},
];

export function Nav() {
  // Without its trailing slash: the GitHub Pages build exports every page as a directory
  // (`trailingSlash` in next.config.ts), so there this reads `/send/`, and comparing it to `/send`
  // as it was left no tab marked as the current page.
  const pathname = usePathname().replace(/(.)\/+$/, "$1");
  const {address, isConnected} = useAccount();
  const {connect, connectors, isPending} = useConnect();
  const {disconnect} = useDisconnect();
  // Discovered through EIP-6963. Empty means no wallet extension announced itself, which the
  // button says plainly rather than sitting there doing nothing when clicked.
  const wallet = connectors[0];

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-ink/70 backdrop-blur-md">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3.5">
        <Link href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          {/* A filled square beside an outlined one: the address you meant, and the one beside it. */}
          <span aria-hidden className="flex gap-0.5">
            <span className="h-2.5 w-2.5 bg-text" />
            <span className="h-2.5 w-2.5 border border-text" />
          </span>
          TrueSend
        </Link>

        {/* On a phone the tabs take a row of their own, under the name and the wallet button: in
            one row the four of them pushed the page wider than the screen. Last in the header
            either way, so the active tab's underline still lands on its bottom edge. */}
        <nav className="order-last flex w-full gap-1 sm:order-none sm:w-auto">
          {TABS.map((tab) => {
            const active = pathname === tab.href;
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`relative rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                  active ? "text-text" : "text-muted hover:text-text"
                }`}
              >
                {tab.label}
                {active ? (
                  <span
                    aria-hidden
                    className="underline-draw absolute inset-x-2.5 -bottom-[15px] h-px bg-text"
                  />
                ) : null}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto">
          {isConnected && address ? (
            <button
              type="button"
              onClick={() => disconnect()}
              className="flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-sm text-muted transition-colors hover:border-line-strong hover:text-text"
              title="Disconnect"
            >
              <Identicon address={address} size={18} />
              <span className="tabular">{fingerprint(address).short}</span>
            </button>
          ) : (
            <button
              type="button"
              disabled={!wallet || isPending}
              onClick={() => wallet && connect({connector: wallet})}
              title={wallet ? `Connect ${wallet.name}` : "No wallet extension detected"}
              className="rounded-md border border-line-strong px-3 py-1.5 text-sm text-text transition-colors hover:bg-raised disabled:opacity-50"
            >
              {isPending ? "Connecting…" : wallet ? `Connect ${wallet.name}` : "No wallet found"}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
