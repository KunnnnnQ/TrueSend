import {describe, expect, it, beforeEach} from "vitest";

import {Store, type QueuedRow} from "../src/store.js";
import {cancelUrl} from "../src/watcher.js";
import {composeAlert, type AlertContext} from "../src/notify.js";

const CHAIN = 31337;
const POLICY = "0x845810b228bedd20fc181eb4feb0631e14298d80";
const OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const GUARDIAN = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const ATTACKER = "0xd9a1c3788d81257612e2581a6ea0ada244853a91";

function row(over: Partial<QueuedRow> = {}): QueuedRow {
  return {
    chainId: CHAIN,
    policy: POLICY,
    transferId: "1",
    recipient: ATTACKER,
    token: "0x0000000000000000000000000000000000000000",
    amount: "3000000000000000000",
    unlockAt: 1_790_000_000,
    blockNumber: 100,
    txHash: "0xabc",
    status: "queued",
    firstSeenAt: 1_789_900_000,
    ...over,
  };
}

let store: Store;

beforeEach(() => {
  store = new Store(":memory:");
  store.watch({
    chainId: CHAIN,
    policy: POLICY,
    owner: OWNER,
    guardian: GUARDIAN,
    cooldown: 86_400,
    addedAt: 0,
  });
});

/**
 * The properties that decide whether this component is a safety net or a liability.
 *
 * Missing an alert is the failure that matters — the user has stopped watching for themselves
 * because something else promised to. Sending one twice is merely annoying. Every rule below
 * follows from that asymmetry.
 */
describe("alert delivery", () => {
  it("owes an alert on every channel for a new hold", () => {
    store.recordQueued(row());

    const owed = store.pendingAlerts(["console", "telegram"], 5);
    expect(owed.map((a) => a.channel).sort()).toEqual(["console", "telegram"]);
  });

  it("never owes the same alert twice once it has been delivered", () => {
    store.recordQueued(row());
    store.recordAlert(CHAIN, POLICY, "1", "console", {delivered: true});

    expect(store.pendingAlerts(["console"], 5)).toEqual([]);
  });

  it("still owes the other channels after one succeeds", () => {
    store.recordQueued(row());
    store.recordAlert(CHAIN, POLICY, "1", "console", {delivered: true});

    const owed = store.pendingAlerts(["console", "telegram"], 5);
    expect(owed.map((a) => a.channel)).toEqual(["telegram"]);
  });

  it("retries a failure rather than dropping it", () => {
    store.recordQueued(row());
    store.recordAlert(CHAIN, POLICY, "1", "telegram", {delivered: false, error: "429"});

    const owed = store.pendingAlerts(["telegram"], 5);
    expect(owed).toHaveLength(1);
    expect(store.alerts(CHAIN, POLICY)[0]?.lastError).toBe("429");
  });

  it("gives up after the attempt cap, so a dead channel cannot spin forever", () => {
    store.recordQueued(row());
    for (let attempt = 0; attempt < 3; attempt++) {
      store.recordAlert(CHAIN, POLICY, "1", "telegram", {delivered: false, error: "nope"});
    }

    expect(store.pendingAlerts(["telegram"], 3)).toEqual([]);
    expect(store.alerts(CHAIN, POLICY)[0]?.attempts).toBe(3);
  });

  it("stops owing an alert once the hold is resolved", () => {
    store.recordQueued(row());
    store.settle(CHAIN, POLICY, "1", "cancelled");

    expect(store.pendingAlerts(["console"], 5)).toEqual([]);
  });

  /**
   * The crash-between-write-and-send case. The watcher replays a window whenever the cursor did
   * not advance, so recording the same hold again must not produce a second alert.
   */
  it("does not re-alert when a window is replayed after a crash", () => {
    store.recordQueued(row());
    store.recordAlert(CHAIN, POLICY, "1", "console", {delivered: true});

    expect(store.recordQueued(row())).toBe(false);
    expect(store.pendingAlerts(["console"], 5)).toEqual([]);
  });

  it("reports a hold as new exactly once", () => {
    expect(store.recordQueued(row())).toBe(true);
    expect(store.recordQueued(row())).toBe(false);
  });
});

describe("the cursor", () => {
  it("starts empty so a fresh watcher can choose to begin at the head", () => {
    expect(store.getCursor(CHAIN)).toBeUndefined();
  });

  it("survives a reopen, which is the whole reason it is on disk", () => {
    store.setCursor(CHAIN, 1234);
    expect(store.getCursor(CHAIN)).toBe(1234);

    store.setCursor(CHAIN, 5678);
    expect(store.getCursor(CHAIN)).toBe(5678);
  });

  it("is kept per chain", () => {
    store.setCursor(1, 10);
    store.setCursor(31337, 20);

    expect(store.getCursor(1)).toBe(10);
    expect(store.getCursor(31337)).toBe(20);
  });
});

describe("the queue view", () => {
  it("hides resolved transfers by default and shows them on request", () => {
    store.recordQueued(row({transferId: "1"}));
    store.recordQueued(row({transferId: "2"}));
    store.settle(CHAIN, POLICY, "1", "executed");

    expect(store.queue(CHAIN, POLICY, true).map((r) => r.transferId)).toEqual(["2"]);
    expect(store.queue(CHAIN, POLICY, false).map((r) => r.transferId)).toEqual(["2", "1"]);
  });

  it("orders by id numerically, not as text", () => {
    for (const id of ["2", "10", "1"]) store.recordQueued(row({transferId: id}));

    expect(store.queue(CHAIN, POLICY).map((r) => r.transferId)).toEqual(["10", "2", "1"]);
  });
});

describe("the message", () => {
  const context: AlertContext = {
    transfer: row(),
    owner: OWNER,
    guardian: GUARDIAN,
    cancelUrl: cancelUrl("http://localhost:3000", CHAIN, POLICY, "1"),
  };

  it("leads with the fact that nothing has moved", () => {
    expect(composeAlert(context).body.split("\n")[0]).toContain("on hold, not sent");
  });

  /** A phrase survives a notification preview. A picture does not. */
  it("carries the recipient's fingerprint as text", () => {
    const body = composeAlert(context).body;
    expect(body).toMatch(/0xd9A1C3…3a91/);
    expect(body).toMatch(/\n\s+\w+ \w+ \w+ \w+\n/);
  });

  it("says cancelling stays possible after the hold ends", () => {
    expect(composeAlert(context).body).toContain("after the hold ends");
  });

  it("points at the exact transfer, so the link is one click from the button", () => {
    const url = new URL(composeAlert(context).body.match(/http:\/\/\S+/)![0]);
    expect(url.pathname).toBe("/pending");
    expect(url.searchParams.get("chain")).toBe(String(CHAIN));
    expect(url.searchParams.get("policy")).toBe(POLICY);
    expect(url.searchParams.get("id")).toBe("1");
  });
});
