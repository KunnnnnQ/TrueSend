/**
 * Does the end-only lookalike rule hold up on data it was not read off?
 *
 *   node src/suffix-rule.mjs [--blocks 1200]
 *
 * `SUFFIX_ONLY_MATCH` in @truesend/engine — seven matching trailing characters make a lookalike,
 * whatever the start — was added after the replay of Poison-Hunter's 2022–23 sample
 * (`poison-hunter.mjs`), where 40 of 44 dust baits had exactly that shape. The seven was read off
 * that sample, so the sample cannot also be its evidence. This is the check on fresh data: one
 * recent window of mainnet USDT and USDC, asked two questions.
 *
 *  - **Does it cry wolf?** Every pair of genuine counterparties of one account — addresses it really
 *    paid, and addresses that really paid it — that the rule would call lookalikes of each other.
 *    Each is a warning a user would see about somebody legitimate, so each is listed.
 *  - **Does it still catch anything?** Every address planted in an account's history inside the
 *    window — a zero-value transfer the account did not sign, or dust sent to it — set against the
 *    addresses that account really paid, and sorted by which test recognises the imitation: both
 *    ends, the end alone, or neither.
 *
 * "Really paid" is a transfer of at least one whole token. On the real USDT and USDC contracts that
 * is money moving, whoever submitted it, so its counterparty is genuine. Dust is anything above
 * zero and below that — the line the product draws for these two tokens.
 *
 * Writes `data/suffix-rule.json`.
 */

import {mkdir, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

import {MIN_AFFIX_MATCH, SUFFIX_ONLY_MATCH, collidingPairs, lookalikeAffixes} from "@truesend/engine";

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
const BLOCKS = Number(args.get("blocks") ?? 1200);
/** One USDT or one USDC: both have six decimals. */
const WHOLE = 1_000_000n;
const ZERO = "0x0000000000000000000000000000000000000000";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "data");
const client = createClient([...ARCHIVE_ENDPOINTS, ...RECENT_ENDPOINTS]);

const head = await client.blockNumber();
// A few blocks back so a reorg near the tip cannot change the sample.
const toBlock = head - 5;
const fromBlock = toBlock - BLOCKS + 1;
console.log(`USDT and USDC transfers, blocks ${fromBlock}..${toBlock} (${BLOCKS} blocks)\n`);

const transfers = [];
for (const name of ["USDT", "USDC"]) {
  const logs = await client.getLogsRange({address: TOKENS[name], topics: [TRANSFER_TOPIC]}, fromBlock, toBlock, {
    chunk: 200,
    onChunk: (end, total) => process.stdout.write(`\r  ${name}: to block ${end}, ${total} transfers`),
  });
  process.stdout.write("\n");
  for (const log of logs) {
    if (log.topics.length !== 3) continue;
    transfers.push({
      token: name,
      block: Number.parseInt(log.blockNumber, 16),
      tx: log.transactionHash,
      from: addressFromTopic(log.topics[1]),
      to: addressFromTopic(log.topics[2]),
      value: BigInt(log.data || "0x0"),
    });
  }
}

const moves = transfers.filter((t) => t.from !== ZERO && t.to !== ZERO && t.from !== t.to);
const real = moves.filter((t) => t.value >= WHOLE);
const dust = moves.filter((t) => t.value > 0n && t.value < WHOLE);
const zeroValue = moves.filter((t) => t.value === 0n);

// Only the zero-value records need a signer: a zero-value transfer is a payment record exactly when
// the account it names as sender signed it, and almost never is.
const uniqueTxs = [...new Set(zeroValue.map((t) => t.tx))];
console.log(`\nResolving the signer of ${uniqueTxs.length} zero-value transactions…`);
const fetched = await client.batch("eth_getTransactionByHash", uniqueTxs.map((hash) => [hash]), {chunkSize: 100});
const signerOf = new Map();
uniqueTxs.forEach((hash, i) => {
  if (fetched[i]?.from) signerOf.set(hash, fetched[i].from.toLowerCase());
});
const fabricated = zeroValue.filter((t) => signerOf.has(t.tx) && signerOf.get(t.tx) !== t.from);
const unresolved = zeroValue.filter((t) => !signerOf.has(t.tx)).length;

console.log(`  ${transfers.length} transfers: ${real.length} of at least one token, ${dust.length} dust, ` +
  `${zeroValue.length} zero-value (${fabricated.length} not signed by their named sender, ${unresolved} unresolved)`);

// ---------------------------------------------------------------------------
// Every account's genuine counterparties.
// ---------------------------------------------------------------------------

const payees = new Map();
const payers = new Map();
const add = (map, key, value) => (map.get(key) ?? map.set(key, new Set()).get(key)).add(value);
for (const t of real) {
  add(payees, t.from, t.to);
  add(payers, t.to, t.from);
}

const branch = ({sharedPrefix, sharedSuffix}) =>
  sharedPrefix >= MIN_AFFIX_MATCH && sharedSuffix >= MIN_AFFIX_MATCH ? "both ends" : "end only";

// ---------------------------------------------------------------------------
// 1. Does it cry wolf?
// ---------------------------------------------------------------------------

/**
 * The engine compares whatever is being checked against the account's payees, so a false alarm is
 * a pair with at least one payee in it. Two addresses that only ever paid the account are never
 * compared with each other, and are left out of both the count and the expectation.
 */
const accounts = new Set([...payees.keys(), ...payers.keys()]);
let comparisons = 0;
const alarms = [];

for (const account of accounts) {
  const paid = payees.get(account) ?? new Set();
  if (paid.size === 0) continue;
  const everyone = new Set([...paid, ...(payers.get(account) ?? [])]);
  comparisons += (paid.size * (paid.size - 1)) / 2 + paid.size * (everyone.size - paid.size);

  for (const pair of collidingPairs(everyone)) {
    if (!paid.has(pair.a) && !paid.has(pair.b)) continue;
    alarms.push({account, a: pair.a, b: pair.b, sharedPrefix: pair.sharedPrefix, sharedSuffix: pair.sharedSuffix, branch: branch(pair)});
  }
}

// Chance alone: seven trailing characters is 28 bits, four at each end 32.
const expected = {endOnly: comparisons / 2 ** 28, bothEnds: comparisons / 2 ** 32};
const observedAlarms = {
  endOnly: alarms.filter((a) => a.branch === "end only").length,
  bothEnds: alarms.filter((a) => a.branch === "both ends").length,
};

console.log(`\n1. Genuine counterparties called lookalikes of one another`);
console.log(`   ${comparisons.toLocaleString("en-US")} comparisons the engine would make`);
console.log(`   end only:  ${observedAlarms.endOnly} observed, ${expected.endOnly.toFixed(3)} expected by chance`);
console.log(`   both ends: ${observedAlarms.bothEnds} observed, ${expected.bothEnds.toFixed(3)} expected by chance`);
for (const a of alarms) {
  console.log(`     ${a.branch.padEnd(9)} ${a.sharedPrefix}+${a.sharedSuffix}  account ${a.account}  ${a.a} ~ ${a.b}`);
}

// ---------------------------------------------------------------------------
// 2. Does it still catch anything?
// ---------------------------------------------------------------------------

/** Each planted address once per account, with the record that planted it. */
const planted = new Map();
for (const t of fabricated) planted.set(`${t.from}|${t.to}`, {kind: "zero-value", account: t.from, address: t.to, tx: t.tx, block: t.block});
for (const t of dust) {
  const key = `${t.to}|${t.from}`;
  if (!planted.has(key)) planted.set(key, {kind: "dust", account: t.to, address: t.from, tx: t.tx, block: t.block});
}

const tally = {};
const endOnlyCatches = [];
for (const p of planted.values()) {
  const paid = payees.get(p.account);
  let verdict = "account paid nobody in the window";
  if (paid?.size && !paid.has(p.address)) {
    let best;
    for (const payee of paid) {
      const match = lookalikeAffixes(p.address, payee);
      if (match && (!best || match.sharedPrefix + match.sharedSuffix > best.sharedPrefix + best.sharedSuffix)) {
        best = {...match, payee};
      }
    }
    verdict = best ? branch(best) : "no payee it resembles";
    if (best && verdict === "end only") endOnlyCatches.push({...p, imitating: best.payee, sharedPrefix: best.sharedPrefix, sharedSuffix: best.sharedSuffix});
  } else if (paid?.has(p.address)) {
    verdict = "the account really paid it too";
  }
  const row = (tally[p.kind] ??= {});
  row[verdict] = (row[verdict] ?? 0) + 1;
}

console.log(`\n2. Planted addresses, against what the same account really paid`);
for (const [kind, row] of Object.entries(tally)) {
  console.log(`   ${kind.padEnd(10)} ${Object.entries(row).map(([k, v]) => `${k}: ${v}`).join(" · ")}`);
}
for (const c of endOnlyCatches.slice(0, 10)) {
  console.log(`     ${c.kind.padEnd(10)} ${c.sharedPrefix}+${c.sharedSuffix}  ${c.address} imitating ${c.imitating}  tx ${c.tx}`);
}

await mkdir(dataDir, {recursive: true});
await writeFile(
  join(dataDir, "suffix-rule.json"),
  `${JSON.stringify(
    {
      scannedAt: new Date().toISOString(),
      window: {fromBlock, toBlock, tokens: ["USDT", "USDC"]},
      rule: {minAffixMatch: MIN_AFFIX_MATCH, suffixOnlyMatch: SUFFIX_ONLY_MATCH},
      transfers: {
        total: transfers.length,
        real: real.length,
        dust: dust.length,
        zeroValue: zeroValue.length,
        fabricated: fabricated.length,
        unresolved,
      },
      cryingWolf: {comparisons, expectedByChance: expected, observed: observedAlarms, pairs: alarms},
      catching: {byKind: tally, endOnly: endOnlyCatches},
    },
    null,
    2,
  )}\n`,
);
console.log("\nwrote data/suffix-rule.json");
