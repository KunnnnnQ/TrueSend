"use client";

import {useCallback, useEffect, useState} from "react";
import {isAddress, zeroAddress, type Address} from "viem";
import {useAccount, useReadContract, useReadContracts} from "wagmi";
import {mainnet} from "wagmi/chains";

export {policyAbi} from "@truesend/chain";
import {policyAbi} from "@truesend/chain";

const STORAGE_KEY = "truesend.policy-address";
const CHAIN_KEY = "truesend.policy-chain";

/**
 * Which account's policy the Send and Pending screens act on, and on which chain.
 *
 * Both are kept per browser rather than derived from the wallet, because neither follows from it.
 * In vault mode the policy lives at a contract the wallet owns; in 7702 mode it lives at the
 * wallet's own address. And the chain it lives on is not necessarily the one the wallet happens
 * to be pointed at — a user reviewing a hold does not want to be told there is nothing pending
 * because their wallet was left on a different network.
 */
export function usePolicyTarget(): {
  address: Address | undefined;
  chainId: number;
  setAddress: (next: string) => void;
  setChainId: (next: number) => void;
} {
  const {address: connected, chainId: walletChain} = useAccount();
  const [stored, setStored] = useState<string>("");
  const [chain, setChain] = useState<number | undefined>(undefined);

  useEffect(() => {
    setStored(window.localStorage.getItem(STORAGE_KEY) ?? "");
    const saved = window.localStorage.getItem(CHAIN_KEY);
    if (saved) setChain(Number(saved));
  }, []);

  const setAddress = useCallback((next: string) => {
    setStored(next);
    if (next) window.localStorage.setItem(STORAGE_KEY, next);
    else window.localStorage.removeItem(STORAGE_KEY);
  }, []);

  const setChainId = useCallback((next: number) => {
    setChain(next);
    window.localStorage.setItem(CHAIN_KEY, String(next));
  }, []);

  return {
    address: isAddress(stored) ? (stored as Address) : connected,
    chainId: chain ?? walletChain ?? mainnet.id,
    setAddress,
    setChainId,
  };
}

export interface PolicyView {
  initialized: boolean;
  owner: Address;
  cooldown: number;
  trustDelay: number;
  guardian: Address;
  pendingCooldown: number;
  pendingCooldownUnlockAt: bigint;
  pendingGuardian: Address;
  pendingGuardianUnlockAt: bigint;
  nextTransferId: bigint;
}

export function usePolicy(address: Address | undefined, chainId: number) {
  const query = useReadContract({
    abi: policyAbi,
    address,
    chainId,
    functionName: "policy",
    query: {enabled: Boolean(address), retry: false},
  });

  const policy = query.data as PolicyView | undefined;

  return {
    ...query,
    policy,
    /**
     * An address with no policy is the common case, not an error: an ordinary EOA, or a contract
     * that is not a TrueSend account. The screens say so rather than showing a failure.
     */
    hasPolicy: Boolean(policy?.initialized),
  };
}

export const TransferStatus = {
  None: 0,
  Queued: 1,
  Executed: 2,
  Cancelled: 3,
} as const;

export interface PendingTransfer {
  id: bigint;
  to: Address;
  token: Address;
  amount: bigint;
  queuedAt: bigint;
  unlockAt: bigint;
  status: number;
}

/**
 * Read the whole queue.
 *
 * Ids are dense and monotonic — an invariant the contracts assert — so walking `1..nextTransferId`
 * is guaranteed to see every entry that has ever existed. That is deliberate: it means this screen
 * cannot miss a queued transfer because an event was dropped, which for a cancel button is the
 * difference between a safety net and a decoration.
 */
export function usePendingTransfers(
  address: Address | undefined,
  nextTransferId: bigint | undefined,
  chainId: number,
) {
  const ids: bigint[] = [];
  if (nextTransferId !== undefined) {
    // Most recent first; a queue deep enough for this cap is already a different problem.
    const first = nextTransferId > 200n ? nextTransferId - 200n : 1n;
    for (let id = nextTransferId - 1n; id >= first; id--) ids.push(id);
  }

  const query = useReadContracts({
    contracts: ids.map((id) => ({
      abi: policyAbi,
      address,
      chainId,
      functionName: "getTransfer" as const,
      args: [id] as const,
    })),
    query: {enabled: Boolean(address) && ids.length > 0},
  });

  const transfers: PendingTransfer[] = (query.data ?? []).flatMap((entry, index) => {
    if (entry.status !== "success") return [];
    const raw = entry.result as unknown as Omit<PendingTransfer, "id">;
    return [{...raw, id: ids[index]!}];
  });

  return {
    ...query,
    transfers,
    queued: transfers.filter((t) => t.status === TransferStatus.Queued),
  };
}

export const NATIVE: Address = zeroAddress;

/** Seconds into something a person reads without converting. */
export function humaniseDuration(seconds: number): string {
  if (seconds <= 0) return "now";
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
  if (seconds < 48 * 3600) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.round(seconds / 86_400)} days`;
}
