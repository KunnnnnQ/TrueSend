import {describe, expect, it} from "vitest";

import {counterparties, foldHistory, type TransferRecord} from "../src/history.js";
import {assessAddress} from "../src/risk.js";
import type {Address} from "../src/address.js";

const ME = "0x1e227979f0b5bc691a70deaed2e0f39a6f538fd5" as Address;
const ATTACKER = "0xd9a1c3788d81257612e2581a6ea0ada244853a91" as Address;
const BOT = "0x517dc8e50b8bf03a1d69c84d27bf96dc5a911db2" as Address;
const REAL_PAYEE = "0x4585fe77225b41b697c938b018e2ac67ac5a20c0" as Address;
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7" as Address;

function transfer(over: Partial<TransferRecord> & Pick<TransferRecord, "from" | "to">): TransferRecord {
  return {
    token: USDT,
    value: 1_000_000n,
    at: 1_770_000_000,
    signer: over.from,
    ...over,
  };
}

describe("foldHistory", () => {
  it("counts a payment the owner signed as a payment", () => {
    const [entry] = foldHistory(ME, [transfer({from: ME, to: REAL_PAYEE, signer: ME, at: 100})]);

    expect(entry?.address).toBe(REAL_PAYEE);
    expect(entry?.outgoingCount).toBe(1);
    expect(entry?.spoofedOutgoingCount).toBe(0);
    expect(entry?.lastOutgoingAt).toBe(100);
  });

  /**
   * The rule the whole module exists for. This is the shape of the May 2024 WBTC bait: a log
   * naming the victim as sender, in a transaction a bot signed.
   */
  it("refuses to count a payment the owner did not sign", () => {
    const [entry] = foldHistory(ME, [
      transfer({from: ME, to: ATTACKER, signer: BOT, value: 50_000n, at: 100}),
    ]);

    expect(entry?.address).toBe(ATTACKER);
    expect(entry?.outgoingCount).toBe(0);
    expect(entry?.spoofedOutgoingCount).toBe(1);
    expect(entry?.lastOutgoingAt).toBeUndefined();
  });

  /** The end-to-end version: folded history straight into a verdict. */
  it("turns a fabricated record into a danger verdict", () => {
    const history = foldHistory(ME, [
      transfer({from: ME, to: ATTACKER, signer: BOT, value: 50_000n, at: 100}),
    ]);
    const result = assessAddress({to: ATTACKER, history, now: 200});

    expect(result.level).toBe("danger");
    expect(result.findings[0]?.code).toBe("spoofed-outgoing-transfer");
  });

  it("separates zero-value from dust on the inbound side", () => {
    const history = foldHistory(ME, [
      transfer({from: ATTACKER, to: ME, value: 0n, at: 100}),
      transfer({from: ATTACKER, to: ME, value: 1n, dust: true, at: 110}),
      transfer({from: REAL_PAYEE, to: ME, value: 5_000_000n, at: 120}),
    ]);

    const attacker = history.find((e) => e.address === ATTACKER);
    expect(attacker?.incomingCount).toBe(2);
    expect(attacker?.zeroValueIncoming).toBe(1);
    expect(attacker?.dustIncoming).toBe(1);

    const payee = history.find((e) => e.address === REAL_PAYEE);
    expect(payee?.incomingCount).toBe(1);
    expect(payee?.zeroValueIncoming).toBe(0);
    expect(payee?.dustIncoming).toBe(0);
  });

  it("tracks the first and last time a counterparty was seen", () => {
    const [entry] = foldHistory(ME, [
      transfer({from: ME, to: REAL_PAYEE, signer: ME, at: 500}),
      transfer({from: REAL_PAYEE, to: ME, at: 100}),
      transfer({from: ME, to: REAL_PAYEE, signer: ME, at: 300}),
    ]);

    expect(entry?.firstSeenAt).toBe(100);
    expect(entry?.lastSeenAt).toBe(500);
    expect(entry?.outgoingCount).toBe(2);
    expect(entry?.lastOutgoingAt).toBe(500);
  });

  it("ignores self-transfers, which say nothing about a counterparty", () => {
    expect(foldHistory(ME, [transfer({from: ME, to: ME, signer: ME})])).toEqual([]);
  });

  it("ignores transfers between two other parties", () => {
    expect(foldHistory(ME, [transfer({from: ATTACKER, to: REAL_PAYEE, signer: ATTACKER})])).toEqual([]);
  });

  it("does not care how addresses are capitalised", () => {
    const history = foldHistory(ME.toUpperCase().replace("0X", "0x"), [
      transfer({from: ME, to: REAL_PAYEE.toUpperCase().replace("0X", "0x") as Address, signer: ME}),
    ]);

    expect(history[0]?.address).toBe(REAL_PAYEE);
    expect(history[0]?.outgoingCount).toBe(1);
  });

  it("returns counterparties newest first, which is the order the Scan screen renders", () => {
    const history = foldHistory(ME, [
      transfer({from: ME, to: REAL_PAYEE, signer: ME, at: 100}),
      transfer({from: ME, to: ATTACKER, signer: BOT, at: 900}),
    ]);

    expect(counterparties(history)).toEqual([ATTACKER, REAL_PAYEE]);
  });

  it("keeps genuine and fabricated payments to the same address apart", () => {
    const [entry] = foldHistory(ME, [
      transfer({from: ME, to: ATTACKER, signer: ME, at: 100}),
      transfer({from: ME, to: ATTACKER, signer: BOT, at: 200}),
      transfer({from: ME, to: ATTACKER, signer: BOT, at: 300}),
    ]);

    expect(entry?.outgoingCount).toBe(1);
    expect(entry?.spoofedOutgoingCount).toBe(2);
    expect(entry?.lastOutgoingAt).toBe(100);
  });
});

describe("addresses that are not counterparties", () => {
  const ZERO = "0x0000000000000000000000000000000000000000" as Address;

  it("ignores mints and burns", () => {
    const history = foldHistory(ME, [
      transfer({from: ZERO, to: ME, value: 1_000n, at: 100}),
      transfer({from: ME, to: ZERO, signer: ME, value: 500n, at: 200}),
      transfer({from: ME, to: REAL_PAYEE, signer: ME, at: 300}),
    ]);

    expect(history.map((e) => e.address)).toEqual([REAL_PAYEE]);
  });
});
