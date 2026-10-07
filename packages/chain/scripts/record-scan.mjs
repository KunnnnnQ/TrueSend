/**
 * Record what a real endpoint says about one account over one block range, so a test can replay
 * the Scan screen on it with no network.
 *
 *   node scripts/record-scan.mjs <owner> <fromBlock> <toBlock> <out.json> [rpc]
 *
 * Reads the chain itself rather than wrapping `scanHistory`. A recording made through the code
 * under test inherits its mistakes: a range it never asked about would be missing from the
 * recording too, and the replay would agree with the bug. So this asks for the whole range at
 * once, every transfer to and from the owner, then who signed each transaction and when each block
 * was, and `test/fixtures/` holds the answers.
 *
 * Refuses to write anything partial. A lookup that still fails after its retries aborts the run,
 * because a fixture with a hole in it is the silent gap the replay exists to catch.
 */

import {writeFile} from "node:fs/promises";
import {parseAbiItem} from "viem";

import {DEFAULT_RPC, createChainClient, readTokenIdentities, splitOnRefusal} from "../dist/index.js";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

const [ownerArg, fromArg, toArg, out, rpc = DEFAULT_RPC[1]] = process.argv.slice(2);
if (!ownerArg || !fromArg || !toArg || !out) {
  console.error("usage: node scripts/record-scan.mjs <owner> <fromBlock> <toBlock> <out.json> [rpc]");
  process.exit(2);
}

const owner = ownerArg.toLowerCase();
const range = {fromBlock: BigInt(fromArg), toBlock: BigInt(toArg)};
const client = createChainClient(rpc);

/** Ask again, more slowly each time; give up loudly rather than leave a gap. */
async function patiently(what, ask) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await ask();
    } catch (error) {
      if (attempt === 5) throw new Error(`${what}: ${error instanceof Error ? error.message : error}`);
      await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
    }
  }
}

async function eachSlowly(keys, ask) {
  const answers = new Map();
  for (const key of keys) answers.set(key, await patiently(String(key), () => ask(key)));
  return answers;
}

const logs = new Map();
for (const args of [{from: owner}, {to: owner}]) {
  const found = await patiently(`logs ${JSON.stringify(args)}`, () =>
    splitOnRefusal(range, (part) => client.getLogs({event: TRANSFER, args, ...part})),
  );
  for (const log of found) {
    if (!log.args.from || !log.args.to || log.blockNumber === null || log.transactionHash === null) {
      throw new Error(`a log scanHistory would skip: ${log.transactionHash}:${log.logIndex}`);
    }
    logs.set(`${log.transactionHash}:${log.logIndex}`, {
      token: log.address.toLowerCase(),
      from: log.args.from.toLowerCase(),
      to: log.args.to.toLowerCase(),
      value: String(log.args.value ?? 0n),
      blockNumber: Number(log.blockNumber),
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
      ...(log.blockTimestamp === undefined ? {} : {blockTimestamp: Number(log.blockTimestamp)}),
    });
  }
}

const sorted = [...logs.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
const hashes = [...new Set(sorted.map((log) => log.transactionHash))];
const blocks = [...new Set(sorted.map((log) => log.blockNumber))];

const signers = await eachSlowly(hashes, async (hash) => (await client.getTransaction({hash})).from.toLowerCase());
const times = await eachSlowly(blocks, async (block) =>
  Number((await client.getBlock({blockNumber: BigInt(block), includeTransactions: false})).timestamp),
);
const code = (await patiently("code", () => client.getCode({address: owner}))) ?? "0x";
const tokens = await readTokenIdentities(client, [...new Set(sorted.map((log) => log.token))]);

// Some endpoints put the block's time on each log, and `scanHistory` then skips asking for the
// block. Recorded as one flag rather than per log — the time itself is in `blockTimes` — so the
// replay can serve it both ways. Where it was given, it has to agree with the block's own.
const carried = sorted.filter((log) => log.blockTimestamp !== undefined);
if (carried.length !== 0 && carried.length !== sorted.length) {
  throw new Error(`the endpoint timed ${carried.length} of ${sorted.length} logs; expected all or none`);
}
for (const log of carried) {
  if (log.blockTimestamp !== times.get(log.blockNumber)) {
    throw new Error(`log ${log.transactionHash}:${log.logIndex} disagrees with its block about the time`);
  }
}

const recording = {
  about:
    "Every answer a mainnet endpoint gave about this account over this range: its Transfer logs " +
    "both ways, who signed each transaction, when each block was, its code, and what each token " +
    "calls itself. Written by packages/chain/scripts/record-scan.mjs; replayed by the tests.",
  endpoint: rpc,
  recordedAt: new Date().toISOString().slice(0, 10),
  owner,
  fromBlock: Number(range.fromBlock),
  toBlock: Number(range.toBlock),
  code,
  logsCarryBlockTime: carried.length > 0,
  signers: Object.fromEntries(signers),
  blockTimes: Object.fromEntries([...times].map(([block, time]) => [String(block), time])),
  tokens,
  logs: sorted.map(({blockTimestamp: _carried, ...log}) => log),
};

// One log, one signer, one token to a line: the file is meant to be diffed and read, not only
// parsed. Built entry by entry rather than by reflowing `JSON.stringify` output, because token
// names are whatever the contract chose to return, braces included.
const fields = Object.entries(recording).map(([key, value]) => {
  const name = `  ${JSON.stringify(key)}: `;
  if (Array.isArray(value)) {
    return `${name}[\n${value.map((item) => `    ${JSON.stringify(item)}`).join(",\n")}\n  ]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
    return `${name}{\n${entries.join(",\n")}\n  }`;
  }
  return name + JSON.stringify(value);
});

await writeFile(out, `{\n${fields.join(",\n")}\n}\n`);
console.log(
  `${sorted.length} logs, ${hashes.length} transactions, ${blocks.length} blocks, ${tokens.length} tokens; ` +
    `${sorted.filter((log) => log.blockTimestamp !== undefined).length} logs carried their block's time. -> ${out}`,
);
