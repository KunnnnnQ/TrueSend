import fc from "fast-check";
import {describe, expect, it} from "vitest";

import {
  FINGERPRINT_BITS,
  FINGERPRINT_WORDS,
  compareFingerprints,
  fingerprint,
  identiconSvg,
  sharedPrefixLength,
  sharedSuffixLength,
} from "../src/fingerprint.js";
import {checkAddressFormat, normalizeAddress, toChecksumAddress} from "../src/address.js";

/** A 20-byte address, as a `0x`-prefixed lower-case hex string. */
const anyAddress = fc
  .uint8Array({minLength: 20, maxLength: 20})
  .map((bytes) => `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`);

describe("checksum", () => {
  // Straight from EIP-55.
  it.each([
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
    "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
  ])("reproduces the reference vector %s", (vector) => {
    expect(toChecksumAddress(vector.toLowerCase())).toBe(vector);
    expect(toChecksumAddress(vector)).toBe(vector);
  });

  it("is idempotent and preserves the underlying address", () => {
    fc.assert(
      fc.property(anyAddress, (address) => {
        const once = toChecksumAddress(address);
        expect(toChecksumAddress(once)).toBe(once);
        expect(normalizeAddress(once)).toBe(normalizeAddress(address));
      }),
    );
  });
});

describe("fingerprint", () => {
  it("produces four dictionary words and a colour", () => {
    const fp = fingerprint("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");

    expect(fp.words).toHaveLength(FINGERPRINT_WORDS);
    expect(fp.phrase.split(" ")).toHaveLength(FINGERPRINT_WORDS);
    expect(fp.bits).toBe(FINGERPRINT_BITS);
    expect(fp.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(fp.hue).toBeGreaterThanOrEqual(0);
    expect(fp.hue).toBeLessThan(360);
    for (const word of fp.words) expect(word).toMatch(/^[a-z]+$/);
  });

  it("ignores how the address is capitalised", () => {
    fc.assert(
      fc.property(anyAddress, (address) => {
        const lower = fingerprint(address);
        const upper = fingerprint(`0x${address.slice(2).toUpperCase()}`);
        const checksummed = fingerprint(toChecksumAddress(address));

        expect(upper.phrase).toBe(lower.phrase);
        expect(checksummed.phrase).toBe(lower.phrase);
      }),
    );
  });

  it("is deterministic", () => {
    fc.assert(
      fc.property(anyAddress, (address) => {
        expect(fingerprint(address).phrase).toBe(fingerprint(address).phrase);
      }),
    );
  });

  /**
   * The security claim in one test. Two addresses that a wallet would render identically must
   * still get different phrases — otherwise the fingerprint adds nothing over the short hex form
   * it is meant to backstop.
   */
  it("separates addresses that share the characters a wallet shows", () => {
    fc.assert(
      fc.property(anyAddress, anyAddress, (a, b) => {
        fc.pre(normalizeAddress(a) !== normalizeAddress(b));

        // Force b to share a's first 6 and last 4 hex characters, as a ground-out address would.
        const forged = `0x${a.slice(2, 8)}${b.slice(8, 38)}${a.slice(38)}`;
        fc.pre(normalizeAddress(forged) !== normalizeAddress(a));

        expect(sharedPrefixLength(a, forged)).toBeGreaterThanOrEqual(6);
        expect(sharedSuffixLength(a, forged)).toBeGreaterThanOrEqual(4);
        expect(fingerprint(forged).phrase).not.toBe(fingerprint(a).phrase);
      }),
      {numRuns: 500},
    );
  });

  it("does not collide across a large sample of random addresses", () => {
    const seen = new Map<string, string>();
    let collisions = 0;

    fc.assert(
      fc.property(anyAddress, (address) => {
        const key = fingerprint(address).phrase;
        const previous = seen.get(key);
        if (previous !== undefined && previous !== normalizeAddress(address)) collisions++;
        seen.set(key, normalizeAddress(address));
      }),
      {numRuns: 4000},
    );

    // 44 bits over a few thousand samples: the birthday bound puts the expected count far below 1.
    expect(collisions).toBe(0);
  });
});

describe("compareFingerprints", () => {
  it("reports an address as identical to itself however it is written", () => {
    const address = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    const comparison = compareFingerprints(address, address.toLowerCase());

    expect(comparison.identical).toBe(true);
    expect(comparison.differingWordPositions).toEqual([]);
    expect(comparison.sharedPrefix).toBe(40);
    expect(comparison.sharedSuffix).toBe(40);
  });

  it("names the word positions that differ", () => {
    const legit = "0xab58c49b70d5e2f1a0c9f3d7e6b4a2c8d1f00e93";
    const poisoned = "0xab58c41122334455667788990011223344ff0e93";

    const comparison = compareFingerprints(legit, poisoned);

    expect(comparison.identical).toBe(false);
    expect(comparison.sharedPrefix).toBe(6);
    expect(comparison.sharedSuffix).toBe(4);
    expect(comparison.differingWordPositions.length).toBeGreaterThan(0);
  });
});

describe("identicon", () => {
  it("is horizontally symmetric, which is what makes it read as a glyph", () => {
    const {cells} = fingerprint("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed").identicon;

    expect(cells).toHaveLength(25);
    for (let row = 0; row < 5; row++) {
      for (let column = 0; column < 5; column++) {
        expect(cells[row * 5 + column]).toBe(cells[row * 5 + (4 - column)]);
      }
    }
  });

  it("keeps its two colours far enough apart to read as two colours", () => {
    fc.assert(
      fc.property(anyAddress, (address) => {
        const fp = fingerprint(address);
        const distance = Math.abs(hueOf(fp.identicon.foreground) - hueOf(fp.identicon.accent));
        expect(Math.min(distance, 360 - distance)).toBeGreaterThanOrEqual(90);
      }),
      {numRuns: 300},
    );
  });

  /**
   * The failure this guards against is specific: an earlier version keyed the whole visual on a
   * single hue, and two unrelated addresses rendered as near-identical chips. The glyph exists so
   * that a pair a user is asked to tell apart actually looks different.
   */
  it("gives visibly different glyphs to addresses that share their visible hex", () => {
    const legit = "0xab58c49b70d5e2f1a0c9f3d7e6b4a2c8d1f00e93";
    const poisoned = "0xab58c41122334455667788990011223344ff0e93";

    const a = fingerprint(legit).identicon.cells;
    const b = fingerprint(poisoned).identicon.cells;
    const differing = a.filter((cell, i) => cell !== b[i]).length;

    expect(differing).toBeGreaterThan(0);
  });

  it("renders to standalone SVG carrying the phrase as its label", () => {
    const fp = fingerprint("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
    const svg = identiconSvg(fp, 40);

    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain(`aria-label="Address fingerprint ${fp.phrase}"`);
    expect(svg).toContain("</svg>");
  });
});

/** Recover a hue in degrees from a hex colour, for the colour-distance property above. */
function hueOf(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  return (hue * 60 + 360) % 360;
}

describe("checkAddressFormat", () => {
  it("accepts an all-lowercase address, which carries no checksum to check", () => {
    expect(checkAddressFormat("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")).toBe("valid");
  });

  it("accepts an all-uppercase address for the same reason", () => {
    expect(checkAddressFormat("0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED")).toBe("valid");
  });

  it("accepts a correctly checksummed address", () => {
    expect(checkAddressFormat("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).toBe("valid");
  });

  /**
   * The case worth separating. A mixed-case address whose capitalisation does not match its own
   * hash has been altered somewhere, which is a finding rather than a typo.
   */
  it("reports a mixed-case address with the wrong capitalisation as altered", () => {
    expect(checkAddressFormat("0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).toBe("bad-checksum");
  });

  it("reports anything that is not 40 hex characters as not an address", () => {
    expect(checkAddressFormat("0x1234")).toBe("not-an-address");
    expect(checkAddressFormat("nope")).toBe("not-an-address");
    expect(checkAddressFormat("")).toBe("not-an-address");
  });

  it("agrees with itself over random addresses", () => {
    fc.assert(
      fc.property(anyAddress, (address) => {
        expect(checkAddressFormat(address)).toBe("valid");
        expect(checkAddressFormat(toChecksumAddress(address))).toBe("valid");
      }),
    );
  });
});
