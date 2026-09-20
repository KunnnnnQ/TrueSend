import {createPublicClient, http, type PublicClient} from "viem";

export interface BlockRange {
  fromBlock: bigint;
  toBlock: bigint;
}

/**
 * Endpoints that serve recent blocks. Fine for anything within the last few days.
 *
 * The rest of the list, and which of these answer archive queries, is recorded in
 * `analysis/src/rpc.mjs`. None of it is discoverable from their documentation.
 */
export const DEFAULT_RPC: Record<number, string> = {
  1: "https://rpc.mevblocker.io",
  11155111: "https://ethereum-sepolia-rpc.publicnode.com",
  31337: "http://127.0.0.1:8545",
};

export function createChainClient(url: string): PublicClient {
  return createPublicClient({transport: http(url, {batch: true, retryCount: 2})});
}

/**
 * Halve a range and retry when an endpoint refuses it as too wide.
 *
 * Takes the fetch as a callback rather than the request as an object so viem keeps inferring the
 * log type from the event ABI at the call site. Wrapping `getLogs` directly would erase that.
 *
 * Log density is not something a caller can know up front — USDT alone runs tens of thousands of
 * transfers an hour, and the cap differs per provider — so guessing a fixed chunk size means
 * either a scan that dies halfway or one that crawls.
 */
export async function splitOnRefusal<T>(
  range: BlockRange,
  fetch: (part: BlockRange) => Promise<T[]>,
): Promise<T[]> {
  try {
    return await fetch(range);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const tooWide = /more than \d+ results|exceeds limit|too large|range|limited to/i.test(message);
    if (!tooWide || range.toBlock - range.fromBlock < 2n) throw error;

    const middle = (range.fromBlock + range.toBlock) / 2n;
    const [left, right] = await Promise.all([
      splitOnRefusal({fromBlock: range.fromBlock, toBlock: middle}, fetch),
      splitOnRefusal({fromBlock: middle + 1n, toBlock: range.toBlock}, fetch),
    ]);
    return [...left, ...right];
  }
}
