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
 * A placeholder table full of zero addresses would read like a deployment that exists.
 * `forge script script/Deploy.s.sol --broadcast` writes `contracts/deployments/<chainid>.json`, and
 * `tools/deployment-env.mjs` turns the committed records into these variables - the live demo's
 * build runs it, and so can a local `.env.local`. Sepolia has had a record since 2026-10-06. Where
 * a chain has none, `deploymentFor` returns undefined and the screens that need a policy say so.
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

// The tokens known for certain, with their dust thresholds, are `KNOWN_TOKENS` in `@truesend/chain`:
// the replay of the May 2024 case in `packages/chain/test/` has to read the same list as this app.
