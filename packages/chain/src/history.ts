import {parseAbiItem, parseUnits, type Address, type PublicClient} from "viem";

import {
  foldHistory,
  type AddressSighting,
  type TransferRecord,
  type UncheckedTransfer,
} from "@truesend/engine";

import {accountKind, type AccountKind} from "./account.js";
import {splitOnRefusal, type BlockRange} from "./client.js";

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

/** Wide enough to be few requests, narrow enough that most endpoints accept it. */
const CHUNK_BLOCKS = 9_000n;

/**
 * How long to wait before each pass back over the lookups an endpoint refused: a second, then
 * three more.
 *
 * A refusal is nearly always a rate limit, so those passes ask one lookup at a time after a pause.
 * Four seconds is as long as a screen can sit on "checking" before it looks broken, and whatever
 * is still missing after that is reported rather than waited for.
 */
const RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];

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
  /**
   * Transfers the scan could not check: who signed the transaction, or when its block was, never
   * came back, even when asked again.
   *
   * Kept out of `transfers`, because a record nobody has checked the signer of is neither a payment
   * the owner made nor provably a fabrication. Not dropped, though. An earlier version dropped them
   * without a trace, and the screen showed nothing missing: on the May 2024 case, one refused
   * lookup — the bait's — turned the attacker from "do not send" into "looks fine". They reach
   * `history` as `uncheckedCount` on the address involved, and a screen that shows a result with
   * any of these has to say that it is incomplete.
   */
  unchecked: UncheckedTransfer[];
  /** Folded per counterparty, newest first. */
  history: AddressSighting[];
  /** How many transaction signers had to be resolved to build it. */
  signersResolved: number;
  /** Every token contract seen, including ones nobody has heard of. */
  tokensSeen: Address[];
  /**
   * What kind of account the owner is.
   *
   * Read from the chain and reported rather than kept private, because it is useful information
   * on its own — a caller may want to say "this is a smart-contract wallet" somewhere in the UI —
   * even though `foldHistory` no longer branches on it. An earlier version passed it through to
   * change how the fold treated unsigned outgoing transfers for a contract account; that turned
   * out to be unsafe (see the doc comment on `foldHistory` in `@truesend/engine`) and was removed.
   * The classification itself was never the problem and stays.
   */
  ownerKind: AccountKind;
}

export interface ScanOptions {
  /** Supplies decimals so a small inbound amount can be called dust rather than guessed at. */
  knownTokens?: readonly KnownToken[];
  onProgress?: (progress: ScanProgress) => void;
  /** How many transactions to resolve at once. Public endpoints start refusing above this. */
  concurrency?: number;
  /**
   * The pause before each pass back over refused lookups, in milliseconds, one pass per entry.
   * Defaults to a second and then three; the tests, which have no rate limit to wait out, use
   * zeros.
   */
  retryDelaysMs?: readonly number[];
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
 * A lookup the endpoint refuses is asked again, more slowly, and whatever still does not come back
 * is returned in `unchecked` rather than dropped. That field says why the difference matters.
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
  const {knownTokens = [], onProgress, concurrency = 8, retryDelaysMs = RETRY_DELAYS_MS} = options;

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
    /** The block's time, when the endpoint put it on the log, which saves asking for the block. */
    blockTimestamp?: number;
  }

  // Keyed by transaction and position: a transfer from the owner to themselves answers both
  // queries below, and would otherwise be counted twice.
  const raw = new Map<string, RawLog>();

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
      if (log.blockNumber === null || log.transactionHash === null || log.logIndex === null) continue;
      if (!log.args.from || !log.args.to) continue;

      raw.set(`${log.transactionHash}:${log.logIndex}`, {
        token: log.address.toLowerCase() as Address,
        from: log.args.from,
        to: log.args.to,
        value: log.args.value ?? 0n,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        ...(log.blockTimestamp == null ? {} : {blockTimestamp: Number(log.blockTimestamp)}),
      });
    }

    done++;
    onProgress?.({
      fraction: (done / spans.length) * 0.6,
      message: `Reading transfers — ${raw.size} so far`,
    });
  }

  const logs = [...raw.values()];

  // Signers and block times are per-transaction and per-block, so deduplicate before fetching;
  // an address with fifty transfers usually has far fewer of each. A block whose time arrived on
  // one of its logs is not asked about at all: fewer requests, and fewer for an endpoint to refuse.
  const txHashes = [...new Set(logs.map((log) => log.transactionHash))];
  const timesOnLogs = new Map<bigint, number>();
  for (const log of logs) {
    if (log.blockTimestamp !== undefined) timesOnLogs.set(log.blockNumber, log.blockTimestamp);
  }
  const blocksToAsk = [...new Set(logs.map((log) => log.blockNumber))].filter(
    (block) => !timesOnLogs.has(block),
  );

  onProgress?.({
    fraction: 0.6,
    message: `Checking who signed ${txHashes.length} transaction${txHashes.length === 1 ? "" : "s"}`,
  });

  const onRetry = (missing: number) =>
    onProgress?.({fraction: 0.9, message: `Asking again about ${missing} the endpoint refused`});

  const [signers, times] = await Promise.all([
    resolveAll(
      txHashes,
      async (hash) => (await client.getTransaction({hash})).from.toLowerCase() as Address,
      concurrency,
      retryDelaysMs,
      onRetry,
    ),
    resolveAll(
      blocksToAsk,
      async (blockNumber) =>
        Number((await client.getBlock({blockNumber, includeTransactions: false})).timestamp),
      concurrency,
      retryDelaysMs,
      onRetry,
    ),
  ]);
  for (const [block, time] of timesOnLogs) times.set(block, time);

  onProgress?.({fraction: 0.95, message: "Scoring"});

  const transfers: TransferRecord[] = [];
  const unchecked: UncheckedTransfer[] = [];

  for (const log of logs) {
    const signer = signers.get(log.transactionHash);
    const at = times.get(log.blockNumber);
    const from = log.from.toLowerCase() as Address;
    const to = log.to.toLowerCase() as Address;

    if (signer === undefined || at === undefined) {
      unchecked.push({token: log.token, from, to, value: log.value, txHash: log.transactionHash});
      continue;
    }

    // Dust needs decimals and some sense of value, which only exists for tokens we recognise. An
    // unknown contract gets no dust verdict rather than a guessed one; the signals that matter
    // for an unknown token — zero value, and who signed — do not need it.
    const token = knownTokens.find((t) => t.address.toLowerCase() === log.token);
    const dustLimit = token ? parseUnits(String(token.dustBelow), token.decimals) : 0n;

    transfers.push({
      token: log.token,
      from,
      to,
      value: log.value,
      at,
      signer,
      dust: log.value > 0n && log.value < dustLimit,
      txHash: log.transactionHash,
    });
  }

  const ownerKind = await kind;

  onProgress?.({fraction: 1, message: "Done"});

  return {
    owner: owner.toLowerCase() as Address,
    range,
    transfers,
    unchecked,
    history: foldHistory(owner, transfers, unchecked),
    signersResolved: signers.size,
    tokensSeen: [...new Set([...transfers, ...unchecked].map((t) => t.token))],
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

/**
 * Resolve a batch with bounded concurrency, then go back for whatever was refused.
 *
 * The first pass runs `concurrency` lookups at a time, so a large history does not take minutes.
 * Each later pass waits first and then asks one at a time, because a refusal is nearly always the
 * endpoint rate-limiting exactly that concurrency. What is still missing at the end is left out of
 * the map for the caller to report. An earlier version simply left it out, and nobody could tell.
 */
async function resolveAll<K, V>(
  keys: readonly K[],
  resolve: (key: K) => Promise<V>,
  concurrency: number,
  retryDelaysMs: readonly number[],
  onRetry?: (missing: number) => void,
): Promise<Map<K, V>> {
  const out = new Map<K, V>();

  const pass = async (batch: readonly K[], width: number): Promise<void> => {
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < batch.length) {
        const key = batch[cursor++]!;
        try {
          out.set(key, await resolve(key));
        } catch {
          // Left for the next pass, and for the caller to report if every pass is refused.
        }
      }
    };
    await Promise.all(Array.from({length: Math.min(width, batch.length)}, worker));
  };

  await pass(keys, concurrency);
  for (const delay of retryDelaysMs) {
    const missing = keys.filter((key) => !out.has(key));
    if (missing.length === 0) break;
    onRetry?.(missing.length);
    await pause(delay);
    await pass(missing, 1);
  }

  return out;
}

/**
 * The one timer this package needs. Declared rather than typed in from DOM or Node, since this
 * runs in both and each has it.
 */
declare const setTimeout: (callback: () => void, ms: number) => unknown;

function pause(ms: number): Promise<void> {
  return ms > 0 ? new Promise((done) => setTimeout(() => done(), ms)) : Promise.resolve();
}
