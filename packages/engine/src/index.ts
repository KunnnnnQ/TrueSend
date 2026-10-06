/**
 * `@truesend/engine` — address fingerprints, poisoning heuristics and explainable risk scoring.
 *
 * Every export here is a pure function. No clock, no network, no storage. That is what lets the
 * same rules run in three places that could otherwise drift apart: the web app, the browser
 * extension's clipboard guard, and the risk API behind the indexer. A user who is warned by the
 * extension and then opens the app sees the same verdict and the same wording, because it is
 * literally the same code deciding.
 */

export {
  addressBytes,
  addressesEqual,
  checkAddressFormat,
  isAddress,
  normalizeAddress,
  shortHex,
  toChecksumAddress,
  type Address,
  type AddressFormat,
} from "./address.js";

export {
  FINGERPRINT_BITS,
  FINGERPRINT_WORDS,
  compareFingerprints,
  fingerprint,
  identiconSvg,
  sharedPrefixLength,
  sharedSuffixLength,
  type AddressFingerprint,
  type AddressIdenticon,
  type FingerprintComparison,
} from "./fingerprint.js";

export {
  counterparties,
  foldHistory,
  type TransferRecord,
} from "./history.js";

export {
  COMMUNITY_CAP,
  MIN_AFFIX_MATCH,
  RECENT_PAYMENT_WINDOW_SECONDS,
  THRESHOLDS,
  WEIGHTS,
  assessAddress,
  assessMany,
  levelFor,
  nearestLookalike,
} from "./risk.js";

export {
  collidingAddresses,
  collidingPairs,
  findAddresses,
  type AddressCollision,
  type AddressMatch,
} from "./scan.js";

export {
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
  type FlaggedTokens,
  type RestrictionLevel,
  type TokenSymbolFinding,
  type TokenVerdict,
  type TokenSymbolIssue,
  type TokenToInspect,
} from "./tokens.js";

export type {
  AddressSighting,
  Finding,
  FindingCode,
  PoisonReport,
  RiskAssessment,
  RiskInput,
  RiskLevel,
} from "./types.js";
