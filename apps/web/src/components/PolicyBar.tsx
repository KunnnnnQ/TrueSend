"use client";

import Link from "next/link";
import type {Address} from "viem";

import {AddressCard} from "./Fingerprint";
import {SUPPORTED_CHAINS} from "@/lib/chains";
import {humaniseDuration, type PolicyView} from "@/lib/policy";

/**
 * The header both action screens share: which account's policy is in force, and what it says.
 *
 * Shown on every screen that can move funds, because "which account am I about to spend from" is
 * exactly the question a user should never have to guess at in a tool whose whole subject is
 * sending to the wrong place.
 */
export function PolicyBar({
  address,
  onAddressChange,
  chainId,
  onChainChange,
  policy,
  loading,
}: {
  address: Address | undefined;
  onAddressChange: (next: string) => void;
  chainId: number;
  onChainChange: (next: number) => void;
  policy: PolicyView | undefined;
  loading: boolean;
}) {
  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-72 flex-1">
          <span className="mb-1.5 block text-xs uppercase tracking-wide text-faint">
            Protected account
          </span>
          <input
            defaultValue={address ?? ""}
            onChange={(e) => onAddressChange(e.target.value.trim())}
            placeholder="Your SafeVault, or your own address if it is delegated"
            spellCheck={false}
            className="tabular w-full rounded-md border border-line bg-ink px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </label>
        <label className="w-44">
          <span className="mb-1.5 block text-xs uppercase tracking-wide text-faint">Network</span>
          <select
            value={chainId}
            onChange={(e) => onChainChange(Number(e.target.value))}
            className="w-full rounded-md border border-line bg-ink px-3 py-2 text-sm outline-none focus:border-accent"
          >
            {SUPPORTED_CHAINS.map((chain) => (
              <option key={chain.id} value={chain.id}>
                {chain.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {address ? (
        <div className="mt-4 flex flex-wrap items-start gap-x-8 gap-y-4">
          <AddressCard address={address} />

          {loading ? (
            <p className="text-sm text-muted">Reading policy…</p>
          ) : policy?.initialized ? (
            <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-sm">
              <dt className="text-faint">Hold</dt>
              <dd className="tabular">{humaniseDuration(policy.cooldown)}</dd>
              <dt className="text-faint">New contacts active after</dt>
              <dd className="tabular">
                {policy.trustDelay === 0 ? "immediately" : humaniseDuration(policy.trustDelay)}
              </dd>
              <dt className="text-faint">Guardian</dt>
              <dd className="tabular">
                {policy.guardian === "0x0000000000000000000000000000000000000000"
                  ? "none"
                  : `${policy.guardian.slice(0, 8)}…${policy.guardian.slice(-4)}`}
              </dd>
            </dl>
          ) : (
            <NoPolicy />
          )}
        </div>
      ) : null}
    </section>
  );
}

function NoPolicy() {
  return (
    <div className="max-w-md text-sm leading-relaxed text-muted">
      <p className="text-caution">No TrueSend policy at this address.</p>
      <p className="mt-1.5">
        Nothing is deployed on a public network yet. To try it, run a local chain and deploy —{" "}
        <code className="tabular text-xs text-text">contracts/deployments/README.md</code> has the
        two commands — then paste the vault address here.
      </p>
      <p className="mt-1.5">
        <Link href="/" className="text-accent underline-offset-2 hover:underline">
          Scan
        </Link>{" "}
        works against real mainnet history without any of this.
      </p>
    </div>
  );
}
