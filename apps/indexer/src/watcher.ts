import type {Address, PublicClient} from "viem";

import {
  findQueuedTransfers,
  findSettledTransfers,
  readPolicy,
  type BlockRange,
} from "@truesend/chain";
import {assessAddress, type AddressSighting} from "@truesend/engine";

import {composeAlert, type Channel} from "./notify.js";
import type {Store} from "./store.js";

export interface WatcherOptions {
  chainId: number;
  client: PublicClient;
  store: Store;
  channels: readonly Channel[];
  /** Where the Pending screen lives, for the cancel link in each alert. */
  appUrl: string;
  /**
   * How far behind the head to index.
   *
   * Zero would alert a second sooner and occasionally alert about a transfer that a reorg then
   * removed. The hold runs for hours, so a minute of latency costs nothing, while a false alarm
   * costs the only thing this channel has — the user's willingness to read the next one.
   */
  confirmations?: bigint;
  /** How wide a catch-up step may be. */
  maxBlocksPerPoll?: bigint;
  /** Give up on a channel after this many failures, rather than retrying forever. */
  maxAttempts?: number;
  /** Supplies the engine with something to judge recipients against, when available. */
  historyFor?: (chainId: number, owner: Address) => Promise<AddressSighting[] | undefined>;
}

export interface PollResult {
  from: number;
  to: number;
  queuedFound: number;
  settledFound: number;
  alertsSent: number;
  alertsFailed: number;
}

/**
 * Polls a chain for holds starting and ending, and tells somebody.
 *
 * Polling rather than a subscription on purpose. A websocket that drops reconnects at the head and
 * silently skips whatever happened while it was away; a cursor in a database resumes exactly where
 * it stopped. For a component whose entire job is to not miss one event, resumability beats
 * latency.
 */
export class Watcher {
  private readonly confirmations: bigint;
  private readonly maxBlocksPerPoll: bigint;
  private readonly maxAttempts: number;

  constructor(private readonly options: WatcherOptions) {
    this.confirmations = options.confirmations ?? 2n;
    this.maxBlocksPerPoll = options.maxBlocksPerPoll ?? 5_000n;
    this.maxAttempts = options.maxAttempts ?? 5;
  }

  /** Start watching an account, backfilling its queue so nothing already held is missed. */
  async addPolicy(policy: Address): Promise<{watched: boolean; reason?: string}> {
    const {chainId, client, store} = this.options;
    const state = await readPolicy(client, policy);
    if (!state) return {watched: false, reason: "no TrueSend policy at that address"};

    store.watch({
      chainId,
      policy: policy.toLowerCase(),
      owner: state.owner.toLowerCase(),
      guardian: state.guardian.toLowerCase(),
      cooldown: state.cooldown,
      addedAt: Math.floor(Date.now() / 1000),
    });

    return {watched: true};
  }

  async poll(): Promise<PollResult> {
    const {chainId, client, store} = this.options;

    const head = await client.getBlockNumber();
    const safeHead = head > this.confirmations ? head - this.confirmations : 0n;

    const stored = store.getCursor(chainId);
    // A fresh watcher starts at the head rather than at genesis. Backfilling the whole chain to
    // find holds that have long since resolved would take hours and alert about none of them.
    const from = stored === undefined ? safeHead : BigInt(stored) + 1n;
    if (from > safeHead) {
      return {from: Number(from), to: Number(safeHead), queuedFound: 0, settledFound: 0, alertsSent: 0, alertsFailed: 0};
    }

    const to = from + this.maxBlocksPerPoll - 1n > safeHead ? safeHead : from + this.maxBlocksPerPoll - 1n;
    const range: BlockRange = {fromBlock: from, toBlock: to};

    const policies = store.watched(chainId).map((row) => row.policy as Address);
    const [queued, settled] = await Promise.all([
      findQueuedTransfers(client, policies, range),
      findSettledTransfers(client, policies, range),
    ]);

    const now = Math.floor(Date.now() / 1000);
    for (const event of queued) {
      store.recordQueued({
        chainId,
        policy: event.policy,
        transferId: event.id.toString(),
        recipient: event.to,
        token: event.token,
        amount: event.amount.toString(),
        unlockAt: Number(event.unlockAt),
        blockNumber: Number(event.blockNumber),
        txHash: event.txHash,
        status: "queued",
        firstSeenAt: now,
      });
    }

    // Settlements are applied after the queue rows exist, so a transfer that was queued and
    // resolved inside the same poll window ends up closed rather than alerted about.
    for (const event of settled) {
      store.settle(chainId, event.policy, event.id.toString(), event.status);
    }

    // The cursor advances only once everything in the window is durable. A crash between the two
    // repeats the window, which the alert table makes harmless; a crash the other way round would
    // skip it, which nothing would.
    store.setCursor(chainId, Number(to));

    const {sent, failed} = await this.dispatchAlerts();

    return {
      from: Number(from),
      to: Number(to),
      queuedFound: queued.length,
      settledFound: settled.length,
      alertsSent: sent,
      alertsFailed: failed,
    };
  }

  /**
   * Send whatever is owed, once per transfer per channel.
   *
   * Every send is recorded whether it worked or not, so a failure is retried on the next poll and
   * a success is never repeated. At-least-once with a hard cap: missing an alert is the failure
   * that matters, and a duplicate is merely annoying.
   */
  async dispatchAlerts(): Promise<{sent: number; failed: number}> {
    const {chainId, store, channels, appUrl, historyFor} = this.options;

    const owed = store.pendingAlerts(
      channels.map((channel) => channel.name),
      this.maxAttempts,
    );
    if (owed.length === 0) return {sent: 0, failed: 0};

    const watched = new Map(store.watched(chainId).map((row) => [row.policy, row]));
    const histories = new Map<string, AddressSighting[] | undefined>();

    let sent = 0;
    let failed = 0;

    for (const row of owed) {
      const channel = channels.find((candidate) => candidate.name === row.channel);
      const watch = watched.get(row.policy);
      if (!channel || !watch) continue;

      if (historyFor && !histories.has(watch.owner)) {
        histories.set(
          watch.owner,
          await historyFor(chainId, watch.owner as Address).catch(() => undefined),
        );
      }
      const history = histories.get(watch.owner);

      const context = {
        transfer: row,
        owner: watch.owner,
        guardian: watch.guardian,
        cancelUrl: cancelUrl(appUrl, chainId, row.policy, row.transferId),
        ...(history
          ? {assessment: assessAddress({to: row.recipient, history, now: row.firstSeenAt})}
          : {}),
      };

      try {
        await channel.send(context);
        store.recordAlert(chainId, row.policy, row.transferId, row.channel, {delivered: true});
        sent++;
      } catch (error) {
        store.recordAlert(chainId, row.policy, row.transferId, row.channel, {
          delivered: false,
          error: error instanceof Error ? error.message : String(error),
        });
        failed++;
      }
    }

    return {sent, failed};
  }

  /** What a rendered alert looks like, without sending it. Used by the API and by tests. */
  preview(row: Parameters<typeof composeAlert>[0]): {subject: string; body: string} {
    return composeAlert(row);
  }
}

export function cancelUrl(appUrl: string, chainId: number, policy: string, transferId: string): string {
  const url = new URL("/pending", appUrl);
  url.searchParams.set("chain", String(chainId));
  url.searchParams.set("policy", policy);
  url.searchParams.set("id", transferId);
  return url.toString();
}
