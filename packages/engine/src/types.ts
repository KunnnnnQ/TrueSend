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
  /**
   * Transfers the user **signed**. Zero means they have never actually paid this address.
   *
   * A `Transfer` log naming an address as the sender does not mean that address sent anything.
   * Anyone can call a contract that emits one. Only the transaction signer is authoritative, so
   * an indexer must check `tx.from` before counting anything here.
   */
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
  /**
   * Transfer logs that name the user as the sender in a transaction the user did not sign.
   *
   * These are fabrications, and they are the single strongest signal in this set — not a
   * heuristic but a checkable fact. A wallet history built by believing logs shows them as
   * payments the user made, which is exactly why they work: the victim of the May 2024 WBTC
   * case sent 1155 WBTC to an address whose only credential was a fabricated record of a
   * 0.05 "ETH" payment they had never made. See `analysis/`.
   *
   * Required rather than optional on purpose. An indexer that does not resolve transaction
   * signers has to write `0` here deliberately, and take responsibility for it, instead of
   * getting the dangerous default for free.
   */
  spoofedOutgoingCount: number;
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
  | "spoofed-outgoing-transfer"
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
