import {
  checkAddressFormat,
  collidingPairs,
  describeAffixMatch,
  fingerprint,
  normalizeAddress,
  type Address,
  type AddressFingerprint,
} from "@truesend/engine";

export type GuardLevel = "neutral" | "caution" | "danger";

export interface Lookalike {
  address: Address;
  fingerprint: AddressFingerprint;
  sharedPrefix: number;
  sharedSuffix: number;
  /** Where the other address came from: the page in front of the user, or their saved list. */
  source: "page" | "saved";
  label?: string;
}

export interface GuardVerdict {
  address: Address;
  fingerprint: AddressFingerprint;
  level: GuardLevel;
  headline: string;
  detail?: string;
  lookalike?: Lookalike;
}

export interface SavedAddress {
  address: Address;
  label?: string;
}

export interface JudgeInput {
  /** The address that was just copied, pasted, or hovered. */
  address: string;
  /** Every other address currently visible on the page. */
  onPage?: Iterable<string>;
  /** Addresses the user has saved as known-good. */
  saved?: readonly SavedAddress[];
}

/**
 * Decide what to say about one address, using only what is already in front of the user.
 *
 * No network, no history fetch, no clock. The extension has to answer in the time between a copy
 * and a paste, and a verdict that arrives after the paste is not a verdict. Everything here is a
 * string comparison over data the page already handed us.
 *
 * The strongest signal available at this layer is not a heuristic at all: when the planted address
 * and the address it imitates are **both on the screen**, which is the normal case for someone
 * reading their own transaction list, two entries that a wallet would render identically is a
 * fact rather than an inference.
 */
export function judge(input: JudgeInput): GuardVerdict {
  const format = checkAddressFormat(input.address);
  const address = normalizeAddress(input.address);
  const print = fingerprint(address);

  if (format === "bad-checksum") {
    return {
      address,
      fingerprint: print,
      level: "danger",
      headline: "This address has been altered",
      detail:
        "Its capitalisation does not match its own checksum, which means a character changed " +
        "somewhere between the sender and here. Ask for it again rather than using it.",
    };
  }

  const saved = input.saved ?? [];
  const savedMatch = nearest(
    address,
    saved.map((entry) => ({
      address: normalizeAddress(entry.address),
      ...(entry.label === undefined ? {} : {label: entry.label}),
    })),
  );

  if (savedMatch) {
    return {
      address,
      fingerprint: print,
      level: "danger",
      headline: savedMatch.label
        ? `This is not ${savedMatch.label}`
        : "This imitates an address you saved",
      detail:
        `It matches ${describeAffixMatch(savedMatch)} of one you saved, and nothing else.`,
      lookalike: {...savedMatch, source: "saved"},
    };
  }

  const pageMatch = nearest(
    address,
    [...(input.onPage ?? [])].map((value) => ({address: normalizeAddress(value)})),
  );

  if (pageMatch) {
    return {
      address,
      fingerprint: print,
      level: "danger",
      headline: "Two addresses on this page look the same",
      detail:
        `Another address here shares ${describeAffixMatch(pageMatch)} with it. ` +
        `One of them is not what you think it is.`,
      lookalike: {...pageMatch, source: "page"},
    };
  }

  return {
    address,
    fingerprint: print,
    level: "neutral",
    headline: print.phrase,
    detail: "Check these four words against what the recipient told you.",
  };
}

/** The closest colliding address from a candidate set, or nothing if none collide. */
function nearest(
  address: Address,
  candidates: readonly {address: Address; label?: string}[],
): (Omit<Lookalike, "source"> & {label?: string}) | undefined {
  const others = candidates.filter((candidate) => candidate.address !== address);
  if (others.length === 0) return undefined;

  // Pairs come back strongest-first across the whole set, and the strongest pair on a page is
  // often between two addresses that have nothing to do with this one. Filtering to the pairs
  // that actually involve `address` before taking the closest is the difference between warning
  // and silently not warning.
  const closest = collidingPairs([address, ...others.map((other) => other.address)]).find(
    (pair) => pair.a === address || pair.b === address,
  );
  if (!closest) return undefined;

  const other = closest.a === address ? closest.b : closest.a;
  const entry = others.find((candidate) => candidate.address === other);

  return {
    address: other,
    fingerprint: fingerprint(other),
    sharedPrefix: closest.sharedPrefix,
    sharedSuffix: closest.sharedSuffix,
    ...(entry?.label === undefined ? {} : {label: entry.label}),
  };
}
