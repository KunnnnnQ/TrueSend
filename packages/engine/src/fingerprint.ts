import {keccak_256} from "@noble/hashes/sha3.js";
import {wordlist} from "@scure/bip39/wordlists/english.js";

import {addressBytes, shortHex, toChecksumAddress, type Address} from "./address.js";

/** Words in the phrase. Each carries 11 bits, so four of them carry 44. */
export const FINGERPRINT_WORDS = 4;
export const FINGERPRINT_BITS = FINGERPRINT_WORDS * 11;

/**
 * A small symmetric glyph drawn from the same hash as the phrase.
 *
 * A single colour chip is not enough on its own: hue has only 360 usable values, so two unrelated
 * addresses land on visually identical colours often enough to notice, and a pair that a user is
 * being asked to tell apart is the worst possible place for that to happen. The grid adds 15 bits
 * of shape on top of the colours, which is what makes two entries actually look different at a
 * glance rather than merely being different underneath.
 */
export interface AddressIdenticon {
  /** 5 x 5, row-major, mirrored left-to-right. `true` means filled. */
  cells: readonly boolean[];
  /** Primary colour for the filled cells. */
  foreground: string;
  /** Second colour, always at least 100 degrees of hue away from the first. */
  accent: string;
}

export interface AddressFingerprint {
  /** Checksummed form of the address this fingerprint belongs to. */
  address: Address;
  /** Four BIP-39 English words. */
  words: readonly string[];
  /** The words joined by spaces — what the UI shows and what a user reads aloud. */
  phrase: string;
  /** `0xabcd…1234`, kept alongside the phrase so the two can be compared side by side. */
  short: string;
  /** Hue in degrees, derived from the same hash, for the colour chip beside the phrase. */
  hue: number;
  /** That hue as a hex colour. */
  color: string;
  /** The glyph. */
  identicon: AddressIdenticon;
  /** How many bits of the hash the phrase commits to. */
  bits: number;
}

/**
 * A human-checkable name for an address.
 *
 * ## Why this exists
 *
 * Wallets show `0x1a2b…9f0c`. Address poisoning works because an attacker can grind out an
 * address that matches those visible characters exactly, and the two are then indistinguishable
 * in every screen the user looks at. The middle 32 characters differ, but nobody reads them.
 *
 * A fingerprint moves the check onto something a person can actually hold in their head. Four
 * dictionary words are read, remembered and compared in a way that hex is not.
 *
 * ## What it costs an attacker
 *
 * These are order-of-magnitude figures from the birthday-free case of grinding a vanity address,
 * not a proof, and they are stated here so nobody has to guess at them:
 *
 * - matching the 6 leading and 4 trailing hex characters a wallet shows is 10 hex digits, so
 *   about 2^40 tries;
 * - matching those *and* all four fingerprint words adds 44 independent bits, so about 2^84.
 *
 * The second number is the point. It is not that the fingerprint is unforgeable in principle —
 * it is that forging it costs far more than the attack is worth, while forging the short hex
 * form already costs little enough that it happens at scale today.
 *
 * The phrase is derived from the address alone, so two people looking at the same address always
 * see the same words, with no server, no registry and no network call.
 */
export function fingerprint(address: string): AddressFingerprint {
  const hash = keccak_256(addressBytes(address));

  // The first 48 bits of the hash, of which the top 44 become the phrase.
  let acc = 0n;
  for (let i = 0; i < 6; i++) {
    acc = (acc << 8n) | BigInt(hash[i]!);
  }
  acc >>= BigInt(48 - FINGERPRINT_BITS);

  const words: string[] = [];
  for (let i = FINGERPRINT_WORDS - 1; i >= 0; i--) {
    const index = Number((acc >> BigInt(11 * i)) & 0x7ffn);
    words.push(wordlist[index]!);
  }

  // Bytes the phrase did not consume, so the colours and the glyph are not a restatement of the
  // words — a user who compares only the picture still gets an independent check.
  const hue = ((hash[6]! << 8) | hash[7]!) % 360;
  // Kept at least 100 degrees away so the two colours never read as the same one.
  const accentHue = (hue + 100 + (hash[8]! % 160)) % 360;
  // Hue alone has only 360 values, so roughly one random pair in two hundred lands on the same
  // colour. Varying lightness across a visible range multiplies the space by about twenty for one
  // extra byte. The band stays narrow enough that every value keeps usable contrast on both a
  // light and a dark surface.
  const lightness = 42 + (hash[11]! % 21);

  // 15 bits of shape: three columns of five, mirrored to fill the other two.
  const shapeBits = (hash[9]! << 8) | hash[10]!;
  const cells: boolean[] = new Array<boolean>(25);
  for (let row = 0; row < 5; row++) {
    for (let column = 0; column < 3; column++) {
      const filled = ((shapeBits >> (row * 3 + column)) & 1) === 1;
      cells[row * 5 + column] = filled;
      cells[row * 5 + (4 - column)] = filled;
    }
  }

  return {
    address: toChecksumAddress(address),
    words,
    phrase: words.join(" "),
    short: shortHex(address),
    hue,
    color: hslToHex(hue, 62, lightness),
    identicon: {
      cells,
      foreground: hslToHex(hue, 62, lightness),
      accent: hslToHex(accentHue, 58, 100 - lightness),
    },
    bits: FINGERPRINT_BITS,
  };
}

/**
 * Render an identicon as a standalone SVG string.
 *
 * Returned as a string rather than as DOM so the same call works in the Next.js app, in the
 * extension's content script and in a plain Node script that renders documentation figures.
 */
export function identiconSvg(fp: AddressFingerprint, size = 40): string {
  const cell = size / 5;
  let rects = "";
  for (let i = 0; i < 25; i++) {
    if (!fp.identicon.cells[i]) continue;
    const x = (i % 5) * cell;
    const y = Math.floor(i / 5) * cell;
    // The middle column takes the accent so the glyph has a readable spine.
    const fill = i % 5 === 2 ? fp.identicon.accent : fp.identicon.foreground;
    rects += `<rect x="${round(x)}" y="${round(y)}" width="${round(cell)}" height="${round(cell)}" fill="${fill}"/>`;
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${size} ${size}" role="img" aria-label="Address fingerprint ${fp.phrase}">` +
    `${rects}</svg>`
  );
}

function round(value: number): string {
  return Number.parseFloat(value.toFixed(3)).toString();
}

export interface FingerprintComparison {
  left: AddressFingerprint;
  right: AddressFingerprint;
  /** Same address, just written differently. */
  identical: boolean;
  /** Which word positions differ. Empty when the addresses are the same. */
  differingWordPositions: readonly number[];
  /** Leading hex characters (after `0x`) the two addresses share. */
  sharedPrefix: number;
  /** Trailing hex characters the two addresses share. */
  sharedSuffix: number;
}

/**
 * Put two addresses side by side the way the UI does.
 *
 * The combination is what makes the screen persuasive: a long shared prefix and suffix next to a
 * completely different phrase is exactly the signature of a poisoning attempt, and it is legible
 * at a glance in a way that "compare these two 42-character strings" never is.
 */
export function compareFingerprints(left: string, right: string): FingerprintComparison {
  const a = fingerprint(left);
  const b = fingerprint(right);
  const identical = a.address === b.address;

  const differingWordPositions: number[] = [];
  for (let i = 0; i < FINGERPRINT_WORDS; i++) {
    if (a.words[i] !== b.words[i]) differingWordPositions.push(i);
  }

  return {
    left: a,
    right: b,
    identical,
    differingWordPositions,
    sharedPrefix: sharedPrefixLength(a.address, b.address),
    sharedSuffix: sharedSuffixLength(a.address, b.address),
  };
}

/** Leading hex characters two addresses share, not counting the `0x`. */
export function sharedPrefixLength(a: string, b: string): number {
  const x = a.toLowerCase().slice(2);
  const y = b.toLowerCase().slice(2);
  let n = 0;
  while (n < x.length && x[n] === y[n]) n++;
  return n;
}

/** Trailing hex characters two addresses share. */
export function sharedSuffixLength(a: string, b: string): number {
  const x = a.toLowerCase().slice(2);
  const y = b.toLowerCase().slice(2);
  let n = 0;
  while (n < x.length && x[x.length - 1 - n] === y[y.length - 1 - n]) n++;
  return n;
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toByte = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toByte(f(0))}${toByte(f(8))}${toByte(f(4))}`;
}
