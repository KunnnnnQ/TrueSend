import {isAddress, type Address} from "viem";

import {DEFAULT_RPC, createChainClient, scanHistory} from "@truesend/chain";

import {createApi} from "./api.js";
import {channelsFromEnv} from "./notify.js";
import {Store} from "./store.js";
import {Watcher} from "./watcher.js";

const chainId = Number(process.env["CHAIN_ID"] ?? 31337);
const rpcUrl = process.env["RPC_URL"] ?? DEFAULT_RPC[chainId];
if (!rpcUrl) throw new Error(`Set RPC_URL: no default endpoint is known for chain ${chainId}.`);

const port = Number(process.env["PORT"] ?? 4000);
const appUrl = process.env["APP_URL"] ?? "http://localhost:3000";
const dbPath = process.env["DB_PATH"] ?? "truesend.db";
const pollSeconds = Number(process.env["POLL_SECONDS"] ?? 12);
const lookback = BigInt(process.env["HISTORY_BLOCKS"] ?? 50_000);

/**
 * How far behind the head to index.
 *
 * A lag trades a little latency for not alerting about a transfer a reorg then removed, which on
 * a public chain is the right trade: the hold runs for hours, and a false alarm costs the only
 * thing this channel has.
 *
 * A local development chain has no reorgs at all, and — because anvil only mines when there is a
 * transaction — a lag there means the head never moves far enough for anything to become "safe",
 * so nothing is ever indexed. Zero is correct rather than convenient.
 */
const confirmations = BigInt(process.env["CONFIRMATIONS"] ?? (chainId === 31337 ? 0 : 2));

const client = createChainClient(rpcUrl);
const store = new Store(dbPath);
const channels = channelsFromEnv(process.env);

const watcher = new Watcher({
  chainId,
  client,
  store,
  channels,
  appUrl,
  confirmations,
  /**
   * The engine judges the recipient of every hold, so the alert can say why rather than only
   * what. Scoped to a modest window because this runs inside the alert path: a scan that takes a
   * minute would delay the message that the whole component exists to deliver.
   */
  historyFor: async (_chain, owner) =>
    (await scanHistory(client, owner, {
      fromBlock: (await client.getBlockNumber()) - lookback,
      toBlock: await client.getBlockNumber(),
    })).history,
});

// Anything named in WATCH is picked up at boot, so a restart needs no manual step.
for (const entry of (process.env["WATCH"] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
  if (!isAddress(entry)) {
    console.warn(`WATCH: skipping ${entry}, not an address`);
    continue;
  }
  const result = await watcher.addPolicy(entry as Address);
  console.log(result.watched ? `watching ${entry}` : `not watching ${entry}: ${result.reason}`);
}

const server = createApi({store, watcher, chainId, client, defaultLookback: lookback});
server.listen(port, () => {
  console.log(`TrueSend indexer`);
  console.log(`  chain    ${chainId} via ${rpcUrl}`);
  console.log(`  api      http://localhost:${port}`);
  console.log(`  channels ${channels.map((c) => c.name).join(", ")}`);
  console.log(`  db       ${dbPath}`);
  console.log(`  polling  every ${pollSeconds}s`);
});

let stopping = false;

async function tick(): Promise<void> {
  if (stopping) return;
  try {
    const result = await watcher.poll();
    if (result.queuedFound || result.settledFound || result.alertsSent || result.alertsFailed) {
      console.log(
        `blocks ${result.from}–${result.to}: ` +
          `${result.queuedFound} queued, ${result.settledFound} settled, ` +
          `${result.alertsSent} alerts sent${result.alertsFailed ? `, ${result.alertsFailed} failed` : ""}`,
      );
    }
  } catch (error) {
    // A poll that throws must not kill the loop: an RPC hiccup would otherwise stop alerting
    // permanently, and silently. The cursor did not advance, so the window is retried.
    console.error(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

await tick();
const timer = setInterval(() => void tick(), pollSeconds * 1000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    clearInterval(timer);
    server.close();
    store.close();
    console.log("\nstopped");
    process.exit(0);
  });
}
