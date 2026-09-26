/**
 * Which tokens in an account's history are pretending to be something else?
 *
 *   node src/check-tokens.mjs 0x… [--blocks 100000]
 *
 * The token detector in `@truesend/engine` was, for a long time, tested and documented and called
 * by nothing: no screen, no indexer and no extension ever read a token's symbol, so none of them
 * could have run it. This is the whole path a user-facing flow needs — read the history, read what
 * every token in it calls itself, judge — run against a real account, so that the claim "it
 * catches counterfeit tokens" is one a command can check.
 *
 * Uses the built packages exactly as the web app does. Reads mainnet, so it needs an endpoint that
 * answers archive queries for anything older than a few days.
 */

import {createChainClient, readTokenIdentities, scanHistory} from "@truesend/chain";
import {inspectToken, judgeToken, revealSymbol} from "@truesend/engine";

import {ARCHIVE_ENDPOINTS} from "./rpc.mjs";

const args = process.argv.slice(2);
const owner = args.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
const blocksArg = args.indexOf("--blocks");
const BLOCKS = BigInt(blocksArg >= 0 ? args[blocksArg + 1] : 100_000);
if (!owner) {
  console.error("usage: node src/check-tokens.mjs 0x<address> [--blocks 100000]");
  process.exit(2);
}

/** What the real ones are, on mainnet. Same list as the web app's `KNOWN_TOKENS`. */
const CANONICAL = [
  {symbol: "USDT", address: "0xdac17f958d2ee523a2206206994597c13d831ec7"},
  {symbol: "USDC", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"},
  {symbol: "WBTC", address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599"},
];

const client = createChainClient(ARCHIVE_ENDPOINTS[0]);
const head = await client.getBlockNumber();
const fromBlock = head > BLOCKS ? head - BLOCKS : 0n;

console.log(`Account ${owner}\nblocks ${fromBlock}..${head}\n`);
const scan = await scanHistory(client, owner, {fromBlock, toBlock: head});
console.log(`${scan.transfers.length} transfers, ${scan.tokensSeen.length} distinct token contracts touched it\n`);

const started = Date.now();
const identities = await readTokenIdentities(client, scan.tokensSeen);
const seconds = ((Date.now() - started) / 1000).toFixed(1);

const unreadable = identities.filter((i) => i.symbol === null);
const counterfeit = [];
const unusual = [];

for (const identity of identities) {
  if (identity.symbol === null) continue;
  const findings = inspectToken(
    {symbol: identity.symbol, address: identity.address, ...(identity.name ? {name: identity.name} : {})},
    {canonical: CANONICAL},
  );
  if (findings.length === 0) continue;

  const own = scan.transfers.filter((t) => t.token === identity.address);
  // Planted, not merely present: the account "sending" it in a transaction it never signed, or a
  // zero-value transfer in. This is the same count the web app makes.
  const planted = own.filter(
    (t) => (t.from === scan.owner && t.signer !== scan.owner) || (t.to === scan.owner && t.value === 0n),
  ).length;

  const entry = {identity, findings, transfers: own.length, planted};
  (judgeToken(findings, planted) === "counterfeit" ? counterfeit : unusual).push(entry);
}

console.log(`read ${identities.length - unreadable.length} of ${identities.length} token identities in ${seconds}s (${unreadable.length} would not say)`);
console.log(`counterfeit ${counterfeit.length}, unusual-but-not-planted ${unusual.length}
`);

for (const {identity, findings, transfers, planted} of counterfeit.sort((a, b) => b.planted - a.planted || b.transfers - a.transfers)) {
  console.log(`  ${identity.address}   ${String(transfers).padStart(3)} transfers, ${planted} planted`);
  console.log(`    calls itself  ${revealSymbol(identity.symbol)}`);
  console.log(`    because       ${findings.map((f) => f.issue).join(", ")}`);
}
for (const {identity, transfers} of unusual) {
  console.log(`  (unusual) ${identity.address}  ${transfers} transfers  ${revealSymbol(identity.symbol)}`);
}

const judged = new Set([...counterfeit, ...unusual].map((e) => e.identity.address));
const clean = identities.filter((i) => i.symbol !== null && !judged.has(i.address));
console.log(`
not flagged (${clean.length}): ${clean.map((i) => JSON.stringify(i.symbol)).slice(0, 25).join(" ")}${clean.length > 25 ? " …" : ""}`);
