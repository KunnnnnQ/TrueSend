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
 *     transaction they did not sign. That is checkable and it is either true or it is not;
 *   - a **heuristic**: lookalikes, zero-value and dust inbounds, timing. These are inferences and
 *     these are the ones that can be wrong;
 *   - a **baseline**: "you have never paid this address", which is true of every first payment
 *     anyone ever makes and is deliberately weighted to stay quiet.
 *
 * The facts are then checked against the chain rather than taken on trust. See `reconcile`.
 *
 * Writes `data/false-positives.json`.
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
import {reconcile} from "./reconcile.mjs";

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
/** Historical state lives only on the archive endpoint; a pruned node answers "missing trie node". */
const archive = createClient(ARCHIVE_ENDPOINTS);
const viemClient = createChainClient(ARCHIVE_ENDPOINTS[0]);

const FACT_CODES = new Set(["spoofed-outgoing-transfer"]);
const BASELINE_CODES = new Set(["no-history-at-all", "never-paid-before"]);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ---------------------------------------------------------------------------
// The objection that could sink the headline, and how it is settled.
// ---------------------------------------------------------------------------

/**
 * A `Transfer` log naming the user as sender, in a transaction somebody else signed, is either a
 * fabrication or a real movement a third party was authorised to make — an intent settlement
 * (CoW, UniswapX, 1inch Fusion) or an old approval being spent. Calling a solver an attacker is
 * exactly the false alarm that gets a safety tool switched off.
 *
 * This file used to decide it by asking whether the user had ever signed a transfer of that
 * token, reasoning that *"if you have never signed a transfer of a token, you never held it"*.
 * **That reasoning is wrong.** Receiving a token needs no signature. A wallet paid in USDC that
 * sold it through a gasless permit never signed anything touching USDC, and its USDC really left.
 * The old test filed that case under impossible, so the "0 of 354" it produced was in part a
 * property of the test rather than of the chain.
 *
 * `reconcile` replaces it by asking the token itself, and needs archive state to do so — which
 * the product does not have. It is ground truth here, used to score the rules below, which see
 * only what the product sees. `check-reconcile.mjs` calibrates it against two records whose
 * nature was already established.
 */

/**
 * Rules the *product* could apply, scored against the ground truth above.
 *
 * Each decides, from logs and signatures alone, whether a nonzero unsigned outgoing record is a
 * real movement to be left alone. Getting this wrong in one direction costs a false alarm; in the
 * other it waves an attack through, so the two are counted separately and never averaged.
 */
const RULES = [
  {
    name: "flag every unsigned transfer (what the product used to do)",
    callsReal: () => false,
  },
  {
    // Mirrors `tokensTheOwnerHasHeld` in packages/engine/src/history.ts exactly. If the two ever
    // drift, this row stops describing the thing that ships and quietly becomes fiction.
    name: "real if the owner has held the token — SHIPPED",
    callsReal: (record, seen) =>
      seen.signedTokens.has(record.token) || seen.receivedTokens.has(record.token),
  },
  {
    name: "real if they have signed a transfer of that token",
    callsReal: (record, seen) => seen.signedTokens.has(record.token),
  },
  {
    name: "real if they have ever received that token",
    callsReal: (record, seen) => seen.receivedTokens.has(record.token),
  },
  {
    name: "real if they have signed a transfer of it, or received it from someone who signed",
    callsReal: (record, seen) =>
      seen.signedTokens.has(record.token) || seen.attestedTokens.has(record.token),
  },
];

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

const nonZeroLogs = logs.filter((log) => BigInt(log.data || "0x0") > 0n);
const txs = [...new Set(nonZeroLogs.map((log) => log.transactionHash))];
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
    nonZeroLogs
      .filter((log) => signerOf.get(log.transactionHash) === addressFromTopic(log.topics[1]))
      .map((log) => addressFromTopic(log.topics[1])),
  ),
];

console.log(`  ${nonZeroLogs.length} real payments, ${payers.length} distinct self-signed payers`);

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

const truthTally = {zeroValue: 0, noBalance: 0, stateDisagrees: 0, stateAgrees: 0, unknown: 0};
const oldTest = {zeroValue: 0, tokenTheyHaveUsed: 0, tokenTheyNeverTouched: 0};
/** Records the old test called impossible that the chain says really moved. */
let oldTestWrong = 0;
const scored = Object.fromEntries(
  RULES.map((rule) => [rule.name, {cleared: 0, falseAlarm: 0, caught: 0, missed: 0}]),
);
const realMovements = [];
const factCheck = {right: 0, wrong: 0, unknown: 0};

for (const [index, owner] of chosen.entries()) {
  process.stdout.write(`\r  scanning ${index + 1}/${chosen.length}`);

  let scan;
  try {
    scan = await scanHistory(viemClient, owner, {fromBlock: historyFrom, toBlock: historyTo});
    // A measurement cannot use a scan with holes in it; until 2026-10-07 it could not even see them.
    if (scan.unchecked.length > 0) throw new Error(`${scan.unchecked.length} transfers could not be checked`);
  } catch (error) {
    console.log(`\n  ${owner}: scan failed (${error.message.slice(0, 60)}) — excluded`);
    continue;
  }

  const me = owner.toLowerCase();

  /** Every record that claims this wallet paid somebody, in a transaction it did not sign. */
  const unsigned = scan.transfers.filter(
    (t) => t.from === me && t.signer !== me && t.to !== me && t.to !== ZERO_ADDRESS,
  );

  // What the wallet's own logs would let the product know about each token.
  const signedTokens = new Set(
    scan.transfers.filter((t) => t.from === me && t.signer === me).map((t) => t.token),
  );
  const receivedTokens = new Set(
    scan.transfers.filter((t) => t.to === me && t.value > 0n).map((t) => t.token),
  );
  // Received from somebody who signed for it themselves: harder to fake than a bare log, since
  // the sender had to put their own signature behind it.
  const attestedTokens = new Set(
    scan.transfers
      .filter((t) => t.to === me && t.value > 0n && t.signer === t.from)
      .map((t) => t.token),
  );
  const seen = {signedTokens, receivedTokens, attestedTokens};

  const nonZero = unsigned.filter((t) => t.value > 0n);
  truthTally.zeroValue += unsigned.length - nonZero.length;
  oldTest.zeroValue += unsigned.length - nonZero.length;

  let truth = new Map();
  try {
    truth = await reconcile(archive, owner, nonZero);
  } catch (error) {
    console.log(`\n  ${owner}: reconciliation failed (${error.message.slice(0, 50)})`);
  }

  /** counterparty -> verdicts of every unsigned record naming it. */
  const perCounterparty = new Map();

  for (const record of nonZero) {
    const {verdict = "unknown", calling = null} = truth.get(record) ?? {};
    truthTally[verdict]++;

    const oldBucket = signedTokens.has(record.token) ? "tokenTheyHaveUsed" : "tokenTheyNeverTouched";
    oldTest[oldBucket]++;
    if (verdict === "stateAgrees" && oldBucket === "tokenTheyNeverTouched") oldTestWrong++;

    if (!perCounterparty.has(record.to)) perCounterparty.set(record.to, []);
    perCounterparty.get(record.to).push(verdict);

    if (verdict === "unknown") continue;

    const real = verdict === "stateAgrees";
    for (const rule of RULES) {
      const callsReal = rule.callsReal(record, seen);
      const cell = real ? (callsReal ? "cleared" : "falseAlarm") : callsReal ? "missed" : "caught";
      scored[rule.name][cell]++;
    }

    if (real && realMovements.length < 40) {
      realMovements.push({
        owner,
        token: record.token,
        value: record.value.toString(),
        to: record.to,
        signer: record.signer,
        calling,
        txHash: record.txHash,
        theWalletHasSignedThisToken: signedTokens.has(record.token),
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

    if (codes.some((code) => FACT_CODES.has(code))) {
      factFlagged++;
      // Is the "fact" true? Only if at least one record behind it really was fabricated.
      const records = perCounterparty.get(verdict.address.toLowerCase()) ?? [];
      const decided = records.filter((v) => v !== "unknown");
      if (records.length === 0) factCheck.right++; // a zero-value record, fabricated by definition
      else if (decided.length === 0) factCheck.unknown++;
      else if (decided.every((v) => v === "stateAgrees")) factCheck.wrong++;
      else factCheck.right++;
    } else if (codes.some((code) => !BASELINE_CODES.has(code))) {
      heuristicFlagged++;
    }
  }

  wallets.push({
    owner,
    transfers: scan.transfers.length,
    counterparties: scan.history.length,
    danger: danger.length,
    caution: caution.length,
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

// ---------------------------------------------------------------------------
// 4. Are the facts true?
// ---------------------------------------------------------------------------

const records = Object.values(truthTally).reduce((a, b) => a + b, 0);
const decided = records - truthTally.unknown;

console.log(`\nThe ${records} records that claim these wallets paid somebody without signing:`);
console.log(`  zero value, so nothing moved     ${truthTally.zeroValue}`);
console.log(`  the contract keeps no balances   ${truthTally.noBalance}`);
console.log(`  balances contradict the logs     ${truthTally.stateDisagrees}`);
console.log(`  value really left the wallet     ${truthTally.stateAgrees}`);
console.log(`  could not be checked             ${truthTally.unknown}`);
console.log(
  `\n  fabricated ${decided - truthTally.stateAgrees} of ${decided} checked ` +
    `(${pct(decided - truthTally.stateAgrees, decided)})`,
);

console.log(`\nThe test this file used to use, scored against that:`);
console.log(`  it called ${oldTest.tokenTheyNeverTouched} records impossible-to-be-a-settlement,`);
console.log(`  of which ${oldTestWrong} really did move value.`);

console.log(`\nWarnings that rest on a fact, checked:`);
console.log(`  the record really was fabricated ${factCheck.right}`);
console.log(`  value really moved — false alarm ${factCheck.wrong}`);
console.log(`  undecided                        ${factCheck.unknown}`);

console.log(`\nRules the product could use instead, scored on the ${decided} checked records:`);
console.log(`  ${"".padEnd(62)}  left alone   false alarm   caught   MISSED`);
for (const rule of RULES) {
  const s = scored[rule.name];
  console.log(
    `  ${rule.name.padEnd(62)}  ${String(s.cleared).padStart(10)}   ${String(s.falseAlarm).padStart(11)}   ` +
      `${String(s.caught).padStart(6)}   ${String(s.missed).padStart(6)}`,
  );
}
console.log(`\n  "MISSED" is a fabrication the rule would wave through. It has to stay at zero;`);
console.log(`  a false alarm costs trust, a miss costs the user their money.`);

/**
 * The analytical check.
 *
 * A both-ends lookalike needs four leading and four trailing hex characters to match: 32 bits. For a
 * wallet with `n` counterparties the expected number of chance collisions is about n^2 / 2^33, so a
 * warning that fires is essentially never a coincidence. Worth stating and worth checking, since
 * the whole heuristic rests on it. The engine's end-only rule (seven trailing characters, 28 bits)
 * multiplies that by about sixteen; it was checked against fresh data in `suffix-rule.mjs` rather
 * than only argued for here.
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
  unsignedOutgoing: {
    ...truthTally,
    checked: decided,
    fabricated: decided - truthTally.stateAgrees,
    oldTest,
    oldTestCalledImpossibleButRealAnyway: oldTestWrong,
    realMovementSample: realMovements,
  },
  factWarnings: factCheck,
  rules: scored,
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
