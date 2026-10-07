import {describe, expect, it} from "vitest";
import type {Address} from "viem";

import {assessAddress} from "@truesend/engine";

import {scanHistory, type ScanProgress} from "../src/history.js";
import {replay, type RecordedLog, type Recording} from "./replay.js";

const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const PAYEE = "0x2222222222222222222222222222222222222222" as Address;
const PLANTED = "0x3333333333333333333333333333333333333333" as Address;
const BOT = "0x4444444444444444444444444444444444444444" as Address;
const TOKEN = "0x5555555555555555555555555555555555555555" as Address;
const BAIT = "0x6666666666666666666666666666666666666666" as Address;

const PAID = `0x${"a".repeat(64)}` as const;
const FABRICATED = `0x${"b".repeat(64)}` as const;
const RECEIVED = `0x${"c".repeat(64)}` as const;

function log(over: Partial<RecordedLog> & Pick<RecordedLog, "from" | "to" | "blockNumber" | "transactionHash">): RecordedLog {
  return {token: TOKEN, value: "100", logIndex: 0, ...over};
}

/**
 * Three transfers: a payment the owner signed, a zero-value record a bot fabricated, and a payment
 * back. Small enough to hold in your head, which the WBTC recording is not.
 */
function recording(extra: Partial<Recording> = {}): Recording {
  return {
    owner: OWNER,
    fromBlock: 0,
    toBlock: 100,
    code: "0x",
    logsCarryBlockTime: true,
    signers: {[PAID]: OWNER, [FABRICATED]: BOT, [RECEIVED]: PAYEE},
    blockTimes: {"10": 1_000, "20": 2_000, "30": 3_000},
    tokens: [],
    logs: [
      log({from: OWNER, to: PAYEE, blockNumber: 10, transactionHash: PAID}),
      log({from: OWNER, to: PLANTED, value: "0", blockNumber: 20, transactionHash: FABRICATED, token: BAIT}),
      log({from: PAYEE, to: OWNER, value: "50", blockNumber: 30, transactionHash: RECEIVED}),
    ],
    ...extra,
  };
}

const RANGE = {fromBlock: 0n, toBlock: 100n};
/** Nothing here is rate-limited, so the passes back over refusals need not wait. */
const NO_WAIT = {retryDelaysMs: [0, 0]};

describe("scanHistory", () => {
  it("checks who signed each transfer, and folds what it finds", async () => {
    const {client} = replay(recording());
    const result = await scanHistory(client, OWNER, RANGE, NO_WAIT);

    expect(result.transfers).toHaveLength(3);
    expect(result.unchecked).toEqual([]);
    expect(result.signersResolved).toBe(3);
    expect(result.history.find((e) => e.address === PAYEE)).toMatchObject({outgoingCount: 1, incomingCount: 1});
    expect(result.history.find((e) => e.address === PLANTED)).toMatchObject({outgoingCount: 0, spoofedOutgoingCount: 1});
  });

  it("takes a block's time from its logs when the endpoint puts it there, and asks only when it does not", async () => {
    const timed = replay(recording(), {logsCarryBlockTime: true});
    const untimed = replay(recording(), {logsCarryBlockTime: false});

    const a = await scanHistory(timed.client, OWNER, RANGE, NO_WAIT);
    const b = await scanHistory(untimed.client, OWNER, RANGE, NO_WAIT);

    expect(timed.asked.blocks).toBe(0);
    expect(untimed.asked.blocks).toBe(3);
    expect(a.transfers.map((t) => t.at)).toEqual([1_000, 2_000, 3_000]);
    expect(b.transfers).toEqual(a.transfers);
  });

  /** A transfer from the owner to themselves matches "from the owner" and "to the owner" alike. */
  it("counts a transfer from the owner to themselves once, though both queries return it", async () => {
    const SELF = `0x${"d".repeat(64)}` as const;
    const base = recording();
    const {client} = replay({
      ...base,
      signers: {...base.signers, [SELF]: OWNER},
      blockTimes: {...base.blockTimes, "40": 4_000},
      logs: [...base.logs, log({from: OWNER, to: OWNER, blockNumber: 40, transactionHash: SELF})],
    });

    const result = await scanHistory(client, OWNER, RANGE, NO_WAIT);

    expect(result.transfers.filter((t) => t.txHash === SELF)).toHaveLength(1);
  });

  it("reads a range wider than one request in pieces, and misses nothing at the seams", async () => {
    const base = recording();
    const EDGE = `0x${"e".repeat(64)}` as const;
    const NEXT = `0x${"f".repeat(64)}` as const;
    const {client, asked} = replay({
      ...base,
      toBlock: 20_000,
      signers: {[EDGE]: PAYEE, [NEXT]: PAYEE},
      blockTimes: {"8999": 1_000, "9000": 1_012},
      logs: [
        log({from: PAYEE, to: OWNER, blockNumber: 8_999, transactionHash: EDGE}),
        log({from: PAYEE, to: OWNER, blockNumber: 9_000, transactionHash: NEXT}),
      ],
    });

    const result = await scanHistory(client, OWNER, {fromBlock: 0n, toBlock: 20_000n}, NO_WAIT);

    expect(result.transfers.map((t) => t.txHash)).toEqual([EDGE, NEXT]);
    expect(asked.logs).toBe(6);
  });
});

/**
 * What happens when the endpoint refuses a lookup.
 *
 * This used to be the one silent failure in the product: the transfer was dropped, and the screen
 * showed nothing missing. Simulated on the May 2024 case before it was fixed, refusing only the
 * bait's lookup turned the attacker from "do not send 65" into "looks fine 0".
 */
describe("scanHistory, when the endpoint refuses", () => {
  it("asks again, and gets the whole history when the refusal was a passing one", async () => {
    const {client, asked} = replay(recording(), {refuse: {transactions: {[FABRICATED]: 2}}});
    const result = await scanHistory(client, OWNER, RANGE, NO_WAIT);

    expect(result.unchecked).toEqual([]);
    expect(result.history.find((e) => e.address === PLANTED)?.spoofedOutgoingCount).toBe(1);
    expect(asked.transactions).toBe(5);
  });

  it("returns what it still could not check, instead of dropping it", async () => {
    const {client} = replay(recording(), {refuse: {transactions: {[FABRICATED]: Infinity}}});
    const result = await scanHistory(client, OWNER, RANGE, NO_WAIT);

    expect(result.transfers).toHaveLength(2);
    expect(result.unchecked).toEqual([
      {token: BAIT, from: OWNER, to: PLANTED, value: 0n, txHash: FABRICATED},
    ]);
    expect(result.history.find((e) => e.address === PLANTED)).toMatchObject({
      uncheckedCount: 1,
      spoofedOutgoingCount: 0,
      outgoingCount: 0,
    });
  });

  it("leaves the address involved a caution rather than a first payment", async () => {
    const {client} = replay(recording(), {refuse: {transactions: {[FABRICATED]: Infinity}}});
    const result = await scanHistory(client, OWNER, RANGE, NO_WAIT);
    const verdict = assessAddress({to: PLANTED, history: result.history});

    expect(verdict.level).toBe("caution");
    expect(verdict.findings.map((f) => f.code)).toEqual(["unchecked-records"]);
  });

  it("does the same for a block whose time never came, with every transfer in it", async () => {
    const {client} = replay(recording(), {logsCarryBlockTime: false, refuse: {blocks: {"20": Infinity}}});
    const result = await scanHistory(client, OWNER, RANGE, NO_WAIT);

    expect(result.unchecked.map((u) => u.txHash)).toEqual([FABRICATED]);
    expect(result.transfers).toHaveLength(2);
  });

  it("still lists a token seen only in a transfer it could not check", async () => {
    const {client} = replay(recording(), {refuse: {transactions: {[FABRICATED]: Infinity}}});
    const result = await scanHistory(client, OWNER, RANGE, NO_WAIT);

    expect(result.tokensSeen).toContain(BAIT);
  });

  it("says that it is asking again, rather than sitting on a progress bar", async () => {
    const {client} = replay(recording(), {refuse: {transactions: {[FABRICATED]: 1}}});
    const seen: ScanProgress[] = [];
    await scanHistory(client, OWNER, RANGE, {...NO_WAIT, onProgress: (p) => seen.push(p)});

    expect(seen.map((p) => p.message)).toContain("Asking again about 1 the endpoint refused");
  });

  it("asks one at a time on the pass back, which is what a rate limit needs", async () => {
    const {client} = replay(recording(), {refuse: {transactions: {[PAID]: 1, [FABRICATED]: 1, [RECEIVED]: 1}}});
    const ask = client.getTransaction.bind(client);
    let inFlight = 0;
    const atEachCall: number[] = [];
    client.getTransaction = (async (args: Parameters<typeof ask>[0]) => {
      atEachCall.push(++inFlight);
      try {
        return await ask(args);
      } finally {
        inFlight--;
      }
    }) as typeof client.getTransaction;

    const result = await scanHistory(client, OWNER, RANGE, NO_WAIT);

    expect(result.unchecked).toEqual([]);
    // The first pass all at once, every one refused; then the pass back, strictly one by one.
    expect(atEachCall).toEqual([1, 2, 3, 1, 1, 1]);
  });
});
