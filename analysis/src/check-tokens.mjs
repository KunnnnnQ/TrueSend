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

import {KNOWN_TOKENS, LISTED_TOKENS, createChainClient, readTokenIdentities, scanHistory} from "@truesend/chain";
import {checkTokens, revealSymbol} from "@truesend/engine";

import {ARCHIVE_ENDPOINTS} from "./rpc.mjs";

const args = process.argv.slice(2);
const owner = args.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
const blocksArg = args.indexOf("--blocks");
const BLOCKS = BigInt(blocksArg >= 0 ? args[blocksArg + 1] : 100_000);
if (!owner) {
  console.error("usage: node src/check-tokens.mjs 0x<address> [--blocks 100000]");
  process.exit(2);
}

/** What the real ones are, on mainnet: the two tiers the web app passes, from the same package. */
const CANONICAL = (KNOWN_TOKENS[1] ?? []).map(({symbol, address}) => ({symbol, address}));
const LISTED = LISTED_TOKENS[1] ?? [];

const client = createChainClient(ARCHIVE_ENDPOINTS[0]);
const head = await client.getBlockNumber();
const fromBlock = head > BLOCKS ? head - BLOCKS : 0n;

console.log(`Account ${owner}\nblocks ${fromBlock}..${head}\n`);
const scan = await scanHistory(client, owner, {fromBlock, toBlock: head});
console.log(`${scan.transfers.length} transfers, ${scan.tokensSeen.length} distinct token contracts touched it\n`);
if (scan.unchecked.length > 0) {
  console.log(
    `${scan.unchecked.length} transfers could not be checked — the endpoint would not say who signed them, or when.\n` +
      `The planted and forged counts below leave them out; run it again for a complete answer.\n`,
  );
}

const started = Date.now();
const identities = await readTokenIdentities(client, scan.tokensSeen);
const seconds = ((Date.now() - started) / 1000).toFixed(1);

// The web app's own check, from the engine — not a copy of it.
const {counterfeit, unusual, unreadable, unanswered} = checkTokens(scan.owner, scan.transfers, identities, {
  canonical: CANONICAL,
  listed: LISTED,
});

console.log(
  `read ${identities.length - unreadable - unanswered} of ${identities.length} token identities in ${seconds}s ` +
    `(${unreadable} would not say${unanswered ? `, ${unanswered} the endpoint would not ask` : ""})`,
);
console.log(`counterfeit ${counterfeit.length}, unusual-but-not-planted ${unusual.length}
`);

for (const token of counterfeit) {
  console.log(`  ${token.address}   ${String(token.transfers).padStart(3)} transfers, ${token.planted} planted`);
  console.log(`    calls itself  ${token.symbol === "" ? "(no name)" : revealSymbol(token.symbol)}`);
  const why = [...(token.forged ? [`${token.forged} forged`] : []), ...token.findings.map((f) => f.issue)];
  console.log(`    because       ${why.join(", ")}`);
}
for (const token of unusual) {
  console.log(`  (unusual) ${token.address}  ${token.transfers} transfers  ${revealSymbol(token.symbol)}`);
}

const judged = new Set([...counterfeit, ...unusual].map((token) => token.address));
const clean = identities.filter((i) => i.symbol !== null && !judged.has(i.address));
console.log(`
not flagged (${clean.length}): ${clean.map((i) => JSON.stringify(i.symbol)).slice(0, 25).join(" ")}${clean.length > 25 ? " …" : ""}`);
