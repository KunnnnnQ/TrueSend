import {normalizeAddress, type Address} from "./address.js";
import {sharedPrefixLength, sharedSuffixLength} from "./fingerprint.js";
import {MIN_AFFIX_MATCH} from "./risk.js";

/** An address as it appeared in some text, with enough to point back at it. */
export interface AddressMatch {
  /** Lower-cased, for comparison. */
  address: Address;
  /** Exactly as written, so a caller can highlight the original characters. */
  raw: string;
  index: number;
}

const ADDRESS_PATTERN = /0x[0-9a-fA-F]{40}/g;

/**
 * Pull every address out of a block of text.
 *
 * No checksum filtering here. An address with a broken checksum is still an address that is about
 * to be used, and it is the one most worth flagging — `checkAddressFormat` says which.
 */
export function findAddresses(text: string): AddressMatch[] {
  const out: AddressMatch[] = [];
  for (const match of text.matchAll(ADDRESS_PATTERN)) {
    // A 40-hex run inside a longer hex string is part of a hash or calldata, not an address.
    const after = text[match.index + match[0].length];
    if (after !== undefined && /[0-9a-fA-F]/.test(after)) continue;

    out.push({
      address: normalizeAddress(match[0]),
      raw: match[0],
      index: match.index,
    });
  }
  return out;
}

export interface AddressCollision {
  a: Address;
  b: Address;
  sharedPrefix: number;
  sharedSuffix: number;
}

/**
 * Find pairs of addresses that a wallet would render identically.
 *
 * The reason this is worth doing on a page rather than against a stored history: when someone is
 * looking at their transaction list, the planted address and the address it imitates are usually
 * **both on the screen at once**. Nothing needs to be remembered, no history needs to be fetched,
 * and no heuristic about intent is involved — two entries in the same list that share the
 * characters the interface shows and differ everywhere else is a fact about what is in front of
 * the user right now.
 *
 * Bucketed on the first and last `minAffix` characters rather than compared pairwise, so a block
 * explorer page with several hundred addresses stays a linear pass instead of a quadratic one.
 */
export function collidingPairs(
  addresses: Iterable<string>,
  minAffix: number = MIN_AFFIX_MATCH,
): AddressCollision[] {
  const buckets = new Map<string, Address[]>();

  for (const value of addresses) {
    const address = normalizeAddress(value);
    const body = address.slice(2);
    const key = `${body.slice(0, minAffix)}:${body.slice(-minAffix)}`;

    const bucket = buckets.get(key);
    if (bucket) {
      if (!bucket.includes(address)) bucket.push(address);
    } else {
      buckets.set(key, [address]);
    }
  }

  const collisions: AddressCollision[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;

    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i]!;
        const b = bucket[j]!;
        collisions.push({
          a,
          b,
          sharedPrefix: sharedPrefixLength(a, b),
          sharedSuffix: sharedSuffixLength(a, b),
        });
      }
    }
  }

  // Longest match first: the closest pair is the one most likely to be a deliberate imitation.
  return collisions.sort(
    (x, y) => y.sharedPrefix + y.sharedSuffix - (x.sharedPrefix + x.sharedSuffix),
  );
}

/** Every address involved in at least one collision, for highlighting them in place. */
export function collidingAddresses(collisions: readonly AddressCollision[]): Set<Address> {
  const out = new Set<Address>();
  for (const collision of collisions) {
    out.add(collision.a);
    out.add(collision.b);
  }
  return out;
}
