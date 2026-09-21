import {describe, expect, it} from "vitest";

import {counterparties, foldHistory, type TransferRecord} from "../src/history.js";
import {assessAddress} from "../src/risk.js";
import type {Address} from "../src/address.js";

const ME = "0x1e227979f0b5bc691a70deaed2e0f39a6f538fd5" as Address;
const ATTACKER = "0xd9a1c3788d81257612e2581a6ea0ada244853a91" as Address;
const BOT = "0x517dc8e50b8bf03a1d69c84d27bf96dc5a911db2" as Address;
const REAL_PAYEE = "0x4585fe77225b41b697c938b018e2ac67ac5a20c0" as Address;
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7" as Address;
/** The contract the attacker deployed for the WBTC bait: symbol `ETH`, name `Ether`, 6 decimals. */
const BAIT = "0x739352337c902c3874b95f14e81ebbcf1b7b262e" as Address;
const EXCHANGE_PAYER = "0x28c6c06298d514db089934071355e5743bf21d60" as Address;

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
      transfer({from: ME, to: ATTACKER, signer: BOT, token: BAIT, at: 200}),
      transfer({from: ME, to: ATTACKER, signer: BOT, token: BAIT, at: 300}),
    ]);

    expect(entry?.outgoingCount).toBe(1);
    expect(entry?.spoofedOutgoingCount).toBe(2);
    expect(entry?.lastOutgoingAt).toBe(100);
  });
});

/**
 * Measured on mainnet before any of this was written. Over twelve minutes, 4.6% of nonzero USDT
 * and USDC transfers moved an ordinary account's tokens without that account signing — 252
 * distinct people, most through Permit2, with CoW Protocol's settlement contract among them.
 *
 * The fold used to call every one of those a fabrication and score the counterparty 65, which is
 * danger. `analysis/src/authorised-movements.mjs` demonstrates it against the shipped engine.
 */
describe("tokens somebody else was authorised to move", () => {
  const SOLVER = "0x9008d19f58aabd9ed0d60971565aa8510560ab41" as Address;
  const FILLER = "0x0000000000000000000000000000000000000f11" as Address;
  const EXCHANGE = "0x28c6c06298d514db089934071355e5743bf21d60" as Address;

  const at = (history: ReturnType<typeof foldHistory>, address: Address) =>
    history.find((entry) => entry.address === address);

  /** Being paid in a token needs no signature, which is exactly what the old rule forgot. */
  it("does not call it a fabrication when the owner was paid the token and never signed for it", () => {
    const history = foldHistory(ME, [
      transfer({from: EXCHANGE, to: ME, value: 5_000_000n, at: 100}),
      transfer({from: ME, to: SOLVER, value: 5_000_000n, signer: FILLER, at: 200}),
    ]);

    expect(at(history, SOLVER)?.spoofedOutgoingCount).toBe(0);
    expect(at(history, SOLVER)?.authorisedOutgoingCount).toBe(1);
  });

  it("does not call it a payment either, so the solver never looks trusted", () => {
    const history = foldHistory(ME, [
      transfer({from: EXCHANGE, to: ME, value: 5_000_000n, at: 100}),
      transfer({from: ME, to: SOLVER, value: 5_000_000n, signer: FILLER, at: 200}),
    ]);

    expect(at(history, SOLVER)?.outgoingCount).toBe(0);
    expect(at(history, SOLVER)?.lastOutgoingAt).toBeUndefined();
  });

  it("stops scoring the solver as an attacker", () => {
    const history = foldHistory(ME, [
      transfer({from: EXCHANGE, to: ME, value: 5_000_000n, at: 100}),
      transfer({from: ME, to: SOLVER, value: 5_000_000n, signer: FILLER, at: 200}),
    ]);
    const verdict = assessAddress({to: SOLVER, history, now: 300});

    expect(verdict.findings.map((f) => f.code)).not.toContain("spoofed-outgoing-transfer");
    expect(verdict.level).not.toBe("danger");
  });

  it("counts it when the owner moved the token themselves at some point", () => {
    const history = foldHistory(ME, [
      transfer({from: ME, to: REAL_PAYEE, value: 1n, signer: ME, at: 100}),
      transfer({from: ME, to: SOLVER, value: 5_000_000n, signer: FILLER, at: 200}),
    ]);

    expect(at(history, SOLVER)?.authorisedOutgoingCount).toBe(1);
    expect(at(history, SOLVER)?.spoofedOutgoingCount).toBe(0);
  });

  /**
   * The case the exemption must never reach. This is the WBTC bait: a contract the attacker
   * deployed, and — checked on chain — not one transfer of it ever went *to* the victim.
   */
  it("still calls it a fabrication when the owner never held the token", () => {
    const history = foldHistory(ME, [
      transfer({from: EXCHANGE, to: ME, value: 5_000_000n, at: 100}),
      transfer({from: ME, to: ATTACKER, token: BAIT, value: 50_000n, signer: BOT, at: 200}),
    ]);
    const verdict = assessAddress({to: ATTACKER, history, now: 300});

    expect(at(history, ATTACKER)?.spoofedOutgoingCount).toBe(1);
    expect(at(history, ATTACKER)?.authorisedOutgoingCount).toBeUndefined();
    expect(verdict.level).toBe("danger");
  });

  /** Nobody settles nothing, so a zero-value record is fabricated whatever the owner holds. */
  it("still calls a zero-value record a fabrication, token held or not", () => {
    const history = foldHistory(ME, [
      transfer({from: EXCHANGE, to: ME, value: 5_000_000n, at: 100}),
      transfer({from: ME, to: ATTACKER, value: 0n, signer: BOT, at: 200}),
    ]);

    expect(at(history, ATTACKER)?.spoofedOutgoingCount).toBe(1);
  });

  /**
   * A zero-value inbound is a poisoning primitive in its own right. Letting one establish that
   * the owner holds a token would hand the exemption straight to the thing being detected.
   */
  it("does not let a zero-value inbound establish that the owner holds anything", () => {
    const history = foldHistory(ME, [
      transfer({from: ATTACKER, to: ME, token: BAIT, value: 0n, at: 100}),
      transfer({from: ME, to: ATTACKER, token: BAIT, value: 50_000n, signer: BOT, at: 200}),
    ]);

    expect(at(history, ATTACKER)?.spoofedOutgoingCount).toBe(1);
    expect(at(history, ATTACKER)?.authorisedOutgoingCount).toBeUndefined();
  });

  /**
   * The documented cost of the rule, pinned so nobody discovers it by surprise: an attacker who
   * also emits a nonzero inbound of their own token buys the exemption for one extra log. The
   * cheapest version of the attack — one log, no setup — is what the rule defeats.
   */
  it("can be bought off by an attacker willing to emit a second log", () => {
    const history = foldHistory(ME, [
      transfer({from: ATTACKER, to: ME, token: BAIT, value: 1n, at: 100}),
      transfer({from: ME, to: ATTACKER, token: BAIT, value: 50_000n, signer: BOT, at: 200}),
    ]);

    expect(at(history, ATTACKER)?.spoofedOutgoingCount).toBe(0);
    // Not a free pass: the inbound it had to plant is itself something the score can see.
    expect(at(history, ATTACKER)?.incomingCount).toBe(1);
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

/**
 * An owner that cannot sign anything.
 *
 * An ERC-4337 smart account never appears as `tx.from`: its user operations are submitted by a
 * bundler. EIP-7702 puts this in the protocol — an account whose code is not a valid delegation
 * designator "may not originate transactions" at all — so for such an owner "they did not sign
 * it" is not evidence of anything. It is the only thing that can ever be true.
 *
 * The damage is not the missing trust signal. `assessAddress` builds its payee set from entries
 * with `outgoingCount > 0`, and the lookalike rule only compares against that set, so an owner
 * whose every payment is submitted by somebody else has no payees and **the lookalike rule cannot
 * fire at all**. The detector is not weakened for these users, it is switched off.
 */
describe("an owner that cannot sign anything", () => {
  const SMART_ACCOUNT = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc" as Address;
  const BUNDLER = "0x0000000000000000000000000000000000b0d1e5" as Address;
  /** Shares REAL_PAYEE's four leading and four trailing characters, and nothing else: 32 bits. */
  const LOOKALIKE = "0x45851111111111111111111111111111dead20c0" as Address;

  const paidSomebody = [
    transfer({from: EXCHANGE_PAYER, to: SMART_ACCOUNT, value: 9_000_000n, at: 50}),
    transfer({from: SMART_ACCOUNT, to: REAL_PAYEE, value: 5_000_000n, signer: BUNDLER, at: 100}),
  ];

  it("sees a lookalike of a payee the account really paid", () => {
    const history = foldHistory(SMART_ACCOUNT, paidSomebody, {ownerCanSign: false});
    const verdict = assessAddress({to: LOOKALIKE, history, now: 200});

    expect(verdict.findings.map((f) => f.code)).toContain("lookalike-of-known-payee");
  });

  it("records the payment as a payment, since a contract only moves what its own code moves", () => {
    const history = foldHistory(SMART_ACCOUNT, paidSomebody, {ownerCanSign: false});
    const payee = history.find((e) => e.address === REAL_PAYEE);

    expect(payee?.outgoingCount).toBe(1);
    expect(payee?.spoofedOutgoingCount).toBe(0);
    expect(payee?.lastOutgoingAt).toBe(100);
  });

  /** The blindness, kept as a test so the reason for the flag is not lost. */
  it("is blind to that same lookalike when told the owner signs for itself", () => {
    const history = foldHistory(SMART_ACCOUNT, paidSomebody);
    const verdict = assessAddress({to: LOOKALIKE, history, now: 200});

    expect(verdict.findings.map((f) => f.code)).not.toContain("lookalike-of-known-payee");
  });

  /** A fabrication is still a fabrication: a contract cannot move what it never held either. */
  it("still catches a fabricated record against a contract account", () => {
    const history = foldHistory(
      SMART_ACCOUNT,
      [transfer({from: SMART_ACCOUNT, to: ATTACKER, token: BAIT, value: 50_000n, signer: BOT, at: 100})],
      {ownerCanSign: false},
    );
    const verdict = assessAddress({to: ATTACKER, history, now: 200});

    expect(history[0]?.spoofedOutgoingCount).toBe(1);
    expect(history[0]?.outgoingCount).toBe(0);
    expect(verdict.level).toBe("danger");
  });

  it("still catches a zero-value fabrication against a contract account", () => {
    const history = foldHistory(
      SMART_ACCOUNT,
      [
        transfer({from: EXCHANGE_PAYER, to: SMART_ACCOUNT, value: 9_000_000n, at: 50}),
        transfer({from: SMART_ACCOUNT, to: ATTACKER, value: 0n, signer: BOT, at: 100}),
      ],
      {ownerCanSign: false},
    );

    expect(history.find((e) => e.address === ATTACKER)?.spoofedOutgoingCount).toBe(1);
  });
});
