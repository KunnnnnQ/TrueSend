"use client";

import {Suspense, useEffect, useState} from "react";
import {useSearchParams} from "next/navigation";
import {formatUnits, zeroAddress} from "viem";
import {useBlock, useWaitForTransactionReceipt, useWriteContract} from "wagmi";

import {assessAddress, type AddressSighting} from "@truesend/engine";

import {AddressCard} from "@/components/Fingerprint";
import {Findings, RiskChip} from "@/components/Risk";
import {PolicyBar} from "@/components/PolicyBar";
import {useLastScan} from "@/lib/scanStore";
import {
  humaniseDuration,
  policyAbi,
  usePendingTransfers,
  usePolicy,
  usePolicyTarget,
  type PendingTransfer,
} from "@/lib/policy";

/**
 * The alert's cancel link lands here.
 *
 * `useSearchParams` makes this page dynamic, which Next requires a boundary for; the fallback is
 * the same page without the deep link rather than a spinner, because the queue is worth showing
 * even while the parameters are still being read.
 */
export default function PendingPage() {
  return (
    <Suspense fallback={<Heading />}>
      <PendingScreen />
    </Suspense>
  );
}

/**
 * The static shell.
 *
 * Reading search params makes a component dynamic, so the fallback must not read them — an
 * earlier version used the same component for both and the page failed to prerender at all.
 */
function Heading() {
  return (
    <section className="rise">
      <h1 className="headline text-4xl font-semibold sm:text-5xl">Pending</h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
        Transfers waiting out their hold. Cancelling stays available right up until one is
        executed — the hold is the earliest a transfer <em>may</em> settle, not a window after
        which it becomes unstoppable.
      </p>
    </section>
  );
}

function PendingScreen() {
  const {address: policyAddress, chainId, setAddress, setChainId} = usePolicyTarget();

  // A one-click cancel link carries the account, the chain and the transfer. Applying all three
  // means the person who just got the alert lands on the button, not on a form to fill in.
  const params = useSearchParams();
  const linkedTransferId = params.get("id");
  useEffect(() => {
    const policy = params.get("policy");
    const chain = params.get("chain");
    if (policy) setAddress(policy);
    if (chain) setChainId(Number(chain));
  }, [params, setAddress, setChainId]);
  const {policy, isLoading} = usePolicy(policyAddress, chainId);
  const {queued, refetch} = usePendingTransfers(policyAddress, policy?.nextTransferId, chainId);

  const now = useChainClock(chainId);
  // Same history the Send screen uses, so a queued transfer carries the verdict that should have
  // stopped it rather than a shrug.
  const lastScan = useLastScan();

  const {writeContract, data: txHash, isPending, error} = useWriteContract();
  const receipt = useWaitForTransactionReceipt({hash: txHash});

  useEffect(() => {
    if (receipt.isSuccess) void refetch();
  }, [receipt.isSuccess, refetch]);

  return (
    <div className="space-y-8">
      <Heading />

      <PolicyBar
        address={policyAddress}
        onAddressChange={setAddress}
        chainId={chainId}
        onChainChange={setChainId}
        policy={policy}
        loading={isLoading}
      />

      {error ? <p className="text-sm text-danger">{error.message.split("\n")[0]}</p> : null}

      {policy?.initialized ? (
        queued.length === 0 ? (
          <p className="rounded-lg border border-line bg-surface p-6 text-sm text-muted">
            Nothing is waiting. Anything sent to an address this account has not trusted will
            appear here instead of leaving.
          </p>
        ) : (
          <ul className="space-y-3">
            {queued.map((transfer) => (
              <QueuedRow
                key={transfer.id.toString()}
                transfer={transfer}
                now={now}
                history={lastScan?.history}
                highlighted={transfer.id.toString() === linkedTransferId}
                busy={isPending}
                onCancel={() =>
                  writeContract({
                    abi: policyAbi,
                    address: policyAddress!,
                    chainId,
                    functionName: "cancelQueued",
                    args: [transfer.id],
                  })
                }
                onExecute={() =>
                  writeContract({
                    abi: policyAbi,
                    address: policyAddress!,
                    chainId,
                    functionName: "executeQueued",
                    args: [transfer.id],
                  })
                }
              />
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

/**
 * Seconds, as the chain counts them.
 *
 * The contract compares against `block.timestamp`, so a countdown driven by the browser's clock
 * is answering a different question. Usually the two agree closely enough that nobody notices;
 * they do not on a local chain whose time has been advanced, and they do not for a user whose
 * system clock is wrong — who would be told a hold is still running when the chain would already
 * let the transfer through, or the reverse.
 *
 * Anchored to the latest block and ticked locally in between, so the number still moves every
 * second without a request per second.
 */
function useChainClock(chainId: number): number {
  const {data: block} = useBlock({chainId, watch: true});
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    if (block) setOffset(Number(block.timestamp) - Math.floor(Date.now() / 1000));
  }, [block]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);

  return now + offset;
}

function QueuedRow({
  transfer,
  now,
  history,
  highlighted,
  busy,
  onCancel,
  onExecute,
}: {
  transfer: PendingTransfer;
  now: number;
  history: AddressSighting[] | undefined;
  highlighted: boolean;
  busy: boolean;
  onCancel: () => void;
  onExecute: () => void;
}) {
  const unlockAt = Number(transfer.unlockAt);
  const remaining = unlockAt - now;
  const unlocked = remaining <= 0;
  const assessment = assessAddress({to: transfer.to, now, ...(history ? {history} : {})});

  const isNative = transfer.token === zeroAddress;
  // Without the token's metadata the honest thing is to show raw units rather than guess at 18
  // decimals and render a number that is wrong by a factor of a billion.
  const amount = isNative
    ? `${formatUnits(transfer.amount, 18)} ETH`
    : `${transfer.amount.toString()} units`;

  return (
    <li
      className={`rounded-lg border bg-surface ${
        highlighted ? "border-accent ring-1 ring-accent/40" : "border-line"
      }`}
    >
      <div className="flex flex-wrap items-start gap-4 p-4">
        <AddressCard address={transfer.to} />

        <div className="ml-auto text-right">
          <div className="tabular text-sm text-text">{amount}</div>
          {!isNative ? (
            <div className="tabular text-xs text-faint" title={transfer.token}>
              {transfer.token.slice(0, 8)}…{transfer.token.slice(-4)}
            </div>
          ) : null}
        </div>

        <div className="w-full border-t border-line pt-3 sm:w-auto sm:border-0 sm:pt-0">
          <div
            className={`tabular text-right text-sm ${unlocked ? "text-safe" : "text-accent"}`}
            aria-live="polite"
          >
            {unlocked ? "Hold over" : `Unlocks in ${humaniseDuration(remaining)}`}
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onCancel}
              className="rounded-md border border-danger/40 px-3 py-1.5 text-sm text-danger transition-colors hover:bg-danger/10 disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || !unlocked}
              onClick={onExecute}
              title={unlocked ? undefined : "The hold has not elapsed yet"}
              className="rounded-md border border-line-strong px-3 py-1.5 text-sm transition-colors hover:bg-raised disabled:opacity-30"
            >
              Execute
            </button>
          </div>
        </div>
      </div>

      {assessment.findings.length > 0 ? (
        <div className="flex items-start gap-3 border-t border-line px-4 py-3">
          <RiskChip level={assessment.level} score={assessment.score} />
          <div className="min-w-0 flex-1">
            <Findings assessment={assessment} />
          </div>
        </div>
      ) : null}
    </li>
  );
}
