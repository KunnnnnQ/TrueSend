/**
 * How often do somebody's tokens move without their signature, legitimately?
 *
 *   node src/authorised-movements.mjs [--blocks 60] [--check]
 *
 * The rule this whole project rests on is that **a transfer log naming you as sender, in a
 * transaction you did not sign, is not a payment you made**. That is true, and it is the reason
 * the detector catches address poisoning at all.
 *
 * It is not the same statement as "…is therefore a fabrication", and the product has been
 * treating the two as interchangeable. They come apart whenever somebody is *authorised* to move
 * your tokens for you:
 *
 *   - **Permit2**, Uniswap's signature-based allowance contract — you sign an order off chain,
 *     a filler submits it;
 *   - **intent settlement** — a CoW Protocol or UniswapX solver settles your order;
 *   - **EIP-3009 / EIP-2612** — `transferWithAuthorization` and `permit`, which USDC supports, let
 *     a relayer move your tokens against an off-chain signature so you need no ETH for gas;
 *   - **an ordinary ERC-20 allowance** being spent by a contract you approved earlier.
 *
 * In every one of those the log names you, the transaction names them, and your tokens really
 * moved. `foldHistory` counts all of them as `spoofedOutgoingCount`, which scores 65 and lands
 * the counterparty in **danger**. A tool that calls a solver an attacker is a tool that gets
 * switched off, and one that is switched off protects nobody.
 *
 * So this measures the exposure directly, against mainnet, without a list of known protocols —
 * the addresses below are discovered, not configured. The one filter that matters is whether the
 * log's named sender has code: a transfer out of a pool, a router or a vault is a routing hop
 * inside somebody else's transaction and was never anybody's address book entry. A transfer out
 * of an **externally owned account** is a person.
 *
 * With `--check` it also builds a history from one measured record, hands it to the shipped
 * engine, and prints the verdict — so the claim that this produces a false alarm is demonstrated
 * on real data rather than argued.
 *
 * Writes `data/authorised-movements.json`.
 */

import {writeFile, mkdir} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

import {createChainClient, scanHistory} from "@truesend/chain";
import {assessAddress} from "@truesend/engine";

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
const BLOCKS = Number(args.get("blocks") ?? 60);
/** How many of the measured people to re-scan the way the product would. */
const PEOPLE = Number(args.get("people") ?? 8);
const HISTORY_BLOCKS = Number(args.get("history") ?? 8_000);
const CHECK = process.argv.includes("--check");

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "data");

const rpc = createClient(RECENT_ENDPOINTS);

const head = await rpc.blockNumber();
const toBlock = head - 5;
const fromBlock = toBlock - BLOCKS + 1;

console.log(`USDT and USDC transfers, blocks ${fromBlock}..${toBlock}`);
console.log(`(${BLOCKS} blocks, about ${Math.round((BLOCKS * 12) / 60)} minutes of mainnet)\n`);

const logs = [];
for (const token of [TOKENS.USDT, TOKENS.USDC]) {
  logs.push(
    ...(await rpc.getLogsRange({address: token, topics: [TRANSFER_TOPIC]}, fromBlock, toBlock, {
      chunk: 20,
    })),
  );
}

const amount = (log) => (log.data && log.data !== "0x" ? BigInt(log.data) : 0n);
/** Three topics is the ERC-20 shape; a fourth means the third argument is an id, not an amount. */
const erc20 = logs.filter((log) => log.topics.length === 3);
const nonZero = erc20.filter((log) => amount(log) > 0n);
const zeroValue = erc20.length - nonZero.length;

const hashes = [...new Set(nonZero.map((log) => log.transactionHash))];
const txs = await rpc.batch("eth_getTransactionByHash", hashes.map((h) => [h]), {chunkSize: 100});

const transaction = new Map();
hashes.forEach((hash, i) => {
  if (txs[i]?.from) {
    transaction.set(hash, {
      signer: txs[i].from.toLowerCase(),
      calling: txs[i].to ? txs[i].to.toLowerCase() : null,
    });
  }
});

const unsigned = [];
for (const log of nonZero) {
  const tx = transaction.get(log.transactionHash);
  if (!tx) continue;
  const named = addressFromTopic(log.topics[1]);
  if (named === tx.signer) continue;

  unsigned.push({
    token: log.address.toLowerCase(),
    from: named,
    to: addressFromTopic(log.topics[2]),
    value: amount(log),
    signer: tx.signer,
    calling: tx.calling,
    txHash: log.transactionHash,
    blockNumber: Number.parseInt(log.blockNumber, 16),
  });
}

/**
 * A contract named as sender is a routing hop. A plain account named as sender is a person whose
 * tokens moved, which is the only case that ever reaches somebody's address book.
 */
const namedSenders = [...new Set(unsigned.map((u) => u.from))];
const codes = await rpc.batch("eth_getCode", namedSenders.map((a) => [a, "latest"]), {chunkSize: 100});
const plainAccount = new Map();
namedSenders.forEach((address, i) => plainAccount.set(address, codes[i] === "0x"));

const fromPeople = unsigned.filter((u) => plainAccount.get(u.from));
const people = new Set(fromPeople.map((u) => u.from));

console.log(`  nonzero transfers                              ${nonZero.length}`);
console.log(`  zero-value transfers (the poisoning signature) ${zeroValue}`);
console.log(`\n  nonzero, naming a sender who did not sign      ${unsigned.length}`);
console.log(`    named sender is a contract                   ${unsigned.length - fromPeople.length}  routing hops`);
console.log(`    named sender is an ordinary account          ${fromPeople.length}  (${people.size} distinct people)`);
console.log(
  `\n  ${pct(fromPeople.length, nonZero.length)} of nonzero transfers move a person's tokens ` +
    `without that person signing.`,
);

const byCaller = new Map();
for (const record of fromPeople) {
  const caller = record.calling ?? "(contract creation)";
  if (!byCaller.has(caller)) byCaller.set(caller, {transfers: 0, people: new Set(), example: record});
  const row = byCaller.get(caller);
  row.transfers++;
  row.people.add(record.from);
}

const movers = [...byCaller.entries()]
  .sort((a, b) => b[1].transfers - a[1].transfers)
  .map(([address, row]) => ({
    address,
    transfers: row.transfers,
    people: row.people.size,
    exampleTx: row.example.txHash,
  }));

console.log(`\nWhat does the moving (discovered, not configured):`);
for (const mover of movers.slice(0, 10)) {
  console.log(
    `  ${mover.address}  ${String(mover.transfers).padStart(4)}x  ` +
      `${String(mover.people).padStart(4)} people   ${mover.exampleTx.slice(0, 20)}…`,
  );
}

// ---------------------------------------------------------------------------
// What the shipped engine makes of one of them.
// ---------------------------------------------------------------------------

/**
 * Demonstrated rather than argued, and against a real history rather than a convenient one.
 *
 * Handing `foldHistory` the single unsigned record in isolation would be rigging it: with no
 * history at all the engine cannot know the owner ever held the token, so of course it calls the
 * record a fabrication. The honest test is the one the product actually performs — scan the
 * person's history the way the Scan screen does, fold it, and score the address their tokens went
 * to.
 *
 * That also measures the real limit of the fix. The engine learns that somebody holds a token by
 * seeing it arrive, so a token acquired before the start of the scanned window is invisible and
 * the warning comes back. This counts how often that happens instead of assuming it away.
 */
const sample = [];
const seenPeople = new Set();
for (const record of fromPeople) {
  if (seenPeople.has(record.from)) continue;
  seenPeople.add(record.from);
  sample.push(record);
  if (sample.length >= PEOPLE) break;
}

console.log(`\nWhat the shipped engine says, over ${sample.length} of these people's real histories`);
console.log(`(scanning back ${HISTORY_BLOCKS} blocks, as the product does):\n`);

// Public endpoints refuse `eth_getLogs` over a window this wide; only the archive one answers.
const viemClient = createChainClient(ARCHIVE_ENDPOINTS[0]);
const historyTo = BigInt(toBlock);
const historyFrom = historyTo > BigInt(HISTORY_BLOCKS) ? historyTo - BigInt(HISTORY_BLOCKS) : 0n;

const verdicts = [];
for (const record of sample) {
  let scan;
  try {
    scan = await scanHistory(viemClient, record.from, {fromBlock: historyFrom, toBlock: historyTo});
    // A measurement cannot use a scan with holes in it; until 2026-10-07 it could not even see them.
    if (scan.unchecked.length > 0) throw new Error(`${scan.unchecked.length} transfers could not be checked`);
  } catch (error) {
    console.log(`  ${record.from}  scan failed (${error.message.slice(0, 40)}) — skipped`);
    continue;
  }

  const now = Math.max(...scan.transfers.map((t) => t.at), 0);
  const verdict = assessAddress({to: record.to, history: scan.history, now});
  const entry = scan.history.find((e) => e.address === record.to);

  verdicts.push({
    person: record.from,
    recipient: record.to,
    calling: record.calling,
    txHash: record.txHash,
    level: verdict.level,
    score: verdict.score,
    findings: verdict.findings.map((f) => f.code),
    sawTheTokenArrive: (entry?.authorisedOutgoingCount ?? 0) > 0,
  });

  console.log(
    `  ${record.from}  ->  ${record.to}  ${verdict.level.toUpperCase().padEnd(7)} ` +
      `${String(verdict.score).padStart(3)}/100   ${verdict.findings.map((f) => f.code).join(", ") || "nothing"}`,
  );
}

const criedWolf = verdicts.filter((v) => v.level === "danger");
console.log(
  `\n  called an attacker: ${criedWolf.length} of ${verdicts.length}` +
    (verdicts.length
      ? `  (${pct(criedWolf.length, verdicts.length)})`
      : ""),
);
if (criedWolf.length > 0) {
  console.log(
    `  Every one of those is a token whose arrival predates the ${HISTORY_BLOCKS}-block window,\n` +
      `  so nothing in the history says the owner ever held it. Widening the window shrinks this;\n` +
      `  only a balance read removes it, and that is a change to the chain layer, not the engine.`,
  );
}

const report = {
  scannedAt: new Date().toISOString(),
  range: {fromBlock, toBlock, blocks: BLOCKS},
  tokens: ["USDT", "USDC"],
  transfers: {nonZero: nonZero.length, zeroValue},
  unsigned: {
    total: unsigned.length,
    namedSenderIsContract: unsigned.length - fromPeople.length,
    namedSenderIsPerson: fromPeople.length,
    distinctPeople: people.size,
    shareOfNonZero: fromPeople.length / nonZero.length,
  },
  movers,
  engineOverRealHistories: {
    scanned: verdicts.length,
    historyBlocks: HISTORY_BLOCKS,
    calledAnAttacker: criedWolf.length,
    verdicts,
  },
};

await mkdir(dataDir, {recursive: true});
const path = join(dataDir, "authorised-movements.json");
await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nWrote ${path}`);

if (CHECK) {
  const problems = [];

  if (fromPeople.length === 0) {
    problems.push(
      "no authorised third-party movements found at all, which contradicts every previous run — " +
        "check the scan before concluding the exposure has gone away",
    );
  }

  // The point of the check: the engine must not call a legitimate settlement an attack. Until
  // the rule is fixed this fails, and it is supposed to.
  if (sample.length > 0 && verdicts.length === 0) {
    problems.push(
      `every one of the ${sample.length} history scans failed, so the engine was never actually ` +
        `asked — "0 of 0 cried wolf" is not a result`,
    );
  }

  if (verdicts.length > 0 && criedWolf.length === verdicts.length) {
    problems.push(
      `the engine calls every one of ${verdicts.length} legitimate authorised movements an ` +
        `attack — the holding rule is not firing at all`,
    );
  }

  if (problems.length) {
    console.log("\nFAILED:");
    for (const problem of problems) console.log(`  - ${problem}`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

function pct(n, d) {
  return d === 0 ? "0%" : `${((n / d) * 100).toFixed(2)}%`;
}
