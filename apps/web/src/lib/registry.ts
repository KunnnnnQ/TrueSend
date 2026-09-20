"use client";

import {useMemo} from "react";
import {
  encodeAbiParameters,
  encodePacked,
  isAddress,
  keccak256,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import {useReadContract, useReadContracts} from "wagmi";

import {EAS_DEPLOYMENTS, poisonRegistryAbi} from "@truesend/chain";
import {checkAddressFormat, type PoisonReport} from "@truesend/engine";

export {EAS_DEPLOYMENTS};

/**
 * The schema literal, byte for byte as `contracts/script/RegisterSchema.s.sol` registers it.
 *
 * The whitespace is load-bearing: the schema UID is a hash of this string, so a stray space
 * produces a UID that matches no schema and every attestation reverts. Kept as a literal here
 * rather than normalised from a friendlier form for that reason. Verified against a live local
 * deployment: `getSchema(schemaUidFor(resolver))` returns this resolver, `revocable = true` and
 * this exact string back.
 */
export const REPORT_SCHEMA = "address subject,uint8 role,address imitates,bytes32 evidence";

/**
 * `EAS.getSchemaRegistry()` confirms these on chain, and `packages/chain/src/registry.ts` carries
 * the same two addresses for reading. Repeated rather than imported because that module exports
 * them for its own read path and this is the write path's only use for them.
 */
export const REPORT_ROLE = {unknown: 0, planter: 1, lookalike: 2} as const;

/** EAS's sentinel for "never expires". A report about a poisoning address should not lapse. */
export const NO_EXPIRATION = 0n;

export const ZERO_ADDRESS = zeroAddress;
export const ZERO_EVIDENCE = zeroHash;

/**
 * The schema UID, derived rather than pasted.
 *
 * `SchemaRegistry._getUID` is `keccak256(abi.encodePacked(schema, resolver, revocable))`, which is
 * exactly what `encodePacked` produces. Deriving it means the UID cannot drift from the resolver
 * address it belongs to, and it makes the lookup for the *local* deployment possible at all: the
 * anvil registry is at an address that only exists in a gitignored file, so a hard-coded UID would
 * be a hard-coded answer for one chain.
 *
 * The shipped UID for a given chain can then be compared against `getSchema(uid)` on the schema
 * registry, which is what `useRegisteredSchema` below does — the derivation is checked, not
 * trusted.
 */
export function schemaUidFor(registry: Address): Hex {
  return keccak256(encodePacked(["string", "address", "bool"], [REPORT_SCHEMA, registry, true]));
}

/** One report, as the resolver's struct expects it. */
export interface ReportPayload {
  subject: Address;
  role: (typeof REPORT_ROLE)["planter"] | (typeof REPORT_ROLE)["lookalike"];
  /** Zero for a planter report — the resolver refuses one that names an imitated address. */
  imitates: Address;
  /** A transaction hash anyone can look up. Recorded, never checked. */
  evidence: Hex;
}

/**
 * The `data` field of the attestation.
 *
 * `PoisonRegistry.onAttest` does `abi.decode(attestation.data, (Report))`, so this is an ordinary
 * ABI encoding of the four fields in declaration order and nothing cleverer.
 */
export function encodeReport(payload: ReportPayload): Hex {
  return encodeAbiParameters(
    [{type: "address"}, {type: "uint8"}, {type: "address"}, {type: "bytes32"}],
    [payload.subject, payload.role, payload.imitates, payload.evidence],
  );
}

/**
 * The EAS `attest` request.
 *
 * Hand-written rather than pulled from `@ethereum-attestation-service/eas-sdk`: it is one struct,
 * and a dependency that exists only to assemble it would be a dependency whose version has to keep
 * matching EAS on chain. The component order below is `AttestationRequestData`'s declaration order
 * in `lib/eas-contracts/contracts/IEAS.sol`, which is what the ABI encoder keys off.
 */
export const easAbi = [
  {
    type: "function",
    name: "attest",
    inputs: [
      {
        name: "request",
        type: "tuple",
        internalType: "struct AttestationRequest",
        components: [
          {name: "schema", type: "bytes32", internalType: "bytes32"},
          {
            name: "data",
            type: "tuple",
            internalType: "struct AttestationRequestData",
            components: [
              {name: "recipient", type: "address", internalType: "address"},
              {name: "expirationTime", type: "uint64", internalType: "uint64"},
              {name: "revocable", type: "bool", internalType: "bool"},
              {name: "refUID", type: "bytes32", internalType: "bytes32"},
              {name: "data", type: "bytes", internalType: "bytes"},
              {name: "value", type: "uint256", internalType: "uint256"},
            ],
          },
        ],
      },
    ],
    outputs: [{name: "", type: "bytes32", internalType: "bytes32"}],
    stateMutability: "payable",
  },
] as const;

/**
 * What `attest` would be called with, given everything the screen has collected.
 *
 * `value` is sent as 0 deliberately. `attest` is payable so a resolver can be paid for its work,
 * and this resolver charges nothing — but the field exists because EAS treats a non-zero value as
 * an explicit instruction, and passing it through unexamined is how a fee gets paid by accident.
 */
export function attestArgs(payload: ReportPayload, registry: Address) {
  return [
    {
      schema: schemaUidFor(registry),
      data: {
        recipient: ZERO_ADDRESS,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: ZERO_EVIDENCE,
        data: encodeReport(payload),
        value: 0n,
      },
    },
  ] as const;
}

/**
 * The EAS deployment for a chain, or undefined when nothing is deployed there.
 *
 * `EAS_DEPLOYMENTS` in `@truesend/chain` carries the two public networks, because those addresses
 * are the same for every reader of that package. A local chain cannot be: `LocalEas.s.sol` deploys
 * a fresh EAS on every run and its address exists only in a gitignored file, so it is configuration
 * rather than a constant. Kept in this app's environment instead of being added to that table,
 * which would put an address that changes on every `anvil` into a package the indexer also reads.
 */
export function easFor(chainId: number): {eas: Address; schemaRegistry: Address} | undefined {
  if (chainId === 31337) {
    const eas = process.env.NEXT_PUBLIC_ANVIL_EAS;
    const schemaRegistry = process.env.NEXT_PUBLIC_ANVIL_SCHEMA_REGISTRY;
    if (eas && schemaRegistry && isAddress(eas) && isAddress(schemaRegistry)) {
      return {eas: eas as Address, schemaRegistry: schemaRegistry as Address};
    }
    return undefined;
  }
  return EAS_DEPLOYMENTS[chainId];
}

/**
 * The resolver address for a chain, from configuration.
 *
 * Same reasoning as `deploymentFor` in `./chains`: nothing is on a public network yet, and a
 * placeholder table full of zero addresses would read like a deployment that exists. Until one is
 * configured the Report screen says so instead of offering a button that cannot work.
 *
 * Each variable is written out in full rather than looked up as `process.env[name]`. Next.js
 * substitutes `process.env.NEXT_PUBLIC_X` textually at build time, so an indirect lookup compiles
 * to a property read on an object that does not exist in the browser — it returns `undefined` and
 * the screen reports "no registry" on a chain that has one. Measured, not assumed: the first
 * version of this function did the indirect lookup and the local chain showed the empty state.
 */
export function registryFor(chainId: number): Address | undefined {
  const configured =
    chainId === 1
      ? process.env.NEXT_PUBLIC_MAINNET_POISON_REGISTRY
      : chainId === 11155111
        ? process.env.NEXT_PUBLIC_SEPOLIA_POISON_REGISTRY
        : chainId === 31337
          ? process.env.NEXT_PUBLIC_ANVIL_POISON_REGISTRY
          : undefined;

  return configured && isAddress(configured) ? (configured as Address) : undefined;
}

/**
 * The environment variable that would configure a chain's resolver.
 *
 * Named here rather than inlined so the empty state can tell the reader exactly which variable to
 * set. A screen that says "configure the registry" and stops has moved the problem rather than
 * solved it.
 */
export const REGISTRY_ENV_VAR: Partial<Record<number, string>> = {
  1: "NEXT_PUBLIC_MAINNET_POISON_REGISTRY",
  11155111: "NEXT_PUBLIC_SEPOLIA_POISON_REGISTRY",
  31337: "NEXT_PUBLIC_ANVIL_POISON_REGISTRY",
};

/**
 * What the chain says about a configured resolver.
 *
 * `unreachable` is a state, not an error: a node that is not answering is the ordinary condition
 * of a laptop that has not started `anvil` yet, and it deserves a sentence rather than a spinner.
 */
export type RegistryStatus =
  | "no-registry"
  | "no-eas"
  | "unreachable"
  | "checking"
  | "not-registered"
  | "wrong-resolver"
  | "ready";

/**
 * Whether the configured resolver is actually there and actually ours.
 *
 * Two reads, because "an address was configured" and "a registry is deployed at it" are different
 * claims and the screen should not confuse them. The schema comparison is the stronger one: it
 * asks the chain's schema registry what resolver the derived UID belongs to, so a mistyped address
 * fails here rather than after the user has paid gas for an attestation that reverts.
 */
export function useRegisteredSchema(registry: Address | undefined, chainId: number) {
  const eas = registry ? easFor(chainId) : undefined;

  const query = useReadContract({
    abi: SCHEMA_REGISTRY_ABI,
    address: eas?.schemaRegistry,
    chainId,
    functionName: "getSchema",
    args: registry ? [schemaUidFor(registry)] : undefined,
    query: {enabled: Boolean(registry && eas), retry: false},
  });

  const record = query.data as
    | {uid: Hex; resolver: Address; revocable: boolean; schema: string}
    | undefined;

  /**
   * `isError` is checked before `isLoading`.
   *
   * A node that is not answering leaves the query "loading" for as long as the retry policy keeps
   * trying, so a screen that tests loading first sits on "Checking the registry on chain…"
   * indefinitely. Measured while driving this screen in a browser against a chain on the wrong
   * port: the RPC refused every call and the page never said so.
   */
  const status = useMemo(() => {
    if (!registry) return "no-registry" as const;
    if (!eas) return "no-eas" as const;
    if (query.isError) return "unreachable" as const;
    if (query.isLoading) return "checking" as const;
    if (!record?.uid || record.uid === zeroHash) return "not-registered" as const;
    if (record.resolver.toLowerCase() !== registry.toLowerCase()) return "wrong-resolver" as const;
    return "ready" as const;
  }, [registry, eas, query.isError, query.isLoading, record]);

  return {...query, record, status};
}

const SCHEMA_REGISTRY_ABI = [
  {
    type: "function",
    name: "getSchema",
    inputs: [{name: "uid", type: "bytes32", internalType: "bytes32"}],
    outputs: [
      {
        name: "",
        type: "tuple",
        internalType: "struct SchemaRecord",
        components: [
          {name: "uid", type: "bytes32", internalType: "bytes32"},
          {name: "resolver", type: "address", internalType: "ISchemaResolver"},
          {name: "revocable", type: "bool", internalType: "bool"},
          {name: "schema", type: "string", internalType: "string"},
        ],
      },
    ],
    stateMutability: "view",
  },
] as const;

/**
 * What the registry already says about an address.
 *
 * The aggregate tally only — `reporters` is the number the scoring weights, and `verified` is the
 * only part of it any contract could prove. The event log that carries `role` and `imitates` needs
 * a block range, which the caller supplies when it has one.
 */
export function useReport(registry: Address | undefined, subject: Address | undefined, chainId: number) {
  const query = useReadContract({
    abi: poisonRegistryAbi,
    address: registry,
    chainId,
    functionName: "tally",
    args: subject ? [subject] : undefined,
    query: {enabled: Boolean(registry && subject), retry: false},
  });

  const tally = query.data as {reports: bigint; reporters: bigint; verified: bigint} | undefined;
  const report = useMemo(
    () => (subject ? reportFromTally(subject, tally) : undefined),
    [subject, tally],
  );

  return {...query, tally, report};
}

/**
 * The same read for a whole list of addresses, in one hook.
 *
 * Scan has a counterparty list already; asking for them one at a time would be a request per row
 * for numbers the scoring only ever uses beside the real signal. `useReadContracts` batches where
 * the chain has Multicall3 and fans out where it does not — so this is one *hook* rather than one
 * round trip, and the difference is not worth claiming either way. Each entry reports its own
 * success, and a failed one is skipped rather than failing the batch.
 *
 * Failing soft is the point of the `enabled` guard: with no registry configured — which is every
 * public network today — this must return an empty list rather than an error, because a screen
 * that cannot read a registry it knows is absent should behave exactly as it did before the
 * registry existed. Reports are corroboration, never the reason a warning fires.
 */
export function useReports(
  registry: Address | undefined,
  subjects: readonly Address[],
  chainId: number,
): {reports: PoisonReport[]; isLoading: boolean} {
  const query = useReadContracts({
    contracts: subjects.map((subject) => ({
      abi: poisonRegistryAbi,
      address: registry,
      chainId,
      functionName: "tally" as const,
      args: [subject] as const,
    })),
    query: {enabled: Boolean(registry) && subjects.length > 0, retry: false},
  });

  const reports = useMemo(() => {
    const found: PoisonReport[] = [];
    (query.data ?? []).forEach((entry, index) => {
      const subject = subjects[index];
      if (!subject || entry.status !== "success") return;
      const report = reportFromTally(subject, entry.result as RawTally);
      if (report) found.push(report);
    });
    return found;
  }, [query.data, subjects]);

  return {reports, isLoading: query.isLoading};
}

interface RawTally {
  reports: bigint;
  reporters: bigint;
  verified: bigint;
}

/**
 * One tally, as the engine's `PoisonReport`.
 *
 * `role` is derived from `verified` rather than read from the event log, and that is not a
 * shortcut: the resolver only ever sets `verified` on a lookalike it proved on chain — a planter
 * report cannot be proved by anything — so a non-zero `verified` count is the same statement as
 * "at least one reporter's lookalike claim was checked and held". Reading it costs a block range;
 * deriving it costs nothing and cannot disagree.
 *
 * `imitates` is deliberately absent. It is not in the tally, and inventing it here would put an
 * address the contract never named into a sentence about what the contract found.
 */
function reportFromTally(subject: Address, tally: RawTally | undefined): PoisonReport | undefined {
  if (!tally || Number(tally.reporters) === 0) return undefined;
  const verified = Number(tally.verified) > 0;
  return {
    suspect: subject.toLowerCase() as Address,
    role: verified ? "lookalike" : "planter",
    verified,
    reporters: Number(tally.reporters),
  };
}

/**
 * Whether this address may be reported by the connected account at all.
 *
 * Mirrors the resolver's own refusals so the screen can say why before a wallet prompt appears.
 * Not a substitute for them: the contract is the authority, and it will reject a report this
 * function allowed. Keeping the two in step is what the on-chain pre-flight is for.
 */
export function reportBlockers(input: {
  reporter: Address | undefined;
  subject: Address | undefined;
  role: (typeof REPORT_ROLE)["planter"] | (typeof REPORT_ROLE)["lookalike"];
  imitates?: Address | undefined;
  evidence?: Hex | undefined;
}): string[] {
  const problems: string[] = [];
  const {reporter, subject, role, imitates, evidence} = input;

  if (!reporter) problems.push("Connect a wallet — the resolver records who made a report.");
  if (!subject) problems.push("Enter the address being reported.");
  if (reporter && subject && reporter.toLowerCase() === subject.toLowerCase()) {
    problems.push("You cannot report your own address.");
  }
  if (role === REPORT_ROLE.lookalike) {
    if (!imitates) problems.push("A lookalike report has to name the address being imitated.");
    if (imitates && subject && imitates.toLowerCase() === subject.toLowerCase()) {
      problems.push("An address cannot imitate itself.");
    }
    if (!evidence) {
      problems.push(
        "Add the transaction where this address was used, or a payment you made to the real one.",
      );
    }
  }
  return problems;
}

/** The same reporting rule the resolver applies, evaluated locally so it costs no gas. */
export function sharedAffix(a: Address, b: Address): {prefix: number; suffix: number} | undefined {
  const x = a.toLowerCase().slice(2);
  const y = b.toLowerCase().slice(2);
  if (x.length !== 40 || y.length !== 40) return undefined;

  let prefix = 0;
  while (prefix < 40 && x[prefix] === y[prefix]) prefix++;

  let suffix = 0;
  while (suffix < 40 - prefix && x[39 - suffix] === y[39 - suffix]) suffix++;

  return {prefix, suffix};
}

/**
 * Narrow a pasted string to an address.
 *
 * `isAddress` applies EIP-55, so a checksum that does not match is refused — which is the right
 * behaviour for a screen whose entire subject is addresses that differ somewhere the eye cannot
 * check. What it must not do is call that "not an address": a mistyped or tampered address is a
 * different problem from a malformed one, and the fix is different too. `describeAddress` says
 * which, using the same three-way distinction the Send screen shows.
 *
 * Not checksum-corrected on the way in. Quietly fixing the capitalisation would hide exactly the
 * signal the checksum exists to carry.
 */
export function asAddress(value: string | undefined): Address | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return isAddress(trimmed) ? (trimmed as Address) : undefined;
}

export function describeAddress(value: string): string | undefined {
  if (!value.trim()) return undefined;
  switch (checkAddressFormat(value.trim())) {
    case "valid":
      return undefined;
    case "bad-checksum":
      return "The right shape, but the checksum does not match — this address was altered or mistyped somewhere between the sender and here. Ask for it again rather than fixing the capitalisation.";
    default:
      return "Not a 20-byte hex address.";
  }
}
