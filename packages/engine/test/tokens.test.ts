import {describe, expect, it} from "vitest";

import {confusableSkeleton, inspectTokenSymbol, isPlainSymbol} from "../src/tokens.js";

/** `USDT` with a Cyrillic Т (U+0422) standing in for the Latin one. */
const CYRILLIC_USDT = "USDТ";
/** `USDC` with a zero-width space wedged in. */
const ZERO_WIDTH_USDC = "USD​C";

describe("confusableSkeleton", () => {
  it("leaves an honest symbol alone", () => {
    expect(confusableSkeleton("USDT")).toBe("USDT");
    expect(confusableSkeleton("WETH")).toBe("WETH");
  });

  it("folds cross-script homoglyphs to what they render as", () => {
    expect(CYRILLIC_USDT).not.toBe("USDT");
    expect(confusableSkeleton(CYRILLIC_USDT)).toBe("USDT");
  });

  it("drops invisible characters and surrounding padding", () => {
    expect(confusableSkeleton(ZERO_WIDTH_USDC)).toBe("USDC");
    expect(confusableSkeleton("  USDC  ")).toBe("USDC");
  });

  it("narrows fullwidth and subscript forms via NFKC", () => {
    expect(confusableSkeleton("ＵＳＤＴ")).toBe("USDT");
    expect(confusableSkeleton("USDT₀")).toBe("USDT0");
  });
});

describe("inspectTokenSymbol", () => {
  it("says nothing about a real symbol", () => {
    expect(inspectTokenSymbol("USDT", ["USDT", "USDC"])).toEqual([]);
  });

  it("catches a Cyrillic impersonation and names what it is imitating", () => {
    const findings = inspectTokenSymbol(CYRILLIC_USDT, ["USDT", "USDC"]);
    const issues = findings.map((f) => f.issue);

    expect(issues).toContain("mixed-scripts");
    expect(issues).toContain("confusable-with-known-symbol");

    const impersonation = findings.find((f) => f.issue === "confusable-with-known-symbol");
    expect(impersonation?.evidence["impersonating"]).toBe("USDT");
  });

  it("catches hidden characters and reports their code points", () => {
    const findings = inspectTokenSymbol(ZERO_WIDTH_USDC, ["USDC"]);
    const hidden = findings.find((f) => f.issue === "invisible-characters");

    expect(hidden?.evidence["codePoints"]).toEqual(["U+200B"]);
  });

  it("catches whitespace padding used to line a row up with a real token", () => {
    const issues = inspectTokenSymbol(" USDC", ["USDC"]).map((f) => f.issue);
    expect(issues).toContain("padded-whitespace");
  });

  it("does not accuse a symbol of impersonating something the user has never seen", () => {
    const issues = inspectTokenSymbol(CYRILLIC_USDT, ["DAI"]).map((f) => f.issue);

    expect(issues).toContain("mixed-scripts");
    expect(issues).not.toContain("confusable-with-known-symbol");
  });
});

describe("isPlainSymbol", () => {
  it("does not carry regex state between calls", () => {
    // A `g`-flagged regex would remember `lastIndex` here and give the wrong answer on the
    // second and third calls.
    expect(isPlainSymbol(ZERO_WIDTH_USDC)).toBe(false);
    expect(isPlainSymbol(ZERO_WIDTH_USDC)).toBe(false);
    expect(isPlainSymbol(ZERO_WIDTH_USDC)).toBe(false);
  });

  it("accepts ordinary tickers", () => {
    expect(isPlainSymbol("USDT")).toBe(true);
    expect(isPlainSymbol("WBTC")).toBe(true);
  });
});
