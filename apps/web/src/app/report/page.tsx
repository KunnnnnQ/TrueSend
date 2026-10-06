"use client";

import {useEffect, useMemo, useState} from "react";
import Link from "next/link";
import {isHash, type Address, type Hex} from "viem";
import {useAccount, useWaitForTransactionReceipt, useWriteContract} from "wagmi";

import {MIN_AFFIX_MATCH} from "@truesend/engine";

import {AddressCard} from "@/components/Fingerprint";
import {SUPPORTED_CHAINS} from "@/lib/chains";
import {
  REGISTRY_ENV_VAR,
  REPORT_ROLE,
  ZERO_ADDRESS,
  ZERO_EVIDENCE,
  asAddress,
  attestArgs,
  easAbi,
  easFor,
  registryFor,
  describeAddress,
  reportBlockers,
  schemaUidFor,
  sharedAffix,
  useRegisteredSchema,
  useReport,
  type RegistryStatus,
  type ReportPayload,
} from "@/lib/registry";

const STORAGE_KEY = "truesend.report-chain";

/**
 * Report an address to the community registry.
 *
 * The screen is built around one line from `docs/registry.md`: a `Lookalike` report is provable on
 * chain and a `Planter` report is not. Everything below follows from taking that seriously rather
 * than treating the two as variants of one form.
 *
 *   - The lookalike path checks the claim **before** the user pays anything, using the resolver's
 *     own rule, and refuses to submit something the resolver would revert on. The check is the
 *     contract's rule, not a friendlier approximation of it.
 *   - The planter path says in as many words that nothing on chain can verify it, and never
 *     renders a proved badge. A screen that let a planter report look proved would be building the
 *     thing `docs/threat-model.md` calls a griefing tool.
 *
 * Attestations go to EAS, not to the resolver. `PoisonRegistry` is a `SchemaResolver`: EAS records
 * the attestation, calls the resolver, and reverts the whole transaction if the resolver refuses.
 * Calling the resolver directly would store nothing.
 */
export default function ReportPage() {
  const {address: connected, chainId: walletChain} = useAccount();

  const {writeContract, data: txHash, isPending, error: writeError, reset} = useWriteContract();
  const receipt = useWaitForTransactionReceipt({hash: txHash});

  /**
   * Which chain to report on, kept per browser.
   *
   * Not taken from the wallet, for the same reason the Send screen does not: the registry is at a
   * configured address per chain and a user reviewing a report does not want to be told there is
   * no registry because their wallet was left on another network.
   */
  const [chain, setChain] = useState<number | undefined>(undefined);
  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved) setChain(Number(saved));
  }, []);

  const chainId = chain ?? walletChain ?? 1;
  const selectChain = (next: number) => {
    setChain(next);
    window.localStorage.setItem(STORAGE_KEY, String(next));
    reset();
  };

  const registry = registryFor(chainId);
  const schema = useRegisteredSchema(registry, chainId);
  const eas = easFor(chainId);

  const [role, setRole] = useState<(typeof REPORT_ROLE)["planter"] | (typeof REPORT_ROLE)["lookalike"]>(
    REPORT_ROLE.planter,
  );
  const [subjectRaw, setSubjectRaw] = useState("");
  const [imitatesRaw, setImitatesRaw] = useState("");
  const [evidenceRaw, setEvidenceRaw] = useState("");

  const subject = asAddress(subjectRaw);
  const imitates = asAddress(imitatesRaw);
  const evidence = normaliseHash(evidenceRaw);

  const existing = useReport(registry, subject, chainId);

  const planter = role === REPORT_ROLE.planter;

  /**
   * The resolver's predicate, evaluated here first.
   *
   * `sharedAffix` is the comparison `PoisonRegistry.isLookalike` performs — leading and trailing
   * hex characters — against the contract's own `MIN_AFFIX_NIBBLES` floor. Computing it locally is
   * what makes the check work with no registry deployed at all, which is the state every public
   * network is in today.
   */
  const collision = useMemo(
    () => (subject && imitates ? sharedAffix(subject, imitates) : undefined),
    [subject, imitates],
  );

  /**
   * The decision, and it is the resolver's.
   *
   * `PoisonRegistry.isLookalike` rejects two addresses unless both the top `MIN_AFFIX_NIBBLES`
   * hex characters and the bottom `MIN_AFFIX_NIBBLES` match. Requiring both here is the same
   * predicate: a pair that shares four leading characters and no trailing ones fails in the
   * contract and must fail here, which is exactly the pair a user is most likely to assume is
   * close enough.
   *
   * `MIN_AFFIX_MATCH` comes from `@truesend/engine`, which is the copy a test in `contracts/`
   * asserts against the contract's constant — so this screen's precondition is pinned to the
   * resolver's rule by that test rather than by a comment claiming they agree.
   */
  const collides =
    collision !== undefined &&
    collision.prefix >= MIN_AFFIX_MATCH &&
    collision.suffix >= MIN_AFFIX_MATCH;

  const blockers = reportBlockers({
    reporter: connected,
    subject,
    role,
    ...(planter ? {} : {imitates}),
    ...(evidence ? {evidence} : {}),
  });

  /**
   * The one gate that is not an opinion.
   *
   * A lookalike attestation the resolver will refuse must never reach a wallet prompt: there is
   * nothing to pay for and nothing to learn from the revert.
   */
  const rejectedByResolver = !planter && subject !== undefined && imitates !== undefined && !collides;

  /**
   * Whether the registry can be written to at all.
   *
   * The form stays usable while this is still resolving, and it stays usable when it comes back
   * negative — the lookalike check below is a pure computation over two addresses and has nothing
   * to do with whether a registry exists on this chain. Greying the whole screen out behind an RPC
   * round trip would hide the one thing on this page that works with no deployment at all, which is
   * also the thing most likely to talk a user out of paying for a report that cannot be accepted.
   */
  const deployReady = schema.status === "ready" && registry !== undefined && eas !== undefined;

  const canAttest = deployReady && blockers.length === 0 && !rejectedByResolver;

  const payload: ReportPayload | undefined =
    canAttest && subject
      ? {
          subject,
          role,
          imitates: planter ? ZERO_ADDRESS : (imitates as Address),
          evidence: evidence ?? ZERO_EVIDENCE,
        }
      : undefined;

  return (
    <div className="space-y-8">
      <section className="rise">
        <h1 className="headline text-4xl font-semibold sm:text-5xl">Report an address</h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
          A community registry held on chain. Attesting is permissionless, which it has to be for
          the registry to be worth having — so it cannot be trusted, only weighted. Nothing here
          decides whether a transfer is allowed: the scoring holds any number of reports below the
          level that stops a payment.
        </p>
      </section>

      <section className="rise rounded-lg border border-line bg-surface p-4 [--i:1]">
        <label className="block w-56">
          <span className="mb-1.5 block text-xs uppercase tracking-wide text-faint">
            Network
          </span>
          <select
            value={chainId}
            onChange={(e) => selectChain(Number(e.target.value))}
            className="w-full rounded-md border border-line bg-ink px-3 py-2 text-sm outline-none focus:border-accent"
          >
            {SUPPORTED_CHAINS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>

        <div className="mt-3">
          <NetworkState
            registry={registry}
            status={schema.status}
            chainId={chainId}
            easDeployed={Boolean(eas)}
          />
        </div>
      </section>

      <section className="rise rounded-lg border border-line bg-surface p-4 [--i:2]">
        <div>
          <div className="text-xs uppercase tracking-wide text-faint">What are you reporting</div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <RoleOption
              selected={planter}
              onSelect={() => {
                setRole(REPORT_ROLE.planter);
                reset();
              }}
              title="Planter"
              badge="Not provable"
              badgeTone="caution"
              body="The address that signed the transactions planting fabricated records in other people's histories. This is the high-leverage one: over twelve hundred blocks of mainnet USDT, 18 addresses accounted for every fabricated record found."
            />
            <RoleOption
              selected={!planter}
              onSelect={() => {
                setRole(REPORT_ROLE.lookalike);
                reset();
              }}
              title="Lookalike"
              badge="Provable on chain"
              badgeTone="safe"
              body="An address ground out to imitate one you already use. The resolver checks that the two really do share the characters a wallet shows, and rejects the attestation outright when they do not."
            />
          </div>

          <div className="mt-5 space-y-4">
            <Field
              label={planter ? "Address that signs the fabrications" : "Address imitating another"}
              value={subjectRaw}
              onChange={setSubjectRaw}
              placeholder="0x…"
              invalid={subjectRaw.trim() !== "" && !subject}
              problem={
                describeAddress(subjectRaw) ??
                (connected && subject && subject.toLowerCase() === connected.toLowerCase()
                  ? "This is your own address — the resolver refuses a report of yourself."
                  : undefined)
              }
            />

            {subject ? (
              <div className="flex flex-wrap items-start gap-x-8 gap-y-3 rounded-md border border-line bg-ink p-3">
                <AddressCard address={subject} label="Being reported" emphasis="strong" />
                <div className="text-sm">
                  <div className="text-faint">Registry says</div>
                  {existing.report ? (
                    <div className="mt-0.5 text-text">
                      <span className="tabular">{existing.report.reporters}</span>{" "}
                      {existing.report.reporters === 1 ? "reporter" : "reporters"}
                      {existing.report.verified ? (
                        <span className="text-safe"> · a lookalike claim was proved</span>
                      ) : (
                        <span className="text-caution"> · nothing proved</span>
                      )}
                    </div>
                  ) : existing.isLoading ? (
                    <div className="mt-0.5 text-muted">Reading…</div>
                  ) : (
                    <div className="mt-0.5 text-muted">No reports yet.</div>
                  )}
                </div>
              </div>
            ) : null}

            {!planter ? (
              <>
                <Field
                  label="Address it imitates"
                  value={imitatesRaw}
                  onChange={setImitatesRaw}
                  placeholder="The one you actually pay"
                  invalid={imitatesRaw.trim() !== "" && !imitates}
                  problem={describeAddress(imitatesRaw)}
                />

                {subject && imitates ? (
                  <LookalikeCheck
                    subject={subject}
                    imitates={imitates}
                    collision={collision}
                    collides={collides}
                  />
                ) : null}
              </>
            ) : (
              <div className="rounded-md border border-caution/25 bg-caution/8 px-3 py-2.5 text-sm leading-relaxed text-caution">
                <p className="font-medium">Nothing on chain can verify this report.</p>
                <p className="mt-1.5">
                  Showing that an address signed a transaction which emitted a fabricated transfer
                  log would mean re-executing a past transaction, which no contract can do. A
                  planter report is recorded unproven and weighted as unproven: one of them, on an
                  address with no other history, lands on “worth a look” rather than “do not send”.
                  What it needs is the evidence transaction, so a person or an indexer can check it.
                </p>
              </div>
            )}

            <Field
              label="Evidence transaction"
              value={evidenceRaw}
              onChange={setEvidenceRaw}
              placeholder="0x… a transaction anyone can look up"
              invalid={evidenceRaw.trim() !== "" && !evidence}
              problem={
                evidenceRaw.trim() !== "" && !evidence ? "Not a 32-byte transaction hash." : undefined
              }
              hint={
                planter
                  ? "The transaction that planted a record. It is recorded and never checked — a human or an indexer has to go and look at it."
                  : "Recorded, never checked. Without one a reader has only your word for the pairing."
              }
            />
          </div>

          <div className="mt-5 space-y-2 border-t border-line pt-4">
            {blockers.length > 0 ? (
              <ul className="space-y-1 text-sm text-muted">
                {blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            ) : null}

            <button
              type="button"
              disabled={!canAttest || isPending}
              onClick={() => {
                if (!payload || !registry || !eas) return;
                writeContract({
                  abi: easAbi,
                  address: eas.eas,
                  chainId,
                  functionName: "attest",
                  args: attestArgs(payload, registry),
                });
              }}
              className="rounded-md border border-accent bg-accent px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-transparent hover:text-text disabled:opacity-40 disabled:hover:bg-accent disabled:hover:text-ink"
            >
              {isPending ? "Confirm in your wallet…" : "Attest"}
            </button>

            <p className="text-xs leading-relaxed text-faint">
              Goes to EAS, which records the attestation and calls the resolver. If the resolver
              refuses — a lookalike claim that does not hold, an address reported by itself, a
              planter report naming an imitated address — the whole transaction reverts.
            </p>

            {!deployReady ? (
              <p className="text-xs text-caution">
                {schema.status === "checking"
                  ? "Still checking the registry on this chain. The lookalike check above does not wait for it."
                  : "Nothing to attest to on this chain yet — see the note above."}
              </p>
            ) : null}

            {writeError ? (
              <p className="text-sm text-danger">{firstLine(writeError.message)}</p>
            ) : null}
            {receipt.isSuccess ? (
              <p className="text-sm text-safe">
                Attested. The registry counts it now — and counts you once, however many times you
                attest.
              </p>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * The lookalike pre-flight.
 *
 * Side by side, because that is the whole point: the two addresses share the characters every
 * wallet shows and share nothing underneath. Shown before the button, not after a revert.
 */
function LookalikeCheck({
  subject,
  imitates,
  collision,
  collides,
}: {
  subject: Address;
  imitates: Address;
  collision: {prefix: number; suffix: number} | undefined;
  collides: boolean;
}) {
  const prefix = collision?.prefix ?? 0;
  const suffix = collision?.suffix ?? 0;

  return (
    <div
      className={`rounded-md border px-3 py-3 ${
        collides ? "border-safe/25 bg-safe/8" : "border-danger/30 bg-danger/8"
      }`}
    >
      <div className={`text-sm font-medium ${collides ? "text-safe" : "text-danger"}`}>
        {collides
          ? `Shares the first ${prefix} and last ${suffix} characters — the resolver will accept this.`
          : "These two do not look alike, so the resolver would reject this attestation."}
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted">
        {collides
          ? `Checked with the resolver's own rule before anything is signed. ${MIN_AFFIX_MATCH} leading and ${MIN_AFFIX_MATCH} trailing hex characters is the floor; a wallet truncates to about six and four.`
          : "Nothing to send. A lookalike report is the half of this registry the chain can prove, and this pair does not pass it — the attestation would revert with NotALookalike."}
      </p>

      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <div>
          <div className="mb-2 text-xs font-medium text-muted">The one it imitates</div>
          <AddressCard address={imitates} />
        </div>
        <div>
          <div className="mb-2 text-xs font-medium text-muted">The suspected lookalike</div>
          <AddressCard address={subject} emphasis="strong" />
        </div>
      </div>

      {collision ? (
        <p className="tabular mt-3 text-xs text-faint">
          shared prefix {prefix} · shared suffix {suffix} · required {MIN_AFFIX_MATCH} +{" "}
          {MIN_AFFIX_MATCH}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Whether reporting is possible here, said plainly.
 *
 * Modelled on `PolicyBar`'s "no policy at this address": on a chain with no registry this screen
 * cannot do its job, and the useful thing is to say so and point at where it can - Sepolia, since
 * 2026-10-06 - and at the commands that stand one up locally. A form that looks like it works and reverts
 * on submit would be worse than one that explains itself.
 */
function NetworkState({
  registry,
  status,
  chainId,
  easDeployed,
}: {
  registry: Address | undefined;
  status: RegistryStatus;
  chainId: number;
  easDeployed: boolean;
}) {
  if (status === "checking") {
    return (
      <div className="rounded-md border border-line bg-ink p-3 text-sm text-muted">
        Checking the registry on chain…
      </div>
    );
  }

  if (status === "ready" && registry) {
    return (
      <div className="rounded-md border border-safe/25 bg-safe/8 p-3 text-sm">
        <p className="text-safe">Registry live on this chain.</p>
        <p className="tabular mt-1.5 break-all text-muted">
          resolver {registry} · schema {schemaUidFor(registry)}
        </p>
        <p className="mt-1.5 leading-relaxed text-muted">
          Confirmed against the chain's schema registry, which reports this resolver as the one the
          derived schema UID belongs to — so the address in the environment is the address that will
          actually check the claim.
        </p>
      </div>
    );
  }

  const reason =
    status === "no-registry"
      ? "No registry is configured for this chain."
      : status === "no-eas"
        ? "This chain has no EAS deployment configured, so there is nowhere to attest."
        : status === "unreachable"
          ? `A registry is configured here, but the node for chain ${chainId} is not answering.`
          : status === "wrong-resolver"
            ? "A schema with this UID exists here, but it belongs to a different resolver."
            : "The schema is not registered at the configured resolver.";

  const vars = [
    REGISTRY_ENV_VAR[chainId] ?? "NEXT_PUBLIC_…_POISON_REGISTRY",
    "NEXT_PUBLIC_ANVIL_EAS",
    "NEXT_PUBLIC_ANVIL_SCHEMA_REGISTRY",
  ];

  return (
    <div className="rounded-md border border-line bg-ink p-3 text-sm leading-relaxed text-muted">
      <p className="text-caution">{reason}</p>
      <p className="mt-1.5">
        The live registry is on Sepolia — choose it above. (A local dev server finds it after{" "}
        <code className="tabular text-xs text-text">node tools/deployment-env.mjs &gt;&gt; apps/web/.env.local</code>.)
        A local chain has no EAS at all, so this brings the whole stack up there at once:
      </p>
      <pre className="tabular mt-2 overflow-x-auto rounded-md border border-line bg-surface p-3 text-xs text-text">
{`anvil
forge script script/LocalEas.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \\
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`}
      </pre>
      <p className="mt-2">
        The script prints the <code className="tabular text-xs text-text">PoisonRegistry</code>,{" "}
        <code className="tabular text-xs text-text">EAS</code> and{" "}
        <code className="tabular text-xs text-text">SchemaRegistry</code> addresses it deployed. Put
        them in these variables and restart the dev server:
      </p>
      <ul className="tabular mt-1.5 space-y-1 text-xs text-text">
        {vars.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
      <p className="mt-2">
        The schema UID is derived from the resolver address rather than transcribed, so there is
        nothing else to copy — and the screen verifies the derivation against the chain's schema
        registry before it offers the button.
      </p>
      {!easDeployed ? (
        <p className="mt-2 text-faint">No EAS address is known for chain {chainId}.</p>
      ) : null}
      <p className="mt-2">
        <Link href="/" className="text-accent underline-offset-2 hover:underline">
          Scan
        </Link>{" "}
        works against real mainnet history without any of this, and reads the registry whenever one
        is configured.
      </p>
    </div>
  );
}

function RoleOption({
  selected,
  onSelect,
  title,
  badge,
  badgeTone,
  body,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  badge: string;
  badgeTone: "safe" | "caution";
  body: string;
}) {
  const tone =
    badgeTone === "safe"
      ? "border-safe/30 bg-safe/12 text-safe"
      : "border-caution/30 bg-caution/12 text-caution";

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`rounded-lg border p-3 text-left transition-colors ${
        selected ? "border-accent bg-raised" : "border-line bg-ink hover:border-line-strong"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{title}</span>
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone}`}>
          {badge}
        </span>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted">{body}</p>
    </button>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  problem,
  invalid,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  hint?: string;
  problem?: string | undefined;
  invalid?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs uppercase tracking-wide text-faint">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className={`tabular w-full rounded-md border bg-ink px-3 py-2 text-sm outline-none focus:border-accent ${
          invalid ? "border-danger" : "border-line"
        }`}
      />
      {problem ? <span className="mt-1.5 block text-xs text-danger">{problem}</span> : null}
      {!problem && hint ? <span className="mt-1.5 block text-xs text-faint">{hint}</span> : null}
    </label>
  );
}

/** Wallet and RPC errors arrive as paragraphs; the first line is the part that helps. */
function firstLine(message: string): string {
  return message.split("\n")[0] ?? message;
}

function normaliseHash(value: string): Hex | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return isHash(trimmed) ? (trimmed as Hex) : undefined;
}
