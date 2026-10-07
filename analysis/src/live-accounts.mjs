/**
 * The whole Scan screen, run on accounts being poisoned right now.
 *
 *   node src/live-accounts.mjs [--accounts 25] [--lookback 50000] [--max-transfers 2000]
 *
 * The token check, and the product run end to end, had been tried on one live account
 * (2026-09-26, `check-tokens.mjs`). This picks accounts that had a payment record fabricated in
 * their history in the last few hundred blocks — people being targeted today — and runs on each
 * exactly what the Scan screen runs: `scanHistory` over the app's own look-back, every counterparty
 * through `assessAddress`, and every token through `readTokenIdentities`, `inspectToken` and
 * `judgeToken` against the web app's own canonical list.
 *
 * What counts as right is settled by signatures, not by the rules under test:
 *
 *  - **Crying wolf at a real contact.** A counterparty the account itself signed a payment to is
 *    somebody it chose to pay. Every warning on one is listed.
 *  - **Crying wolf at a real token.** A token the account itself signed a transfer of is one it
 *    chose to hold. Every one judged counterfeit or unusual is listed.
 *  - **Planted tokens let through.** A token whose every transfer in the history was planted — sent
 *    "from" the account in a transaction it did not sign, or a zero-value transfer in — and that the
 *    check calls clean is listed, with what it calls itself, for a reader to judge.
 *
 * Accounts too active to scan in the time a user would wait (`--max-transfers`) are counted and
 * skipped, never silently dropped. Account addresses are left out of the output; every listed finding
 * carries a transaction hash, which is enough to check it on an explorer.
 *
 * Writes `data/live-accounts.json`.
 */

import {mkdir, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

import {createChainClient, readTokenIdentities, scanHistory} from "@truesend/chain";
import {MIN_AFFIX_MATCH, assessAddress, inspectToken, judgeToken} from "@truesend/engine";

import {
  ARCHIVE_ENDPOINTS,
  RECENT_ENDPOINTS,
  TOKENS,
  TRANSFER_TOPIC,
  addressFromTopic,
  createClient,
  topicFor,
} from "./rpc.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}
const ACCOUNTS = Number(args.get("accounts") ?? 25);
/** `DEFAULT_LOOKBACK` in apps/web/src/app/page.tsx. */
const LOOKBACK = BigInt(args.get("lookback") ?? 50_000);
const MAX_TRANSFERS = Number(args.get("max-transfers") ?? 2_000);
/** Where the accounts are drawn from: recent enough that they are being poisoned now. */
const SAMPLE_BLOCKS = 300;

/** Mirrors mainnet's `KNOWN_TOKENS` in apps/web/src/lib/chains.ts, as `poison-hunter.mjs` does. */
const KNOWN_TOKENS = [
  {address: TOKENS.USDT, symbol: "USDT", decimals: 6, dustBelow: 1},
  {address: TOKENS.USDC, symbol: "USDC", decimals: 6, dustBelow: 1},
  {address: TOKENS.WBTC, symbol: "WBTC", decimals: 8, dustBelow: 0.0001},
];
const CANONICAL = KNOWN_TOKENS.map((t) => ({symbol: t.symbol, address: t.address}));

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "data");
const rpc = createClient([...ARCHIVE_ENDPOINTS, ...RECENT_ENDPOINTS]);
const client = createChainClient(ARCHIVE_ENDPOINTS[0]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 1. Accounts somebody fabricated a payment record for, in the last few hundred blocks.
// ---------------------------------------------------------------------------

const head = BigInt(await rpc.blockNumber()) - 5n;
const sampleFrom = Number(head) - SAMPLE_BLOCKS + 1;
console.log(`Drawing accounts from USDT and USDC zero-value transfers in blocks ${sampleFrom}..${head}`);

const zeroValue = [];
for (const token of [TOKENS.USDT, TOKENS.USDC]) {
  const logs = await rpc.getLogsRange({address: token, topics: [TRANSFER_TOPIC]}, sampleFrom, Number(head), {chunk: 100});
  for (const log of logs) {
    if (log.topics.length !== 3 || BigInt(log.data || "0x0") !== 0n) continue;
    zeroValue.push({tx: log.transactionHash, from: addressFromTopic(log.topics[1])});
  }
}
const txs = [...new Set(zeroValue.map((t) => t.tx))];
const fetched = await rpc.batch("eth_getTransactionByHash", txs.map((hash) => [hash]), {chunkSize: 100});
const signerOf = new Map(txs.map((hash, i) => [hash, fetched[i]?.from?.toLowerCase()]));
const targeted = [...new Set(zeroValue.filter((t) => signerOf.get(t.tx) && signerOf.get(t.tx) !== t.from).map((t) => t.from))];

// Fisher–Yates, so the sample is not biased towards whichever bot ran first in the window.
for (let i = targeted.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [targeted[i], targeted[j]] = [targeted[j], targeted[i]];
}
console.log(`  ${targeted.length} accounts had a payment record fabricated; scanning up to ${ACCOUNTS}\n`);

// ---------------------------------------------------------------------------
// 2. Each one, as the Scan screen would.
// ---------------------------------------------------------------------------

const range = {fromBlock: head - LOOKBACK, toBlock: head};

/**
 * How many transfers the scan would have to resolve, counted cheaply first and abandoned as soon
 * as it passes the cap. An exchange's hot wallet is poisoned too, but scanning one means resolving
 * tens of thousands of signers, and the honest thing is to count it as skipped rather than let one
 * account decide how long the measurement takes.
 */
async function tooActive(account) {
  let seen = 0;
  for (let start = range.fromBlock; start <= range.toBlock; start += 10_000n) {
    const end = start + 9_999n > range.toBlock ? range.toBlock : start + 9_999n;
    for (const topics of [[TRANSFER_TOPIC, topicFor(account)], [TRANSFER_TOPIC, null, topicFor(account)]]) {
      const logs = await rpc.getLogsRange({topics}, Number(start), Number(end), {chunk: 10_000});
      seen += logs.filter((log) => log.topics.length === 3).length;
      if (seen > MAX_TRANSFERS) return true;
    }
  }
  return false;
}

const results = [];
let skipped = 0;
let failed = 0;

for (const account of targeted) {
  if (results.length >= ACCOUNTS) break;
  const label = `[${String(results.length + 1).padStart(2)}/${ACCOUNTS}]`;
  try {
    if (await tooActive(account)) {
      skipped++;
      console.log(`${label} skipped: more than ${MAX_TRANSFERS} transfers in the look-back`);
      continue;
    }

    const scan = await scanHistory(client, account, range, {knownTokens: KNOWN_TOKENS});
    const now = Math.max(...scan.transfers.map((t) => t.at), 0);
    const owner = scan.owner;

    // Ground truth from signatures alone.
    const signedPayments = scan.transfers.filter((t) => t.from === owner && t.signer === owner && t.value > 0n);
    const chosePayees = new Map(signedPayments.map((t) => [t.to, t.txHash]));
    const choseTokens = new Set(scan.transfers.filter((t) => t.from === owner && t.signer === owner).map((t) => t.token));
    const isPlanted = (t) => (t.from === owner && t.signer !== owner) || (t.to === owner && t.value === 0n);

    // Every counterparty, as the Scan screen scores it.
    const verdicts = scan.history.map((entry) => assessAddress({to: entry.address, history: scan.history, now}));
    const levels = {danger: 0, caution: 0, safe: 0};
    let lookalikes = 0;
    let endOnly = 0;
    const alarmsOnContacts = [];
    for (const v of verdicts) {
      levels[v.level]++;
      if (v.resembles) {
        lookalikes++;
        if (v.resembles.sharedPrefix < MIN_AFFIX_MATCH) endOnly++;
      }
      const address = v.address.toLowerCase();
      if (chosePayees.has(address) && v.level !== "safe") {
        alarmsOnContacts.push({
          counterparty: address,
          level: v.level,
          score: v.score,
          codes: v.findings.map((f) => f.code),
          signedPaymentTx: chosePayees.get(address),
        });
      }
    }

    // Every token, as the Scan screen judges it.
    const identities = await readTokenIdentities(client, scan.tokensSeen);
    const tokens = {counterfeit: 0, unusual: 0, clean: 0, unread: 0};
    const alarmsOnHeldTokens = [];
    const plantedButClean = [];
    for (const identity of identities) {
      const address = identity.address.toLowerCase();
      const own = scan.transfers.filter((t) => t.token === address);
      const planted = own.filter(isPlanted).length;

      if (identity.symbol === null) {
        tokens.unread++;
        continue;
      }
      const findings = inspectToken(
        {symbol: identity.symbol, address: identity.address, ...(identity.name ? {name: identity.name} : {})},
        {canonical: CANONICAL},
      );
      const verdict = findings.length === 0 ? "clean" : judgeToken(findings, planted);
      tokens[verdict]++;

      if (verdict !== "clean" && choseTokens.has(address)) {
        alarmsOnHeldTokens.push({token: address, symbol: identity.symbol, verdict, issues: findings.map((f) => f.issue), tx: own.find((t) => t.from === owner && t.signer === owner)?.txHash});
      }
      if (verdict === "clean" && own.length > 0 && planted === own.length) {
        plantedButClean.push({token: address, symbol: identity.symbol, name: identity.name, transfers: own.length, tx: own[0].txHash});
      }
    }

    results.push({
      transfers: scan.transfers.length,
      counterparties: scan.history.length,
      levels,
      lookalikes,
      lookalikesOnTheEndAlone: endOnly,
      contactsTheAccountPaid: chosePayees.size,
      alarmsOnContacts,
      tokens,
      tokensTheAccountMoved: choseTokens.size,
      alarmsOnHeldTokens,
      plantedButClean,
    });
    console.log(`${label} ${String(scan.transfers.length).padStart(5)} transfers  ` +
      `danger ${levels.danger} caution ${levels.caution} safe ${levels.safe}  ` +
      `tokens: ${tokens.counterfeit} counterfeit, ${tokens.unusual} unusual, ${tokens.clean} clean, ${tokens.unread} unread  ` +
      `| contacts warned ${alarmsOnContacts.length}/${chosePayees.size}, held tokens flagged ${alarmsOnHeldTokens.length}, planted-but-clean ${plantedButClean.length}`);
  } catch (error) {
    failed++;
    console.log(`${label} failed: ${String(error?.shortMessage ?? error?.message ?? error).slice(0, 120)}`);
    await sleep(15_000);
  }
}

// ---------------------------------------------------------------------------
// 3. Across all of them.
// ---------------------------------------------------------------------------

const sum = (pick) => results.reduce((total, r) => total + pick(r), 0);
const summary = {
  accountsScanned: results.length,
  skippedAsTooActive: skipped,
  failed,
  transfers: sum((r) => r.transfers),
  counterparties: sum((r) => r.counterparties),
  levels: {danger: sum((r) => r.levels.danger), caution: sum((r) => r.levels.caution), safe: sum((r) => r.levels.safe)},
  lookalikes: sum((r) => r.lookalikes),
  lookalikesOnTheEndAlone: sum((r) => r.lookalikesOnTheEndAlone),
  contactsTheAccountsPaid: sum((r) => r.contactsTheAccountPaid),
  contactsWarnedAbout: sum((r) => r.alarmsOnContacts.length),
  tokens: {
    counterfeit: sum((r) => r.tokens.counterfeit),
    unusual: sum((r) => r.tokens.unusual),
    clean: sum((r) => r.tokens.clean),
    unread: sum((r) => r.tokens.unread),
  },
  tokensTheAccountsMoved: sum((r) => r.tokensTheAccountMoved),
  heldTokensFlagged: sum((r) => r.alarmsOnHeldTokens.length),
  plantedTokensCalledClean: sum((r) => r.plantedButClean.length),
};

console.log(`\n${summary.accountsScanned} accounts scanned, ${skipped} skipped as too active, ${failed} failed`);
console.log(`  ${summary.counterparties} counterparties: danger ${summary.levels.danger}, caution ${summary.levels.caution}, safe ${summary.levels.safe}`);
console.log(`  lookalike findings ${summary.lookalikes}, of which on the end alone ${summary.lookalikesOnTheEndAlone}`);
console.log(`  contacts the accounts signed payments to: ${summary.contactsTheAccountsPaid}, warned about: ${summary.contactsWarnedAbout}`);
console.log(`  tokens: counterfeit ${summary.tokens.counterfeit}, unusual ${summary.tokens.unusual}, clean ${summary.tokens.clean}, unread ${summary.tokens.unread}`);
console.log(`  tokens the accounts moved themselves: ${summary.tokensTheAccountsMoved}, flagged: ${summary.heldTokensFlagged}`);
console.log(`  tokens with every transfer planted that the check called clean: ${summary.plantedTokensCalledClean}`);

for (const r of results) {
  for (const a of r.alarmsOnContacts) console.log(`    contact warned: ${a.level} ${a.score} ${a.codes.join(", ")}  paid in ${a.signedPaymentTx}`);
  for (const a of r.alarmsOnHeldTokens) console.log(`    held token flagged: ${a.verdict} ${JSON.stringify(a.symbol)} ${a.issues.join(", ")}  moved in ${a.tx}`);
  for (const p of r.plantedButClean) console.log(`    planted but clean: ${JSON.stringify(p.symbol)} ${JSON.stringify(p.name)} ${p.transfers} transfers  e.g. ${p.tx}`);
}

await mkdir(dataDir, {recursive: true});
await writeFile(
  join(dataDir, "live-accounts.json"),
  `${JSON.stringify({scannedAt: new Date().toISOString(), drawnFrom: {fromBlock: sampleFrom, toBlock: Number(head)}, lookbackBlocks: Number(LOOKBACK), summary, accounts: results}, null, 2)}\n`,
);
console.log("\nwrote data/live-accounts.json");
