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
];

export function Nav() {
  const pathname = usePathname();
  const {address, isConnected} = useAccount();
  const {connect, connectors, isPending} = useConnect();
  const {disconnect} = useDisconnect();
  // Discovered through EIP-6963. Empty means no wallet extension announced itself, which the
  // button says plainly rather than sitting there doing nothing when clicked.
  const wallet = connectors[0];

  return (
    <header className="border-b border-line">
      <div className="mx-auto flex max-w-5xl items-center gap-6 px-5 py-3.5">
        <Link href="/" className="text-sm font-semibold tracking-tight">
          TrueSend
        </Link>

        <nav className="flex gap-1">
          {TABS.map((tab) => {
            const active = pathname === tab.href;
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                  active ? "bg-raised text-text" : "text-muted hover:text-text"
                }`}
              >
                {tab.label}
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
