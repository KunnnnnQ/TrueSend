"use client";

import {useCallback, useEffect, useMemo, useState, type CSSProperties} from "react";
import {isAddress, type Address} from "viem";
import {mainnet} from "wagmi/chains";
import {useAccount, usePublicClient} from "wagmi";

import {
  createChainClient,
  readTokenIdentities,
  scanHistory,
  type ScanProgress,
  type ScanResult,
} from "@truesend/chain";
import {
  assessAddress,
  inspectToken,
  judgeToken,
  type FlaggedToken,
  type PoisonReport,
  type RiskAssessment,
} from "@truesend/engine";

import {AddressCard} from "@/components/Fingerprint";
import {Findings, LookalikeComparison, ReportChip, ReportLine, RiskChip} from "@/components/Risk";
import {CounterfeitTokens, type TokenCheck} from "@/components/Tokens";
import {HISTORY_RPC, KNOWN_TOKENS} from "@/lib/chains";
import {registryFor, useReports} from "@/lib/registry";
import {attachTokenCheck, saveScan} from "@/lib/scanStore";

/**
 * The verified case from `analysis/`, preloaded.
 *
 * A demo that depends on whatever the connected wallet happens to contain is a demo that shows
 * nothing when the wallet is clean. This range is the one the case file covers, so the screen
 * always has something real to show — and it is real, not a fixture.
 */
const WBTC_CASE = {
  label: "The 1155 WBTC loss, May 2024",
  address: "0x1e227979f0b5bc691a70deaed2e0f39a6f538fd5" as Address,
  fromBlock: 19_780_000n,
  toBlock: 19_789_100n,
};

/** About a week of mainnet, which is as far back as most people's recent payments go. */
const DEFAULT_LOOKBACK = 50_000n;

export default function ScanPage() {
  const {address: connected, chainId} = useAccount();
  const client = usePublicClient();

  const [subject, setSubject] = useState("");
  const [range, setRange] = useState<{from: string; to: string}>({from: "", to: ""});
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tokenCheck, setTokenCheck] = useState<TokenCheck>({status: "idle"});

  const scanChain = chainId ?? mainnet.id;

  const run = useCallback(
    async (owner: Address, fromBlock: bigint, toBlock: bigint) => {
      setError(null);
      setResult(null);
      setExpanded(null);
      setProgress({fraction: 0, message: "Starting"});
      try {
        const endpoint = HISTORY_RPC[scanChain];
        if (!endpoint) throw new Error(`No history endpoint is configured for chain ${scanChain}.`);

        const scanned = await scanHistory(
          createChainClient(endpoint),
          owner,
          {fromBlock, toBlock},
          {knownTokens: KNOWN_TOKENS[scanChain] ?? [], onProgress: setProgress},
        );
        setResult(scanned);
        // Hand it to Send, which otherwise starts from nothing on the one screen that spends.
        saveScan({
          owner: scanned.owner,
          history: scanned.history,
          scannedAt: Date.now(),
          fromBlock: fromBlock.toString(),
          toBlock: toBlock.toString(),
        });
        if (scanned.transfers.length === 0) {
          setError("No transfers for that address in that block range.");
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setProgress(null);
      }
    },
    [scanChain],
  );

  const onScan = useCallback(async () => {
    const owner = (subject.trim() || connected) as Address | undefined;
    if (!owner || !isAddress(owner)) {
      setError("Enter an address, or connect a wallet.");
      return;
    }

    let toBlock: bigint;
    let fromBlock: bigint;
    if (range.to.trim() && range.from.trim()) {
      fromBlock = BigInt(range.from.trim());
      toBlock = BigInt(range.to.trim());
    } else {
      const head = await client!.getBlockNumber();
      toBlock = head;
      fromBlock = head > DEFAULT_LOOKBACK ? head - DEFAULT_LOOKBACK : 0n;
    }

    await run(owner, fromBlock, toBlock);
  }, [subject, connected, range, client, run]);

  const loadCase = useCallback(() => {
    setSubject(WBTC_CASE.address);
    setRange({from: String(WBTC_CASE.fromBlock), to: String(WBTC_CASE.toBlock)});
    void run(WBTC_CASE.address, WBTC_CASE.fromBlock, WBTC_CASE.toBlock);
  }, [run]);

  const assessments = useMemo(() => {
    if (!result) return [];
    const now = Math.max(...result.transfers.map((t) => t.at), 0);
    return result.history
      .map((entry) => assessAddress({to: entry.address, history: result.history, now}))
      .sort((a, b) => b.score - a.score);
  }, [result]);

  /**
   * What the community registry says about these counterparties, when one is configured.
   *
   * Kept beside the engine's verdict rather than folded into it, deliberately. The score is the
   * engine's own opinion of the user's history; a report is somebody else's claim. Running them
   * through the same number and printing one figure would hide which of the two moved it — and
   * `docs/registry.md` is explicit that reports alone are capped below `danger` for exactly the
   * reason that they cannot be trusted, only weighted.
   *
   * `registryFor` returns undefined on a chain with no registry — mainnet, today; Sepolia has one
   * since 2026-10-06 — and the hook then does nothing at all rather than failing: reports are
   * corroboration, never the reason a warning fires.
   */
  const counterparties = useMemo(
    () => assessments.map((a) => a.address),
    [assessments],
  );
  const {reports} = useReports(registryFor(scanChain), counterparties, scanChain);
  const reportsByAddress = useMemo(() => {
    const map = new Map<string, PoisonReport>();
    for (const report of reports) map.set(report.suspect, report);
    return map;
  }, [reports]);

  /**
   * What every token in the history calls itself, and whether it is what it says.
   *
   * Address poisoning is not only about addresses: the bait in the May 2024 case was a token
   * contract calling itself `ETH`, and the token detector in the engine existed, tested and
   * documented, for a long while without any screen ever reading a symbol — so none of them could
   * have run it. This is the call that was missing.
   *
   * Runs after the scan rather than inside it, so a slow or refusing endpoint costs the user this
   * one panel and not the counterparty list, which does not depend on it. Cancelled when a new scan
   * replaces the result, so an answer for the previous account can never land on the next one.
   *
   * Also attached to the stored scan once it finishes (`attachTokenCheck`), so Send can recognise
   * a contract this account already had flagged, instead of knowing only the address history.
   */
  useEffect(() => {
    if (!result) {
      setTokenCheck({status: "idle"});
      return;
    }

    const endpoint = HISTORY_RPC[scanChain];
    if (!endpoint || result.tokensSeen.length === 0) {
      setTokenCheck({status: "done", checked: 0, unreadable: 0, counterfeit: [], unusual: []});
      attachTokenCheck(result.owner, {checked: 0, unreadable: 0, counterfeit: [], unusual: []});
      return;
    }

    let cancelled = false;
    setTokenCheck({status: "checking", total: result.tokensSeen.length});

    void (async () => {
      try {
        const identities = await readTokenIdentities(createChainClient(endpoint), result.tokensSeen);
        const canonical = (KNOWN_TOKENS[scanChain] ?? []).map((t) => ({symbol: t.symbol, address: t.address}));

        const counterfeit: FlaggedToken[] = [];
        const unusual: FlaggedToken[] = [];
        let unreadable = 0;
        for (const identity of identities) {
          // A token that would not say what it is called cannot be judged, and is counted rather
          // than passed: reporting it as clean would be a claim nothing established.
          if (identity.symbol === null) {
            unreadable++;
            continue;
          }

          const findings = inspectToken(
            {
              symbol: identity.symbol,
              address: identity.address,
              ...(identity.name ? {name: identity.name} : {}),
            },
            {canonical},
          );
          if (findings.length === 0) continue;

          const own = result.transfers.filter((t) => t.token === identity.address);
          // Planted, not merely present: the account "sending" it in a transaction it did not sign,
          // or a zero-value transfer in. An account does not sign for, or receive nothing of, a
          // token it chose to hold — which is what tells a counterfeit from a strange spelling.
          const planted = own.filter(
            (t) => (t.from === result.owner && t.signer !== result.owner) || (t.to === result.owner && t.value === 0n),
          ).length;

          const token: FlaggedToken = {
            address: identity.address,
            symbol: identity.symbol,
            name: identity.name,
            transfers: own.length,
            planted,
            findings,
          };
          (judgeToken(findings, planted) === "counterfeit" ? counterfeit : unusual).push(token);
        }
        const byUse = (a: FlaggedToken, b: FlaggedToken) => b.planted - a.planted || b.transfers - a.transfers;
        counterfeit.sort(byUse);
        unusual.sort(byUse);

        if (!cancelled) {
          setTokenCheck({status: "done", checked: identities.length, unreadable, counterfeit, unusual});
          attachTokenCheck(result.owner, {checked: identities.length, unreadable, counterfeit, unusual});
        }
      } catch (caught) {
        if (!cancelled) {
          setTokenCheck({status: "failed", message: caught instanceof Error ? caught.message : String(caught)});
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [result, scanChain]);

  const dangerous = assessments.filter((a) => a.level === "danger").length;
  const fabricated = result?.history.filter((e) => e.spoofedOutgoingCount > 0).length ?? 0;

  return (
    <div className="space-y-8">
      <section className="rise">
        <h1 className="headline text-4xl font-semibold sm:text-5xl">Scan a history</h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
          Reads every transfer touching an address, then checks <em>who signed</em> each one. A
          transfer log naming you as the sender is not proof you sent anything — anyone can emit
          one, and almost everyone doing so is planting an address in your history.
        </p>
      </section>

      <section className="rise rounded-lg border border-line bg-surface p-4" style={{"--i": 1} as CSSProperties}>
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-64 flex-1">
            <span className="mb-1.5 block text-xs uppercase tracking-wide text-faint">Address</span>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={connected ?? "0x…"}
              spellCheck={false}
              className="tabular w-full rounded-md border border-line bg-ink px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </label>
          <label className="w-36">
            <span className="mb-1.5 block text-xs uppercase tracking-wide text-faint">From block</span>
            <input
              value={range.from}
              onChange={(e) => setRange((r) => ({...r, from: e.target.value}))}
              placeholder="latest − 50k"
              spellCheck={false}
              className="tabular w-full rounded-md border border-line bg-ink px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </label>
          <label className="w-36">
            <span className="mb-1.5 block text-xs uppercase tracking-wide text-faint">To block</span>
            <input
              value={range.to}
              onChange={(e) => setRange((r) => ({...r, to: e.target.value}))}
              placeholder="latest"
              spellCheck={false}
              className="tabular w-full rounded-md border border-line bg-ink px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </label>
          <button
            type="button"
            onClick={() => void onScan()}
            disabled={progress !== null}
            className="rounded-md border border-accent bg-accent px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-transparent hover:text-text disabled:opacity-50 disabled:hover:bg-accent disabled:hover:text-ink"
          >
            {progress ? "Scanning…" : "Scan"}
          </button>
        </div>

        <button
          type="button"
          onClick={loadCase}
          disabled={progress !== null}
          className="mt-3 text-xs text-accent underline-offset-2 hover:underline disabled:opacity-50"
        >
          Load {WBTC_CASE.label}
        </button>

        {progress ? (
          <div className="mt-4">
            <div className="h-1 overflow-hidden rounded-full bg-line">
              <div
                className="working h-full bg-accent transition-[width] duration-300"
                style={{width: `${Math.round(progress.fraction * 100)}%`}}
              />
            </div>
            <p className="mt-2 text-xs text-muted">{progress.message}</p>
          </div>
        ) : null}

        {error ? <p className="mt-3 text-sm text-caution">{error}</p> : null}
      </section>

      {result && assessments.length > 0 ? (
        <section className="space-y-4">
          <div className="rise flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm text-muted">
            <span>
              <span className="tabular text-text">{result.transfers.length}</span> transfers ·{" "}
              <span className="tabular text-text">{assessments.length}</span> counterparties
            </span>
            <span>
              <span className="tabular text-text">{result.signersResolved}</span> signers resolved
            </span>
            {fabricated > 0 ? (
              <span className="text-danger">
                <span className="tabular">{fabricated}</span> with a fabricated payment record
              </span>
            ) : null}
            {dangerous > 0 ? (
              <span className="text-danger">
                <span className="tabular">{dangerous}</span> to avoid
              </span>
            ) : null}
            {reports.length > 0 ? (
              <span className="text-caution">
                <span className="tabular">{reports.length}</span> reported to the community registry
              </span>
            ) : null}
          </div>

          <CounterfeitTokens check={tokenCheck} />

          <ul className="space-y-2">
            {assessments.map((assessment, index) => (
              <Row
                key={assessment.address}
                index={index}
                assessment={assessment}
                {...(reportsByAddress.get(assessment.address.toLowerCase())
                  ? {report: reportsByAddress.get(assessment.address.toLowerCase())!}
                  : {})}
                open={expanded === assessment.address}
                onToggle={() =>
                  setExpanded((current) =>
                    current === assessment.address ? null : assessment.address,
                  )
                }
              />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function Row({
  index,
  assessment,
  report,
  open,
  onToggle,
}: {
  /** Position in the list: rows arrive in order, and each phrase resolves after its row lands. */
  index: number;
  assessment: RiskAssessment;
  report?: PoisonReport;
  open: boolean;
  onToggle: () => void;
}) {
  const border =
    assessment.level === "danger"
      ? "border-danger/30"
      : assessment.level === "caution"
        ? "border-caution/25"
        : "border-line";

  return (
    <li className={`rise lift rounded-lg border bg-surface ${border}`} style={{"--i": index} as CSSProperties}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-4 p-4 text-left"
      >
        <AddressCard address={assessment.address} delay={Math.min(index, 16) * 45 + 150} />
        <div className="ml-auto flex items-center gap-3">
          {report ? <ReportChip report={report} /> : null}
          <RiskChip level={assessment.level} score={assessment.score} />
          <span aria-hidden className="text-faint">
            {open ? "−" : "+"}
          </span>
        </div>
      </button>

      {open ? (
        <div className="space-y-4 border-t border-line px-4 py-4">
          <Findings assessment={assessment} />
          <LookalikeComparison assessment={assessment} />
          {report ? <ReportLine report={report} /> : null}
        </div>
      ) : null}
    </li>
  );
}
