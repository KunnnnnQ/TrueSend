/**
 * Does the shipped detector catch poisonings that somebody else found?
 *
 *   node src/poison-hunter.mjs [--limit 150] [--lookback 50000]
 *
 * Every other recall number in `analysis/` is measured on cases this project picked: the May 2024
 * WBTC loss, and lookalikes matched by our own scan, using rules written beside the detector they
 * test. This one is not. Guan and Li's Poison-Hunter (ACM CCS 2024) published 150 sample poisoning
 * transfers — 50 each of dust, zero-value and counterfeit-token attacks — and each names the
 * victim, the attacker's address, the genuine address it imitates, the transaction and the block.
 * None was chosen by us, and their detector and ours share no code.
 *
 * Method, for each case: rebuild the victim's history the way the Scan screen would have the moment
 * the bait landed — `scanHistory` from @truesend/chain over the app's own default look-back, 50,000
 * blocks (about a week), ending at the bait's block — then ask the engine about the attacker's
 * address, as Send would when the victim pasted it. Beside it, the same history read the naive way,
 * believing every log, and the genuine address as a control, which has to come back clean.
 *
 * The dataset is fetched from a pinned commit and checked against a hash rather than copied in: it
 * carries no licence, and pinning keeps the input from moving underneath the result. The output
 * keys each case by its transaction hash and leaves out the victims' addresses — the dataset
 * already has them, and this repo has no reason to become another list of them.
 *
 * Writes `data/poison-hunter.json`. Each victim's raw scan is cached in `.cache/poison-hunter/`
 * (gitignored), so an interrupted run resumes rather than starting again.
 */

import {createHash} from "node:crypto";
import {existsSync} from "node:fs";
import {mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

import {KNOWN_TOKENS, createChainClient, readTokenIdentities, scanHistory, splitOnRefusal} from "@truesend/chain";
import {
  MIN_AFFIX_MATCH,
  assessAddress,
  checkTokens,
  foldHistory,
  sharedPrefixLength,
  sharedSuffixLength,
} from "@truesend/engine";

import {ARCHIVE_ENDPOINTS, TRANSFER_TOPIC, addressFromTopic, topicFor} from "./rpc.mjs";

const DATASET = {
  source: "https://github.com/DS2L/Poison-Hunter",
  paper: "Guan and Li, Characterizing Ethereum Address Poisoning Attack, ACM CCS 2024",
  commit: "74ff6f7d14f196a7396d7aa0b88aecd9a3bd9ff0",
  file: "phishing_transfers_sample.csv",
  sha256: "1de4bf2aa0bdc02e8347eeedf5d843f32e83a3f8e0c7fd864fea1997726fcc84",
};

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}
const LIMIT = Number(args.get("limit") ?? Infinity);
/** `DEFAULT_LOOKBACK` in apps/web/src/app/page.tsx: the history a user who opens Scan gets. */
const LOOKBACK = BigInt(args.get("lookback") ?? 50_000);
/**
 * Victims scanned at once. Each scan already resolves eight transactions at a time, and the free
 * archive endpoint starts answering with an HTML error page well before four scans in parallel.
 */
const CONCURRENCY = Number(args.get("concurrency") ?? 2);
const ATTEMPTS = 4;

/**
 * The product's own list, so "dust" means here what it means in the product. This used to be a
 * copy kept in step by hand, and a copy that drifts stops measuring the thing that ships.
 */
const KNOWN = KNOWN_TOKENS[1] ?? [];

const LEVELS = ["danger", "caution", "safe"];

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "data");
const cacheDir = join(here, "..", ".cache", "poison-hunter");
const client = createChainClient(ARCHIVE_ENDPOINTS[0]);

// ---------------------------------------------------------------------------
// The cases, exactly as published.
// ---------------------------------------------------------------------------

async function loadCases() {
  const url = `https://raw.githubusercontent.com/DS2L/Poison-Hunter/${DATASET.commit}/${DATASET.file}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== DATASET.sha256) {
    throw new Error(`${DATASET.file} at ${DATASET.commit} hashes to ${digest}, not ${DATASET.sha256}`);
  }

  // Plain comma-separated, no quoting anywhere in the file. Rows carry two columns more than the
  // header names; only named columns are read, so their meaning is never guessed at.
  const [header, ...rows] = bytes.toString("utf8").trim().split(/\r?\n/).map((line) => line.split(","));
  const at = (row, name) => {
    const index = header.indexOf(name);
    if (index < 0) throw new Error(`${DATASET.file} has no column ${name}`);
    return row[index];
  };

  return rows.map((row, index) => ({
    // A batched bait plants hundreds of victims in one transaction, so the hash is not a key: 40
    // of the 150 rows share one with another row. The row number is.
    row: index + 1,
    txHash: at(row, "tx_hash").toLowerCase(),
    type: at(row, "phishing_type"),
    symbol: at(row, "symbol").toUpperCase(),
    attacker: at(row, "attacker").toLowerCase(),
    victim: at(row, "victim").toLowerCase(),
    imitated: at(row, "similar_norm").toLowerCase(),
    // Despite the name, this is the bait's token for every type: the real USDT or USDC for dust
    // and zero-value baits, the attacker's own contract for counterfeit ones.
    token: at(row, "fake_token_address").toLowerCase(),
    /** Who signed the bait: the planter, for every type but dust, where it is the attacker. */
    planter: at(row, "tx_from").toLowerCase(),
    block: BigInt(at(row, "block_number")),
  }));
}

// ---------------------------------------------------------------------------
// One victim's history, as the Scan screen would have built it.
// ---------------------------------------------------------------------------

/** A scan depends on whose history and where it ends — not on which bait sent us there. */
const cacheFile = (c) => join(cacheDir, `${c.victim}_${c.block}.json`);

async function scanVictim(c) {
  const file = cacheFile(c);
  if (existsSync(file)) return JSON.parse(await readFile(file, "utf8"));

  const range = {fromBlock: c.block - LOOKBACK, toBlock: c.block};
  const result = await scanHistory(client, c.victim, range, {knownTokens: KNOWN});
  // Refused before it is cached or scored; `runCase` scans the case again.
  if (result.unchecked.length > 0) throw new Error(`${result.unchecked.length} transfers could not be checked`);
  const baitBlock = await client.getBlock({blockNumber: c.block, includeTransactions: false});

  const scan = {
    owner: c.victim,
    range: {fromBlock: String(range.fromBlock), toBlock: String(range.toBlock)},
    baitAt: Number(baitBlock.timestamp),
    signersResolved: result.signersResolved,
    transfers: result.transfers.map((t) => ({...t, value: String(t.value)})),
  };
  await writeFile(file, JSON.stringify(scan));
  return scan;
}

/**
 * Why a bait is missing from the scan, when it is.
 *
 * The scan asks the node for `Transfer` logs whose indexed `from` or `to` is the victim. A bait
 * that never emitted such a log is invisible to it by construction — that is a blind spot of the
 * method, and it has to be told apart from a transfer that was there and got dropped on the way.
 */
async function baitShape(c) {
  const receipt = await client.getTransactionReceipt({hash: c.txHash});
  const victim = topicFor(c.victim);
  const transfers = receipt.logs.filter((log) => log.topics[0] === TRANSFER_TOPIC);
  if (transfers.some((log) => log.topics.length === 3 && log.topics.slice(1).includes(victim))) {
    return "an indexed Transfer naming the victim";
  }
  if (transfers.some((log) => log.topics.length < 3)) return "a Transfer with unindexed addresses";
  return "no Transfer log naming the victim";
}

/** Did the victim pay the genuine address, by any token, inside the window? Asked of the node directly. */
async function genuinePaymentsInWindow(c, range) {
  const logs = await client.request({
    method: "eth_getLogs",
    params: [{
      fromBlock: `0x${BigInt(range.fromBlock).toString(16)}`,
      toBlock: `0x${BigInt(range.toBlock).toString(16)}`,
      topics: [TRANSFER_TOPIC, topicFor(c.victim), topicFor(c.imitated)],
    }],
  });
  return logs.length;
}

/**
 * Shares enough with `b` to be imitating it.
 *
 * Looser than the engine's four-and-four on purpose: this explains a verdict after the fact rather
 * than making one, and the baits in this very dataset are mostly three-and-more. Seven matching
 * hex characters happen by chance about once in 270 million comparisons.
 */
const imitates = (a, b) => a !== b && sharedPrefixLength(a, b) >= 3 && sharedSuffixLength(a, b) >= 4;

/** The payees the victim really signed for in `from..to`, and how often — read from the node. */
async function signedPayeesBefore(c, from, to) {
  const logs = [];
  for (let start = from; start <= to; start += 50_000n) {
    const end = start + 49_999n > to ? to : start + 49_999n;
    logs.push(
      ...(await splitOnRefusal({fromBlock: start, toBlock: end}, (part) =>
        client.request({
          method: "eth_getLogs",
          params: [{
            topics: [TRANSFER_TOPIC, topicFor(c.victim)],
            fromBlock: `0x${part.fromBlock.toString(16)}`,
            toBlock: `0x${part.toBlock.toString(16)}`,
          }],
        }),
      )),
    );
  }
  const candidates = logs.filter((log) => log.topics.length === 3 && imitates(addressFromTopic(log.topics[2]), c.imitated));
  const paid = new Map();
  for (const log of candidates) {
    const tx = await client.getTransaction({hash: log.transactionHash});
    if (tx.from.toLowerCase() !== c.victim) continue;
    const to = addressFromTopic(log.topics[2]);
    paid.set(to, (paid.get(to) ?? 0) + 1);
  }
  return paid;
}

/**
 * Why a genuine address scored anything but safe — established, not argued.
 *
 * The control is whatever the dataset labels genuine (`similar_norm`). If the victim never signed a
 * payment to it, and every record naming it was signed by somebody else, it is not a payee this
 * history can vouch for, whatever its label says. Two checks then say what it is instead: which
 * payee the victim really did sign for it imitates — in the scanned week, then in the 300,000
 * blocks (about six weeks) before — and whether the records naming it were signed by addresses
 * that sign other baits in this same dataset. Only the counts are kept: the payee is the victim's.
 */
async function explainControl(c, scan, planters) {
  const records = scan.transfers.filter((t) => t.from === c.victim && t.to === c.imitated);
  const signers = new Set(records.map((t) => t.signer));
  const transfers = scan.transfers.map((t) => ({...t, value: BigInt(t.value)}));
  const inWeek = foldHistory(c.victim, transfers).filter((e) => e.outgoingCount > 0 && imitates(e.address, c.imitated));

  let realPayee;
  if (inWeek.length > 0) {
    realPayee = {where: "the scanned week", signedPayments: Math.max(...inWeek.map((e) => e.outgoingCount))};
  } else {
    const start = BigInt(scan.range.fromBlock);
    const earlier = await signedPayeesBefore(c, start - 300_000n, start - 1n);
    realPayee = earlier.size > 0
      ? {where: "the six weeks before", signedPayments: Math.max(...earlier.values())}
      : {where: "not found in seven weeks"};
  }

  return {
    recordsNamingIt: records.length,
    signedByVictim: records.filter((t) => t.signer === c.victim).length,
    signersWhoPlantOtherBaitsHere: [...signers].filter((s) => planters.has(s)).length,
    signers: signers.size,
    realPayeeItImitates: realPayee,
  };
}

// ---------------------------------------------------------------------------
// Scoring, the way Send would see it.
// ---------------------------------------------------------------------------

function verdict(assessment) {
  return {level: assessment.level, score: assessment.score, codes: assessment.findings.map((f) => f.code)};
}

function score(c, scan) {
  const transfers = scan.transfers.map((t) => ({...t, value: BigInt(t.value)}));
  // A naive indexer believes the log: a `Transfer` naming you as sender is a payment you made.
  const believed = transfers.map((t) => ({...t, signer: t.from}));

  const signerAware = foldHistory(c.victim, transfers);
  const naive = foldHistory(c.victim, believed);
  const now = scan.baitAt;

  const genuine = signerAware.find((entry) => entry.address === c.imitated);
  // The web app's own count, in apps/web/src/app/page.tsx: the account "sending" the token in a
  // transaction it did not sign, or a zero-value transfer of it in.
  const ofToken = transfers.filter((t) => t.token === c.token);
  const planted = ofToken.filter(
    (t) => (t.from === c.victim && t.signer !== c.victim) || (t.to === c.victim && t.value === 0n),
  ).length;

  return {
    transfers: transfers.length,
    baitToken: {transfers: ofToken.length, planted},
    // Held only until the token check below has run on it, then dropped: it carries the victim.
    _bait: {owner: c.victim, transfers: ofToken},
    // The hash alone would match any of the other transfers a batched bait carries.
    baitInScan: transfers.some(
      (t) =>
        t.txHash.toLowerCase() === c.txHash &&
        [t.from, t.to].includes(c.victim) &&
        [t.from, t.to].includes(c.attacker),
    ),
    imitatedWasPaid: (genuine?.outgoingCount ?? 0) > 0,
    affix: {
      prefix: sharedPrefixLength(c.attacker, c.imitated),
      suffix: sharedSuffixLength(c.attacker, c.imitated),
    },
    signerAware: verdict(assessAddress({to: c.attacker, history: signerAware, now})),
    naive: verdict(assessAddress({to: c.attacker, history: naive, now})),
    control: verdict(assessAddress({to: c.imitated, history: signerAware, now})),
  };
}

// ---------------------------------------------------------------------------

await mkdir(cacheDir, {recursive: true});
const cases = (await loadCases()).slice(0, LIMIT);
console.log(`${cases.length} cases from ${DATASET.source} @ ${DATASET.commit.slice(0, 7)}`);
console.log(`each scanned over ${LOOKBACK} blocks ending at its bait, via ${ARCHIVE_ENDPOINTS[0]}\n`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const describe = (error) =>
  [error?.shortMessage ?? error?.message ?? String(error), error?.details].filter(Boolean).join(" — ").slice(0, 240);

/**
 * One case, retried.
 *
 * This was written when `scanHistory` dropped a transfer whose signer it could not look up, and
 * the comment here called that "right for a user, wrong for a measurement". Only the second half
 * was true: for a user, the dropped transfer could be the bait, and the screen then called the
 * attacker fine without a word. The scan now returns what it could not check (`unchecked`), and
 * `scanVictim` refuses an incomplete scan outright. A bait that the chain shows as an ordinary
 * indexed `Transfer` but that is still absent is scanned again rather than scored, as before.
 */
async function runCase(c) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const scan = await scanVictim(c);
      const outcome = score(c, scan);
      if (!outcome.baitInScan) {
        outcome.baitShape = await baitShape(c);
        if (outcome.baitShape === "an indexed Transfer naming the victim" && attempt < ATTEMPTS) {
          await rm(cacheFile(c), {force: true});
          throw new Error("bait was on chain but dropped from the scan");
        }
      }
      if (!outcome.imitatedWasPaid) outcome.genuinePaymentsInWindow = await genuinePaymentsInWindow(c, scan.range);
      if (outcome.control.level !== "safe") outcome.controlExplained = await explainControl(c, scan, planters);
      return outcome;
    } catch (error) {
      lastError = error;
      if (attempt < ATTEMPTS) await sleep(15_000 * attempt);
    }
  }
  throw lastError;
}

/**
 * A row is a bait paired with one earlier payment it imitates, so a bait aimed at a payee the
 * victim had paid six times is six rows (rows 45–50 are one transfer). Each is scored, but only the
 * first row of each bait counts towards the tallies, so a repeated bait cannot count twice.
 */
/** Everyone who signed a bait in this dataset. */
const planters = new Set(cases.map((c) => c.planter));

const firstRow = new Map();
for (const c of cases) {
  const key = `${c.txHash}|${c.victim}|${c.attacker}`;
  if (!firstRow.has(key)) firstRow.set(key, c.row);
  c.duplicateOf = firstRow.get(key) === c.row ? undefined : firstRow.get(key);
}

const results = [];
const failures = [];
let cursor = 0;

async function worker() {
  while (cursor < cases.length) {
    const index = cursor++;
    const c = cases[index];
    const label = `[${String(index + 1).padStart(3)}/${cases.length}] ${c.type.padEnd(4)} ${c.symbol.padEnd(4)}`;
    try {
      const outcome = await runCase(c);
      results.push({
        index,
        row: c.row,
        ...(c.duplicateOf ? {duplicateOf: c.duplicateOf} : {}),
        txHash: c.txHash,
        type: c.type,
        symbol: c.symbol,
        block: Number(c.block),
        attacker: c.attacker,
        token: c.token,
        ...outcome,
      });
      const {level, score: points, codes} = outcome.signerAware;
      console.log(`${label} ${String(outcome.transfers).padStart(6)} transfers  ${level.padEnd(7)} ${String(points).padStart(3)}  ${codes.join(", ")}`);
    } catch (error) {
      failures.push({index, row: c.row, txHash: c.txHash, error: describe(error)});
      console.log(`${label} FAILED ${describe(error)}`);
    }
  }
}

await Promise.all(Array.from({length: Math.min(CONCURRENCY, cases.length)}, worker));
results.sort((a, b) => a.index - b.index);
failures.sort((a, b) => a.index - b.index);
for (const row of [...results, ...failures]) delete row.index;

// ---------------------------------------------------------------------------
// The other place a counterfeit-token bait meets the product: the token itself.
// ---------------------------------------------------------------------------

/**
 * A counterfeit-token bait is met twice. Once as a record on the attacker's row, scored above, and
 * once as a contract in Scan's counterfeit panel, which Send repeats when that contract's address
 * is pasted. The second is judged here exactly as the web app judges it: what the contract calls
 * itself, against the same canonical list, and how many of its transfers in this history were
 * planted. Names are read now, not at the bait's block — a contract's name is set once, but a
 * contract that has since self-destructed answers nothing and is counted as unread, not as clean.
 */
const CANONICAL = KNOWN.map((t) => ({symbol: t.symbol, address: t.address}));
const fakeTokens = [...new Set(results.filter((r) => r.type === "fake").map((r) => r.token))];
const identities = new Map(
  (await readTokenIdentities(client, fakeTokens)).map((identity) => [identity.address.toLowerCase(), identity]),
);
for (const r of results.filter((row) => row.type === "fake")) {
  const identity = identities.get(r.token) ?? {address: r.token, symbol: null, name: null};
  // The engine's own check, given only this token's records: whether the account ever held a
  // token is a question about that token's transfers alone, so nothing it decides is lost.
  const check = checkTokens(r._bait.owner, r._bait.transfers, [identity], {canonical: CANONICAL});
  const flagged = check.counterfeit[0] ?? check.unusual[0];
  r.tokenCheck = {
    symbol: identity.symbol,
    verdict: check.counterfeit.length ? "counterfeit" : check.unusual.length ? "unusual" : check.unreadable ? "unread" : "clean",
    issues: [...(flagged?.forged ? ["forged-transfers"] : []), ...(flagged?.findings ?? []).map((f) => f.issue)],
  };
}
for (const r of results) delete r._bait;

// ---------------------------------------------------------------------------
// Tallies. Misses are listed one by one rather than folded into a rate.
// ---------------------------------------------------------------------------

const baits = results.filter((r) => r.duplicateOf === undefined);
const tally = (mode, rows) => Object.fromEntries(LEVELS.map((l) => [l, rows.filter((r) => r[mode].level === l).length]));
const types = [...new Set(baits.map((r) => r.type))];
const byType = Object.fromEntries(types.map((type) => {
  const rows = baits.filter((r) => r.type === type);
  return [type, {baits: rows.length, signerAware: tally("signerAware", rows), naive: tally("naive", rows)}];
}));

const summary = {
  rows: results.length,
  baits: baits.length,
  failed: failures.length,
  signerAware: tally("signerAware", baits),
  naive: tally("naive", baits),
  control: tally("control", baits),
  byType,
  baitMissingFromScan: baits.filter((r) => !r.baitInScan).length,
  belowAffixFloor: baits.filter((r) => r.affix.prefix < MIN_AFFIX_MATCH || r.affix.suffix < MIN_AFFIX_MATCH).length,
  /** The control restricted to addresses the victim provably paid: the clean test of crying wolf. */
  controlWherePaid: tally("control", baits.filter((r) => r.imitatedWasPaid)),
  tokenCheck: Object.fromEntries(
    ["counterfeit", "unusual", "clean", "unread"].map((v) => [
      v,
      baits.filter((r) => r.type === "fake" && r.tokenCheck?.verdict === v).length,
    ]),
  ),
};

console.log(`\nAttacker's address, as Send would score it — ${summary.baits} distinct baits in ${summary.rows} rows`);
for (const mode of ["signerAware", "naive"]) {
  const t = summary[mode];
  console.log(`  ${mode.padEnd(12)} danger ${t.danger}  caution ${t.caution}  safe ${t.safe}   of ${summary.baits}`);
}
for (const [type, t] of Object.entries(byType)) {
  const s = t.signerAware;
  console.log(`    ${type.padEnd(5)} danger ${s.danger}  caution ${s.caution}  safe ${s.safe}   of ${t.baits}`);
}
console.log(`\nControl — the genuine address in the same history: danger ${summary.control.danger}  caution ${summary.control.caution}  safe ${summary.control.safe}`);
const cp = summary.controlWherePaid;
console.log(`  where the victim signed a payment to it in the week: danger ${cp.danger}  caution ${cp.caution}  safe ${cp.safe}`);
const tc = summary.tokenCheck;
console.log(`Counterfeit-token baits, the token itself: counterfeit ${tc.counterfeit}  unusual ${tc.unusual}  clean ${tc.clean}  unread ${tc.unread}`);
console.log(`Bait missing from the scan: ${summary.baitMissingFromScan}`);
console.log(`Below the ${MIN_AFFIX_MATCH}+${MIN_AFFIX_MATCH} lookalike floor: ${summary.belowAffixFloor}`);
if (failures.length) console.log(`Failed to scan: ${failures.length} (rerun to retry; finished cases are cached)`);

const misses = baits.filter((r) => r.signerAware.level === "safe");
if (misses.length) {
  console.log("\nEvery miss:");
  for (const r of misses) {
    console.log(`  row ${String(r.row).padStart(3)} ${r.txHash} ${r.type} affix ${r.affix.prefix}+${r.affix.suffix} paid-genuine ${r.imitatedWasPaid}` +
      `${r.baitInScan ? "" : ` bait-missing (${r.baitShape})`}  ${r.signerAware.codes.join(", ") || "no findings"}`);
  }
}

// A genuine payee flagged is the tool crying wolf, so these are listed as carefully as the misses.
const alarms = baits.filter((r) => r.control.level !== "safe");
if (alarms.length) {
  console.log("\nEvery genuine address that was not scored safe:");
  for (const r of alarms) {
    const x = r.controlExplained;
    console.log(`  row ${String(r.row).padStart(3)} ${r.type} ${r.control.level} ${r.control.score}  ${r.control.codes.join(", ")}`);
    console.log(`        ${x.recordsNamingIt} records name it, ${x.signedByVictim} signed by the victim, ` +
      `${x.signersWhoPlantOtherBaitsHere} of ${x.signers} signers plant other baits here; ` +
      `real payee it imitates: ${x.realPayeeItImitates.where}` +
      `${x.realPayeeItImitates.signedPayments ? ` (paid ${x.realPayeeItImitates.signedPayments}x)` : ""}`);
  }
}

await mkdir(dataDir, {recursive: true});
await writeFile(
  join(dataDir, "poison-hunter.json"),
  `${JSON.stringify({dataset: DATASET, lookbackBlocks: Number(LOOKBACK), endpoint: ARCHIVE_ENDPOINTS[0], ranAt: new Date().toISOString(), summary, failures, cases: results}, null, 2)}\n`,
);
console.log("\nwrote data/poison-hunter.json");
