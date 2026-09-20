import {parseAbiItem, type Address, type PublicClient} from "viem";

import type {PoisonReport} from "@truesend/engine";

import {poisonRegistryAbi} from "./abi/index.js";
import {splitOnRefusal, type BlockRange} from "./client.js";

/**
 * EAS, confirmed on chain rather than copied from documentation.
 *
 * `EAS.getSchemaRegistry()` on each of these returns exactly the registry address listed beside
 * it, on both networks. That check costs one call and this project has already been caught out
 * once by trusting a remembered address.
 */
export const EAS_DEPLOYMENTS: Record<number, {eas: Address; schemaRegistry: Address}> = {
  1: {
    eas: "0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587",
    schemaRegistry: "0xA7b39296258348C78294F95B872b282326A97BDF",
  },
  11155111: {
    eas: "0xC2679fBD37d54388Ce493F1DB75320D236e1815e",
    schemaRegistry: "0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0",
  },
};

/** Mirrors `PoisonRegistry.Role`. */
export const REPORT_ROLE = {unknown: 0, planter: 1, lookalike: 2} as const;

const REPORTED_EVENT = parseAbiItem(
  "event Reported(address indexed subject, address indexed reporter, uint8 role, address imitates, bool verified, bytes32 evidence)",
);

interface RawTally {
  reports: bigint;
  reporters: bigint;
  verified: bigint;
}

/**
 * What the registry says about one address.
 *
 * Reads the aggregate counts the resolver maintains rather than replaying every attestation:
 * the numbers that matter are how many *distinct* reporters spoke and how many of their claims
 * the contract could prove, and the resolver already tracks both.
 *
 * The `role` and `imitating` fields need the event log, because the tally is deliberately a
 * summary. When no log is available the report still carries its counts, which is what the
 * scoring actually weights.
 */
export async function readReport(
  client: PublicClient,
  registry: Address,
  subject: Address,
  options: {range?: BlockRange} = {},
): Promise<PoisonReport | undefined> {
  const tally = (await client.readContract({
    abi: poisonRegistryAbi,
    address: registry,
    functionName: "tally",
    args: [subject],
  })) as RawTally;

  const reporters = Number(tally.reporters);
  if (reporters === 0) return undefined;

  const verified = Number(tally.verified) > 0;
  let role: PoisonReport["role"] = verified ? "lookalike" : "planter";
  let imitating: Address | undefined;
  let reportedAt: number | undefined;

  if (options.range) {
    const logs = await splitOnRefusal(options.range, (part) =>
      client.getLogs({
        address: registry,
        event: REPORTED_EVENT,
        args: {subject},
        fromBlock: part.fromBlock,
        toBlock: part.toBlock,
      }),
    );

    // Prefer a proven claim when there is one: it is the only kind that names an imitated address
    // the contract actually checked.
    const proven = logs.find((log) => log.args.verified === true) ?? logs.at(-1);
    if (proven) {
      role = proven.args.role === REPORT_ROLE.lookalike ? "lookalike" : "planter";
      if (proven.args.imitates && proven.args.imitates !== ZERO) {
        imitating = proven.args.imitates.toLowerCase() as Address;
      }
      if (proven.blockNumber !== null) {
        const block = await client.getBlock({blockNumber: proven.blockNumber});
        reportedAt = Number(block.timestamp);
      }
    }
  }

  return {
    suspect: subject.toLowerCase() as Address,
    role,
    verified,
    reporters,
    ...(imitating ? {imitating} : {}),
    ...(reportedAt ? {reportedAt} : {}),
  };
}

/** The same, for a batch — what the Scan screen needs for a whole address book. */
export async function readReports(
  client: PublicClient,
  registry: Address,
  subjects: readonly Address[],
  options: {range?: BlockRange} = {},
): Promise<PoisonReport[]> {
  const found: PoisonReport[] = [];
  for (const subject of subjects) {
    const report = await readReport(client, registry, subject, options);
    if (report) found.push(report);
  }
  return found;
}

/**
 * Ask the registry whether two addresses collide, using its own rule.
 *
 * Worth having even though `@truesend/engine` computes the same thing locally: this is the exact
 * predicate that decides whether an attestation is accepted, so a client that is about to report
 * something can check it will be accepted rather than paying gas to find out.
 */
export async function isLookalikeOnChain(
  client: PublicClient,
  registry: Address,
  a: Address,
  b: Address,
): Promise<boolean> {
  return (await client.readContract({
    abi: poisonRegistryAbi,
    address: registry,
    functionName: "isLookalike",
    args: [a, b],
  })) as boolean;
}

const ZERO = "0x0000000000000000000000000000000000000000";
