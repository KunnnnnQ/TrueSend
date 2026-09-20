import {parseAbiItem, type Address, type PublicClient} from "viem";

import {safeVaultAbi} from "./abi/index.js";
import {splitOnRefusal, type BlockRange} from "./client.js";

/**
 * The policy events worth watching.
 *
 * `TransferQueued` is the one that matters: it is the moment a hold starts, and therefore the
 * moment somebody needs to be told. The rest exist so a watcher can tell a hold that ended safely
 * from one that is still running, without re-reading the whole queue every poll.
 */
export const POLICY_EVENTS = {
  queued: parseAbiItem(
    "event TransferQueued(uint256 indexed id, address indexed to, address indexed token, uint256 amount, uint64 unlockAt)",
  ),
  executed: parseAbiItem(
    "event TransferExecuted(uint256 indexed id, address indexed to, address indexed token, uint256 amount)",
  ),
  cancelled: parseAbiItem("event TransferCancelled(uint256 indexed id, address indexed by)"),
  initialized: parseAbiItem(
    "event PolicyInitialized(address indexed owner, uint32 cooldown, uint32 trustDelay, address guardian)",
  ),
} as const;

export interface PolicyState {
  initialized: boolean;
  owner: Address;
  cooldown: number;
  trustDelay: number;
  guardian: Address;
  nextTransferId: bigint;
}

export interface QueuedTransfer {
  id: bigint;
  to: Address;
  token: Address;
  amount: bigint;
  queuedAt: bigint;
  unlockAt: bigint;
  /** 0 none, 1 queued, 2 executed, 3 cancelled. */
  status: number;
}

export const TRANSFER_STATUS = {none: 0, queued: 1, executed: 2, cancelled: 3} as const;

export async function readPolicy(
  client: PublicClient,
  address: Address,
): Promise<PolicyState | undefined> {
  try {
    const result = (await client.readContract({
      abi: safeVaultAbi,
      address,
      functionName: "policy",
    })) as PolicyState;
    return result.initialized ? result : undefined;
  } catch {
    // An address with no policy is the common case — an ordinary EOA, or any other contract.
    // Callers treat "no policy here" as an answer rather than a failure.
    return undefined;
  }
}

/**
 * Read every entry the queue has ever held.
 *
 * Ids are dense and monotonic, which the contracts assert as an invariant, so walking
 * `1..nextTransferId` cannot miss one. That matters more than it sounds: a watcher that rebuilt
 * the queue purely from events would silently lose an entry whenever a log was dropped, and the
 * thing it would lose is the transfer nobody got told about.
 */
export async function readQueue(
  client: PublicClient,
  address: Address,
  nextTransferId: bigint,
): Promise<QueuedTransfer[]> {
  const out: QueuedTransfer[] = [];
  for (let id = 1n; id < nextTransferId; id++) {
    const raw = (await client.readContract({
      abi: safeVaultAbi,
      address,
      functionName: "getTransfer",
      args: [id],
    })) as Omit<QueuedTransfer, "id">;
    out.push({...raw, id});
  }
  return out;
}

export interface TransferQueuedEvent {
  policy: Address;
  id: bigint;
  to: Address;
  token: Address;
  amount: bigint;
  unlockAt: bigint;
  blockNumber: bigint;
  txHash: `0x${string}`;
}

/**
 * Every hold that started in a block range, across every account being watched.
 *
 * Filtered by contract address rather than by topic, because a `TransferQueued` from an account
 * nobody asked about is not this watcher's business — and on a busy chain, reading every one of
 * them would be both expensive and a privacy problem.
 */
export async function findQueuedTransfers(
  client: PublicClient,
  policies: readonly Address[],
  range: BlockRange,
): Promise<TransferQueuedEvent[]> {
  if (policies.length === 0) return [];

  const logs = await splitOnRefusal(range, (part) =>
    client.getLogs({
      address: policies as Address[],
      event: POLICY_EVENTS.queued,
      fromBlock: part.fromBlock,
      toBlock: part.toBlock,
    }),
  );

  return logs.flatMap((log) => {
    if (log.blockNumber === null || log.transactionHash === null) return [];
    const {id, to, token, amount, unlockAt} = log.args;
    if (id === undefined || !to || !token || amount === undefined || unlockAt === undefined) {
      return [];
    }

    return [
      {
        policy: log.address.toLowerCase() as Address,
        id,
        to: to.toLowerCase() as Address,
        token: token.toLowerCase() as Address,
        amount,
        unlockAt,
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
      },
    ];
  });
}

/** Ids that have left the queue in a range, so a watcher can close them out. */
export async function findSettledTransfers(
  client: PublicClient,
  policies: readonly Address[],
  range: BlockRange,
): Promise<{policy: Address; id: bigint; status: "executed" | "cancelled"}[]> {
  if (policies.length === 0) return [];

  const [executed, cancelled] = await Promise.all([
    splitOnRefusal(range, (part) =>
      client.getLogs({
        address: policies as Address[],
        event: POLICY_EVENTS.executed,
        fromBlock: part.fromBlock,
        toBlock: part.toBlock,
      }),
    ),
    splitOnRefusal(range, (part) =>
      client.getLogs({
        address: policies as Address[],
        event: POLICY_EVENTS.cancelled,
        fromBlock: part.fromBlock,
        toBlock: part.toBlock,
      }),
    ),
  ]);

  return [
    ...executed.flatMap((log) =>
      log.args.id === undefined
        ? []
        : [{policy: log.address.toLowerCase() as Address, id: log.args.id, status: "executed" as const}],
    ),
    ...cancelled.flatMap((log) =>
      log.args.id === undefined
        ? []
        : [{policy: log.address.toLowerCase() as Address, id: log.args.id, status: "cancelled" as const}],
    ),
  ];
}
