import {anvil, mainnet, sepolia} from "wagmi/chains";
import {isAddress, type Address} from "viem";

/** The singletons a chain needs before Send and Pending can do anything. */
export interface Deployment {
  chainId: number;
  safeVaultFactory: Address;
  guardedAccountImplementation: Address;
}

/**
 * Addresses come from the environment rather than from a checked-in table.
 *
 * Nothing is deployed yet, and a placeholder file full of zero addresses would read like a
 * deployment that exists. `forge script script/Deploy.s.sol --broadcast` writes
 * `contracts/deployments/<chainid>.json`; copy the two addresses into `.env.local` and the app
 * picks them up. Until then `deploymentFor` returns undefined and the screens that need a policy
 * say so plainly.
 */
function fromEnv(chainId: number, factory?: string, account?: string): Deployment | undefined {
  if (!factory || !account || !isAddress(factory) || !isAddress(account)) return undefined;
  return {
    chainId,
    safeVaultFactory: factory as Address,
    guardedAccountImplementation: account as Address,
  };
}

const DEPLOYMENTS: Partial<Record<number, Deployment | undefined>> = {
  [sepolia.id]: fromEnv(
    sepolia.id,
    process.env.NEXT_PUBLIC_SEPOLIA_VAULT_FACTORY,
    process.env.NEXT_PUBLIC_SEPOLIA_GUARDED_ACCOUNT,
  ),
  [anvil.id]: fromEnv(
    anvil.id,
    process.env.NEXT_PUBLIC_ANVIL_VAULT_FACTORY,
    process.env.NEXT_PUBLIC_ANVIL_GUARDED_ACCOUNT,
  ),
};

export function deploymentFor(chainId: number | undefined): Deployment | undefined {
  return chainId === undefined ? undefined : DEPLOYMENTS[chainId];
}

export const SUPPORTED_CHAINS = [mainnet, sepolia, anvil] as const;

/**
 * Where history is read from.
 *
 * Mainnet defaults to an endpoint that answers archive queries on a free plan, because the Scan
 * screen looks back further than a pruned node keeps. `analysis/src/rpc.mjs` records which public
 * endpoints do and which do not, and why none of it is in their documentation.
 */
export const HISTORY_RPC: Partial<Record<number, string>> = {
  [mainnet.id]: process.env.NEXT_PUBLIC_MAINNET_RPC ?? "https://rpc.mevblocker.io",
  [sepolia.id]: process.env.NEXT_PUBLIC_SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com",
  [anvil.id]: "http://127.0.0.1:8545",
};

export interface KnownToken {
  address: Address;
  symbol: string;
  decimals: number;
  /** Inbound transfers strictly below this many whole units count as dust. */
  dustBelow: number;
}

/**
 * Tokens we can put a dust threshold on.
 *
 * This is **not** the list the Scan screen walks — that would make the attack invisible, because
 * the bait is always a contract the attacker deployed. Scanning is by topic across every token;
 * this table only supplies decimals so a small inbound amount can be called dust rather than
 * guessed at.
 */
export const KNOWN_TOKENS: Partial<Record<number, KnownToken[]>> = {
  [mainnet.id]: [
    {address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", decimals: 6, dustBelow: 1},
    {address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6, dustBelow: 1},
    {address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", symbol: "WBTC", decimals: 8, dustBelow: 0.0001},
  ],
  [sepolia.id]: [],
  [anvil.id]: [],
};
