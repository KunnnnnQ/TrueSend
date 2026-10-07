import fc from "fast-check";
import {describe, expect, it} from "vitest";

import {normalizeAddress} from "../src/address.js";
import {
  COMMUNITY_CAP,
  SUFFIX_ONLY_MATCH,
  THRESHOLDS,
  WEIGHTS,
  assessAddress,
  assessMany,
  describeAffixMatch,
  levelFor,
  lookalikeAffixes,
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

/**
 * The shape the both-ends floor could not see. 40 of the 44 dust baits in Guan and Li's
 * Poison-Hunter sample matched the last seven characters of the address they imitated and fewer
 * than four of the first; replayed through the engine as it was, every one scored a bare caution from
 * the dust rule and none was recognised as imitating the contact the victim had just paid.
 */
describe("a lookalike that only matches how the address ends", () => {
  /** Alice's first 2 and last 7 characters, and nothing else: the shape of those baits. */
  const ENDS_ALIKE = `0xab${"0".repeat(31)}1f00e93`;
  const duster = sighting({
    address: ENDS_ALIKE,
    dustIncoming: 1,
    incomingCount: 1,
    // Dusted five minutes after the user paid Alice.
    firstSeenAt: NOW - 2 * HOUR + 5 * 60,
    lastSeenAt: NOW - 2 * HOUR + 5 * 60,
  });
  const history = [alicePaid, duster];

  it("is recognised as imitating the contact it copies", () => {
    const result = assessAddress({to: ENDS_ALIKE, history, now: NOW});

    expect(result.findings.map((f) => f.code)).toContain("lookalike-of-known-payee");
    expect(result.resembles?.label).toBe("Alice");
    expect(result.level).toBe("danger");
  });

  it("says which characters match, without pointing at the start that does not", () => {
    const finding = assessAddress({to: ENDS_ALIKE, history, now: NOW}).findings.find(
      (f) => f.code === "lookalike-of-known-payee",
    );

    expect(finding?.message).toContain("the last 7 characters of");
    expect(finding?.message).not.toContain("first");
  });

  it("weighs exactly seven like the four-and-four floor, and more only with more", () => {
    const weightOf = (address: string) =>
      assessAddress({to: address, history: [alicePaid], now: NOW}).findings.find(
        (f) => f.code === "lookalike-of-known-payee",
      )?.weight;

    expect(weightOf(ENDS_ALIKE)).toBe(WEIGHTS.lookalikeBase);
    expect(weightOf(`0xab${"0".repeat(30)}d1f00e93`)).toBe(WEIGHTS.lookalikeBase + WEIGHTS.lookalikePerExtraChar);
  });

  it("stops at six", () => {
    expect(lookalikeAffixes(`0xab${"0".repeat(32)}f00e93`, ALICE)).toBeUndefined();
    expect(SUFFIX_ONLY_MATCH).toBe(7);
  });

  /**
   * Leading zeros are what a legitimate vanity address looks like. A rule that fired on a long
   * shared start would put every pair of them in front of a user as an attack.
   */
  it("has no twin for a long shared start", () => {
    expect(lookalikeAffixes(`0xab58c49b${"0".repeat(32)}`, ALICE)).toBeUndefined();
    expect(lookalikeAffixes(`0x0000000${"1".repeat(33)}`, `0x0000000${"2".repeat(33)}`)).toBeUndefined();
  });
});

describe("lookalikeAffixes", () => {
  it("never calls an address a lookalike of itself", () => {
    expect(lookalikeAffixes(ALICE, ALICE)).toBeUndefined();
  });

  it("accepts four or more at both ends", () => {
    expect(lookalikeAffixes(POISONED, ALICE)).toEqual({sharedPrefix: 6, sharedSuffix: 4});
  });

  it("refuses three at the start with six at the end", () => {
    expect(lookalikeAffixes(`0xab5${"0".repeat(31)}f00e93`, ALICE)).toBeUndefined();
  });

  const anyAddress = fc
    .uint8Array({minLength: 20, maxLength: 20})
    .map((bytes) => `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`);

  it("gives the same answer whichever way round it is asked", () => {
    fc.assert(
      fc.property(anyAddress, anyAddress, fc.nat({max: 40}), (a, b, keep) => {
        // Splice part of a into b so matches of every length actually turn up.
        const spliced = `0x${b.slice(2, 42 - keep)}${a.slice(42 - keep)}`;
        expect(lookalikeAffixes(a, spliced)).toEqual(lookalikeAffixes(spliced, a));
      }),
    );
  });
});

describe("describeAffixMatch", () => {
  it("names both ends when both qualified", () => {
    expect(describeAffixMatch({sharedPrefix: 6, sharedSuffix: 4})).toBe("the first 6 and last 4 characters");
  });

  it("names only the end when the start did not earn a mention", () => {
    expect(describeAffixMatch({sharedPrefix: 2, sharedSuffix: 7})).toBe("the last 7 characters");
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

  /**
   * Found on live accounts (`analysis/src/live-accounts.mjs`): a planter copies a real payment with
   * a counterfeit token — same amount, same real recipient, minutes later — and the recipient, a
   * contact the user had paid with their own signature, used to read "Do not send".
   */
  it("does not hold a copied payment against an address the user had already paid", () => {
    const contact = sighting({
      address: BOB,
      outgoingCount: 2,
      firstOutgoingAt: NOW - 3 * HOUR,
      lastOutgoingAt: NOW - HOUR,
      spoofedOutgoingCount: 1,
      // The copy, a few minutes after the payment it copies.
      firstSpoofedAt: NOW - 3 * HOUR + 480,
    });
    const result = assessAddress({to: BOB, history: [contact], now: NOW});

    expect(result.level).toBe("safe");
    expect(result.findings.map((f) => f.code)).toEqual(["spoofed-copy-of-payment"]);
    expect(result.findings[0]?.weight).toBe(0);
    expect(result.findings[0]?.message).toContain("after you had already paid it yourself");
  });

  /**
   * The first version of the exemption asked only whether the user had ever paid the address, and
   * called the May 2024 attacker "Looks fine" on the app's own preset: the bait at block 19788642,
   * then the 1155 WBTC the victim signed at 19789009, both inside the scanned range.
   */
  it("still condemns a fake that came first, when the user then paid it", () => {
    const attacker = sighting({
      address: BOB,
      spoofedOutgoingCount: 1,
      firstSpoofedAt: NOW - 4400,
      outgoingCount: 1,
      firstOutgoingAt: NOW,
      lastOutgoingAt: NOW,
    });
    const result = assessAddress({to: BOB, history: [attacker], now: NOW});

    expect(result.level).toBe("danger");
    expect(result.findings[0]?.code).toBe("spoofed-outgoing-transfer");
    expect(result.findings[0]?.message).toContain("after the fake record appeared");
  });

  /** A history folded before the timestamps existed cannot show the order, so it earns nothing. */
  it("gives no exemption when the order is unknown", () => {
    const unknown = sighting({address: BOB, outgoingCount: 1, lastOutgoingAt: NOW, spoofedOutgoingCount: 1});
    expect(assessAddress({to: BOB, history: [unknown], now: NOW}).level).toBe("danger");
  });

  /** A lookalike the user paid by mistake, bait first: both signals, not just one. */
  it("still names the contact being imitated when the user paid a lookalike by mistake", () => {
    const paidByMistake = sighting({
      address: POISONED,
      outgoingCount: 1,
      spoofedOutgoingCount: 1,
      firstSpoofedAt: NOW - 2 * HOUR + 600,
      firstOutgoingAt: NOW - HOUR,
      lastOutgoingAt: NOW - HOUR,
      firstSeenAt: NOW - 2 * HOUR + 600,
    });
    const codes = assessAddress({to: POISONED, history: [alicePaid, paidByMistake], now: NOW}).findings.map(
      (f) => f.code,
    );

    expect(codes).toContain("spoofed-outgoing-transfer");
    expect(codes).toContain("lookalike-of-known-payee");
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

  /** "The endpoint did not answer" is no more evidence against an address than "never seen" is. */
  it("is not tipped into danger by records the scan could not check", () => {
    const result = assessAddress({
      to: BOB,
      history: [sighting({address: BOB, uncheckedCount: 3})],
      reports: [report({reporters: 6, verified: true, role: "lookalike"})],
      now: NOW,
    });

    expect(result.findings.map((f) => f.code)).toContain("unchecked-records");
    expect(result.score).toBeLessThanOrEqual(COMMUNITY_CAP);
    expect(result.level).toBe("caution");
  });
});

/**
 * Records the scan could not check, because the endpoint never said who signed them or when.
 *
 * They used to vanish. One refused lookup — the bait's — turned the attacker in the May 2024 case
 * from "do not send" into "looks fine", and the screen showed nothing missing. These hold the two
 * properties that make that impossible, over every shape of history rather than the one case.
 */
describe("records the scan could not check", () => {
  const anyHistory = fc.record({
    outgoingCount: fc.nat({max: 3}),
    incomingCount: fc.nat({max: 3}),
    zeroValueIncoming: fc.nat({max: 3}),
    dustIncoming: fc.nat({max: 3}),
    spoofedOutgoingCount: fc.nat({max: 2}),
  });

  it("make any address at least a caution, whatever else its history says", () => {
    fc.assert(
      fc.property(anyHistory, fc.integer({min: 1, max: 4}), (counts, unchecked) => {
        const result = assessAddress({
          to: BOB,
          history: [alicePaid, sighting({address: BOB, ...counts, uncheckedCount: unchecked})],
          now: NOW,
        });

        expect(result.level).not.toBe("safe");
        expect(result.findings.map((f) => f.code)).toContain("unchecked-records");
      }),
    );
  });

  it("never lower a score, so they cannot be used to soften a verdict", () => {
    fc.assert(
      fc.property(anyHistory, fc.integer({min: 1, max: 4}), (counts, unchecked) => {
        const without = assessAddress({to: BOB, history: [alicePaid, sighting({address: BOB, ...counts})], now: NOW});
        const withThem = assessAddress({
          to: BOB,
          history: [alicePaid, sighting({address: BOB, ...counts, uncheckedCount: unchecked})],
          now: NOW,
        });

        expect(withThem.score).toBeGreaterThanOrEqual(without.score);
      }),
    );
  });

  it("weigh exactly enough for a caution on their own, and no more", () => {
    expect(WEIGHTS.unchecked).toBeGreaterThanOrEqual(THRESHOLDS.caution);
    expect(WEIGHTS.unchecked).toBeLessThan(THRESHOLDS.danger);
  });
});
