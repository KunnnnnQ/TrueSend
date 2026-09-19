/**
 * Fake-token detection.
 *
 * The address-poisoning playbook has a second half: deploy a contract whose symbol renders as
 * `USDT` but is not spelled with the letters in `USDT`, then use it for the zero-value transfers
 * that plant an address in someone's history. The row in the wallet looks exactly like a real
 * stablecoin transfer, which is what makes the planted address look like a real counterparty.
 *
 * Everything here works on the rendered string, because that is what the user actually sees.
 */

export type TokenSymbolIssue =
  | "invisible-characters"
  | "mixed-scripts"
  | "confusable-with-known-symbol"
  | "padded-whitespace";

export interface TokenSymbolFinding {
  issue: TokenSymbolIssue;
  message: string;
  evidence: Record<string, unknown>;
}

/**
 * Characters that take up no visual space: zero-width spaces and joiners, bidi overrides, the
 * BOM, and the soft hyphen. Any of them in a token symbol is a deliberate choice.
 */
const INVISIBLE_PATTERN = "[\\u00AD\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF]";
/** For `match` and `replace`. */
const INVISIBLE_ALL = new RegExp(INVISIBLE_PATTERN, "gu");
/** For `test`. Separate because a `g`-flagged regex carries `lastIndex` between calls. */
const INVISIBLE = new RegExp(INVISIBLE_PATTERN, "u");

const CYRILLIC = /[Ѐ-ӿ]/u;
const GREEK = /[Ͱ-Ͽ]/u;
const LATIN = /[A-Za-z]/u;

/**
 * Homoglyphs that matter for ticker symbols, which are short, upper-case and ASCII in practice.
 * Not a general Unicode confusables table — a small, auditable list beats a large opaque one for
 * a rule whose output is shown to a user as an accusation.
 *
 * Only cross-script twins are listed. Fullwidth letters, subscript and superscript digits and
 * the like are handled by NFKC in `confusableSkeleton`; NFKC deliberately leaves Cyrillic and
 * Greek alone, because as far as Unicode is concerned those really are different letters. That
 * gap is exactly the one this table closes.
 */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T",
  У: "Y", Х: "X", І: "I", Ј: "J", Ѕ: "S", Ү: "Y",
  а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ј: "j", ѕ: "s",
  // Greek
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O",
  Ρ: "P", Τ: "T", Υ: "Y", Χ: "X", ο: "o", ρ: "p", α: "a", ι: "i", ν: "v",
};

/**
 * Fold a symbol to the plain-ASCII shape it renders as.
 *
 * Invisible characters are dropped, fullwidth forms are narrowed and the homoglyphs above are
 * mapped to their Latin twins, so `"USDТ"` written with a Cyrillic Т folds to `"USDT"`.
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
 * Check a token symbol, optionally against the symbols the user actually holds or has heard of.
 *
 * Returns every issue found rather than a single verdict, because the UI shows them as a list
 * next to the token row and a symbol can be wrong in more than one way at once.
 */
export function inspectTokenSymbol(
  symbol: string,
  knownSymbols: readonly string[] = [],
): TokenSymbolFinding[] {
  const findings: TokenSymbolFinding[] = [];

  const invisible = symbol.match(INVISIBLE_ALL);
  if (invisible) {
    findings.push({
      issue: "invisible-characters",
      message:
        `This token's symbol contains ${invisible.length} character(s) that render as nothing. ` +
        `A real token has no reason to hide characters in its ticker.`,
      evidence: {
        count: invisible.length,
        codePoints: invisible.map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`),
      },
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
  ].filter((s): s is string => s !== null);

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
          `This token renders as "${match}" but is not spelled with the characters in "${match}". ` +
          `It is a different token wearing a familiar name.`,
        evidence: {symbol, skeleton, impersonating: match},
      });
    }
  }

  return findings;
}

/** True when a symbol is spelled with exactly the characters it appears to be spelled with. */
export function isPlainSymbol(symbol: string): boolean {
  return symbol === confusableSkeleton(symbol) && !INVISIBLE.test(symbol);
}
