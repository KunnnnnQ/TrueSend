import fc from "fast-check";
import {describe, expect, it} from "vitest";

import {collidingAddresses, collidingPairs, findAddresses} from "../src/scan.js";
import type {Address} from "../src/address.js";

const ALICE = "0xab58c49b70d5e2f1a0c9f3d7e6b4a2c8d1f00e93";
/** Ground out to share Alice's first six and last four characters. */
const POISONED = "0xab58c41122334455667788990011223344ff0e93";
const BOB = "0x742d35cc6634c0532925a3b844bc454e4438f44e";

describe("findAddresses", () => {
  it("finds an address on its own", () => {
    const [found] = findAddresses(ALICE);
    expect(found?.address).toBe(ALICE);
    expect(found?.index).toBe(0);
  });

  it("finds several in running text and keeps their positions", () => {
    const text = `Sent to ${ALICE} and then to ${BOB}.`;
    const found = findAddresses(text);

    expect(found.map((m) => m.address)).toEqual([ALICE, BOB]);
    expect(text.slice(found[1]!.index, found[1]!.index + 42)).toBe(BOB);
  });

  it("keeps the original capitalisation so a caller can highlight it", () => {
    const checksummed = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    const [found] = findAddresses(`pay ${checksummed} now`);

    expect(found?.raw).toBe(checksummed);
    expect(found?.address).toBe(checksummed.toLowerCase());
  });

  /**
   * A transaction hash is 64 hex characters, and its first 40 look exactly like an address. A
   * page full of hashes would otherwise produce a page full of false addresses.
   */
  it("does not mistake the start of a transaction hash for an address", () => {
    const hash = "0x3374abc5a9c766ba709651399b6e6162de97ca986abc23f423a9d893c8f5f570";
    expect(findAddresses(hash)).toEqual([]);
  });

  it("finds an address that ends where the hex ends", () => {
    expect(findAddresses(`${ALICE} done`)).toHaveLength(1);
    expect(findAddresses(`${ALICE}, done`)).toHaveLength(1);
  });

  it("finds nothing in text with no addresses", () => {
    expect(findAddresses("nothing to see here, 0x1234 is too short")).toEqual([]);
  });
});

describe("collidingPairs", () => {
  /**
   * The property the page scan rests on. Two entries in the same list that a wallet would render
   * identically is a fact about what is on the screen, not a guess about intent.
   */
  it("spots two addresses a wallet would render the same", () => {
    const [pair] = collidingPairs([ALICE, POISONED, BOB]);

    expect(pair).toBeDefined();
    expect([pair!.a, pair!.b].sort()).toEqual([ALICE, POISONED].sort());
    expect(pair!.sharedPrefix).toBe(6);
    expect(pair!.sharedSuffix).toBe(4);
  });

  it("says nothing about a page of unrelated addresses", () => {
    expect(collidingPairs([ALICE, BOB])).toEqual([]);
  });

  it("ignores an address listed more than once", () => {
    expect(collidingPairs([ALICE, ALICE, ALICE])).toEqual([]);
  });

  it("does not care how the addresses are capitalised", () => {
    const pairs = collidingPairs([ALICE.toUpperCase().replace("0X", "0x"), POISONED]);
    expect(pairs).toHaveLength(1);
  });

  it("puts the closest imitation first", () => {
    // Shares eight leading characters rather than six, so it is the more deliberate copy.
    const closer = `0x${ALICE.slice(2, 10)}${"5".repeat(28)}${ALICE.slice(38)}`;
    const pairs = collidingPairs([ALICE, POISONED, closer]);

    expect(pairs[0]?.sharedPrefix).toBeGreaterThan(6);
  });

  it("reports every address that is part of a collision", () => {
    const flagged = collidingAddresses(collidingPairs([ALICE, POISONED, BOB]));

    expect(flagged.has(ALICE as Address)).toBe(true);
    expect(flagged.has(POISONED as Address)).toBe(true);
    expect(flagged.has(BOB as Address)).toBe(false);
  });

  it("stays fast on a page with hundreds of addresses", () => {
    const many = Array.from(
      {length: 800},
      (_, i) => `0x${i.toString(16).padStart(40, "0")}` as Address,
    );

    const started = performance.now();
    const pairs = collidingPairs([...many, ALICE, POISONED]);
    const elapsed = performance.now() - started;

    // Bucketed rather than pairwise: 800 addresses is 320k comparisons the naive way.
    expect(elapsed).toBeLessThan(100);
    expect(pairs).toHaveLength(1);
  });

  const anyAddress = fc
    .uint8Array({minLength: 20, maxLength: 20})
    .map((bytes) => `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`);

  it("never reports a pair that does not actually share both affixes", () => {
    fc.assert(
      fc.property(fc.array(anyAddress, {minLength: 2, maxLength: 30}), (addresses) => {
        for (const pair of collidingPairs(addresses)) {
          expect(pair.sharedPrefix).toBeGreaterThanOrEqual(4);
          expect(pair.sharedSuffix).toBeGreaterThanOrEqual(4);
          expect(pair.a).not.toBe(pair.b);
        }
      }),
    );
  });

  it("finds a forged lookalike whatever the rest of the address is", () => {
    fc.assert(
      fc.property(anyAddress, anyAddress, (real, filler) => {
        const forged = `0x${real.slice(2, 8)}${filler.slice(8, 38)}${real.slice(38)}`;
        fc.pre(forged.toLowerCase() !== real.toLowerCase());

        expect(collidingPairs([real, forged])).toHaveLength(1);
      }),
      {numRuns: 300},
    );
  });
});
