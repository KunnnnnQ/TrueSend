import {parseAbiItem, parseUnits, type Address, type PublicClient} from "viem";

import {foldHistory, type AddressSighting, type TransferRecord} from "@truesend/engine";

import {accountKind, canSignOwnTransactions, type AccountKind} from "./account.js";
import {splitOnRefusal, type BlockRange} from "./client.js";

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

/** Wide enough to be few requests, narrow enough that most endpoints accept it. */
const CHUNK_BLOCKS = 9_000n;

export interface ScanProgress {
  /** 0..1, for a progress bar. */
  fraction: number;
  message: string;
}

export interface KnownToken {
  address: Address;
  symbol: string;
  decimals: number;
  /** Inbound transfers strictly below this many whole units count as dust. */
  dustBelow: number;
}

export interface ScanResult {
  owner: Address;
  range: BlockRange;
  transfers: TransferRecord[];
  /** Folded per counterparty, newest first. */
  history: AddressSighting[];
  /** How many transaction signers had to be resolved to build it. */
  signersResolved: number;
  /** Every token contract seen, including ones nobody has heard of. */
  tokensSeen: Address[];
  /**
   * Whether the owner is an account that signs for itself.
   *
   * Reported rather than kept private because it changes how every other field should be read: a
   * contract account never appears as `tx.from`, so for one of those "the owner did not sign it"
   * is a fact about the account type and not about the transfer.
   */
  ownerKind: AccountKind;
}

export interface ScanOptions {
  /** Supplies decimals so a small inbound amount can be called dust rather than guessed at. */
  knownTokens?: readonly KnownToken[];
  onProgress?: (progress: ScanProgress) => void;
  /** How many transactions to resolve at once. Public endpoints start refusing above this. */
  concurrency?: number;
}

/**
 * Pull every transfer touching `owner`, then resolve who actually signed each one.
 *
 * The second half is the part that cannot be skipped. A `Transfer` log naming the owner as sender
 * is not evidence the owner sent anything — an attacker can emit one for the price of gas, and in
 * a sampled window 99.88% of zero-value USDT transfers were exactly that. Reading the logs alone
 * builds the same history a wallet shows, which is the history the attack is designed to exploit.
 *
 * Deliberately not filtered by token address. The bait in a poisoning attempt is an obscure
 * contract the attacker deployed for the purpose — in the May 2024 WBTC case one claiming the
 * symbol `ETH` — so a scan restricted to well-known tokens is a scan that cannot see the attack.
 * Logs are filtered by the owner's address on the node instead, which keeps this a handful of
 * requests however wide the range is.
 *
 * Lives here rather than in either consumer because the web app and the indexer must not drift
 * apart on this: two implementations of "check the signer" is one implementation that eventually
 * forgets to.
 */
export async function scanHistory(
  client: PublicClient,
  owner: Address,
  range: BlockRange,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const {knownTokens = [], onProgress, concurrency = 8} = options;

  // Started here and awaited at the end: one request, and no reason to make the scan wait on it.
  const kind = accountKind(client, owner);

  const spans = chunk(range, CHUNK_BLOCKS);
  let done = 0;

  interface RawLog {
    token: Address;
    from: Address;
    to: Address;
    value: bigint;
    blockNumber: bigint;
    transactionHash: `0x${string}`;
  }

  const raw: RawLog[] = [];

  for (const span of spans) {
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
      // rather than asserting keeps the types honest about what a node can return.
      if (log.blockNumber === null || log.transactionHash === null) continue;
      if (!log.args.from || !log.args.to) continue;

      raw.push({
        token: log.address.toLowerCase() as Address,
        from: log.args.from,
        to: log.args.to,
        value: log.args.value ?? 0n,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
      });
    }

    done++;
    onProgress?.({
      fraction: (done / spans.length) * 0.6,
      message: `Reading transfers — ${raw.length} so far`,
    });
  }

  // Signers and block times are per-transaction and per-block, so deduplicate before fetching;
  // an address with fifty transfers usually has far fewer of each.
  const txHashes = [...new Set(raw.map((log) => log.transactionHash))];
  const blockNumbers = [...new Set(raw.map((log) => log.blockNumber))];

  onProgress?.({
    fraction: 0.6,
    message: `Checking who signed ${txHashes.length} transaction${txHashes.length === 1 ? "" : "s"}`,
  });

  const [signers, times] = await Promise.all([
    resolveAll(
      txHashes,
      async (hash) => (await client.getTransaction({hash})).from.toLowerCase() as Address,
      concurrency,
    ),
    resolveAll(
      blockNumbers,
      async (blockNumber) =>
        Number((await client.getBlock({blockNumber, includeTransactions: false})).timestamp),
      concurrency,
    ),
  ]);

  onProgress?.({fraction: 0.95, message: "Scoring"});

  const transfers: TransferRecord[] = raw.flatMap((log) => {
    const signer = signers.get(log.transactionHash);
    const at = times.get(log.blockNumber);
    if (signer === undefined || at === undefined) return [];

    // Dust needs decimals and some sense of value, which only exists for tokens we recognise. An
    // unknown contract gets no dust verdict rather than a guessed one; the signals that matter
    // for an unknown token — zero value, and who signed — do not need it.
    const token = knownTokens.find((t) => t.address.toLowerCase() === log.token);
    const dustLimit = token ? parseUnits(String(token.dustBelow), token.decimals) : 0n;

    return [
      {
        token: log.token,
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

  const ownerKind = await kind;

  onProgress?.({fraction: 1, message: "Done"});

  return {
    owner: owner.toLowerCase() as Address,
    range,
    transfers,
    history: foldHistory(owner, transfers, {ownerCanSign: canSignOwnTransactions(ownerKind)}),
    signersResolved: signers.size,
    tokensSeen: [...new Set(transfers.map((t) => t.token))],
    ownerKind,
  };
}

function chunk(range: BlockRange, size: bigint): BlockRange[] {
  const spans: BlockRange[] = [];
  for (let start = range.fromBlock; start <= range.toBlock; start += size) {
    const end = start + size - 1n;
    spans.push({fromBlock: start, toBlock: end > range.toBlock ? range.toBlock : end});
  }
  return spans;
}

/** Resolve a batch with bounded concurrency so a public endpoint does not start refusing. */
async function resolveAll<K, V>(
  keys: readonly K[],
  resolve: (key: K) => Promise<V>,
  concurrency: number,
): Promise<Map<K, V>> {
  const out = new Map<K, V>();
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < keys.length) {
      const key = keys[cursor++]!;
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
