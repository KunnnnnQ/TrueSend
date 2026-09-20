/**
 * How often would TrueSend cry wolf at somebody who is fine?
 *
 *   node src/false-positives.mjs [--wallets 25] [--blocks 20000]
 *
 * Every other number in `analysis/` measures whether the detector *catches* things. This one
 * measures whether it is bearable to live with, which decides whether anybody keeps it switched
 * on — and a tool that gets switched off protects nobody. The existing control set does not
 * answer it: those addresses were already known to be real payees, so of course they came back
 * clean.
 *
 * Method: pick wallets at random from people who made a genuine payment, rebuild each history the
 * way the product does (signers resolved), score every counterparty, and count the warnings.
 *
 * The result is then split by what each warning rests on, because "false positive" is the wrong
 * frame for half of them:
 *
 *   - a **fact**: `spoofed-outgoing-transfer` says a transfer log names the user as sender in a
 *     transaction they did not sign. That is checkable and it is either true or it is not. When
 *     one fires it is a discovery, not a false alarm;
 *   - a **heuristic**: lookalikes, zero-value and dust inbounds, timing. These are inferences and
 *     these are the ones that can be wrong;
 *   - a **baseline**: "you have never paid this address", which is true of every first payment
 *     anyone ever makes and is deliberately weighted to stay quiet.
 *
 * Writes `data/false-positives.json`.
 */

import {writeFile, mkdir} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

import {createChainClient, scanHistory} from "@truesend/chain";
import {assessAddress} from "@truesend/engine";

import {ARCHIVE_ENDPOINTS, RECENT_ENDPOINTS, TOKENS, TRANSFER_TOPIC, addressFromTopic, createClient} from "./rpc.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}
const WALLETS = Number(args.get("wallets") ?? 25);
const HISTORY_BLOCKS = BigInt(args.get("blocks") ?? 20_000);
/** Where the wallets are drawn from. Small: we only need enough to sample out of. */
const SAMPLE_BLOCKS = 120;

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "data");

const rpc = createClient([...ARCHIVE_ENDPOINTS, ...RECENT_ENDPOINTS]);
const viemClient = createChainClient(ARCHIVE_ENDPOINTS[0]);

const FACT_CODES = new Set(["spoofed-outgoing-transfer"]);

/**
 * The one thing that could undermine the headline.
 *
 * A `Transfer` log naming the user as sender in a transaction somebody else signed is *usually* a
 * fabrication — but it is also exactly what a legitimate intent-based settlement looks like. A
 * CoW or UniswapX solver moves your tokens after you sign an order off chain, and the log names
 * you while the transaction names them. Flagging those would be a real false positive, so their
 * share has to be measured rather than waved away.
 *
 * The discriminator is **whether the user has ever moved that token themselves**, which needs no
 * list of known tokens and therefore cannot be wrong about a token the list forgot. If you have
 * never signed a transfer of a token, you never held it, and a record of you sending it is
 * fabricated. If you have, a third party moving it for you is plausible and the case is counted
 * as ambiguous.
 *
 * An earlier version of this check used a five-token canonical list instead. That would have
 * filed a solver settling PEPE under "impossible" purely because the list was short.
 */
function classifyFabrication(transfer, tokensTheOwnerHasSigned) {
  if (transfer.value === 0n) return "zeroValue";
  return tokensTheOwnerHasSigned.has(transfer.token) ? "tokenTheyHaveUsed" : "tokenTheyNeverTouched";
}
const BASELINE_CODES = new Set(["no-history-at-all", "never-paid-before"]);

// ---------------------------------------------------------------------------
// 1. Pick wallets at random from people who actually paid somebody.
// ---------------------------------------------------------------------------

const head = await rpc.blockNumber();
const to = head - 5;
const from = to - SAMPLE_BLOCKS + 1;

console.log(`Sampling wallets from USDT payments in blocks ${from}..${to}\n`);

const logs = await rpc.getLogsRange(
  {address: TOKENS.USDT, topics: [TRANSFER_TOPIC]},
  from,
  to,
  {chunk: 60},
);

const nonZero = logs.filter((log) => BigInt(log.data || "0x0") > 0n);
const txs = [...new Set(nonZero.map((log) => log.transactionHash))];
const fetched = await rpc.batch("eth_getTransactionByHash", txs.map((h) => [h]), {chunkSize: 100});

const signerOf = new Map();
for (let i = 0; i < txs.length; i++) {
  if (fetched[i]?.from) signerOf.set(txs[i], fetched[i].from.toLowerCase());
}

/**
 * Only wallets that signed their own payment.
 *
 * A `from` taken straight from a log would include every address a fabricated record names, which
 * would stack the sample with victims and make the answer meaningless. The whole point of this
 * measurement is to ask what an ordinary wallet sees.
 */
const payers = [
  ...new Set(
    nonZero
      .filter((log) => signerOf.get(log.transactionHash) === addressFromTopic(log.topics[1]))
      .map((log) => addressFromTopic(log.topics[1])),
  ),
];

console.log(`  ${nonZero.length} real payments, ${payers.length} distinct self-signed payers`);

// Deterministic pick, so a rerun over the same window gives the same wallets.
const chosen = [];
for (let i = 0; i < payers.length && chosen.length < WALLETS; i++) {
  const index = (i * 7919) % payers.length;
  const candidate = payers[index];
  if (!chosen.includes(candidate)) chosen.push(candidate);
}

console.log(`  sampling ${chosen.length} of them\n`);

// ---------------------------------------------------------------------------
// 2. Rebuild each history the way the product does, and score everything in it.
// ---------------------------------------------------------------------------

const historyTo = BigInt(to);
const historyFrom = historyTo > HISTORY_BLOCKS ? historyTo - HISTORY_BLOCKS : 0n;

const wallets = [];
const byCode = new Map();
let counterparties = 0;
let flagged = 0;
let factFlagged = 0;
let heuristicFlagged = 0;

const spoofKind = {zeroValue: 0, tokenTheyNeverTouched: 0, tokenTheyHaveUsed: 0};
const ambiguous = [];

for (const [index, owner] of chosen.entries()) {
  process.stdout.write(`\r  scanning ${index + 1}/${chosen.length}`);

  let scan;
  try {
    scan = await scanHistory(viemClient, owner, {fromBlock: historyFrom, toBlock: historyTo});
  } catch (error) {
    console.log(`\n  ${owner}: scan failed (${error.message.slice(0, 60)}) — excluded`);
    continue;
  }

  // Tokens this wallet has demonstrably held, because it signed a transfer of one.
  const tokensTheOwnerHasSigned = new Set(
    scan.transfers
      .filter((t) => t.signer === owner.toLowerCase() && t.from === owner.toLowerCase())
      .map((t) => t.token),
  );

  for (const transfer of scan.transfers) {
    if (transfer.from !== owner.toLowerCase() || transfer.signer === owner.toLowerCase()) continue;

    const kind = classifyFabrication(transfer, tokensTheOwnerHasSigned);
    spoofKind[kind]++;

    if (kind === "tokenTheyHaveUsed" && ambiguous.length < 12) {
      ambiguous.push({
        owner,
        token: transfer.token,
        value: transfer.value.toString(),
        signer: transfer.signer,
        txHash: transfer.txHash,
      });
    }
  }

  const now = Math.max(...scan.transfers.map((t) => t.at), 0);
  const verdicts = scan.history.map((entry) =>
    assessAddress({to: entry.address, history: scan.history, now}),
  );

  const danger = verdicts.filter((v) => v.level === "danger");
  const caution = verdicts.filter((v) => v.level === "caution");

  for (const verdict of verdicts) {
    counterparties++;
    const codes = verdict.findings.map((f) => f.code);
    for (const code of codes) byCode.set(code, (byCode.get(code) ?? 0) + 1);

    if (verdict.level === "safe") continue;
    flagged++;

    if (codes.some((code) => FACT_CODES.has(code))) factFlagged++;
    else if (codes.some((code) => !BASELINE_CODES.has(code))) heuristicFlagged++;
  }

  wallets.push({
    owner,
    transfers: scan.transfers.length,
    counterparties: scan.history.length,
    danger: danger.length,
    caution: caution.length,
    /** Warnings that rest on a fact rather than an inference. */
    fabricated: scan.history.filter((entry) => entry.spoofedOutgoingCount > 0).length,
    dangerDetail: danger.slice(0, 5).map((v) => ({
      address: v.address,
      score: v.score,
      codes: v.findings.map((f) => f.code),
    })),
  });
}

process.stdout.write("\n\n");

// ---------------------------------------------------------------------------
// 3. What does a randomly chosen wallet actually see?
// ---------------------------------------------------------------------------

const scanned = wallets.length;
const quiet = wallets.filter((w) => w.danger === 0 && w.caution === 0).length;
const anyDanger = wallets.filter((w) => w.danger > 0).length;
const totalDanger = wallets.reduce((n, w) => n + w.danger, 0);
const totalCaution = wallets.reduce((n, w) => n + w.caution, 0);

console.log(`Scanned ${scanned} wallets, ${counterparties} counterparties between them.\n`);
console.log(`Per counterparty:`);
console.log(`  flagged at all          ${flagged} (${pct(flagged, counterparties)})`);
console.log(`    on a fact             ${factFlagged} (${pct(factFlagged, counterparties)})`);
console.log(`    on a heuristic        ${heuristicFlagged} (${pct(heuristicFlagged, counterparties)})`);
console.log(`  danger                  ${totalDanger} (${pct(totalDanger, counterparties)})`);
console.log(`  caution                 ${totalCaution} (${pct(totalCaution, counterparties)})`);

console.log(`\nPer wallet:`);
console.log(`  saw nothing at all      ${quiet} (${pct(quiet, scanned)})`);
console.log(`  saw at least one danger ${anyDanger} (${pct(anyDanger, scanned)})`);

console.log(`\nFindings, by how often they fired:`);
for (const [code, count] of [...byCode.entries()].sort((a, b) => b[1] - a[1])) {
  const kind = FACT_CODES.has(code) ? "fact" : BASELINE_CODES.has(code) ? "baseline" : "heuristic";
  console.log(`  ${code.padEnd(30)} ${String(count).padStart(5)}  ${kind}`);
}

/**
 * The analytical check.
 *
 * A lookalike needs four leading and four trailing hex characters to match: 32 bits. For a wallet
 * with `n` counterparties the expected number of chance collisions is about n^2 / 2^33, so a
 * warning that fires is essentially never a coincidence. Worth stating and worth checking, since
 * the whole heuristic rests on it.
 */
const expectedChance = wallets.reduce((sum, w) => sum + (w.counterparties ** 2) / 2 ** 33, 0);
console.log(
  `\nExpected chance lookalike collisions across this sample: ${expectedChance.toFixed(6)}`,
);
console.log(`Observed lookalike findings: ${byCode.get("lookalike-of-known-payee") ?? 0}`);

const report = {
  scannedAt: new Date().toISOString(),
  sampledFrom: {fromBlock: from, toBlock: to, token: "USDT"},
  historyWindow: {fromBlock: Number(historyFrom), toBlock: Number(historyTo)},
  wallets: scanned,
  counterparties,
  perCounterparty: {
    flagged,
    onAFact: factFlagged,
    onAHeuristic: heuristicFlagged,
    danger: totalDanger,
    caution: totalCaution,
  },
  perWallet: {quiet, withAnyDanger: anyDanger},
  findings: Object.fromEntries(byCode),
  fabricatedRecords: {...spoofKind, ambiguousSample: ambiguous},
  expectedChanceCollisions: expectedChance,
  detail: wallets,
};

await mkdir(dataDir, {recursive: true});
const path = join(dataDir, "false-positives.json");
await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nWrote ${path}`);

function pct(n, d) {
  return d === 0 ? "0%" : `${((n / d) * 100).toFixed(1)}%`;
}
