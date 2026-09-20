import {normalizeAddress, type Address} from "./address.js";

/**
 * Fake-token detection.
 *
 * The address-poisoning playbook has a second half: deploy a contract whose symbol renders as
 * `USDT`, then use it for the transfers that plant an address in someone's history. The row in
 * the wallet looks exactly like a real stablecoin transfer, which is what makes the planted
 * address look like a real counterparty.
 *
 * ## Why this does not try to enumerate lookalike characters
 *
 * An earlier version of this file carried a table of Cyrillic and Greek homoglyphs. Then three
 * fake USDT contracts turned up in a random sample of real wallets (`analysis/README.md`) and it
 * caught none of them:
 *
 * | rendered | actually |
 * | --- | --- |
 * | `USDT` | `U+A4A4` (Yi radical) + `5DT` |
 * | `USDT` | `U+A4F4` (Lisu letter) + `S` + `U+17B4` ×2 + `DT` |
 * | `USDT` | plain ASCII `USDT` — at a contract that is not USDT |
 *
 * Unicode has about 140,000 characters and an attacker picks from all of them, so a table of the
 * ones seen so far is an arms race that loses by default. The rules below are chosen to cover
 * whole classes instead:
 *
 *   - **a real ticker is plain ASCII.** That single rule catches every exotic-script impostor
 *     regardless of which script is used next, and cannot be evaded by finding a new homoglyph;
 *   - **a real token's symbol belongs to its own contract.** That catches the third one, whose
 *     symbol is spelled correctly and whose only lie is where it lives.
 *
 * The narrower rules that follow still run, because they say *which* token is being imitated,
 * which is worth telling a user. They are no longer what the detection rests on.
 */

export type TokenSymbolIssue =
  | "non-ascii-symbol"
  | "known-symbol-wrong-contract"
  | "impersonates-native-asset"
  | "invisible-characters"
  | "mixed-scripts"
  | "confusable-with-known-symbol"
  | "padded-whitespace";

export interface TokenSymbolFinding {
  issue: TokenSymbolIssue;
  message: string;
  evidence: Record<string, unknown>;
}

export interface TokenToInspect {
  symbol: string;
  /**
   * The contract the symbol came from.
   *
   * Without it, a token whose ticker is spelled perfectly is indistinguishable from the real
   * thing — which is exactly the gap the third row of the table above lives in.
   */
  address?: string;
  name?: string;
}

/** A token that really is what it says, on the chain being inspected. */
export interface CanonicalToken {
  symbol: string;
  address: Address;
}

/** Printable ASCII. Anything outside it has no business in a ticker. */
const NON_ASCII = /[^\x20-\x7E]/gu;

/**
 * Characters that take up no visual space: zero-width spaces and joiners, bidi overrides, the
 * BOM, the soft hyphen, and any combining mark used as filler — `U+17B4` in the sample above is
 * a Khmer combining vowel doing exactly that.
 */
const INVISIBLE_PATTERN = "[\\u00AD\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF\\p{Mn}\\p{Cf}]";
const INVISIBLE_ALL = new RegExp(INVISIBLE_PATTERN, "gu");
/** Separate from the `g` version because a `g`-flagged regex carries `lastIndex` between calls. */
const INVISIBLE = new RegExp(INVISIBLE_PATTERN, "u");

const CYRILLIC = /[Ѐ-ӿ]/u;
const GREEK = /[Ͱ-Ͽ]/u;
const LATIN = /[A-Za-z]/u;

/**
 * Native assets that no honest ERC-20 calls itself.
 *
 * A token contract is by definition not the chain's native currency, so wrapped versions are
 * named WETH, WBNB, WMATIC. A contract whose ticker is a bare `ETH` is claiming to be something
 * it cannot be — which is what the bait in the May 2024 WBTC case did, with a symbol spelled in
 * ordinary Latin letters that every homoglyph rule in here would wave through.
 */
const NATIVE_ASSET_SYMBOLS = new Set(["eth", "ether", "btc", "bnb", "matic", "avax", "sol", "pol"]);

/**
 * Cross-script twins, kept only to name *which* symbol is being imitated.
 *
 * Deliberately short. The `non-ascii-symbol` rule already catches everything this would, so this
 * table adds detail rather than coverage, and growing it is not how the detection improves.
 */
const CONFUSABLES: Record<string, string> = {
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T",
  У: "Y", Х: "X", І: "I", Ј: "J", Ѕ: "S", Ү: "Y",
  а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ј: "j", ѕ: "s",
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O",
  Ρ: "P", Τ: "T", Υ: "Y", Χ: "X", ο: "o", ρ: "p", α: "a", ι: "i", ν: "v",
};

/**
 * Fold a symbol to the plain-ASCII shape it renders as.
 *
 * Invisible characters are dropped, fullwidth and sub/superscript forms are narrowed by NFKC, and
 * the cross-script twins above are mapped. NFKC deliberately leaves Cyrillic and Greek alone —
 * as far as Unicode is concerned those really are different letters — which is the gap the table
 * closes. Characters from scripts the table does not cover survive, and the `non-ascii-symbol`
 * rule is what handles those.
 */
export function confusableSkeleton(symbol: string): string {
  const withoutInvisible = symbol.replace(INVISIBLE_ALL, "");
  let out = "";
  for (const char of withoutInvisible.normalize("NFKC")) {
    out += CONFUSABLES[char] ?? char;
  }
  return out.trim();
}

/**
 * Check a token, against the canonical list for the chain it is on.
 *
 * Returns every issue found rather than a single verdict, because the UI shows them next to the
 * token row and a fake can be wrong in more than one way at once.
 */
export function inspectToken(
  token: TokenToInspect,
  options: {canonical?: readonly CanonicalToken[]; knownSymbols?: readonly string[]} = {},
): TokenSymbolFinding[] {
  const {symbol} = token;
  const canonical = options.canonical ?? [];
  const knownSymbols = options.knownSymbols ?? canonical.map((entry) => entry.symbol);
  const findings: TokenSymbolFinding[] = [];

  // ---- the two rules that carry the detection -----------------------------

  const exotic = symbol.match(NON_ASCII);
  if (exotic) {
    findings.push({
      issue: "non-ascii-symbol",
      message:
        `This token's symbol is not spelled with ordinary characters — ` +
        `${exotic.length} of them ${exotic.length === 1 ? "is" : "are"} from another alphabet or ` +
        `invisible. It renders as something familiar and is not it.`,
      evidence: {symbol, codePoints: exotic.map(describe)},
    });
  }

  if (token.address && canonical.length > 0) {
    const skeleton = confusableSkeleton(symbol).toLowerCase();
    const impersonated = canonical.find((entry) => entry.symbol.toLowerCase() === skeleton);

    if (impersonated && normalizeAddress(token.address) !== normalizeAddress(impersonated.address)) {
      findings.push({
        issue: "known-symbol-wrong-contract",
        message:
          `This calls itself ${impersonated.symbol}, but the real ${impersonated.symbol} is a ` +
          `different contract. Anyone can deploy a token and give it any name; the address is ` +
          `the only part that cannot be copied.`,
        evidence: {symbol, address: token.address, realAddress: impersonated.address},
      });
    }
  }

  // ---- rules that add detail ----------------------------------------------

  if (NATIVE_ASSET_SYMBOLS.has(confusableSkeleton(symbol).toLowerCase())) {
    findings.push({
      issue: "impersonates-native-asset",
      message:
        `This is a token contract calling itself "${symbol.trim()}", which is a native currency ` +
        `and cannot be a token. Genuine wrapped versions are named with a leading W, like WETH.`,
      evidence: {symbol},
    });
  }

  const invisible = symbol.match(INVISIBLE_ALL);
  if (invisible) {
    findings.push({
      issue: "invisible-characters",
      message:
        `${invisible.length} character(s) in this symbol render as nothing at all. A real token ` +
        `has no reason to hide characters in its ticker.`,
      evidence: {count: invisible.length, codePoints: invisible.map(describe)},
    });
  }

  if (symbol !== symbol.trim()) {
    findings.push({
      issue: "padded-whitespace",
      message: `This token's symbol is padded with whitespace so it lines up with another one.`,
      evidence: {raw: symbol},
    });
  }

  const scripts = [
    LATIN.test(symbol) ? "Latin" : null,
    CYRILLIC.test(symbol) ? "Cyrillic" : null,
    GREEK.test(symbol) ? "Greek" : null,
  ].filter((script): script is string => script !== null);

  if (scripts.length > 1) {
    findings.push({
      issue: "mixed-scripts",
      message:
        `This token's symbol mixes ${scripts.join(" and ")} letters. Legitimate tickers do not ` +
        `switch alphabets mid-word; impersonations do it to borrow a familiar shape.`,
      evidence: {scripts},
    });
  }

  const skeleton = confusableSkeleton(symbol);
  if (skeleton !== symbol) {
    const match = knownSymbols.find((known) => known.toLowerCase() === skeleton.toLowerCase());
    if (match) {
      findings.push({
        issue: "confusable-with-known-symbol",
        message:
          `This renders as "${match}" but is not spelled with the characters in "${match}". ` +
          `It is a different token wearing a familiar name.`,
        evidence: {symbol, skeleton, impersonating: match},
      });
    }
  }

  return findings;
}

/** Symbol-only check, for callers that have no contract address to hand. */
export function inspectTokenSymbol(
  symbol: string,
  knownSymbols: readonly string[] = [],
): TokenSymbolFinding[] {
  return inspectToken({symbol}, {knownSymbols});
}

/** True when a symbol is spelled with exactly the characters it appears to be spelled with. */
export function isPlainSymbol(symbol: string): boolean {
  return symbol === confusableSkeleton(symbol) && !INVISIBLE.test(symbol) && !hasNonAscii(symbol);
}

export function hasNonAscii(symbol: string): boolean {
  for (const char of symbol) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code > 0x7e) return true;
  }
  return false;
}

function describe(char: string): string {
  return `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
}
