import type {Address} from "./address.js";
import type {AddressFingerprint} from "./fingerprint.js";

/**
 * Everything the user's own history says about one address.
 *
 * Deliberately a flat summary rather than a transaction list: the indexer folds the history down
 * to this shape once, and the same object is then cheap enough to hand to the browser extension,
 * which has to decide in the time it takes someone to paste an address.
 */
export interface AddressSighting {
  address: Address;
  /** Name from the user's contacts, if they have one for this address. */
  label?: string;
  /** Transfers the user initiated to this address. Zero means they have never paid it. */
  outgoingCount: number;
  /** Unix seconds of the most recent payment the user made to it, if any. */
  lastOutgoingAt?: number;
  /** Transfers this address sent to the user. */
  incomingCount: number;
  /**
   * Inbound transfers carrying no value. The classic poisoning primitive: a zero-value
   * `transferFrom` costs the attacker almost nothing and plants their address in the victim's
   * transaction list, where it sits looking like a real counterparty.
   */
  zeroValueIncoming: number;
  /** Inbound transfers below the dust threshold — the same trick with a token that needs it. */
  dustIncoming: number;
  /** Unix seconds this address first appeared anywhere in the user's history. */
  firstSeenAt: number;
  lastSeenAt: number;
}

/** An address someone has publicly attested is impersonating another one. */
export interface PoisonReport {
  suspect: Address;
  /** The address the suspect appears to be imitating, when the reporter named one. */
  imitating?: Address;
  /** Attestation uid, so the UI can link out to the evidence rather than ask for trust. */
  uid?: string;
  reportedAt?: number;
}

export type FindingCode =
  | "lookalike-of-known-payee"
  | "appeared-right-after-payment"
  | "zero-value-inbound"
  | "dust-inbound"
  | "community-reported"
  | "never-paid-before"
  | "no-history-at-all";

/**
 * One reason, with the evidence behind it.
 *
 * Every finding carries a sentence written for the person about to sign, not a rule name. A score
 * with no explanation asks the user to trust a number; a score that says *why* lets them check it
 * against what they know, which is the only part of this system that can catch a case the rules
 * miss.
 */
export interface Finding {
  code: FindingCode;
  /** Points this contributes to the risk score. */
  weight: number;
  message: string;
  evidence: Record<string, unknown>;
}

export type RiskLevel = "safe" | "caution" | "danger";

export interface RiskInput {
  /** The address about to be paid. */
  to: string;
  /** The user's folded history. May or may not contain `to` itself. */
  history?: readonly AddressSighting[];
  /** Community attestations, from the on-chain registry. */
  reports?: readonly PoisonReport[];
  /** Unix seconds. Defaults to the current time; injectable so tests are not clock-dependent. */
  now?: number;
}

export interface RiskAssessment {
  address: Address;
  fingerprint: AddressFingerprint;
  /** 0-100, capped. */
  score: number;
  level: RiskLevel;
  /** Highest-weight first. */
  findings: readonly Finding[];
  /** The known payee this address most resembles, when there is one. */
  resembles?: {
    address: Address;
    label?: string;
    fingerprint: AddressFingerprint;
    sharedPrefix: number;
    sharedSuffix: number;
  };
}
