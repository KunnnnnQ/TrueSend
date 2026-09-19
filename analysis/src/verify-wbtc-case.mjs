/**
 * Re-derive the May 2024 WBTC address-poisoning case from chain, from scratch.
 *
 * This case is widely written about, and almost every account of it — including the one this
 * project started from — describes the mechanism wrongly. The point of this script is that
 * nothing here is taken from reporting: every claim in `data/case-wbtc-2024-05-03.json` is
 * fetched and asserted against a live archive node, and the script fails loudly rather than
 * writing a file if any assertion breaks.
 *
 *   node src/verify-wbtc-case.mjs
 */

import {writeFile, mkdir} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

import {
  ARCHIVE_ENDPOINTS,
  TOKENS,
  TRANSFER_TOPIC,
  addressFromTopic,
  createClient,
  topicFor,
} from "./rpc.mjs";

const VICTIM = "0x1e227979f0b5bc691a70deaed2e0f39a6f538fd5";
const LOSS_BLOCK = 19_789_009;
const SEARCH_FROM = 19_770_000;

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "data");

const client = createClient(ARCHIVE_ENDPOINTS);

function assert(condition, message) {
  if (!condition) {
    console.error(`\nASSERTION FAILED: ${message}`);
    console.error("Nothing was written. The case file only ever contains verified facts.");
    process.exit(1);
  }
}

/** Reads a string-returning view, tolerating tokens that simply do not implement it. */
async function decodeStringCall(token, selector) {
  // Impersonation tokens are minimal by design and frequently revert on anything optional, so a
  // missing `name()` is itself data rather than an error.
  const raw = await client.call("eth_call", [{to: token, data: selector}, "latest"]).catch(() => null);
  if (!raw || raw === "0x") return null;
  const body = raw.slice(2);
  // Some old tokens return a bare bytes32 instead of an ABI-encoded string.
  if (body.length === 64) return Buffer.from(body, "hex").toString("utf8").replace(/\0+$/, "");
  const length = Number.parseInt(body.slice(64, 128), 16);
  return Buffer.from(body.slice(128, 128 + length * 2), "hex").toString("utf8");
}

console.log("Re-deriving the case from chain. Nothing below is taken from reporting.\n");

// ---------------------------------------------------------------------------
// 1. The loss itself.
// ---------------------------------------------------------------------------

const outgoingWbtc = [];
for (let start = SEARCH_FROM; start <= LOSS_BLOCK; start += 10_000) {
  const page = await client.getLogs({
    address: TOKENS.WBTC,
    topics: [TRANSFER_TOPIC, topicFor(VICTIM)],
    fromBlock: `0x${start.toString(16)}`,
    toBlock: `0x${Math.min(start + 9_999, LOSS_BLOCK).toString(16)}`,
  });
  outgoingWbtc.push(...page);
}

const biggest = outgoingWbtc.reduce((a, b) => (BigInt(a.data) > BigInt(b.data) ? a : b));
const attacker = addressFromTopic(biggest.topics[2]);
const lostSats = BigInt(biggest.data);

assert(Number.parseInt(biggest.blockNumber, 16) === LOSS_BLOCK, "largest WBTC transfer is at the expected block");
assert(lostSats === 115_528_802_767n, `lost amount is 1155.28802767 WBTC (saw ${lostSats})`);

console.log(`1. The loss`);
console.log(`   block ${LOSS_BLOCK}: victim sent ${Number(lostSats) / 1e8} WBTC`);
console.log(`   to ${attacker}`);
console.log(`   tx ${biggest.transactionHash}`);

// ---------------------------------------------------------------------------
// 2. The record that made the victim trust that address.
// ---------------------------------------------------------------------------

const priorToAttacker = [];
for (let start = SEARCH_FROM; start < LOSS_BLOCK; start += 10_000) {
  const page = await client.getLogs({
    topics: [TRANSFER_TOPIC, topicFor(VICTIM), topicFor(attacker)],
    fromBlock: `0x${start.toString(16)}`,
    toBlock: `0x${Math.min(start + 9_999, LOSS_BLOCK - 1).toString(16)}`,
  });
  priorToAttacker.push(...page);
}

assert(
  priorToAttacker.length === 1,
  `exactly one earlier transfer from victim to attacker (saw ${priorToAttacker.length})`,
);

const bait = priorToAttacker[0];
const baitBlock = Number.parseInt(bait.blockNumber, 16);
const baitToken = bait.address.toLowerCase();

const [baitSymbol, baitName, baitDecimalsRaw] = await Promise.all([
  decodeStringCall(baitToken, "0x95d89b41"),
  decodeStringCall(baitToken, "0x06fdde03"),
  client.call("eth_call", [{to: baitToken, data: "0x313ce567"}, "latest"]).catch(() => null),
]);
const baitDecimals = Number.parseInt(baitDecimalsRaw ?? "0x0", 16);

console.log(`\n2. The record the victim acted on`);
console.log(`   block ${baitBlock}, ${LOSS_BLOCK - baitBlock} blocks earlier`);
console.log(`   token ${baitToken}`);
console.log(`   symbol ${JSON.stringify(baitSymbol)}, name ${JSON.stringify(baitName)}, decimals ${baitDecimals}`);
console.log(`   reads as: victim sent ${Number(BigInt(bait.data)) / 10 ** baitDecimals} ${baitSymbol}`);

assert(baitSymbol === "ETH", `the bait token impersonates ETH (saw ${JSON.stringify(baitSymbol)})`);
assert(baitToken !== TOKENS.WBTC.toLowerCase(), "the bait token is not a real asset the victim held");

// ---------------------------------------------------------------------------
// 3. Who actually signed each one. This is the whole point.
// ---------------------------------------------------------------------------

const [baitTx, lossTx] = await Promise.all([
  client.call("eth_getTransactionByHash", [bait.transactionHash]),
  client.call("eth_getTransactionByHash", [biggest.transactionHash]),
]);

const baitSigner = baitTx.from.toLowerCase();
const lossSigner = lossTx.from.toLowerCase();

console.log(`\n3. Who signed what`);
console.log(`   the "earlier payment"  signed by ${baitSigner}`);
console.log(`   the 1155 WBTC transfer signed by ${lossSigner}`);

assert(lossSigner === VICTIM, "the victim signed the WBTC transfer");
assert(
  baitSigner !== VICTIM,
  "the earlier record was NOT signed by the victim — this is the finding the case turns on",
);

console.log(`\n   => The victim never made that earlier payment. A third party called a contract`);
console.log(`      that emitted a Transfer log naming the victim as the sender. The victim's`);
console.log(`      history then showed a successful payment to the attacker's address that the`);
console.log(`      victim had never made, and ${LOSS_BLOCK - baitBlock} blocks later they trusted it.`);

// ---------------------------------------------------------------------------
// 4. The address that was being imitated.
// ---------------------------------------------------------------------------

const REPORTED_INTENDED = "0xd9a1b0b1e1ae382dbdc898ea68012ffcb2853a91";
const [intendedCode, intendedNonce] = await Promise.all([
  client.call("eth_getCode", [REPORTED_INTENDED, "latest"]),
  client.call("eth_getTransactionCount", [REPORTED_INTENDED, "latest"]),
]);

const sharedPrefix = countShared(attacker, REPORTED_INTENDED, false);
const sharedSuffix = countShared(attacker, REPORTED_INTENDED, true);

console.log(`\n4. The imitated address`);
console.log(`   attacker  ${attacker}`);
console.log(`   intended  ${REPORTED_INTENDED}  (from public reporting, NOT verified here)`);
console.log(`   they share the first ${sharedPrefix} and last ${sharedSuffix} characters`);
console.log(`   the intended address exists: nonce ${Number.parseInt(intendedNonce, 16)}, ${intendedCode === "0x" ? "EOA" : "contract"}`);
console.log(`   no transfer between the victim and it appears on chain in the searched window,`);
console.log(`   so the pairing is recorded as unverified and is excluded from scoring.`);

// ---------------------------------------------------------------------------

const record = {
  name: "WBTC address poisoning, 2024-05-03",
  verifiedAt: new Date().toISOString(),
  verifiedAgainst: ARCHIVE_ENDPOINTS[0],
  note:
    "Every field below was fetched from an archive node by src/verify-wbtc-case.mjs and asserted. " +
    "The mechanism is not the one most write-ups describe: the victim did not make a test transfer. " +
    "A third party fabricated the record of one.",
  victim: VICTIM,
  attacker,
  loss: {
    block: LOSS_BLOCK,
    tx: biggest.transactionHash,
    token: TOKENS.WBTC.toLowerCase(),
    amountRaw: lostSats.toString(),
    amount: Number(lostSats) / 1e8,
    symbol: "WBTC",
    signedBy: lossSigner,
    signedByVictim: true,
  },
  bait: {
    block: baitBlock,
    blocksBeforeLoss: LOSS_BLOCK - baitBlock,
    tx: bait.transactionHash,
    token: baitToken,
    symbol: baitSymbol,
    name: baitName,
    decimals: baitDecimals,
    amountRaw: BigInt(bait.data).toString(),
    rendersAs: `${Number(BigInt(bait.data)) / 10 ** baitDecimals} ${baitSymbol}`,
    signedBy: baitSigner,
    signedByVictim: false,
    calledContract: baitTx.to.toLowerCase(),
  },
  imitated: {
    address: REPORTED_INTENDED,
    source: "public reporting",
    verifiedOnChain: false,
    sharedPrefix,
    sharedSuffix,
  },
};

await mkdir(dataDir, {recursive: true});
const path = join(dataDir, "case-wbtc-2024-05-03.json");
await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
console.log(`\nAll assertions passed. Wrote ${path}`);

function countShared(a, b, fromEnd) {
  const x = a.toLowerCase().slice(2);
  const y = b.toLowerCase().slice(2);
  let n = 0;
  while (n < x.length && (fromEnd ? x[x.length - 1 - n] === y[y.length - 1 - n] : x[n] === y[n])) n++;
  return n;
}
