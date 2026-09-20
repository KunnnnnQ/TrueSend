import {
  createPublicClient,
  http,
  parseAbiItem,
  parseUnits,
  type Address,
  type PublicClient,
} from "viem";

import {foldHistory, type TransferRecord} from "@truesend/engine";

import {HISTORY_RPC, KNOWN_TOKENS} from "./chains";

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

/** Endpoints reject wide windows at different thresholds; this halves on the ones that complain. */
const CHUNK_BLOCKS = 9_000n;

export interface ScanRange {
  fromBlock: bigint;
  toBlock: bigint;
}

export interface ScanProgress {
  /** 0..1, for the progress bar. */
  fraction: number;
  message: string;
}

export interface ScanResult {
  owner: Address;
  range: ScanRange;
  transfers: TransferRecord[];
  /** Folded per counterparty, newest first. */
  history: ReturnType<typeof foldHistory>;
  /** How many transaction signers had to be resolved to build it. */
  signersResolved: number;
  /** Every token contract seen, including ones nobody has heard of. */
  tokensSeen: Address[];
}

export function clientFor(chainId: number): PublicClient {
  const url = HISTORY_RPC[chainId];
  if (!url) throw new Error(`No history endpoint configured for chain ${chainId}`);
  return createPublicClient({transport: http(url, {batch: true, retryCount: 2})});
}

/**
 * Pull every transfer touching `owner`, then resolve who actually signed each one.
 *
 * The second half is the part that cannot be skipped. A `Transfer` log naming the owner as sender
 * is not evidence the owner sent anything — an attacker can emit one for the price of gas, and in
 * a sampled window 99.88% of zero-value USDT transfers were exactly that. Reading the logs alone
 * builds the same history a wallet shows, which is the history the attack is designed to exploit.
 *
 * Logs are filtered by the owner's address on the node rather than scanned client-side, so this
 * stays a handful of requests even over a wide range.
 */
export async function scanHistory(
  chainId: number,
  owner: Address,
  range: ScanRange,
  onProgress?: (progress: ScanProgress) => void,
): Promise<ScanResult> {
  const client = clientFor(chainId);
  const known = KNOWN_TOKENS[chainId] ?? [];

  const spans = chunk(range, CHUNK_BLOCKS);
  const steps = spans.length;
  let done = 0;

  type RawLog = {
    address: Address;
    from: Address;
    to: Address;
    value: bigint;
    blockNumber: bigint;
    transactionHash: `0x${string}`;
  };

  const raw: RawLog[] = [];

  for (const span of spans) {
    // Two queries per span: one for what the owner appears to have sent, one for what they
    // received. Filtered by topic on the node, so this stays cheap however wide the window is.
    //
    // Deliberately not filtered by token address. The bait in a poisoning attempt is an obscure
    // contract the attacker deployed for the purpose — in the May 2024 WBTC case it was one
    // claiming the symbol `ETH` — so a scan restricted to a list of well-known tokens is a scan
    // that cannot see the attack. An earlier version of this screen did exactly that and scored
    // the attacker's address as "looks fine".
    const [sent, received] = await Promise.all([
      splitOnRefusal(span, (part) =>
        client.getLogs({
          event: TRANSFER_EVENT,
          args: {from: owner},
          fromBlock: part.fromBlock,
          toBlock: part.toBlock,
        }),
      ),
      splitOnRefusal(span, (part) =>
        client.getLogs({
          event: TRANSFER_EVENT,
          args: {to: owner},
          fromBlock: part.fromBlock,
          toBlock: part.toBlock,
        }),
      ),
    ]);

    for (const log of [...sent, ...received]) {
      // Only pending logs carry nulls here, and a historical range has none. Dropping them
      // rather than asserting keeps the types honest about what the node can return.
      if (log.blockNumber === null || log.transactionHash === null) continue;
      if (!log.args.from || !log.args.to) continue;

      raw.push({
        address: log.address.toLowerCase() as Address,
        from: log.args.from,
        to: log.args.to,
        value: log.args.value ?? 0n,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
      });
    }

    done++;
    onProgress?.({
      fraction: (done / steps) * 0.6,
      message: `Reading transfers — ${raw.length} so far`,
    });
  }

  // Resolve signers and block times. Both are per-transaction and per-block, so deduplicate first;
  // a wallet with fifty transfers usually has far fewer of each.
  const txHashes = [...new Set(raw.map((log) => log.transactionHash))];
  const blockNumbers = [...new Set(raw.map((log) => log.blockNumber))];

  onProgress?.({
    fraction: 0.6,
    message: `Checking who signed ${txHashes.length} transaction${txHashes.length === 1 ? "" : "s"}`,
  });

  const [signers, times] = await Promise.all([
    resolveAll(txHashes, async (hash) => {
      const tx = await client.getTransaction({hash});
      return tx.from.toLowerCase() as Address;
    }),
    resolveAll(blockNumbers, async (blockNumber) => {
      const block = await client.getBlock({blockNumber, includeTransactions: false});
      return Number(block.timestamp);
    }),
  ]);

  onProgress?.({fraction: 0.95, message: "Scoring"});

  const transfers: TransferRecord[] = raw.flatMap((log) => {
    const signer = signers.get(log.transactionHash);
    const at = times.get(log.blockNumber);
    if (signer === undefined || at === undefined) return [];

    // Dust needs decimals and some sense of value, which only exists for tokens we recognise.
    // An unknown contract gets no dust verdict rather than a guessed one; the signals that
    // matter for an unknown token — zero value, and who signed — do not need it.
    const token = known.find((t) => t.address.toLowerCase() === log.address);
    const dustLimit = token ? parseUnits(String(token.dustBelow), token.decimals) : 0n;

    return [
      {
        token: log.address,
        from: log.from.toLowerCase() as Address,
        to: log.to.toLowerCase() as Address,
        value: log.value,
        at,
        signer,
        dust: log.value > 0n && log.value < dustLimit,
        txHash: log.transactionHash,
      },
    ];
  });

  onProgress?.({fraction: 1, message: "Done"});

  return {
    owner: owner.toLowerCase() as Address,
    range,
    transfers,
    history: foldHistory(owner, transfers),
    signersResolved: signers.size,
    tokensSeen: [...new Set(transfers.map((t) => t.token))],
  };
}

function chunk(range: ScanRange, size: bigint): ScanRange[] {
  const spans: ScanRange[] = [];
  for (let start = range.fromBlock; start <= range.toBlock; start += size) {
    const end = start + size - 1n;
    spans.push({fromBlock: start, toBlock: end > range.toBlock ? range.toBlock : end});
  }
  return spans;
}

/**
 * Halve a range and retry when an endpoint refuses it as too wide.
 *
 * Takes the fetch as a callback rather than the request as an object so viem keeps inferring the
 * log type from the event ABI at the call site. Wrapping `getLogs` directly would erase that and
 * hand back untyped `args`.
 */
async function splitOnRefusal<T>(
  range: ScanRange,
  fetch: (part: ScanRange) => Promise<T[]>,
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

/** Resolve a batch with bounded concurrency so a public endpoint does not start refusing. */
async function resolveAll<K, V>(
  keys: readonly K[],
  resolve: (key: K) => Promise<V>,
  concurrency = 8,
): Promise<Map<K, V>> {
  const out = new Map<K, V>();
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < keys.length) {
      const index = cursor++;
      const key = keys[index]!;
      try {
        out.set(key, await resolve(key));
      } catch {
        // A single unresolvable transaction drops that transfer rather than failing the scan.
        // The alternative is a screen that shows nothing because one request timed out.
      }
    }
  }

  await Promise.all(Array.from({length: Math.min(concurrency, keys.length)}, worker));
  return out;
}
