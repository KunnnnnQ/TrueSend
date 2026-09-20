import {DatabaseSync} from "node:sqlite";

/**
 * Durable state for the watcher.
 *
 * SQLite through Node's own `node:sqlite`, so there is no native module to compile and no server
 * to run. The watcher is the kind of thing somebody should be able to start with one command on
 * whatever machine is to hand, and a dependency that fails to build on Windows would defeat that.
 *
 * Everything here exists to answer one question correctly after a restart: has this hold already
 * been reported to this person? An alerting system that forgets is worse than none, because the
 * user has stopped watching for themselves.
 */
export interface QueuedRow {
  chainId: number;
  policy: string;
  transferId: string;
  recipient: string;
  token: string;
  amount: string;
  unlockAt: number;
  blockNumber: number;
  txHash: string;
  status: "queued" | "executed" | "cancelled";
  firstSeenAt: number;
}

export interface WatchRow {
  chainId: number;
  policy: string;
  owner: string;
  guardian: string;
  cooldown: number;
  addedAt: number;
}

export interface AlertRow {
  chainId: number;
  policy: string;
  transferId: string;
  channel: string;
  deliveredAt: number | null;
  attempts: number;
  lastError: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cursor (
  chain_id   INTEGER PRIMARY KEY,
  last_block INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS watch (
  chain_id INTEGER NOT NULL,
  policy   TEXT    NOT NULL,
  owner    TEXT    NOT NULL,
  guardian TEXT    NOT NULL,
  cooldown INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, policy)
);

CREATE TABLE IF NOT EXISTS queued (
  chain_id      INTEGER NOT NULL,
  policy        TEXT    NOT NULL,
  transfer_id   TEXT    NOT NULL,
  recipient     TEXT    NOT NULL,
  token         TEXT    NOT NULL,
  amount        TEXT    NOT NULL,
  unlock_at     INTEGER NOT NULL,
  block_number  INTEGER NOT NULL,
  tx_hash       TEXT    NOT NULL,
  status        TEXT    NOT NULL,
  first_seen_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, policy, transfer_id)
);

CREATE INDEX IF NOT EXISTS queued_open ON queued (status, unlock_at);

-- One row per (transfer, channel), forever. The primary key is the promise that a restart
-- cannot send the same alert twice, and 'delivered_at IS NULL' is the promise that a failure
-- is retried rather than dropped.
CREATE TABLE IF NOT EXISTS alert (
  chain_id     INTEGER NOT NULL,
  policy       TEXT    NOT NULL,
  transfer_id  TEXT    NOT NULL,
  channel      TEXT    NOT NULL,
  delivered_at INTEGER,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  PRIMARY KEY (chain_id, policy, transfer_id, channel)
);
`;

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // WAL keeps the API's reads from blocking behind the watcher's writes.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /*//////////////////////////////////////////////////////////////
                                CURSOR
  //////////////////////////////////////////////////////////////*/

  getCursor(chainId: number): number | undefined {
    const row = this.db.prepare("SELECT last_block FROM cursor WHERE chain_id = ?").get(chainId) as
      | {last_block: number}
      | undefined;
    return row?.last_block;
  }

  setCursor(chainId: number, block: number): void {
    this.db
      .prepare(
        "INSERT INTO cursor (chain_id, last_block) VALUES (?, ?) " +
          "ON CONFLICT (chain_id) DO UPDATE SET last_block = excluded.last_block",
      )
      .run(chainId, block);
  }

  /*//////////////////////////////////////////////////////////////
                             WATCH LIST
  //////////////////////////////////////////////////////////////*/

  watch(row: WatchRow): void {
    this.db
      .prepare(
        "INSERT INTO watch (chain_id, policy, owner, guardian, cooldown, added_at) " +
          "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (chain_id, policy) DO UPDATE SET " +
          "owner = excluded.owner, guardian = excluded.guardian, cooldown = excluded.cooldown",
      )
      .run(row.chainId, row.policy, row.owner, row.guardian, row.cooldown, row.addedAt);
  }

  unwatch(chainId: number, policy: string): void {
    this.db.prepare("DELETE FROM watch WHERE chain_id = ? AND policy = ?").run(chainId, policy);
  }

  watched(chainId?: number): WatchRow[] {
    const rows = (
      chainId === undefined
        ? this.db.prepare("SELECT * FROM watch ORDER BY added_at").all()
        : this.db.prepare("SELECT * FROM watch WHERE chain_id = ? ORDER BY added_at").all(chainId)
    ) as Record<string, string | number>[];

    return rows.map((row) => ({
      chainId: row["chain_id"] as number,
      policy: row["policy"] as string,
      owner: row["owner"] as string,
      guardian: row["guardian"] as string,
      cooldown: row["cooldown"] as number,
      addedAt: row["added_at"] as number,
    }));
  }

  /*//////////////////////////////////////////////////////////////
                                QUEUE
  //////////////////////////////////////////////////////////////*/

  /** @returns true when this is the first time the row has been seen. */
  recordQueued(row: QueuedRow): boolean {
    const before = this.db
      .prepare("SELECT 1 FROM queued WHERE chain_id = ? AND policy = ? AND transfer_id = ?")
      .get(row.chainId, row.policy, row.transferId);

    this.db
      .prepare(
        "INSERT INTO queued (chain_id, policy, transfer_id, recipient, token, amount, unlock_at, " +
          "block_number, tx_hash, status, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (chain_id, policy, transfer_id) DO UPDATE SET status = excluded.status",
      )
      .run(
        row.chainId,
        row.policy,
        row.transferId,
        row.recipient,
        row.token,
        row.amount,
        row.unlockAt,
        row.blockNumber,
        row.txHash,
        row.status,
        row.firstSeenAt,
      );

    return before === undefined;
  }

  settle(chainId: number, policy: string, transferId: string, status: "executed" | "cancelled"): void {
    this.db
      .prepare("UPDATE queued SET status = ? WHERE chain_id = ? AND policy = ? AND transfer_id = ?")
      .run(status, chainId, policy, transferId);
  }

  queue(chainId: number, policy: string, onlyOpen = false): QueuedRow[] {
    const sql =
      "SELECT * FROM queued WHERE chain_id = ? AND policy = ?" +
      (onlyOpen ? " AND status = 'queued'" : "") +
      " ORDER BY CAST(transfer_id AS INTEGER) DESC";
    const rows = this.db.prepare(sql).all(chainId, policy) as Record<string, string | number>[];
    return rows.map(toQueuedRow);
  }

  /*//////////////////////////////////////////////////////////////
                                ALERTS
  //////////////////////////////////////////////////////////////*/

  /**
   * Alerts that still need sending: never delivered, on a transfer that is still held.
   *
   * A transfer that has already been executed or cancelled needs no alert — telling someone about
   * a hold they already resolved is noise, and noise is how an alerting channel gets muted.
   */
  pendingAlerts(channels: readonly string[], maxAttempts: number): (QueuedRow & {channel: string})[] {
    // One query per channel rather than a cross join. There are two or three channels, so the
    // loop costs nothing, and the SQL stays something a reviewer can read in one pass — which
    // matters more here than anywhere else in the file, because a bug in this predicate is a
    // hold that nobody is told about.
    const statement = this.db.prepare(
      `SELECT q.* FROM queued q
       LEFT JOIN alert a
         ON a.chain_id = q.chain_id
        AND a.policy = q.policy
        AND a.transfer_id = q.transfer_id
        AND a.channel = ?
       WHERE q.status = 'queued'
         AND a.delivered_at IS NULL
         AND COALESCE(a.attempts, 0) < ?
       ORDER BY q.block_number`,
    );

    return channels.flatMap((channel) =>
      (statement.all(channel, maxAttempts) as Record<string, string | number>[]).map((row) => ({
        ...toQueuedRow(row),
        channel,
      })),
    );
  }

  recordAlert(
    chainId: number,
    policy: string,
    transferId: string,
    channel: string,
    outcome: {delivered: boolean; error?: string},
  ): void {
    this.db
      .prepare(
        "INSERT INTO alert (chain_id, policy, transfer_id, channel, delivered_at, attempts, last_error) " +
          "VALUES (?, ?, ?, ?, ?, 1, ?) " +
          "ON CONFLICT (chain_id, policy, transfer_id, channel) DO UPDATE SET " +
          "delivered_at = excluded.delivered_at, attempts = alert.attempts + 1, " +
          "last_error = excluded.last_error",
      )
      .run(
        chainId,
        policy,
        transferId,
        channel,
        outcome.delivered ? Math.floor(Date.now() / 1000) : null,
        outcome.error ?? null,
      );
  }

  alerts(chainId: number, policy: string): AlertRow[] {
    const rows = this.db
      .prepare("SELECT * FROM alert WHERE chain_id = ? AND policy = ?")
      .all(chainId, policy) as Record<string, string | number | null>[];

    return rows.map((row) => ({
      chainId: row["chain_id"] as number,
      policy: row["policy"] as string,
      transferId: row["transfer_id"] as string,
      channel: row["channel"] as string,
      deliveredAt: row["delivered_at"] as number | null,
      attempts: row["attempts"] as number,
      lastError: row["last_error"] as string | null,
    }));
  }
}

function toQueuedRow(row: Record<string, string | number>): QueuedRow {
  return {
    chainId: row["chain_id"] as number,
    policy: row["policy"] as string,
    transferId: row["transfer_id"] as string,
    recipient: row["recipient"] as string,
    token: row["token"] as string,
    amount: row["amount"] as string,
    unlockAt: row["unlock_at"] as number,
    blockNumber: row["block_number"] as number,
    txHash: row["tx_hash"] as string,
    status: row["status"] as QueuedRow["status"],
    firstSeenAt: row["first_seen_at"] as number,
  };
}
