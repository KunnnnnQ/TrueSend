/**
 * Which kinds of account actually appear as the sender of a token transfer?
 *
 *   node src/account-kinds.mjs [--blocks 25] [--check]
 *
 * The detector compares the owner against `tx.from`. That comparison is only meaningful for an
 * account that signs, and EIP-7702 settles which do in the protocol rather than by convention:
 * accounts *"whose code is a valid delegation indicator, i.e. `0xef0100 || address`"* may
 * originate transactions, and *"accounts with any other code values may not originate
 * transactions."*
 *
 * So there are three kinds, and both ways of getting them wrong are expensive:
 *
 *   - call a **contract account** an EOA and every payment it ever made reads as unsigned. That
 *     is not a degraded result. `assessAddress` builds its payee set from `outgoingCount > 0` and
 *     the lookalike rule only compares against that set, so the rule cannot fire at all;
 *   - call a **delegated EOA** a contract and the signer test is dropped for an account that does
 *     sign — which would mean dropping it for precisely the users this project asks to install a
 *     delegation, since `GuardedAccount` is one.
 *
 * The second is the reason `classifyAccount` matches the designator exactly instead of asking
 * whether the account has code at all. This script measures how much that distinction is worth
 * against live mainnet rather than arguing it.
 *
 * Writes `data/account-kinds.json`.
 */

import {writeFile, mkdir} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

import {classifyAccount} from "@truesend/chain";

import {RECENT_ENDPOINTS, TOKENS, TRANSFER_TOPIC, addressFromTopic, createClient} from "./rpc.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}
const BLOCKS = Number(args.get("blocks") ?? 25);
const CHECK = process.argv.includes("--check");

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "data");

const rpc = createClient(RECENT_ENDPOINTS);

const head = await rpc.blockNumber();
const toBlock = head - 5;
const fromBlock = toBlock - BLOCKS + 1;

console.log(`USDT and USDC transfers, blocks ${fromBlock}..${toBlock}\n`);

const logs = [];
for (const token of [TOKENS.USDT, TOKENS.USDC]) {
  logs.push(
    ...(await rpc.getLogsRange({address: token, topics: [TRANSFER_TOPIC]}, fromBlock, toBlock, {
      chunk: 10,
    })),
  );
}

const senders = [
  ...new Set(logs.filter((log) => log.topics.length === 3).map((log) => addressFromTopic(log.topics[1]))),
];
const codes = await rpc.batch("eth_getCode", senders.map((a) => [a, "latest"]), {chunkSize: 100});

const tally = {eoa: 0, "delegated-eoa": 0, contract: 0};
const examples = {};

senders.forEach((address, i) => {
  const kind = classifyAccount(codes[i]);
  tally[kind]++;
  if (!examples[kind]) examples[kind] = {address, code: (codes[i] ?? "0x").slice(0, 52)};
});

console.log(`${senders.length} distinct addresses named as the sender of a transfer:\n`);
for (const [kind, count] of Object.entries(tally)) {
  console.log(`  ${kind.padEnd(14)} ${String(count).padStart(5)}  ${pct(count, senders.length)}`);
}

console.log(`\nOne of each, live, so the classifier is checked against the chain and not a fixture:`);
for (const [kind, example] of Object.entries(examples)) {
  console.log(`  ${kind.padEnd(14)} ${example.address}`);
  console.log(`  ${" ".repeat(14)} code ${example.code}${example.code.length >= 52 ? "…" : ""}`);
}

/**
 * What the shares do and do not say.
 *
 * `delegated-eoa` is exact: a delegation designator only ever sits on an EOA, so that share is
 * the share of senders running EIP-7702 — and the size of the mistake that reading "has code" as
 * "is a contract" would have made.
 *
 * `contract` is an upper bound on smart *wallets*. Every pool, router and vault that appears as a
 * sender inside somebody else's transaction lands in it too, and those were never anybody's
 * address book entry. The figure worth quoting for smart wallets is the ERC-4337 one in
 * `authorised-movements.mjs`, which counts accounts whose transfers arrived through the
 * EntryPoint.
 */
console.log(`\n  ${pct(tally["delegated-eoa"], senders.length)} are delegated EOAs: accounts that`);
console.log(`  have code and still sign. Reading "has code" as "is a contract" would have dropped`);
console.log(`  the signer test for every one of them.`);
console.log(`\n  The contract share is an upper bound on smart wallets — pools, routers and vaults`);
console.log(`  appear as senders too, and none of those is anybody's address book entry.`);

const report = {
  scannedAt: new Date().toISOString(),
  range: {fromBlock, toBlock, blocks: BLOCKS},
  tokens: ["USDT", "USDC"],
  distinctSenders: senders.length,
  kinds: tally,
  shares: Object.fromEntries(
    Object.entries(tally).map(([kind, n]) => [kind, n / senders.length]),
  ),
  examples,
};

await mkdir(dataDir, {recursive: true});
const path = join(dataDir, "account-kinds.json");
await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nWrote ${path}`);

if (CHECK) {
  const problems = [];

  if (senders.length === 0) problems.push("no senders found at all — the scan did not run");

  // If this ever reads zero, either the classifier stopped recognising the designator or 7702
  // fell out of use. Both are worth failing a build over, because the engine's treatment of
  // these accounts depends on telling them apart.
  if (tally["delegated-eoa"] === 0) {
    problems.push(
      "not one EIP-7702 delegated account among the senders, which contradicts every previous " +
        "run — check that classifyAccount still recognises 0xef0100 before believing it",
    );
  }
  if (tally.contract === 0) {
    problems.push("not one contract account among the senders, which is not a plausible sample");
  }

  if (problems.length) {
    console.log("\nFAILED:");
    for (const problem of problems) console.log(`  - ${problem}`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

function pct(n, d) {
  return d === 0 ? "0%" : `${((n / d) * 100).toFixed(1)}%`;
}
