import {keccak_256} from "@noble/hashes/sha3.js";

/** A 20-byte EVM address, always stored with a `0x` prefix. */
export type Address = `0x${string}`;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isAddress(value: string): value is Address {
  return ADDRESS_RE.test(value);
}

/**
 * Lower-cased, `0x`-prefixed form. Every comparison in this package runs on this form so that a
 * checksummed address and its lower-case twin are never treated as two different accounts.
 */
export function normalizeAddress(value: string): Address {
  if (!isAddress(value)) {
    throw new Error(`Not an EVM address: ${JSON.stringify(value)}`);
  }
  return value.toLowerCase() as Address;
}

/** The 20 raw bytes, for hashing. */
export function addressBytes(value: string): Uint8Array {
  const hex = normalizeAddress(value).slice(2);
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * EIP-55 mixed-case checksum.
 *
 * Worth being precise about what this does and does not buy: the checksum catches an address that
 * was mistyped or truncated, because random damage almost certainly breaks the capitalisation
 * pattern. It catches nothing at all about address poisoning, where the attacker generates a
 * genuine, perfectly-checksummed address that merely looks like yours. That is what the
 * fingerprint in `fingerprint.ts` is for.
 */
export function toChecksumAddress(value: string): Address {
  const lower = normalizeAddress(value).slice(2);
  // The input is 40 lower-case hex characters, so each one is a single ASCII byte. Encoding it
  // by hand rather than reaching for `TextEncoder` keeps this module free of platform globals,
  // which matters because the same build runs in a browser extension, in Node and on an edge
  // runtime.
  const hash = keccak_256(Uint8Array.from(lower, (char) => char.charCodeAt(0)));

  let out = "0x";
  for (let i = 0; i < lower.length; i++) {
    const char = lower[i]!;
    // Each hex character is nibble-aligned: byte i>>1, high nibble first.
    const nibble = i % 2 === 0 ? hash[i >> 1]! >> 4 : hash[i >> 1]! & 0x0f;
    out += nibble >= 8 ? char.toUpperCase() : char;
  }
  return out as Address;
}

/** `0xabcd…1234`, the form wallets show and the form poisoning attacks exploit. */
export function shortHex(value: string, lead = 6, tail = 4): string {
  const address = toChecksumAddress(value);
  return `${address.slice(0, 2 + lead)}…${address.slice(42 - tail)}`;
}

export function addressesEqual(a: string, b: string): boolean {
  return normalizeAddress(a) === normalizeAddress(b);
}
