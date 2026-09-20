"use client";

import {useMemo, useState} from "react";
import {parseUnits, type Address} from "viem";
import {useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract} from "wagmi";

import {assessAddress, checkAddressFormat} from "@truesend/engine";

import {Findings, LookalikeComparison, ReportLine, RiskChip} from "@/components/Risk";
import {PolicyBar} from "@/components/PolicyBar";
import {NATIVE, humaniseDuration, policyAbi, usePolicy, usePolicyTarget} from "@/lib/policy";
import {registryFor, useReports} from "@/lib/registry";
import {useLastScan} from "@/lib/scanStore";

export default function SendPage() {
  const {isConnected} = useAccount();
  const {address: policyAddress, chainId, setAddress, setChainId} = usePolicyTarget();
  const {policy, isLoading} = usePolicy(policyAddress, chainId);

  const [to, setTo] = useState("");
  const [token, setToken] = useState<string>(NATIVE);
  const [decimals, setDecimals] = useState("18");
  const [amount, setAmount] = useState("");

  const format = to.trim() ? checkAddressFormat(to.trim()) : undefined;
  const recipientValid = format === "valid";
  const recipient = recipientValid ? (to.trim() as Address) : undefined;

  const parsedAmount = useMemo(() => {
    if (!amount.trim()) return undefined;
    try {
      return parseUnits(amount.trim(), Number(decimals) || 0);
    } catch {
      return undefined;
    }
  }, [amount, decimals]);

  /**
   * Ask the contract what it will do, before anything is signed.
   *
   * The same decision the policy will make at execution time, so the screen cannot promise one
   * thing and the chain do another.
   */
  const quote = useReadContract({
    abi: policyAbi,
    address: policyAddress,
    chainId,
    functionName: "quote",
    args:
      recipient && parsedAmount !== undefined
        ? [recipient, token as Address, parsedAmount]
        : undefined,
    query: {enabled: Boolean(policyAddress && recipient && parsedAmount !== undefined)},
  });

  const [instant, unlockAt] = (quote.data as [boolean, bigint] | undefined) ?? [];

  /**
   * Scored against the last scan, when there is one.
   *
   * Without it this screen would know nothing beyond the address that was pasted — and would
   * cheerfully report "no history, normal for a first payment" about an address whose only
   * credential is a payment record somebody else fabricated. The verdict has to follow the user
   * from the screen that found it to the screen that spends.
   */
  const lastScan = useLastScan();

  /**
   * Community reports for this one recipient.
   *
   * Handed to `assessAddress` rather than shown beside its verdict, because a report *is* one of
   * the engine's findings — it has a weight, a sentence and a place in the ordering, and the
   * scoring's cap on reports is applied across the combination rather than to this finding alone.
   * Re-implementing that here to display it separately would be a second implementation of the
   * rule that keeps a permissionless registry from condemning an address by itself.
   *
   * `registryFor` is undefined on every public chain today, so in practice this contributes
   * nothing and the screen behaves exactly as it did before the registry existed.
   */
  const registry = registryFor(chainId);
  const {reports} = useReports(registry, recipient ? [recipient] : [], chainId);
  const report = reports[0];

  const assessment = useMemo(
    () =>
      recipient
        ? assessAddress({
            to: recipient,
            ...(lastScan ? {history: lastScan.history} : {}),
            ...(reports.length > 0 ? {reports} : {}),
          })
        : undefined,
    [recipient, lastScan, reports],
  );

  const {writeContract, data: txHash, isPending, error: writeError} = useWriteContract();
  const receipt = useWaitForTransactionReceipt({hash: txHash});

  const canSend =
    isConnected &&
    Boolean(policyAddress) &&
    policy?.initialized &&
    recipient !== undefined &&
    parsedAmount !== undefined &&
    parsedAmount > 0n;

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">Send</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          A recipient the account has not trusted does not settle. It goes into a hold you can
          cancel. You are told which it will be before you sign.
        </p>
      </section>

      <PolicyBar
        address={policyAddress}
        onAddressChange={setAddress}
        chainId={chainId}
        onChainChange={setChainId}
        policy={policy}
        loading={isLoading}
      />

      <section className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-4 rounded-lg border border-line bg-surface p-4">
          <label className="block">
            <span className="mb-1.5 block text-xs uppercase tracking-wide text-faint">To</span>
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="0x…"
              spellCheck={false}
              className={`tabular w-full rounded-md border bg-ink px-3 py-2 text-sm outline-none focus:border-accent ${
                to.trim() && !recipientValid ? "border-danger" : "border-line"
              }`}
            />
            {format === "not-an-address" ? (
              <span className="mt-1.5 block text-xs text-danger">
                Not a 20-byte hex address.
              </span>
            ) : null}
            {format === "bad-checksum" ? (
              <span className="mt-1.5 block text-xs leading-relaxed text-danger">
                This is the right shape, but its checksum does not match. The address has been
                altered or mistyped somewhere between the sender and here — ask the recipient for
                it again rather than fixing the capitalisation.
              </span>
            ) : null}
          </label>

          <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
            <label className="block">
              <span className="mb-1.5 block text-xs uppercase tracking-wide text-faint">
                Token (blank for ETH)
              </span>
              <input
                value={token === NATIVE ? "" : token}
                onChange={(e) => setToken(e.target.value.trim() || NATIVE)}
                placeholder="ETH"
                spellCheck={false}
                className="tabular w-full rounded-md border border-line bg-ink px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs uppercase tracking-wide text-faint">
                Decimals
              </span>
              <input
                value={decimals}
                onChange={(e) => setDecimals(e.target.value)}
                spellCheck={false}
                className="tabular w-full rounded-md border border-line bg-ink px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </label>
          </div>

          <label className="block">
            <span className="mb-1.5 block text-xs uppercase tracking-wide text-faint">Amount</span>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.0"
              spellCheck={false}
              className={`tabular w-full rounded-md border bg-ink px-3 py-2 text-sm outline-none focus:border-accent ${
                amount.trim() && parsedAmount === undefined ? "border-danger" : "border-line"
              }`}
            />
          </label>

          {instant !== undefined ? (
            <div
              className={`rounded-md border px-3 py-2.5 text-sm ${
                instant
                  ? "border-safe/25 bg-safe/8 text-safe"
                  : "border-accent/25 bg-accent/8 text-accent"
              }`}
            >
              {instant ? (
                <>This recipient is trusted and within the daily allowance. It settles now.</>
              ) : (
                <>
                  This goes into a hold for {humaniseDuration(policy?.cooldown ?? 0)}. You can
                  cancel it at any point before you execute it — including after the hold ends.
                  {unlockAt ? (
                    <span className="tabular block pt-1 text-xs opacity-70">
                      Executable from block timestamp {unlockAt.toString()}
                    </span>
                  ) : null}
                </>
              )}
            </div>
          ) : null}

          <button
            type="button"
            disabled={!canSend || isPending}
            onClick={() =>
              writeContract({
                abi: policyAbi,
                address: policyAddress!,
                chainId,
                functionName: "send",
                args: [recipient!, token as Address, parsedAmount!],
              })
            }
            className="w-full rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-ink transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {isPending ? "Confirm in your wallet…" : instant === false ? "Queue transfer" : "Send"}
          </button>

          {writeError ? (
            <p className="text-sm text-danger">{shortenError(writeError.message)}</p>
          ) : null}
          {receipt.isSuccess ? (
            <p className="text-sm text-safe">
              Done. {instant === false ? "It is in the hold — see Pending." : "It settled."}
            </p>
          ) : null}
        </div>

        <aside className="space-y-4">
          {assessment ? (
            <div className="space-y-3 rounded-lg border border-line bg-surface p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium">This recipient</h2>
                <RiskChip level={assessment.level} score={assessment.score} />
              </div>
              {lastScan ? (
                <p className="text-xs text-faint">
                  Checked against your scan of{" "}
                  <span className="tabular">
                    {lastScan.owner.slice(0, 8)}…{lastScan.owner.slice(-4)}
                  </span>
                  , {lastScan.history.length} counterparties.
                </p>
              ) : (
                <p className="text-xs text-caution">
                  No history to check against — run Scan first and this becomes a real verdict
                  rather than a fingerprint.
                </p>
              )}
              <Findings assessment={assessment} />
              {report ? <ReportLine report={report} /> : null}
              <LookalikeComparison assessment={assessment} />
            </div>
          ) : (
            <div className="rounded-lg border border-line bg-surface p-4 text-sm text-muted">
              Paste a recipient to see its fingerprint.
            </div>
          )}
        </aside>
      </section>
    </div>
  );
}

/** Wallet errors arrive as paragraphs; the first line is the part that helps. */
function shortenError(message: string): string {
  return message.split("\n")[0] ?? message;
}
