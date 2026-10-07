import type {Address, PublicClient} from "viem";

/** One `Transfer` log, as `scripts/record-scan.mjs` writes it. */
export interface RecordedLog {
  token: Address;
  from: Address;
  to: Address;
  value: string;
  blockNumber: number;
  transactionHash: `0x${string}`;
  logIndex: number;
}

/** What `scripts/record-scan.mjs` writes: everything an endpoint said about one account. */
export interface Recording {
  owner: Address;
  fromBlock: number;
  toBlock: number;
  code: string;
  /** Whether the endpoint put each log's block time on the log itself. */
  logsCarryBlockTime: boolean;
  signers: Record<string, Address>;
  blockTimes: Record<string, number>;
  tokens: {address: Address; symbol: string | null; name: string | null}[];
  logs: RecordedLog[];
}

export interface ReplayOptions {
  /** Put each block's time on its logs, as some endpoints do, or leave it off. Defaults to the recording. */
  logsCarryBlockTime?: boolean;
  /**
   * Lookups to refuse, by transaction hash or block number, and how many times before answering.
   * `Infinity` never answers.
   */
  refuse?: {transactions?: Record<string, number>; blocks?: Record<string, number>};
}

/**
 * An endpoint that answers from a recording, and refuses whatever it is told to.
 *
 * Implements the four calls `scanHistory` makes, and answers them the way a node does: logs
 * filtered by indexed sender or recipient and by block range, a transaction's sender, a block's
 * time, an account's code. It counts what it was asked, so a test can tell a scan that asked for a
 * block from one that had no need to.
 */
export function replay(recording: Recording, options: ReplayOptions = {}) {
  const carryTime = options.logsCarryBlockTime ?? recording.logsCarryBlockTime;
  const refusalsLeft = {
    transactions: new Map(Object.entries(options.refuse?.transactions ?? {})),
    blocks: new Map(Object.entries(options.refuse?.blocks ?? {})),
  };
  const asked = {logs: 0, transactions: 0, blocks: 0};

  const refuseIfTold = (kind: "transactions" | "blocks", key: string) => {
    const left = refusalsLeft[kind].get(key);
    if (left === undefined || left <= 0) return;
    refusalsLeft[kind].set(key, left - 1);
    throw new Error(`HTTP request failed. Status: 429 (${kind} ${key}, refused by the test)`);
  };

  const client = {
    async getLogs(request: {args: {from?: Address; to?: Address}; fromBlock: bigint; toBlock: bigint}) {
      asked.logs++;
      const {from, to} = request.args;
      return recording.logs
        .filter((log) => BigInt(log.blockNumber) >= request.fromBlock && BigInt(log.blockNumber) <= request.toBlock)
        .filter((log) => (from ? log.from === from.toLowerCase() : log.to === to?.toLowerCase()))
        .map((log) => ({
          address: log.token,
          args: {from: log.from, to: log.to, value: BigInt(log.value)},
          blockNumber: BigInt(log.blockNumber),
          transactionHash: log.transactionHash,
          logIndex: log.logIndex,
          ...(carryTime ? {blockTimestamp: BigInt(recording.blockTimes[String(log.blockNumber)]!)} : {}),
        }));
    },

    async getTransaction({hash}: {hash: string}) {
      asked.transactions++;
      refuseIfTold("transactions", hash);
      const from = recording.signers[hash];
      if (!from) throw new Error(`not in the recording: transaction ${hash}`);
      return {from};
    },

    async getBlock({blockNumber}: {blockNumber: bigint}) {
      asked.blocks++;
      refuseIfTold("blocks", String(blockNumber));
      const time = recording.blockTimes[String(blockNumber)];
      if (time === undefined) throw new Error(`not in the recording: block ${blockNumber}`);
      return {timestamp: BigInt(time)};
    },

    async getCode() {
      return recording.code;
    },
  };

  return {client: client as unknown as PublicClient, asked};
}
