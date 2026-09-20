import fc from "fast-check";
import {describe, expect, it} from "vitest";

import {normalizeAddress} from "../src/address.js";
import {
  COMMUNITY_CAP,
  THRESHOLDS,
  WEIGHTS,
  assessAddress,
  assessMany,
  levelFor,
  nearestLookalike,
} from "../src/risk.js";
import type {AddressSighting, PoisonReport} from "../src/types.js";

const HOUR = 3600;
const NOW = 1_770_000_000;

/** The address the user has actually paid before. */
const ALICE = "0xab58c49b70d5e2f1a0c9f3d7e6b4a2c8d1f00e93";
/** Ground out to share Alice's first 6 and last 4 characters — what a wallet shows. */
const POISONED = "0xab58c41122334455667788990011223344ff0e93";
/** Unrelated. */
const BOB = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";

function sighting(
  over: Omit<Partial<AddressSighting>, "address"> & {address: string},
): AddressSighting {
  return {
    outgoingCount: 0,
    incomingCount: 0,
    zeroValueIncoming: 0,
    dustIncoming: 0,
    spoofedOutgoingCount: 0,
    firstSeenAt: NOW - 30 * 24 * HOUR,
    lastSeenAt: NOW,
    ...over,
    address: normalizeAddress(over.address),
  };
}

const alicePaid = sighting({
  address: ALICE,
  label: "Alice",
  outgoingCount: 4,
  lastOutgoingAt: NOW - 2 * HOUR,
  incomingCount: 1,
});

describe("the attack this project exists for", () => {
  const history = [
    alicePaid,
    sighting({
      address: POISONED,
      zeroValueIncoming: 1,
      incomingCount: 1,
      // Planted 20 minutes after the user paid Alice.
      firstSeenAt: NOW - 2 * HOUR + 20 * 60,
      lastSeenAt: NOW - 2 * HOUR + 20 * 60,
    }),
  ];

  it("flags the poisoned address as dangerous", () => {
    const result = assessAddress({to: POISONED, history, now: NOW});

    expect(result.level).toBe("danger");
    expect(result.score).toBeGreaterThanOrEqual(THRESHOLDS.danger);
  });

  it("names all three signals, highest weight first", () => {
    const codes = assessAddress({to: POISONED, history, now: NOW}).findings.map((f) => f.code);

    expect(codes).toContain("lookalike-of-known-payee");
    expect(codes).toContain("appeared-right-after-payment");
    expect(codes).toContain("zero-value-inbound");
    expect(codes[0]).toBe("lookalike-of-known-payee");
  });

  it("explains itself in a sentence that names the real contact and both fingerprints", () => {
    const finding = assessAddress({to: POISONED, history, now: NOW}).findings.find(
      (f) => f.code === "lookalike-of-known-payee",
    );

    expect(finding?.message).toContain("Alice");
    expect(finding?.message).toContain("first 6 and last 4");
    expect(finding?.evidence["thisPhrase"]).not.toBe(finding?.evidence["theirPhrase"]);
  });

  it("points the UI at the contact being impersonated", () => {
    const result = assessAddress({to: POISONED, history, now: NOW});

    expect(result.resembles?.label).toBe("Alice");
    expect(result.resembles?.sharedPrefix).toBe(6);
    expect(result.resembles?.sharedSuffix).toBe(4);
    expect(result.resembles?.fingerprint.phrase).not.toBe(result.fingerprint.phrase);
  });

  it("still leaves the real Alice alone", () => {
    const result = assessAddress({to: ALICE, history, now: NOW});

    expect(result.level).toBe("safe");
    expect(result.findings).toEqual([]);
  });
});

describe("staying quiet when it should", () => {
  it("does not shout at a first payment to a genuinely new address", () => {
    const result = assessAddress({to: BOB, history: [alicePaid], now: NOW});

    expect(result.level).toBe("safe");
    expect(result.findings.map((f) => f.code)).toEqual(["no-history-at-all"]);
  });

  it("treats an unrelated address that only ever sent dust as a caution, not a danger", () => {
    const duster = sighting({address: BOB, dustIncoming: 3, incomingCount: 3});
    const result = assessAddress({to: BOB, history: [alicePaid, duster], now: NOW});

    expect(result.level).toBe("caution");
  });

  it("ignores a lookalike of an address the user has never actually paid", () => {
    // Alice is only ever a *recipient* of dust here, never someone the user paid.
    const neverPaid = sighting({address: ALICE, incomingCount: 2, outgoingCount: 0});
    const result = assessAddress({to: POISONED, history: [neverPaid], now: NOW});

    expect(result.findings.map((f) => f.code)).not.toContain("lookalike-of-known-payee");
  });

  it("does not use the timing signal when the history has no payment timestamp", () => {
    const noTimestamp = {...alicePaid};
    delete (noTimestamp as {lastOutgoingAt?: number}).lastOutgoingAt;

    const result = assessAddress({
      to: POISONED,
      history: [noTimestamp, sighting({address: POISONED, zeroValueIncoming: 1})],
      now: NOW,
    });

    expect(result.findings.map((f) => f.code)).not.toContain("appeared-right-after-payment");
    expect(result.findings.map((f) => f.code)).toContain("lookalike-of-known-payee");
  });
});

describe("nearestLookalike", () => {
  it("returns nothing when no payee is close enough", () => {
    expect(nearestLookalike(BOB, [alicePaid])).toBeUndefined();
  });

  it("picks the payee with the longest combined match", () => {
    const closer = sighting({
      address: `0x${POISONED.slice(2, 12)}${"0".repeat(26)}${POISONED.slice(38)}`,
      label: "closer",
      outgoingCount: 1,
    });

    const best = nearestLookalike(POISONED, [alicePaid, closer]);
    expect(best?.entry.label).toBe("closer");
  });
});

describe("assessMany", () => {
  it("sorts the riskiest first, which is the order the Scan screen renders", () => {
    const history = [
      alicePaid,
      sighting({address: POISONED, zeroValueIncoming: 1, firstSeenAt: NOW - 2 * HOUR + 600}),
    ];

    const results = assessMany([BOB, ALICE, POISONED], {history, now: NOW});

    expect(results[0]?.address.toLowerCase()).toBe(POISONED);
    expect(results.map((r) => r.score)).toEqual([...results.map((r) => r.score)].sort((a, b) => b - a));
  });
});

describe("invariants of the score itself", () => {
  const anyAddress = fc
    .uint8Array({minLength: 20, maxLength: 20})
    .map((bytes) => `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`);

  it("always lands in range and agrees with its own level thresholds", () => {
    fc.assert(
      fc.property(anyAddress, fc.nat({max: 5}), fc.nat({max: 5}), (to, zero, dust) => {
        const result = assessAddress({
          to,
          history: [alicePaid, sighting({address: to, zeroValueIncoming: zero, dustIncoming: dust})],
          now: NOW,
        });

        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
        expect(result.level).toBe(levelFor(result.score));
      }),
    );
  });

  it("never scores below the sum of nothing", () => {
    fc.assert(
      fc.property(anyAddress, (to) => {
        const result = assessAddress({to, now: NOW});
        const summed = result.findings.reduce((n, f) => n + f.weight, 0);
        expect(result.score).toBe(Math.min(100, summed));
      }),
    );
  });
});

/**
 * The gap that real data exposed.
 *
 * In the May 2024 WBTC case the victim's history contained no address resembling the attacker's,
 * so every similarity rule scored it zero and the engine called a 1155 WBTC loss "safe". What it
 * did contain was a `Transfer` log naming the victim as the sender of a 0.05 "ETH" payment they
 * had never signed. See `analysis/src/evaluate-engine.mjs`.
 */
describe("fabricated outgoing records", () => {
  const planted = sighting({
    address: BOB,
    spoofedOutgoingCount: 1,
    firstSeenAt: NOW - 4400,
    lastSeenAt: NOW - 4400,
  });

  it("reaches danger with no lookalike anywhere in the history", () => {
    const result = assessAddress({to: BOB, history: [planted], now: NOW});

    expect(result.level).toBe("danger");
    expect(result.findings[0]?.code).toBe("spoofed-outgoing-transfer");
  });

  it("outranks every similarity rule, because it is a fact rather than an inference", () => {
    const result = assessAddress({to: BOB, history: [planted], now: NOW});
    const spoof = result.findings.find((f) => f.code === "spoofed-outgoing-transfer");

    expect(spoof?.weight).toBeGreaterThan(WEIGHTS.lookalikeMax);
    expect(spoof?.message).toContain("never signed");
  });

  it("does not let a fabricated record count as a payment the user made", () => {
    const result = assessAddress({to: BOB, history: [planted], now: NOW});

    expect(result.findings.map((f) => f.code)).toContain("never-paid-before");
    expect(planted.outgoingCount).toBe(0);
  });

  /**
   * The failure mode this guards against: an indexer that believes logs records the fabrication
   * as a genuine payment, and the address the victim is about to be robbed by looks like a payee
   * they already trust.
   */
  it("says nothing when the fabrication has been miscounted as a genuine payment", () => {
    const misread = sighting({address: BOB, outgoingCount: 1, lastOutgoingAt: NOW - 4400});
    const result = assessAddress({to: BOB, history: [misread], now: NOW});

    expect(result.level).toBe("safe");
    expect(result.score).toBe(0);
  });
});

/**
 * The registry is permissionless, which it has to be. That also makes it a weapon pointed at the
 * people this project protects, unless the scoring refuses to let it be one.
 */
describe("community reports", () => {
  const report = (over: Partial<PoisonReport> = {}): PoisonReport => ({
    suspect: normalizeAddress(BOB),
    role: "planter",
    verified: false,
    reporters: 1,
    ...over,
  });

  it("raises a caution on a single unchecked report, not an alarm", () => {
    const result = assessAddress({to: BOB, reports: [report()], now: NOW});

    expect(result.level).toBe("caution");
    expect(result.findings.map((f) => f.code)).toContain("community-reported");
  });

  it("weighs a report the registry proved above one it could not", () => {
    const unchecked = assessAddress({to: BOB, reports: [report()], now: NOW}).score;
    const proven = assessAddress({
      to: BOB,
      reports: [report({role: "lookalike", verified: true, imitating: normalizeAddress(ALICE)})],
      now: NOW,
    }).score;

    expect(proven).toBeGreaterThan(unchecked);
  });

  it("says how many people said it, and whether anything checked", () => {
    const finding = assessAddress({
      to: BOB,
      reports: [report({reporters: 4})],
      now: NOW,
    }).findings.find((f) => f.code === "community-reported");

    expect(finding?.message).toContain("4 people");
    expect(finding?.message).toContain("lead rather than a verdict");
    expect(finding?.evidence["verified"]).toBe(false);
  });

  /**
   * The line that matters. A hundred "independent" reporters costs a hundred fresh addresses, so
   * no count can be allowed to condemn an address by itself — only to raise a caution, and to tip
   * something already suspicious over.
   */
  it("never reaches danger on reports alone, however many there are", () => {
    for (const reporters of [1, 2, 5, 20, 1_000, 1_000_000]) {
      for (const verified of [false, true]) {
        const result = assessAddress({
          to: BOB,
          reports: [report({reporters, verified})],
          now: NOW,
        });

        expect(result.level, `${reporters} reporters, verified=${verified}`).not.toBe("danger");
        expect(result.score).toBeLessThan(THRESHOLDS.danger);
      }
    }
  });

  it("caps the contribution one point below the danger threshold", () => {
    const finding = assessAddress({
      to: BOB,
      reports: [report({reporters: 10_000, verified: true})],
      now: NOW,
    }).findings.find((f) => f.code === "community-reported");

    expect(finding?.weight).toBe(COMMUNITY_CAP);
    expect(COMMUNITY_CAP).toBe(THRESHOLDS.danger - 1);
  });

  /** It still has to be able to push a real case over the line. */
  it("tips an address that is already suspicious into danger", () => {
    const fabricated = sighting({address: BOB, spoofedOutgoingCount: 0, dustIncoming: 2});
    const withoutReports = assessAddress({to: BOB, history: [fabricated], now: NOW});
    const withReports = assessAddress({
      to: BOB,
      history: [fabricated],
      reports: [report({reporters: 6, verified: true, role: "lookalike"})],
      now: NOW,
    });

    expect(withoutReports.level).toBe("caution");
    expect(withReports.level).toBe("danger");
  });

  it("ignores a report about a different address", () => {
    const result = assessAddress({
      to: BOB,
      reports: [report({suspect: normalizeAddress(ALICE)})],
      now: NOW,
    });

    expect(result.findings.map((f) => f.code)).not.toContain("community-reported");
  });

  it("ignores a report nobody actually made", () => {
    const result = assessAddress({to: BOB, reports: [report({reporters: 0})], now: NOW});
    expect(result.findings.map((f) => f.code)).not.toContain("community-reported");
  });
});
