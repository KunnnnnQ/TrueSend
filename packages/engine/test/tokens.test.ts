import {describe, expect, it} from "vitest";

import type {TransferRecord} from "../src/history.js";
import {
  checkTokens,
  confusableSkeleton,
  hasNonAscii,
  inspectToken,
  inspectTokenSymbol,
  isPlainSymbol,
  judgeToken,
  matchFlaggedToken,
  restrictionLevel,
  revealSymbol,
  type CanonicalToken,
  type FlaggedToken,
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
  /**
   * `U`, `5`, two invisible Khmer marks, `D`, and `U+A4D4` — a Lisu letter drawn like a `T`.
   *
   * **The first of these the rules were not built from.** The three above were found in a random
   * sample and the class-covering rules that replaced the homoglyph table were written to catch
   * them. This one was on a live Blockscout page on 2026-09-26, in the token transfers of an
   * account being poisoned at the time — beside eight more fake USDT contracts in three symbol
   * families, two of which are the ones above. It is the test of the claim the rewrite made: that
   * asking "is this ASCII?" catches the next homoglyph without anyone having to know it.
   */
  khmerFillerAndLisuT: {
    symbol: "U5\u{17B4}\u{17B4}D\u{A4D4}",
    address: "0x952583c189e79f41c7f65509188bce39ebad4510",
  },
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

  /**
   * The one that matters most here, because no rule was written to catch it. If the detection
   * rested on a table of known lookalike characters this is where it would fail.
   */
  it("catches a fake it was never built from", () => {
    const issues = inspectToken(REAL_FAKES.khmerFillerAndLisuT, {canonical: CANONICAL}).map((f) => f.issue);

    expect(issues).toContain("non-ascii-symbol");
    expect(issues).toContain("invisible-characters");
    expect(issues).toContain("mixed-scripts");
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

describe("native-asset impersonation, with decoration", () => {
  /**
   * A live bait token, found in the token transfers of an account being poisoned on 2026-09-26:
   * contract 0x5bc57682a5605f3c1e3e0a1cc0cab0117afe85f8, symbol and name both `Ether..`, 18
   * decimals, `balanceOf` reverting for the account it named as sender. Two ASCII dots defeated
   * the exact-match rule that had caught the May 2024 case.
   */
  it("catches the two-dot variant that got past an exact match", () => {
    expect(inspectTokenSymbol("Ether..").map((f) => f.issue)).toContain("impersonates-native-asset");
  });

  it("catches the other things an attacker adds for free", () => {
    for (const symbol of ["ETH.", "E.T.H", "ETH!", "ETH-", "_ETH_", "Ether...", "ETH\t"]) {
      expect(inspectTokenSymbol(symbol).map((f) => f.issue), JSON.stringify(symbol)).toContain(
        "impersonates-native-asset",
      );
    }
  });

  /**
   * The other side of it, which is what makes widening the rule safe to ship: only separators and
   * punctuation are stripped, so a token that is really something else is left alone.
   */
  it("does not accuse a real token whose symbol merely starts with those letters", () => {
    for (const symbol of ["WETH", "ETH2", "ETH2x", "stETH", "cbETH", "rETH", "ETHX", "BTCB", "WBTC", "ETC", "SOLO"]) {
      expect(inspectTokenSymbol(symbol).map((f) => f.issue), symbol).not.toContain("impersonates-native-asset");
    }
  });

  it("shows the symbol in a form that cannot hide what is wrong with it", () => {
    const issue = inspectTokenSymbol("ET\u{FFF0}H").find((f) => f.issue === "impersonates-native-asset");

    // The message names the code point instead of embedding an invisible one.
    expect(issue?.message).toContain("U+FFF0");
    expect(issue?.message).not.toContain("\u{FFF0}");
  });
});

/**
 * Found by measuring rather than by thinking about it. Run over Uniswap's curated default list for
 * Ethereum mainnet — 407 tokens that are what they say — the native-asset rule flagged three:
 * MATIC, SOL and POL. Each is an ordinary, widely held ERC-20 on Ethereum; the rule had listed every
 * chain's currency as "cannot be a token", which is only true of the chain you are on.
 */
describe("the native-asset rule, on the chain it is running on", () => {
  it("does not accuse another chain's currency of being a counterfeit on this one", () => {
    for (const symbol of ["MATIC", "POL", "SOL", "BNB", "AVAX", "BTC"]) {
      expect(inspectTokenSymbol(symbol).map((f) => f.issue), symbol).not.toContain("impersonates-native-asset");
    }
  });

  it("still accuses this chain's own", () => {
    for (const symbol of ["ETH", "Ether", "ether"]) {
      expect(inspectTokenSymbol(symbol).map((f) => f.issue), symbol).toContain("impersonates-native-asset");
    }
  });

  it("lets a caller running on another chain say what its currency is", () => {
    const on = (symbol: string) =>
      inspectToken({symbol}, {nativeSymbols: ["bnb"]}).map((f) => f.issue);

    expect(on("BNB")).toContain("impersonates-native-asset");
    expect(on("ETH")).not.toContain("impersonates-native-asset");
  });

  /**
   * `ETH+`, `USD+` and `DAI+` are real tokens. The first version of the decoration rule stripped
   * every non-alphanumeric character and flagged `ETH+` — found the same way, on CoinGecko's list.
   */
  it("does not treat a plus sign as decoration, because real tokens carry one", () => {
    expect(inspectTokenSymbol("ETH+").map((f) => f.issue)).not.toContain("impersonates-native-asset");
  });
});

/**
 * Whether a token that is spelled strangely is being used against the account or is merely
 * strange. The numbers behind it: CoinGecko's list, about six thousand Ethereum tokens, flags
 * twelve, and roughly half are legitimate tokens with a Chinese ticker or an emoji in it.
 */
describe("judgeToken", () => {
  const spelling = inspectTokenSymbol("\u{A4A4}5DT");
  const impersonation = inspectToken(
    {symbol: "USDT", address: "0x56208f118a87a41e6f78edf6dc9d70f385e150f7"},
    {canonical: CANONICAL},
  );

  it("calls a clean token clean", () => {
    expect(judgeToken([], 0)).toBe("clean");
    expect(judgeToken([], 9)).toBe("clean");
  });

  it("calls a strange spelling unusual when nothing was done to the account with it", () => {
    expect(spelling.length).toBeGreaterThan(0);
    expect(judgeToken(spelling, 0)).toBe("unusual");
  });

  it("calls the same spelling counterfeit once it was used against the account", () => {
    expect(judgeToken(spelling, 1)).toBe("counterfeit");
  });

  /** A perfectly spelled USDT at the wrong contract has no odd characters and needs no history. */
  it("calls a token that claims to be a specific real asset counterfeit however it got there", () => {
    expect(impersonation.map((f) => f.issue)).toContain("known-symbol-wrong-contract");
    expect(judgeToken(impersonation, 0)).toBe("counterfeit");
  });

  it("calls a fake native currency counterfeit on its own", () => {
    expect(judgeToken(inspectTokenSymbol("Ether.."), 0)).toBe("counterfeit");
  });

  it("calls a contract that forged transfers counterfeit, whatever its name", () => {
    expect(judgeToken([], 1, 1)).toBe("counterfeit");
  });
});

/**
 * Three fakes from live accounts (`analysis/src/live-accounts.mjs`) that every rule about names let
 * through, because there was nothing wrong with the names: a "cbBTC" that is not Coinbase's — the
 * canonical list does not know cbBTC — and two contracts with no name at all, each of which forged
 * three hundred transfers in one transaction. What convicts them is their own records.
 */
describe("checkTokens: a contract that forges its own transfers", () => {
  const OWNER = "0x1111111111111111111111111111111111111111" as Address;
  const PLANTER = "0x2222222222222222222222222222222222222222" as Address;
  const LOOKALIKE = "0x3333333333333333333333333333333333333333" as Address;
  const FAKE_CBBTC = "0xf08f6ff75b72897e716c0afa8d75544cfbc5afb7" as Address;
  const NAMELESS = "0x814e949a5fa573dacbb62f7d8f93f4a2433bc230" as Address;
  const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address;

  /** The account "sending" a nonzero amount it never held, in a transaction somebody else signed. */
  const forgery = (token: Address): TransferRecord => ({
    token,
    from: OWNER,
    to: LOOKALIKE,
    value: 20_002_421n,
    at: 1,
    signer: PLANTER,
  });

  it("is caught under an ordinary name the canonical list does not know", () => {
    const check = checkTokens(
      OWNER,
      [forgery(FAKE_CBBTC)],
      [{address: FAKE_CBBTC, symbol: "cbBTC", name: "cbBTC"}],
      {canonical: CANONICAL},
    );

    expect(check.counterfeit.map((t) => t.address)).toEqual([FAKE_CBBTC]);
    expect(check.counterfeit[0]?.forged).toBe(1);
    expect(check.counterfeit[0]?.findings).toEqual([]);
  });

  it("is caught with an empty name, and when it will not say a name at all", () => {
    const empty = checkTokens(OWNER, [forgery(NAMELESS)], [{address: NAMELESS, symbol: "", name: ""}]);
    expect(empty.counterfeit).toHaveLength(1);

    const silent = checkTokens(OWNER, [forgery(NAMELESS)], [{address: NAMELESS, symbol: null, name: null}]);
    expect(silent.counterfeit).toHaveLength(1);
    expect(silent.unreadable).toBe(0);
  });

  /** Zero-value poisoning runs on real USDC. The record is planted; the contract is genuine. */
  it("leaves a real token used for zero-value poisoning alone", () => {
    const zeroValue = {...forgery(USDC), value: 0n};
    const check = checkTokens(OWNER, [zeroValue], [{address: USDC, symbol: "USDC", name: "USD Coin"}], {
      canonical: CANONICAL,
    });

    expect(check.counterfeit).toEqual([]);
    expect(check.unusual).toEqual([]);
  });

  /** A solver settling an order the account signed for moves a token the account really holds. */
  it("leaves a token the account received alone when somebody else moves it", () => {
    const received: TransferRecord = {...forgery(NAMELESS), from: PLANTER, to: OWNER};
    const check = checkTokens(OWNER, [received, forgery(NAMELESS)], [{address: NAMELESS, symbol: "TKN", name: "Token"}]);

    expect(check.counterfeit).toEqual([]);
  });

  it("still counts a token that will not say its name and forged nothing as unreadable, not clean", () => {
    const check = checkTokens(OWNER, [], [{address: NAMELESS, symbol: null, name: null}]);
    expect(check).toMatchObject({checked: 1, unreadable: 1, counterfeit: [], unusual: []});
  });

  /** "Would not say" is a fact about the contract; a refused request is not, and is kept apart. */
  it("counts a token the endpoint never answered for apart from one that would not say", () => {
    const check = checkTokens(OWNER, [], [
      {address: NAMELESS, symbol: null, name: null, unanswered: true},
      {address: FAKE_CBBTC, symbol: null, name: null},
    ]);
    expect(check).toMatchObject({checked: 2, unreadable: 1, unanswered: 1, counterfeit: [], unusual: []});
  });

  it("still convicts a token nobody could ask, on its own records", () => {
    const check = checkTokens(OWNER, [forgery(NAMELESS)], [
      {address: NAMELESS, symbol: null, name: null, unanswered: true},
    ]);
    expect(check.counterfeit.map((t) => t.address)).toEqual([NAMELESS]);
    expect(check.unanswered).toBe(0);
  });

  /** A received transfer may come without its signer; only a record naming the owner as sender needs one. */
  it("reads a received transfer with no signer, and a sent one with none as not the owner's", () => {
    const received: TransferRecord = {token: NAMELESS, from: PLANTER, to: OWNER, value: 0n, at: 1};
    const unsignedSend: TransferRecord = {token: NAMELESS, from: OWNER, to: LOOKALIKE, value: 0n, at: 2};
    const check = checkTokens(OWNER, [received, unsignedSend], [{address: NAMELESS, symbol: "USDT", name: "Tether"}], {
      canonical: CANONICAL,
    });

    expect(check.counterfeit.map((t) => t.planted)).toEqual([2]);
  });
});

/**
 * The second tier: about four hundred tokens from Uniswap's default list (`LISTED_TOKENS` in
 * @truesend/chain). A name match there is a question, not a verdict, because tickers are not
 * unique — that list itself holds two different `LIT`s.
 */
describe("checkTokens: the listed tier", () => {
  const OWNER = "0x1111111111111111111111111111111111111111" as Address;
  const PLANTER = "0x2222222222222222222222222222222222222222" as Address;
  const REAL_DAI = "0x6b175474e89094c44da98b954eedeac495271d0f" as Address;
  const FAKE_DAI = "0x5555555555555555555555555555555555555555" as Address;
  const LISTED: CanonicalToken[] = [
    {symbol: "DAI", address: REAL_DAI},
    {symbol: "LIT", address: "0x232ce3bd40fcd6f80f3d55a522d03f25df784ee2" as Address},
    {symbol: "LIT", address: "0xb59490ab09a0f526cc7305822ac65f2ab12f9723" as Address},
    {symbol: "USDT", address: REAL_USDT},
  ];
  /** Zero-value poisoning, which needs no forged balance and runs on any contract. */
  const zeroValueIn = (token: Address): TransferRecord => ({token, from: PLANTER, to: OWNER, value: 0n, at: 1, signer: PLANTER});
  const dai = (address: Address) => [{address, symbol: "DAI", name: "Dai Stablecoin"}];

  it("questions a listed name at another contract, without calling it counterfeit", () => {
    const check = checkTokens(OWNER, [], dai(FAKE_DAI), {canonical: CANONICAL, listed: LISTED});

    expect(check.counterfeit).toEqual([]);
    expect(check.unusual.map((t) => t.findings.map((f) => f.issue))).toEqual([["listed-symbol-wrong-contract"]]);
  });

  /** The fake that only ever plants zero-value records: invisible to the forgery rule, not to this. */
  it("calls it counterfeit once it has been used against the account", () => {
    const check = checkTokens(OWNER, [zeroValueIn(FAKE_DAI)], dai(FAKE_DAI), {canonical: CANONICAL, listed: LISTED});
    expect(check.counterfeit.map((t) => t.address)).toEqual([FAKE_DAI]);
  });

  it("leaves the real one alone", () => {
    const check = checkTokens(OWNER, [zeroValueIn(REAL_DAI)], dai(REAL_DAI), {canonical: CANONICAL, listed: LISTED});
    expect(check).toMatchObject({counterfeit: [], unusual: []});
  });

  it("leaves both of two real tokens that share a ticker alone", () => {
    for (const lit of LISTED.filter((t) => t.symbol === "LIT")) {
      expect(inspectToken({symbol: "LIT", address: lit.address}, {listed: LISTED})).toEqual([]);
    }
  });

  it("does not repeat what the stronger tier already said", () => {
    const issues = inspectToken(REAL_FAKES.rightNameWrongContract, {canonical: CANONICAL, listed: LISTED}).map(
      (f) => f.issue,
    );
    expect(issues).toContain("known-symbol-wrong-contract");
    expect(issues).not.toContain("listed-symbol-wrong-contract");
  });

  /** A DAI balance from before the scanned window, moved by a spender the account approved. */
  it("never convicts a listed token on forged records, which a real token cannot make", () => {
    const moved: TransferRecord = {token: REAL_DAI, from: OWNER, to: PLANTER, value: 5_000n, at: 1, signer: PLANTER};
    const check = checkTokens(OWNER, [moved], dai(REAL_DAI), {canonical: CANONICAL, listed: LISTED});
    expect(check).toMatchObject({counterfeit: [], unusual: []});
  });
});

describe("matchFlaggedToken", () => {
  const fakeUsdt: FlaggedToken = {
    address: REAL_FAKES.rightNameWrongContract.address as Address,
    symbol: "USDT",
    name: null,
    transfers: 2,
    planted: 2,
    findings: inspectToken(REAL_FAKES.rightNameWrongContract, {canonical: CANONICAL}),
  };
  const memeCoin: FlaggedToken = {
    address: "0x952583c189e79f41c7f65509188bce39ebad4510" as Address,
    symbol: "BTC.ℏ",
    name: "Some meme coin",
    transfers: 1,
    planted: 0,
    findings: inspectTokenSymbol("BTC.ℏ"),
  };
  const flagged = {counterfeit: [fakeUsdt], unusual: [memeCoin]};

  it("finds a counterfeit by address and says which tier it was", () => {
    expect(matchFlaggedToken(flagged, fakeUsdt.address)).toEqual({
      token: fakeUsdt,
      verdict: "counterfeit",
    });
  });

  it("finds an unusual token too, distinguished from a counterfeit", () => {
    expect(matchFlaggedToken(flagged, memeCoin.address)).toEqual({
      token: memeCoin,
      verdict: "unusual",
    });
  });

  it("matches regardless of checksum casing, like every other address comparison here", () => {
    expect(matchFlaggedToken(flagged, fakeUsdt.address.toUpperCase().replace("0X", "0x") as Address)).toEqual({
      token: fakeUsdt,
      verdict: "counterfeit",
    });
  });

  it("finds nothing for an address no scan ever judged", () => {
    expect(matchFlaggedToken(flagged, REAL_USDT)).toBeUndefined();
  });

  it("finds nothing when nothing was ever flagged", () => {
    expect(matchFlaggedToken({counterfeit: [], unusual: []}, fakeUsdt.address)).toBeUndefined();
  });
});

describe("revealSymbol", () => {
  it("leaves an ordinary ticker exactly as it is", () => {
    expect(revealSymbol("USDT")).toBe("USDT");
    expect(revealSymbol("1INCH")).toBe("1INCH");
  });

  it("names every character outside printable ASCII, including the ones nobody can see", () => {
    expect(revealSymbol("U5\u{17B4}\u{17B4}D\u{A4D4}")).toBe("U5⟨U+17B4⟩⟨U+17B4⟩D⟨U+A4D4⟩");
  });

  /** A right-to-left override reorders the text around it; printing it as a code point cannot. */
  it("defuses a bidi override rather than passing it to whatever displays the result", () => {
    const out = revealSymbol("ABC\u{202E}DEF");

    expect(out).toBe("ABC⟨U+202E⟩DEF");
    expect(out).not.toContain("\u{202E}");
  });

  it("names a character outside the basic plane once, not as two halves", () => {
    expect(revealSymbol("USDT\u{1F4B0}")).toBe("USDT⟨U+1F4B0⟩");
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

/**
 * The rules here were arrived at by being wrong three times and then turned out to be a published
 * standard. These check the alignment is real rather than a claim in a comment.
 *
 * UTS #39, Unicode Security Mechanisms, revision 34 (2026-08-27).
 */
describe("alignment with UTS #39", () => {
  it("reports the restriction level a reader can check against the standard", () => {
    expect(restrictionLevel("USDT")).toBe("ascii-only");
    expect(restrictionLevel("\u{A4A4}5DT")).toBe("unrestricted");
    expect(restrictionLevel("\u0414\u0422")).toBe("single-script");
  });

  it("names the level and the standard in the finding, not just a verdict", () => {
    const finding = inspectTokenSymbol("\u{A4A4}5DT").find((f) => f.issue === "non-ascii-symbol");

    expect(finding?.evidence["restrictionLevel"]).toBe("unrestricted");
    expect(finding?.evidence["standard"]).toBe("UTS #39 ASCII-Only");
  });

  /**
   * `Default_Ignorable_Code_Point` is the set the standard's `skeleton()` removes. Reaching for
   * the property instead of enumerating characters is the same lesson as the ASCII rule: the
   * hand-written list this replaced did not contain U+17B4, and a real fake used it.
   */
  it("drops every default-ignorable character, including the one the old list missed", () => {
    for (const invisible of ["\u{17B4}", "\u{200B}", "\u{FEFF}", "\u{00AD}", "\u{202E}", "\u{2060}"]) {
      expect(confusableSkeleton(`USD${invisible}T`), invisible).toBe("USDT");
    }
  });

  /**
   * The standard defines X and Y as confusable when `skeleton(X) == skeleton(Y)` — both sides
   * folded. Folding only the candidate happens to work for ASCII tickers and is not what the
   * standard says, so a canonical entry that itself needs folding would have been missed.
   */
  it("folds both sides when comparing, as the standard defines it", () => {
    const canonical = [
      {symbol: "USD\u200BT", address: "0xdac17f958d2ee523a2206206994597c13d831ec7" as Address},
    ];
    const findings = inspectToken(
      {symbol: "USD\u0422", address: "0x0000000000000000000000000000000000000099"},
      {canonical},
    );

    expect(findings.map((f) => f.issue)).toContain("known-symbol-wrong-contract");
  });

  it("still folds the compatibility forms NFKC covers and the standard gets from confusables.txt", () => {
    expect(confusableSkeleton("\uFF35\uFF33\uFF24\uFF34")).toBe("USDT");
  });
});

/**
 * The level is computed without a script table, so it has an edge. These pin both sides of it:
 * what the shortcut buys, and the one case where it understates.
 */
describe("counting alphabets without a table of them", () => {
  /**
   * The failure that prompted the rewrite. Asking "Latin? Cyrillic? Greek?" and counting the
   * yeses saw only the `DT` here and called a Yi radical spliced into a ticker single-script.
   */
  it("counts a script it cannot name, which is how the Yi fake is caught", () => {
    expect(restrictionLevel("\u{A4A4}5DT")).toBe("unrestricted");

    const mixed = inspectTokenSymbol("\u{A4A4}5DT").find((f) => f.issue === "mixed-scripts");
    expect(mixed?.evidence["scripts"]).toEqual(["Latin", "another alphabet"]);
    expect(mixed?.message).toContain("mixes Latin and another alphabet.");
  });

  it("treats digits as belonging to no alphabet, so a one-letter swap cannot hide behind one", () => {
    // Cyrillic \u0414\u0422 and an ASCII digit. If the digit counted as Latin this would read as a mix.
    expect(restrictionLevel("\u0414\u04225")).toBe("single-script");
  });

  it("does not invent a second alphabet out of an accented Latin letter", () => {
    expect(restrictionLevel("CAF\u00C9")).toBe("single-script");
    expect(inspectTokenSymbol("CAF\u00C9").map((f) => f.issue)).not.toContain("mixed-scripts");
  });

  it("says nothing about alphabets on account of a character nobody can see", () => {
    // `U+17B4` is Script=Khmer, so a naive count calls this a mix. It is padding, and the
    // `invisible-characters` finding is the one that should speak.
    const issues = inspectTokenSymbol("US\u{17B4}DT").map((f) => f.issue);

    expect(issues).toContain("invisible-characters");
    expect(issues).not.toContain("mixed-scripts");
  });

  /**
   * The documented limit, pinned rather than left to be rediscovered: two scripts this module
   * cannot name share one bucket, so the level understates. The standard would say unrestricted.
   * Nothing is missed by it \u2014 the ASCII-Only rule fires on the same symbol, which is the rule
   * that does the work.
   */
  it("understates the level when two unnamed alphabets meet, and flags the symbol regardless", () => {
    const yiAndLisu = "\u{A4A4}\u{A4F4}";

    expect(restrictionLevel(yiAndLisu)).toBe("single-script");
    expect(inspectTokenSymbol(yiAndLisu).map((f) => f.issue)).toContain("non-ascii-symbol");
  });
});
