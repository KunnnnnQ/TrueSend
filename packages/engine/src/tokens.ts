import {addressesEqual, normalizeAddress, type Address} from "./address.js";

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
 *
 * ## Relationship to UTS #39
 *
 * The first rule was arrived at here by being wrong three times, and then turned out to be a
 * standard. "All characters in the string are in the ASCII range" is the **ASCII-Only restriction
 * level** of Unicode Technical Standard #39, *Unicode Security Mechanisms* (revision 34, 2026-08-27),
 * and the mixed-script rule below is roughly the negation of its **Single Script** level. Using
 * the standard's vocabulary is not decoration: it means a reader can check this against a
 * maintained specification rather than against one author's judgement.
 *
 * Two deliberate departures, because a security rule that silently diverges from the standard it
 * claims to implement is worse than one that never claimed to:
 *
 *   - UTS #39 defines `skeleton()` as NFD, then removal of `Default_Ignorable` characters, then
 *     substitution from `confusables.txt`, then NFD again. This uses **NFKC** in place of
 *     NFD-plus-`confusables.txt`, because that file carries roughly six thousand mappings and
 *     shipping it in a browser extension is not worth it. NFKC covers the compatibility cases —
 *     fullwidth, sub- and superscript — that the confusables data would otherwise handle. What
 *     NFKC deliberately does *not* do is fold across scripts, and that gap is exactly what the
 *     ASCII-Only rule covers instead.
 *   - `Default_Ignorable_Code_Point` is used as the standard specifies, rather than the
 *     hand-written list of zero-width characters this file used to carry. The property is
 *     strictly better: it already contained `U+17B4`, the Khmer mark one of the real fakes above
 *     used as filler, which the hand-written list did not.
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

/**
 * The subset of UTS #39's restriction levels that a ticker symbol can meaningfully fall into.
 *
 * The standard defines six. The three in between — Highly Restrictive, Moderately Restrictive and
 * Minimally Restrictive — exist to let real identifiers in human languages through, which is a
 * problem a four-letter ticker does not have. Collapsing them would be wrong for a username or a
 * domain and is right here, and saying so is the point of naming the standard at all.
 */
export type RestrictionLevel = "ascii-only" | "single-script" | "unrestricted";

/**
 * Where a symbol sits on UTS #39's scale.
 *
 * Exposed because it turns a verdict into something checkable. "This is not ASCII-Only" is a
 * statement about a published standard that a reader can verify; "this looks suspicious to me" is
 * not.
 */
export function restrictionLevel(symbol: string): RestrictionLevel {
  if (!hasNonAscii(symbol)) return "ascii-only";

  return scriptsIn(symbol).length <= 1 ? "single-script" : "unrestricted";
}

/**
 * Which alphabets a symbol draws on, as far as this module can tell.
 *
 * This used to ask three yes/no questions — Latin? Cyrillic? Greek? — and count the yeses, which
 * reported the Yi radical in a real fake as single-script because the only script it could see in
 * `U+A4A4 5 D T` was the `DT`. Enumerating scripts is the homoglyph table's mistake at one
 * remove: the list is always missing the one the attacker reached for.
 *
 * JavaScript will answer "is this character Latin?" but not "what script is this character?", so
 * an exact answer means carrying Unicode's script table. This does not, and does not need to. A
 * character that is neither Latin, Cyrillic, Greek nor script-neutral is *by that fact* from some
 * other script, whatever its name — so the unnamed ones get counted without being identified.
 * Knowing a second alphabet is present is the question; naming it only improves the sentence.
 *
 * Two kinds of character are skipped. Script-neutral ones because UAX #31 says so: digits and
 * punctuation carry `Script=Common` and belong to every script, so counting the `5` above as
 * Latin would make a one-letter swap read as single-script. Invisible ones because they have
 * their own finding, and "mixes two alphabets" is a strange thing to say about a mark that does
 * not render — the Khmer filler in another real fake is `Script=Khmer`, and saying so out loud
 * would be true and useless.
 *
 * The limit, so the level is not read as more than it is: characters from two *different* unnamed
 * scripts share one bucket and read as single-script. That costs no detection, since the
 * ASCII-Only rule has already fired on anything that reaches here — it understates the level
 * only, and `tokens.test.ts` pins the case rather than leaving it to be rediscovered.
 */
function scriptsIn(symbol: string): string[] {
  const named: string[] = [];
  let sawUnnamed = false;

  for (const char of symbol) {
    if (SCRIPT_NEUTRAL.test(char) || INVISIBLE.test(char)) continue;

    const script = NAMED_SCRIPTS.find(([, pattern]) => pattern.test(char))?.[0];
    if (script === undefined) sawUnnamed = true;
    else if (!named.includes(script)) named.push(script);
  }

  return sawUnnamed ? [...named, UNNAMED_SCRIPT] : named;
}

/** Printable ASCII. Anything outside it has no business in a ticker. */
const NON_ASCII = /[^\x20-\x7E]/gu;

/**
 * Characters that take up no visual space.
 *
 * `Default_Ignorable_Code_Point` is the set UTS #39's `skeleton()` removes, and it covers every
 * zero-width space, joiner, bidi control, BOM and soft hyphen this used to list by hand — plus
 * `U+17B4`, the Khmer mark one of the real fakes above used as filler, which the hand-written
 * list missed. Reaching for the property rather than an enumeration is the same lesson as the
 * ASCII rule, one level down.
 *
 * Nonspacing marks are removed as well, which the standard does not do. A ticker has no business
 * carrying combining accents, and stacking them is another way to pad a symbol into a shape.
 */
const INVISIBLE_PATTERN = "[\\p{Default_Ignorable_Code_Point}\\p{Mn}]";
const INVISIBLE_ALL = new RegExp(INVISIBLE_PATTERN, "gu");
/** Separate from the `g` version because a `g`-flagged regex carries `lastIndex` between calls. */
const INVISIBLE = new RegExp(INVISIBLE_PATTERN, "u");

/**
 * The scripts worth naming in a message, which is a different question from the scripts worth
 * counting. These three carry the bulk of UTS #39's Latin confusables, and a reader who is told
 * "Cyrillic" can go and look at the character. Everything else is counted but not named; see
 * `scriptsIn`.
 *
 * `Script=Latin` rather than `[A-Za-z]` so that an accented letter reads as Latin instead of
 * landing in the unnamed bucket and inventing a second alphabet.
 */
const NAMED_SCRIPTS: readonly (readonly [string, RegExp])[] = [
  ["Latin", /\p{Script=Latin}/u],
  ["Cyrillic", /\p{Script=Cyrillic}/u],
  ["Greek", /\p{Script=Greek}/u],
];

/** Stands in for a script this module can tell apart but not identify. */
const UNNAMED_SCRIPT = "another alphabet";

/** So a named script and the unnamed bucket read as a sentence rather than as a `join`. */
const ENGLISH_LIST = new Intl.ListFormat("en", {style: "long", type: "conjunction"});

/**
 * Characters that belong to every script and so distinguish none: digits, punctuation, spacing,
 * and the combining marks that inherit their script from what they sit on.
 */
const SCRIPT_NEUTRAL = /[\p{Script=Common}\p{Script=Inherited}]/u;

/**
 * The chain's own currency, which no honest token on that chain can be called.
 *
 * A token contract is by definition not the chain's native currency, so a wrapped version is named
 * WETH, and a contract whose ticker is a bare `ETH` is claiming to be something it cannot be. That
 * is what the bait in the May 2024 WBTC case did, in ordinary Latin letters that every homoglyph
 * rule would wave through.
 *
 * **This list used to hold every chain's native currency** — matic, bnb, avax, sol, pol, btc — on
 * the reasoning that no token can be a native currency. Measured against Uniswap's curated
 * default list for Ethereum mainnet it flagged MATIC, SOL and POL: three legitimate, widely held
 * tokens. Polygon's, Solana's and Avalanche's currencies *are* ordinary ERC-20s on Ethereum, and a
 * detector that paints a warning over a user's real MATIC is a detector that gets muted. "Cannot be
 * a token" is only true of the chain you are on, so the list is now that chain's, and the default
 * is Ethereum's — the only chain the app supports natively — with `nativeSymbols` for a caller that
 * knows better.
 */
const ETHEREUM_NATIVE = ["eth", "ether"] as const;

/**
 * A symbol with the decoration taken off: folded, lower-cased, and separators and punctuation
 * removed.
 *
 * The native-asset rule used to compare the symbol to the list exactly, and a live bait token
 * walked past it by adding two dots. `Ether..` was found on 2026-09-26 in the token transfers of an
 * account being poisoned at the time: 18 decimals, `balanceOf` reverting for the account it named
 * as sender, and two records of that account "sending" it 1.468 of them to a lookalike, signed by
 * someone else. It is the May 2024 bait again, one punctuation mark from being caught.
 *
 * Deliberately not everything is stripped. Letters and digits stay, so `ETH2` and `WETH` are still
 * not `ETH`. And `+` stays: `ETH+` is a real token, and so are `USD+` and `DAI+`, which this rule
 * flagged when it stripped every non-alphanumeric character — measured against CoinGecko's list.
 * What it strips is what a bait adds for free and a real ticker has no reason to carry.
 */
const DECORATION = /[\s._\-\u2010-\u2015~*!?,;:'"`\u00b4^|/\\()[\]{}<>]/g;

function bareLetters(symbol: string): string {
  return confusableSkeleton(symbol).toLowerCase().replace(DECORATION, "");
}

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
  options: {
    canonical?: readonly CanonicalToken[];
    knownSymbols?: readonly string[];
    /** The chain's own currency, lower case. Defaults to Ethereum's; see `ETHEREUM_NATIVE`. */
    nativeSymbols?: readonly string[];
  } = {},
): TokenSymbolFinding[] {
  const {symbol} = token;
  const canonical = options.canonical ?? [];
  const knownSymbols = options.knownSymbols ?? canonical.map((entry) => entry.symbol);
  const nativeSymbols = new Set(options.nativeSymbols ?? ETHEREUM_NATIVE);
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
      evidence: {
        symbol,
        codePoints: exotic.map(describe),
        // Named so the claim can be checked against a published standard rather than trusted.
        restrictionLevel: restrictionLevel(symbol),
        standard: "UTS #39 ASCII-Only",
      },
    });
  }

  if (token.address && canonical.length > 0) {
    const skeleton = confusableSkeleton(symbol).toLowerCase();
    const impersonated = canonical.find(
      (entry) => confusableSkeleton(entry.symbol).toLowerCase() === skeleton,
    );

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

  if (nativeSymbols.has(bareLetters(symbol))) {
    findings.push({
      issue: "impersonates-native-asset",
      message:
        `This is a token contract calling itself "${revealSymbol(symbol.trim())}", which is a ` +
        `native currency and cannot be a token. Genuine wrapped versions are named with a ` +
        `leading W, like WETH.`,
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

  const scripts = scriptsIn(symbol);
  if (scripts.length > 1) {
    findings.push({
      issue: "mixed-scripts",
      message:
        `This token's symbol mixes ${ENGLISH_LIST.format(scripts)}. Legitimate tickers do not ` +
        `switch alphabets mid-word; impersonations do it to borrow a familiar shape.`,
      evidence: {scripts, restrictionLevel: restrictionLevel(symbol), standard: "UTS #39 Single Script"},
    });
  }

  const skeleton = confusableSkeleton(symbol);
  if (skeleton !== symbol) {
    // UTS #39 defines two strings as confusable when their *skeletons* are equal, so both sides
    // are folded. Comparing a folded symbol against a raw one happens to work for ASCII tickers
    // and is not what the standard says.
    const match = knownSymbols.find(
      (known) => confusableSkeleton(known).toLowerCase() === skeleton.toLowerCase(),
    );
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

/**
 * A symbol written so that what is wrong with it can be seen.
 *
 * Every character outside printable ASCII becomes its code point in brackets: `U5⟨U+17B4⟩⟨U+17B4⟩D⟨U+A4D4⟩`
 * instead of something that renders as `U5D` plus a letter that looks like a `T`. Two of those
 * characters are invisible, so the raw string is the one form of this symbol that cannot show a
 * reader the trick.
 *
 * It is also the only safe way to put an untrusted symbol into a page. A contract chooses its own
 * symbol, and a right-to-left override in it reorders the text *around* it — an attacker's string
 * that changes what the warning beside it appears to say. Printing code points rather than the
 * characters closes that off along with the invisible ones.
 */
export function revealSymbol(symbol: string): string {
  let out = "";
  for (const char of symbol) {
    const code = char.codePointAt(0)!;
    out += code >= 0x20 && code <= 0x7e ? char : `⟨${describe(char)}⟩`;
  }
  return out;
}

/** What a token check comes to, once the token's use in the account's history is known. */
export type TokenVerdict = "counterfeit" | "unusual" | "clean";

/**
 * Findings that say a token is claiming to be one particular real asset. Strong on their own.
 */
const IMPERSONATION: ReadonlySet<TokenSymbolIssue> = new Set([
  "known-symbol-wrong-contract",
  "impersonates-native-asset",
  "confusable-with-known-symbol",
]);

/**
 * Whether a token is counterfeit, or merely spelled strangely.
 *
 * The ASCII rule catches the whole class of exotic-alphabet fakes without anyone having to know
 * the next homoglyph, and the price is stated by measurement: run over CoinGecko's list of about
 * six thousand Ethereum tokens it flags eight, and most are meme tokens whose only fault is how
 * they are spelled — a Chinese ticker, an emoji, `BTC.ℏ` — with nothing in the list marking them as
 * fraudulent. Telling every one of those holders that they own a counterfeit is the false alarm that
 * gets a tool muted.
 *
 * What separates them is the thing this project is built on. A counterfeit is planted in somebody's
 * history by somebody else: it turns up as a record of the account "sending" it in a transaction
 * the account never signed, or as a zero-value transfer in. A token the account bought and moved
 * itself never does. So:
 *
 *  - **claiming to be a specific real asset** — the wrong contract for a known ticker, a fake
 *    native currency, a lookalike of one — is counterfeit however the token got there;
 *  - **spelled strangely and used against the account** is counterfeit;
 *  - **spelled strangely and otherwise ordinary** is `unusual`: worth a sentence, not an alarm.
 *
 * @param plantedTransfers transfers of this token that name the account as sender without its
 *   signature, plus zero-value ones sent to it. Counted by the caller from the history.
 */
export function judgeToken(findings: readonly TokenSymbolFinding[], plantedTransfers: number): TokenVerdict {
  if (findings.length === 0) return "clean";
  if (findings.some((finding) => IMPERSONATION.has(finding.issue))) return "counterfeit";
  return plantedTransfers > 0 ? "counterfeit" : "unusual";
}

/** A token contract a scan judged, with what it was judged on. */
export interface FlaggedToken {
  address: Address;
  symbol: string;
  name: string | null;
  /** How many of the account's transfers in the scanned range involve it. */
  transfers: number;
  /** How many of those were planted — see `judgeToken`. */
  planted: number;
  findings: readonly TokenSymbolFinding[];
}

/** What a token check came to: every token it judged worth a second look, in two tiers. */
export interface FlaggedTokens {
  counterfeit: readonly FlaggedToken[];
  unusual: readonly FlaggedToken[];
}

/**
 * Whether a contract address is one a scan already judged — and if so, what it decided.
 *
 * This exists because of where the two halves of a payment happen. A scan reads a token's symbol
 * once, against the RPC, at the only moment this project has `judgeToken`'s two ingredients: the
 * identity and the history to check it against. Sending money happens later and offers only a
 * contract address, with nothing of its own to judge it by. Asking the chain again at send time
 * would answer a narrower question than the scan already did — a fresh `symbol()` call cannot see
 * whether *this account's* history shows the token being planted on it, which is half of what
 * `judgeToken` weighs. So the send screen is handed the scan's own answer instead of a smaller one
 * it would have to compute itself.
 *
 * This module has no opinion on how `flagged` reaches here, or for how long it stays good — this
 * package is pure functions with no clock, no network and no storage of its own (see
 * `index.ts`), and whatever carries a scan's answer from one screen to another is exactly that
 * kind of question. The caller is the only one who knows whether the answer is still good for
 * anything: whether it came from a scan of the account actually paying, and from a block range
 * recent enough to matter. This function only ever answers "did a scan already flag this address",
 * never "is it safe" — silence here is the absence of a finding, not a finding of cleanliness.
 */
export function matchFlaggedToken(
  flagged: FlaggedTokens,
  tokenAddress: Address,
): {token: FlaggedToken; verdict: "counterfeit" | "unusual"} | undefined {
  const counterfeit = flagged.counterfeit.find((candidate) => addressesEqual(candidate.address, tokenAddress));
  if (counterfeit) return {token: counterfeit, verdict: "counterfeit"};

  const unusual = flagged.unusual.find((candidate) => addressesEqual(candidate.address, tokenAddress));
  if (unusual) return {token: unusual, verdict: "unusual"};

  return undefined;
}
