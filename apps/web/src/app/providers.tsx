"use client";

import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {useState, type ReactNode} from "react";
import {WagmiProvider, createConfig, http} from "wagmi";
import {anvil, mainnet, sepolia} from "wagmi/chains";

/**
 * Wallets arrive through EIP-6963 discovery rather than a declared connector list.
 *
 * Two reasons. Every wallet worth supporting announces itself this way now, and the user gets
 * whichever ones they actually have instead of whichever ones were hard-coded. And importing
 * `wagmi/connectors` pulls the whole barrel — Coinbase, WalletConnect, Safe — which drags in
 * optional dependencies that are not installed and fails the production build outright.
 *
 * WalletConnect is the notable omission: it would add reach, but it needs a project id from a
 * third party before the app will start at all, and a demo that cannot run without someone else's
 * API key is a demo that does not run.
 */
const config = createConfig({
  chains: [mainnet, sepolia, anvil],
  multiInjectedProviderDiscovery: true,
  transports: {
    [mainnet.id]: http(process.env.NEXT_PUBLIC_MAINNET_RPC ?? "https://rpc.mevblocker.io"),
    [sepolia.id]: http(
      process.env.NEXT_PUBLIC_SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com",
    ),
    [anvil.id]: http("http://127.0.0.1:8545"),
  },
  ssr: true,
});

export function Providers({children}: {children: ReactNode}) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
