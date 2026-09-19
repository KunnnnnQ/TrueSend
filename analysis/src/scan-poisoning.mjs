/**
 * Measure how much address poisoning is happening right now.
 *
 *   node src/scan-poisoning.mjs [--blocks 1000] [--token USDT] [--sample 750]
 *
 * Samples a recent window of ERC-20 `Transfer` logs and separates the ones that are records of a
 * payment from the ones that are records of nothing. The distinction that matters is not the
 * amount — it is **who signed the transaction**. A `Transfer` log naming you as the sender, in a
 * transaction you did not sign, is a fabricated entry in your own history. That is the mechanism
 * behind the 2024 WBTC case (`verify-wbtc-case.mjs`), and it is the one most write-ups miss.
 *
 * Writes `data/scan-latest.json`: aggregate counts for the whole scan, plus a capped sample of
 * the matched rows so `evaluate-engine.mjs` can run offline and CI does not need an RPC.
 */

import {writeFile, mkdir} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

import {
  ARCHIVE_ENDPOINTS,
  RECENT_ENDPOINTS,
  TOKENS,
  TRANSFER_TOPIC,
  addressFromTopic,
  createClient,
} from "./rpc.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}
const BLOCKS = Number(args.get("blocks") ?? 1000);
/**
 * How many matched pairs to write out. The aggregate counts always describe the whole scan; this
 * only caps the row-level evidence so the committed file stays a sensible size in a git repo.
 * `--sample 0` writes every row.
 */
const SAMPLE = Number(args.get("sample") ?? 750);
const TOKEN_NAME = (args.get("token") ?? "USDT").toUpperCase();
const TOKEN = TOKENS[TOKEN_NAME];
if (!TOKEN) throw new Error(`unknown token ${TOKEN_NAME}; known: ${Object.keys(TOKENS).join(", ")}`);

/** Matching this many leading and trailing characters is what the engine treats as a lookalike. */
const MIN_AFFIX = 4;

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "data");
// Archive-capable endpoints go first. A window of even a thousand blocks is already "archive"
// to some public nodes, and a scan that dies two thirds of the way through is not a measurement.
const client = createClient([...ARCHIVE_ENDPOINTS, ...RECENT_ENDPOINTS]);

const head = await client.blockNumber();
// Stay a few blocks back so reorgs near the tip cannot change the sample.
const toBlock = head - 5;
const fromBlock = toBlock - BLOCKS + 1;

console.log(`Scanning ${TOKEN_NAME} transfers, blocks ${fromBlock}..${toBlock} (${BLOCKS} blocks)\n`);

const logs = await client.getLogsRange({address: TOKEN, topics: [TRANSFER_TOPIC]}, fromBlock, toBlock, {
  // USDT runs ~50 transfers a block and several endpoints cap a response at 10000 results, so
  // the chunk has to stay well under 200 blocks or the request is rejected outright.
  chunk: 200,
  onChunk: (end, total) => process.stdout.write(`\r  fetched to block ${end}: ${total} transfers`),
});
process.stdout.write("\n");

const transfers = logs.map((log) => ({
  block: Number.parseInt(log.blockNumber, 16),
  tx: log.transactionHash,
  from: addressFromTopic(log.topics[1]),
  to: addressFromTopic(log.topics[2]),
  value: BigInt(log.data || "0x0"),
}));

const zeroValue = transfers.filter((t) => t.value === 0n);
console.log(`  ${transfers.length} transfers, ${zeroValue.length} of them zero-value ` +
  `(${pct(zeroValue.length, transfers.length)})`);

// ---------------------------------------------------------------------------
// Who signed them?
// ---------------------------------------------------------------------------

const uniqueTxs = [...new Set(zeroValue.map((t) => t.tx))];
console.log(`\nResolving the signer of ${uniqueTxs.length} transactions...`);

const fetched = await client.batch(
  "eth_getTransactionByHash",
  uniqueTxs.map((hash) => [hash]),
  {chunkSize: 100},
);

const signerOf = new Map();
for (let i = 0; i < uniqueTxs.length; i++) {
  const tx = fetched[i];
  if (tx?.from) signerOf.set(uniqueTxs[i], tx.from.toLowerCase());
}
console.log(`  resolved ${signerOf.size}/${uniqueTxs.length}`);

/**
 * A zero-value transfer the named sender did not sign. Their history now shows an outgoing
 * payment they never made.
 */
const spoofed = zeroValue.filter((t) => {
  const signer = signerOf.get(t.tx);
  return signer !== undefined && signer !== t.from;
});
const selfSigned = zeroValue.filter((t) => signerOf.get(t.tx) === t.from);

console.log(`\n  ${spoofed.length} zero-value transfers were signed by somebody other than the`);
console.log(`  address they name as sender (${pct(spoofed.length, zeroValue.length)} of zero-value transfers)`);
console.log(`  ${selfSigned.length} were genuinely self-signed`);

// ---------------------------------------------------------------------------
// Is the planted address a lookalike of somebody the victim really paid?
// ---------------------------------------------------------------------------

/** Real payments, indexed by the address that signed them. */
const realPaymentsBySender = new Map();
for (const t of transfers) {
  if (t.value === 0n) continue;
  if (!realPaymentsBySender.has(t.from)) realPaymentsBySender.set(t.from, []);
  realPaymentsBySender.get(t.from).push(t);
}

const pairs = [];
for (const spoof of spoofed) {
  const victim = spoof.from;
  const planted = spoof.to;
  for (const payment of realPaymentsBySender.get(victim) ?? []) {
    if (payment.to === planted) continue;
    const prefix = sharedAffix(planted, payment.to, false);
    const suffix = sharedAffix(planted, payment.to, true);
    if (prefix < MIN_AFFIX || suffix < MIN_AFFIX) continue;

    pairs.push({
      victim,
      planted,
      imitating: payment.to,
      sharedPrefix: prefix,
      sharedSuffix: suffix,
      plantedAtBlock: spoof.block,
      plantedTx: spoof.tx,
      plantedBy: signerOf.get(spoof.tx),
      realPaymentBlock: payment.block,
      realPaymentTx: payment.tx,
      realPaymentValue: payment.value.toString(),
      /** Negative means the bait was planted before the payment we matched it against. */
      blocksAfterRealPayment: spoof.block - payment.block,
    });
    break;
  }
}

console.log(`\n  ${pairs.length} of the planted addresses are affix-lookalikes of an address the`);
console.log(`  same victim genuinely paid inside this same ${BLOCKS}-block window`);

if (pairs.length) {
  console.log(`\n  Examples:`);
  for (const p of pairs.slice(0, 5)) {
    console.log(`    victim   ${p.victim}`);
    console.log(`      paid   ${p.imitating}  at block ${p.realPaymentBlock}`);
    console.log(`      planted ${p.planted}  at block ${p.plantedAtBlock} (${p.blocksAfterRealPayment >= 0 ? "+" : ""}${p.blocksAfterRealPayment} blocks)`);
    console.log(`      shares first ${p.sharedPrefix} and last ${p.sharedSuffix} characters`);
    console.log(`      planted by ${p.plantedBy}`);
    console.log();
  }
}

// ---------------------------------------------------------------------------
// How fast does the bait follow the payment, and who is sending it?
// ---------------------------------------------------------------------------

// The engine scores "appeared right after a payment" against a fixed window. Better to know the
// real distribution than to guess at one.
const reactive = pairs.filter((p) => p.blocksAfterRealPayment >= 0).map((p) => p.blocksAfterRealPayment);
reactive.sort((a, b) => a - b);
const timing = reactive.length
  ? {
      count: reactive.length,
      min: reactive[0],
      p50: reactive[Math.floor(reactive.length * 0.5)],
      p90: reactive[Math.floor(reactive.length * 0.9)],
      max: reactive[reactive.length - 1],
      withinFiveBlocks: reactive.filter((b) => b <= 5).length,
      withinFiftyBlocks: reactive.filter((b) => b <= 50).length,
    }
  : null;

if (timing) {
  console.log(`\n  Of the ${timing.count} planted after the payment they imitate:`);
  console.log(`    median ${timing.p50} blocks (~${((timing.p50 * 12) / 60).toFixed(1)} min), p90 ${timing.p90}, max ${timing.max}`);
  console.log(`    ${timing.withinFiveBlocks} within 5 blocks (~1 min), ${timing.withinFiftyBlocks} within 50 blocks (~10 min)`);
}

// If this is a handful of operators rather than a long tail, that changes what a community
// registry can realistically achieve.
const byPlanter = new Map();
for (const t of spoofed) {
  const signer = signerOf.get(t.tx);
  if (signer) byPlanter.set(signer, (byPlanter.get(signer) ?? 0) + 1);
}
const topPlanters = [...byPlanter.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
console.log(`\n  ${byPlanter.size} distinct addresses planted these records. Busiest:`);
for (const [address, count] of topPlanters) {
  console.log(`    ${address}  ${count} (${pct(count, spoofed.length)})`);
}

// ---------------------------------------------------------------------------

const report = {
  token: TOKEN_NAME,
  tokenAddress: TOKEN.toLowerCase(),
  fromBlock,
  toBlock,
  blocks: BLOCKS,
  scannedAt: new Date().toISOString(),
  totals: {
    transfers: transfers.length,
    zeroValue: zeroValue.length,
    zeroValueResolved: zeroValue.filter((t) => signerOf.has(t.tx)).length,
    spoofedOutgoing: spoofed.length,
    selfSignedZeroValue: selfSigned.length,
    lookalikePairs: pairs.length,
  },
  /**
   * Distinct addresses that had a fabricated outgoing payment planted in their history during
   * this window. This is the number that says how many people were targeted.
   */
  victims: [...new Set(spoofed.map((t) => t.from))].length,
  plantedAddresses: [...new Set(spoofed.map((t) => t.to))].length,
  timing,
  planters: {
    distinct: byPlanter.size,
    top: topPlanters.map(([address, count]) => ({address, count, share: pct(count, spoofed.length)})),
  },
  /**
   * Row-level evidence, capped by `--sample`. Every row carries the two transaction hashes it
   * rests on, so any single claim here can be checked on a block explorer without rerunning
   * anything. `totals` above always describes the full scan, not this sample.
   */
  pairsSampled: SAMPLE === 0 ? pairs.length : Math.min(pairs.length, SAMPLE),
  pairs: SAMPLE === 0 ? pairs : pairs.slice(0, SAMPLE),
};

await mkdir(dataDir, {recursive: true});
// One file, not two. The block range it covers is inside it, so a second copy under a range-named
// path would only double what the repository carries.
const serialised = `${JSON.stringify(report, null, 2)}\n`;
await writeFile(join(dataDir, "scan-latest.json"), serialised);
console.log(
  `
Wrote data/scan-latest.json — ${report.pairsSampled} of ${pairs.length} pairs, ` +
    `${(serialised.length / 1024).toFixed(0)} KB`,
);

function sharedAffix(a, b, fromEnd) {
  const x = a.toLowerCase().slice(2);
  const y = b.toLowerCase().slice(2);
  let n = 0;
  while (n < x.length && (fromEnd ? x[x.length - 1 - n] === y[y.length - 1 - n] : x[n] === y[n])) n++;
  return n;
}

function pct(n, total) {
  return total === 0 ? "0%" : `${((n / total) * 100).toFixed(2)}%`;
}
