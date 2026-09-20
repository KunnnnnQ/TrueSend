import {describe, expect, it} from "vitest";

import {
  confusableSkeleton,
  hasNonAscii,
  inspectToken,
  inspectTokenSymbol,
  isPlainSymbol,
  type CanonicalToken,
} from "../src/tokens.js";
import type {Address} from "../src/address.js";

const REAL_USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7" as Address;
const CANONICAL: CanonicalToken[] = [
  {symbol: "USDT", address: REAL_USDT},
  {symbol: "USDC", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address},
  {symbol: "WETH", address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" as Address},
];

/**
 * Three fake USDT contracts, taken from a random sample of real wallets rather than invented.
 *
 * Every one of them was waved through by the homoglyph table this file used to rely on, which is
 * why that table is no longer what the detection rests on. See `analysis/README.md`.
 */
const REAL_FAKES = {
  /** `U+A4A4` (a Yi radical) followed by `5DT`. */
  yiRadical: {symbol: "\u{A4A4}5DT", address: "0x08dfd4651f1985d44aebc5a616c757c2373c8172"},
  /** `U+A4F4` (a Lisu letter), `S`, two invisible Khmer combining marks, `DT`. */
  lisuAndKhmer: {
    symbol: "\u{A4F4}S\u{17B4}\u{17B4}DT",
    address: "0x482849a5a7a9200364a913f390e6444f2e7acf0c",
  },
  /** Spelled perfectly in ASCII. Its only lie is where it lives. */
  rightNameWrongContract: {symbol: "USDT", address: "0x56208f118a87a41e6f78edf6dc9d70f385e150f7"},
} as const;

describe("the fakes that were actually found on chain", () => {
  it("catches the one built from a Yi radical", () => {
    const issues = inspectToken(REAL_FAKES.yiRadical, {canonical: CANONICAL}).map((f) => f.issue);
    expect(issues).toContain("non-ascii-symbol");
  });

  it("catches the one built from a Lisu letter and invisible Khmer marks", () => {
    const issues = inspectToken(REAL_FAKES.lisuAndKhmer, {canonical: CANONICAL}).map((f) => f.issue);
    expect(issues).toContain("non-ascii-symbol");
    expect(issues).toContain("invisible-characters");
  });

  /**
   * The sneakiest of the three. Nothing is wrong with the symbol at all — the tell is that the
   * real USDT is a different contract, which no amount of looking at the string can reveal.
   */
  it("catches the one whose symbol is spelled correctly", () => {
    const findings = inspectToken(REAL_FAKES.rightNameWrongContract, {canonical: CANONICAL});
    const impostor = findings.find((f) => f.issue === "known-symbol-wrong-contract");

    expect(impostor).toBeDefined();
    expect(impostor?.evidence["realAddress"]).toBe(REAL_USDT);
    expect(impostor?.message).toContain("the address is the only part that cannot be copied");
  });

  it("would have caught none of them by symbol shape alone", () => {
    // The point of the rewrite: two of the three are invisible to every rule that works by
    // comparing against a table of known lookalike characters.
    expect(confusableSkeleton(REAL_FAKES.yiRadical.symbol)).not.toBe("USDT");
    expect(confusableSkeleton(REAL_FAKES.rightNameWrongContract.symbol)).toBe("USDT");
  });
});

describe("the real thing", () => {
  it("passes clean", () => {
    expect(inspectToken({symbol: "USDT", address: REAL_USDT}, {canonical: CANONICAL})).toEqual([]);
  });

  it("does not complain about a token that is simply not on the canonical list", () => {
    const findings = inspectToken(
      {symbol: "SHIB", address: "0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce"},
      {canonical: CANONICAL},
    );
    expect(findings).toEqual([]);
  });

  it("leaves the genuine wrapped assets alone", () => {
    expect(inspectTokenSymbol("WETH", ["WETH"])).toEqual([]);
    expect(inspectTokenSymbol("WBTC", ["WBTC"])).toEqual([]);
  });
});

describe("non-ASCII, the rule that covers the whole class", () => {
  it("flags any character outside printable ASCII, whatever script it came from", () => {
    for (const symbol of ["\u{A4A4}SDT", "US\u{0414}T", "USD\u{0422}", "\u{FF35}SDT", "USDT\u{1F4B0}"]) {
      expect(hasNonAscii(symbol), symbol).toBe(true);
      expect(inspectTokenSymbol(symbol).map((f) => f.issue)).toContain("non-ascii-symbol");
    }
  });

  it("names the code points so the claim can be checked", () => {
    const finding = inspectTokenSymbol("\u{A4A4}5DT").find((f) => f.issue === "non-ascii-symbol");
    expect(finding?.evidence["codePoints"]).toEqual(["U+A4A4"]);
  });

  it("says nothing about an ordinary ticker", () => {
    for (const symbol of ["USDT", "WBTC", "DAI", "1INCH", "cbETH"]) {
      expect(hasNonAscii(symbol), symbol).toBe(false);
    }
  });
});

describe("native-asset impersonation", () => {
  /**
   * The bait in the May 2024 WBTC case: symbol "ETH", name "Ether", 6 decimals, spelled with
   * ordinary Latin letters. Nothing about the characters is wrong, which is the point.
   */
  it("catches a token contract calling itself ETH", () => {
    const issues = inspectTokenSymbol("ETH").map((f) => f.issue);
    expect(issues).toEqual(["impersonates-native-asset"]);
  });

  it("catches it even when it is also spelled with homoglyphs", () => {
    const issues = inspectTokenSymbol("ЕTH").map((f) => f.issue);
    expect(issues).toContain("impersonates-native-asset");
    expect(issues).toContain("non-ascii-symbol");
  });
});

describe("the narrower rules, which now add detail rather than coverage", () => {
  const CYRILLIC_USDT = "USDТ";
  const ZERO_WIDTH_USDC = "USD​C";

  it("still names which symbol a cross-script twin is imitating", () => {
    const findings = inspectTokenSymbol(CYRILLIC_USDT, ["USDT", "USDC"]);
    const impersonation = findings.find((f) => f.issue === "confusable-with-known-symbol");

    expect(impersonation?.evidence["impersonating"]).toBe("USDT");
    expect(findings.map((f) => f.issue)).toContain("mixed-scripts");
  });

  it("still catches hidden characters and reports their code points", () => {
    const hidden = inspectTokenSymbol(ZERO_WIDTH_USDC).find(
      (f) => f.issue === "invisible-characters",
    );
    expect(hidden?.evidence["codePoints"]).toEqual(["U+200B"]);
  });

  it("still catches whitespace padding", () => {
    expect(inspectTokenSymbol(" USDC").map((f) => f.issue)).toContain("padded-whitespace");
  });

  it("does not accuse a symbol of imitating something the user has never seen", () => {
    const issues = inspectTokenSymbol(CYRILLIC_USDT, ["DAI"]).map((f) => f.issue);
    expect(issues).not.toContain("confusable-with-known-symbol");
  });
});

describe("confusableSkeleton", () => {
  it("leaves an honest symbol alone", () => {
    expect(confusableSkeleton("USDT")).toBe("USDT");
  });

  it("folds cross-script twins to what they render as", () => {
    expect(confusableSkeleton("USDТ")).toBe("USDT");
  });

  it("drops invisible characters and surrounding padding", () => {
    expect(confusableSkeleton("USD​C")).toBe("USDC");
    expect(confusableSkeleton("  USDC  ")).toBe("USDC");
  });

  it("narrows fullwidth and subscript forms via NFKC", () => {
    expect(confusableSkeleton("ＵＳＤＴ")).toBe("USDT");
    expect(confusableSkeleton("USDT₀")).toBe("USDT0");
  });

  it("drops the invisible Khmer marks a real fake used as filler", () => {
    expect(confusableSkeleton("S\u{17B4}\u{17B4}DT")).toBe("SDT");
  });
});

describe("isPlainSymbol", () => {
  it("does not carry regex state between calls", () => {
    for (let i = 0; i < 3; i++) expect(isPlainSymbol("USD​C")).toBe(false);
  });

  it("rejects anything with a character from another script", () => {
    expect(isPlainSymbol("\u{A4A4}5DT")).toBe(false);
  });

  it("accepts ordinary tickers", () => {
    expect(isPlainSymbol("USDT")).toBe(true);
    expect(isPlainSymbol("WBTC")).toBe(true);
  });
});
